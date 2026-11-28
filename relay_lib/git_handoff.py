"""Repeat Git handoffs over SSH using the shared file and index journal."""

import hashlib
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import tempfile
import sys
import uuid

from relay_lib import export_workspace as engine, update_workspace as upd
from relay_lib.stream_staging import stage_file
from relay_lib.transfer_plan import build_plan, git_state_changes


def print_result(data, as_json):
    print(json.dumps(data, ensure_ascii=True, indent=None if as_json else 2))
    return 0


def snapshot(path):
    try:
        engine.direct_git_directory(path)
        git, entries, exclusions = engine.inspect(path)
        return {'git': git, 'entries': entries, 'exclusions': exclusions}
    except RuntimeError as exc:
        raise ValueError(str(exc)) from exc


def verify_legacy(importer, pair, ssh, host):
    if pair.get('schema_version') == 2:
        return
    transfer = pair['checkpoint_id']
    receipt_file = Path.home() / '.relay-v0' / 'imports' / (transfer + '.json')
    try:
        receipt = json.loads(receipt_file.read_text())
        saved = importer.remote(ssh, host, pair['workspace_id'], 'export_manifest', {'transfer_id': transfer})
        manifest = saved['manifest']
        if (receipt['manifest_sha256'] != saved['sha256'] or
                any(receipt[k] != pair[k] for k in ('destination', 'workspace_id', 'vm')) or
                any(manifest[k] != pair[k] for k in ('git', 'entries', 'source_path')) or
                any(item['path'] == '.relayignore' for item in manifest['entries'])):
            raise ValueError('Baseline differs.')
        with tempfile.TemporaryDirectory(prefix='relay-legacy-') as temporary:
            payload = importer.download_export(ssh, host, saved, Path(temporary), 'Legacy export download failed.')
            if importer.digest(payload / 'manifest.json') != saved['sha256']:
                raise ValueError('Retained manifest differs.')
            importer.verify_payload(payload, manifest)
            engine.retain_git_snapshot(Path(pair['destination']), manifest, payload)
    except (OSError, RuntimeError, ValueError, KeyError) as exc:
        raise ValueError('UNVERIFIED_BASELINE: import into a new folder to create a verified Git pairing.') from exc


def start(args, importer, dest, pairfile, pair, direction):
    ssh, host = importer.ssh_command(args.vm)
    local = snapshot(dest)
    cloud = importer.remote(ssh, host, args.workspace, 'git_preview')
    if cloud['source_path'] != pair['source_path']:
        raise ValueError('CONFLICT: VM workspace identity changed.')
    source, target = (local, cloud) if direction == 'push' else (cloud, local)
    plan = build_plan(pair['entries'], local['entries'], cloud['entries'])
    plan.update(git_state_changes(pair['git'], local['git'], cloud['git']))
    plan.update(direction=direction, checkpoint_id=pair['checkpoint_id'],
                local_git_changed=local['git'] != pair['git'], cloud_git_changed=cloud['git'] != pair['git'],
                policy={'checkpoint': pair['git'].get('policy_digest'), 'local': local['git'].get('policy_digest'),
                        'vm': cloud['git'].get('policy_digest')})
    try:
        _, local_rules = engine.read_policy(dest)
    except RuntimeError as exc:
        raise ValueError(str(exc)) from exc
    affected = {}
    for entry in local['entries']:
        disposition = engine.relayignore_disposition(entry['path'], local_rules)
        if disposition != 'transfer':
            affected[entry['path']] = disposition
    affected.update({path: 'exclude' for path in local['exclusions']})
    plan['transfer_rules'] = {'pc': local_rules, 'vm': cloud['policy_rules'],
                              'pc_dispositions': affected, 'vm_dispositions': cloud['policy_dispositions']}
    values = set(plan['policy'].values())
    blockers = []
    if len(values) != 1:
        blockers.append('POLICY_MISMATCH: match both policy files to the shared checkpoint or import into a new folder.')
    if target['git'] != pair['git'] or target['entries'] != pair['entries']:
        blockers.append('CONFLICT: receiving workspace has changes since the checkpoint.')
    selected = getattr(args, 'commit', None)
    head_changed = source['git']['head'] != pair['git']['head']
    if head_changed and (selected is None or selected != source['git']['head']):
        blockers.append('COMMIT_APPROVAL_REQUIRED: review the Git change and pass --commit with the full source HEAD.')
    if selected is not None and selected != source['git']['head']:
        blockers.append('INVALID_COMMIT: --commit must equal the full source HEAD.')
    ops = []
    try:
        ops = engine.validate_git_transition(upd.cp(pair), source)
        engine.check_deletions(ops, target['exclusions'])
    except RuntimeError as exc:
        blockers.append(str(exc))
    plan['estimated_bytes'] = sum(op['new']['size'] for op in ops if op['action'] in ('add', 'modify'))
    plan['transfer_supported'] = not blockers
    plan['blockers'] = blockers
    local_changed = bool(plan['local_changes'] or plan['local_git_changed'])
    vm_changed = bool(plan['cloud_changes'] or plan['cloud_git_changed'])
    if local_changed and vm_changed and plan['status'] != 'CONFLICT':
        plan['status'] = 'BOTH_CHANGED'
    elif local_changed and not vm_changed:
        plan['status'] = 'LOCAL_AHEAD'
    elif vm_changed and not local_changed:
        plan['status'] = 'CLOUD_AHEAD'
    if direction == 'pull':
        plan['files'] = build_plan(pair['entries'], cloud['entries'], local['entries'])['files']
    plan['source_head'] = source['git']['head']
    input_state = [direction, pair['checkpoint_id']] + [
        {key: side[key] for key in ('git', 'entries', 'exclusions')} for side in (local, cloud)
    ]
    plan['plan_id'] = hashlib.sha256(json.dumps(input_state, sort_keys=True).encode()).hexdigest()
    if getattr(args, 'expect', None) and args.expect != plan['plan_id']:
        raise ValueError('STALE_PREVIEW: endpoint state changed. Review a new dry run.')
    plan['estimated_bytes_scope'] = 'working files; staged blobs and an optional history bundle are separate'
    if getattr(args, 'dry_run', False):
        return print_result(plan, args.json)
    if blockers:
        raise ValueError(' '.join(blockers))
    if source['git'] == pair['git'] and not ops:
        return print_result(dict(plan, status='NO_OP'), args.json)
    verify_legacy(importer, pair, ssh, host)
    current = upd.remote_cp(importer, args.vm, pair, 'get')
    base = upd.cp(pair)
    if current != {'checkpoint': base, 'pending': None}:
        raise ValueError('RECOVERY_REQUIRED: remote checkpoint differs.')
    if direction == 'pull':
        captured = importer.remote(ssh, host, args.workspace, 'git_capture', {'include_history': head_changed, 'against': base})
        manifest = captured['manifest']
        if any(manifest[key] != source[key] for key in ('git', 'entries', 'source_path')):
            raise ValueError('CONFLICT: VM workspace changed after planning.')
        proposed = upd.cp(pair, dict(manifest, checkpoint_schema=2))
        stage = Path(tempfile.mkdtemp(prefix='.relay-update-', dir=dest.parent))
    else:
        proposed = upd.cp(pair, dict(source, transfer_id=uuid.uuid4().hex, checkpoint_schema=2))
        stage = Path(tempfile.mkdtemp(prefix='.relay-git-push-', dir=dest.parent))
        manifest, captured = None, {}
    op = {'kind': 'git', 'direction': direction, 'phase': 'downloading' if direction == 'pull' else 'uploading',
          'vm': args.vm, 'destination': str(dest), 'pairing': str(pairfile), 'base': pair,
          'staging': str(stage), 'prior': base, 'proposed': proposed, 'manifest': manifest,
          'export_path': captured.get('export_path'), 'ops': ops}
    pending = pairfile.with_suffix('.push-pending.json' if direction == 'push' else '.pending.json')
    importer.write_json_atomic(pending, op)
    print('relay: pause independent editors, watchers and database writers until publication finishes', file=sys.stderr)
    return finish(op, pending, importer, args.json)


def rsync(ssh, source, destination):
    result = subprocess.run(['rsync', '-r', '--checksum', '--partial', '-e',
                             shlex.join(ssh), '--', source, destination])
    if result.returncode:
        raise ValueError('FAILED_RECOVERABLE: rsync interrupted. Resume the same transfer.')


def stage_files(source, stage, ops, captured=False):
    incoming = stage / 'incoming'
    incoming.mkdir(mode=0o700, exist_ok=True)
    for op in ops:
        if op['action'] not in ('add', 'modify'):
            continue
        entry = op['new']
        relative = op['path']
        dest = incoming / relative
        if dest.exists():
            if not engine._batch_matches(dest, entry):
                raise ValueError('RECOVERY_REQUIRED: staged file checksum differs.')
            continue
        if captured:
            (source / relative).chmod(entry['mode'])
            stage_file(source / relative, dest, entry)
        else:
            if any((source / Path(*Path(relative).parts[:n])).is_symlink()
                   for n in range(1, len(Path(relative).parts) + 1)):
                raise ValueError('UNSUPPORTED: symlink in source path.')
            stage_file(source / relative, dest, entry)


def stage_index(source, stage, base, proposed):
    blobs = stage / 'blobs'
    blobs.mkdir(mode=0o700, exist_ok=True)
    known = {item['oid'] for item in base['git']['index']}
    for oid in {item['oid'] for item in proposed['git']['index']} - known:
        final = blobs / oid
        if final.exists():
            continue
        with tempfile.NamedTemporaryFile(dir=stage) as stream:
            engine.run_git(source, 'cat-file', 'blob', oid, output=stream)
            stream.flush()
            os.fsync(stream.fileno())
            os.link(stream.name, final)


def finish(op, pending, importer, as_json):
    try:
        return _finish(op, pending, importer, as_json)
    except RuntimeError as exc:
        raise ValueError(str(exc)) from exc


def _finish(op, pending, importer, as_json):
    dest, stage = Path(op['destination']), Path(op['staging'])
    if stage.is_symlink() or not stage.is_dir() or stage.parent != dest.parent:
        raise ValueError('RECOVERY_REQUIRED: staging path differs.')
    ssh, host = importer.ssh_command(op['vm'])
    base, proposed = op['prior'], op['proposed']
    pair = op['base']
    request = {'base': base, 'proposed': proposed}

    def remote(action):
        return importer.remote(ssh, host, pair['workspace_id'], action, request)

    if op['direction'] == 'push':
        engine.check_git_snapshot(dest, proposed)
        status = remote('git_begin')
        if status['upload']:
            bundle = stage / 'history.bundle'
            stage_files(dest, stage, op['ops'])
            stage_index(dest, stage, base, proposed)
            if proposed['git']['head'] != base['git']['head'] and not bundle.exists():
                engine.make_history_bundle(dest, proposed['git'], stage)
            engine.check_git_snapshot(dest, proposed)
            rsync(ssh, str(stage) + '/', host + ':' + shlex.quote(status['directory'] + '/'))
        engine.check_git_snapshot(dest, proposed)
        result = remote('git_apply')
        engine.check_git_snapshot(dest, proposed)
        engine.retain_git_snapshot(dest, proposed)
        ack = remote('git_ack_push')
        retained = {key: ack[key] for key in ('recovery_artifact', 'recovery_path') if key in ack}
        retained.setdefault('recovery_path', result['recovery_path'])
    else:
        recovery = str(stage / 'publication')
        publication = Path(recovery)
        if not (publication / 'journal.json').exists():
            engine.check_git_snapshot(dest, base)
            remote('git_prepare_pull')
            payload = importer.download_export(ssh, host, op, stage,
                                              'FAILED_RECOVERABLE: download interrupted; resume the Git pull.')
            manifest = op['manifest']
            importer.verify_payload(payload, manifest, base)
            publication.mkdir(mode=0o700, exist_ok=True)
            stage_files(payload / 'files', publication, op['ops'], captured=True)
            for name in ('blobs', 'history.bundle'):
                source = payload / name
                target = publication / name
                if source.exists() and not target.exists():
                    if source.is_dir():
                        shutil.copytree(source, target, copy_function=os.link, dirs_exist_ok=True)
                    else:
                        os.link(source, target)
        remote('git_prepare_pull')
        artifact_id = engine.publish_git(dest, publication, base, proposed,
                                         recovery=engine.pc_recovery(dest, proposed['transfer_id']))
        engine.retain_git_snapshot(dest, proposed)
        ack = remote('git_ack_pull')
        retained = {'recovery_path': recovery}
        if artifact_id and ack['checkpoint'] == proposed:
            journal = publication / 'journal.json'
            state = json.loads(journal.read_text())
            state['phase'] = 'acknowledged'
            importer.write_json_atomic(journal, state)
            retained = engine.finish_recovery(artifact_id, None, publication / 'previous')

    if ack['checkpoint'] != proposed:
        raise ValueError('RECOVERY_REQUIRED: VM acknowledgment differs.')
    engine.check_git_snapshot(dest, proposed)
    result = complete(op, pending, importer, retained, as_json)
    if retained.get('recovery_artifact'):
        shutil.rmtree(stage, ignore_errors=True)
    return result


def complete(op, pending, importer, retained, as_json):
    pair, base, proposed = op['base'], op['prior'], op['proposed']
    dest = Path(op['destination'])
    pairfile = Path(op['pairing'])
    new = dict(pair, schema_version=2, checkpoint_schema=proposed['schema_version'],
               acknowledgment='acknowledged', generation=proposed['generation'], parent_id=base['transfer_id'],
               checkpoint_id=proposed['transfer_id'], entries=proposed['entries'], git=proposed['git'])
    importer.write_json_atomic(pairfile, new)
    receipt = {'status': 'SUCCESS', 'checkpoint_id': new['checkpoint_id'], 'transfer_id': new['checkpoint_id'],
               'parent_id': new['parent_id'], 'generation': new['generation'], 'head': new['git']['head'],
               'vm': op['vm'], 'destination': str(dest), **retained}
    if op['direction'] == 'push':
        receipt['remote_recovery_path'] = retained['recovery_path']
    importer.write_json_atomic(pairfile.with_suffix('.' + op['direction'] + '-last.json'), receipt)
    pending.unlink()
    return print_result(receipt, as_json)
