"""Human-initiated plain-folder batch push with staged, journaled publication."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import sys
import uuid

from relay_lib import import_workspace as imp, update_workspace as upd
from relay_lib.stream_staging import stage_file, StagingError
from relay_lib.transfer_plan import build_plan


def main(argv):
    parser = argparse.ArgumentParser(prog='relay push')
    parser.add_argument('--workspace', required=True); parser.add_argument('--project', required=True)
    parser.add_argument('--vm', default='relay-v0'); parser.add_argument('--json', action='store_true'); parser.add_argument('--resume', action='store_true')
    args = parser.parse_args(argv)
    try:
        dest = Path(args.project).expanduser().absolute()
        if dest.is_symlink() or not dest.is_dir() or dest.resolve() != dest: raise ValueError('Project must be an existing canonical directory.')
        if len(args.workspace) != 16 or any(c not in '0123456789abcdef' for c in args.workspace): raise ValueError('Invalid workspace ID.')
        pairfile = upd.pairing_path(dest); pending = pairfile.with_suffix('.push-pending.json')
        with pairfile.with_suffix('.lock').open('a') as lock:
            try: fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError: raise ValueError('BUSY: another transfer holds the pairing lock.')
            if pairfile.with_suffix('.pending.json').exists(): raise ValueError('RECOVERY_REQUIRED: a pull is pending.')
            if args.resume:
                if not pending.exists():
                    receipt = json.loads(pairfile.with_suffix('.push-last.json').read_text())
                    pair = json.loads(pairfile.read_text())
                    if receipt['destination'] != str(dest) or receipt['vm'] != args.vm or pair['workspace_id'] != args.workspace or pair['checkpoint_id'] != receipt['transfer_id']:
                        raise ValueError('RECOVERY_REQUIRED: completed receipt identity differs.')
                    git, entries, _ = upd.snapshot(dest)
                    remote = upd.remote_cp(imp, args.vm, pair, 'get')
                    if git != pair['git'] or entries != pair['entries'] or remote['checkpoint'] != upd.cp(pair) or remote['pending'] is not None:
                        raise ValueError('RECOVERY_REQUIRED: completed receipt no longer matches both endpoints.')
                    print(json.dumps(receipt, ensure_ascii=True)); return 0
                op = json.loads(pending.read_text())
                if op.get('kind') != 'batch' or op['destination'] != str(dest) or op['vm'] != args.vm or op['base']['workspace_id'] != args.workspace: raise ValueError('Pending batch identity differs.')
                return finish(op, pending, pairfile, args.json)
            if pending.exists(): raise ValueError('RECOVERY_REQUIRED: resume the pending push first.')
            if not pairfile.is_file(): raise ValueError('UNPAIRED: import and pair the folder before batch push.')
            pair = json.loads(pairfile.read_text())
            if pair['installation_id'] != upd.installation_id(imp.write_json_atomic) or pair['destination'] != str(dest) or pair['workspace_id'] != args.workspace or pair['vm'] != args.vm: raise ValueError('Pairing identity mismatch.')
            if pair['git']['mode'] != 'plain': raise ValueError('UNSUPPORTED: only plain folders are supported.')
            git, entries, _ = upd.snapshot(dest)
            ssh, host = imp.ssh_command(args.vm)
            remote = imp.remote(ssh, host, args.workspace, 'preview')
            plan = build_plan(pair['entries'], entries, remote['entries'])
            if git != pair['git'] or remote['git'] != pair['git'] or remote['source_path'] != pair['source_path'] or plan['cloud_changes']:
                raise ValueError('CONFLICT: VM workspace differs from the shared baseline.')
            current = upd.remote_cp(imp, args.vm, pair, 'get'); base = upd.cp(pair)
            if current['checkpoint'] != base or current['pending'] is not None: raise ValueError('RECOVERY_REQUIRED: remote checkpoint differs.')
            if not plan['local_changes']:
                print(json.dumps({'status':'NO_OP'})); return 0
            transfer = uuid.uuid4().hex
            staging_root = Path.home() / '.relay-v0' / 'batch-staging'
            staging_root.mkdir(mode=0o700, parents=True, exist_ok=True); os.chmod(staging_root, 0o700)
            staging = staging_root / transfer; staging.mkdir(mode=0o700)
            (staging / 'files').mkdir(mode=0o700)
            proposed = upd.cp(pair, {'transfer_id':transfer, 'entries':entries, 'git':git})
            op = {'schema_version':1, 'kind':'batch', 'destination':str(dest), 'vm':args.vm, 'pair':pair,
                  'base':base, 'proposed':proposed, 'staging':str(staging), 'phase':'staging'}
            imp.write_json_atomic(pending, op)
            return finish(op, pending, pairfile, args.json)
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as exc:
        return imp.fail(args, 'push_failed', str(exc))


def finish(op, pending, pairfile, as_json):
    dest = Path(op['destination']); pair = op['pair']; proposed = op['proposed']; base = op['base']
    transfer = proposed['transfer_id']; staging = Path(op['staging']); staging_root = Path.home() / '.relay-v0' / 'batch-staging'
    if staging.parent != staging_root or staging.name != transfer or staging.is_symlink() or not staging.is_dir(): raise ValueError('RECOVERY_REQUIRED: invalid staging directory.')
    git, entries, _ = upd.snapshot(dest)
    if git != proposed['git'] or entries != proposed['entries']: raise ValueError('RECOVERY_REQUIRED: local workspace changed; pending push remains.')
    old = {x['path']:x for x in base['entries']}; new = {x['path']:x for x in proposed['entries']}
    changed = [entry for path, entry in new.items() if entry['type'] == 'file' and old.get(path) != entry]
    for entry in changed:
        rel = imp.safe_path(entry['path']); source = dest / rel; target = staging / 'files' / rel
        if any(dest.joinpath(*rel.split('/')[:n]).is_symlink() for n in range(1, len(rel.split('/')) + 1)): raise ValueError('UNSUPPORTED: symlink in source path.')
        if target.exists():
            if target.is_symlink() or not target.is_file() or target.stat().st_size != entry['size'] or (target.stat().st_mode & 0o777) != entry['mode'] or imp.digest(target) != entry['sha256']: raise ValueError('RECOVERY_REQUIRED: staged file differs.')
        else: stage_file(source, target, entry)
    git, entries, _ = upd.snapshot(dest)
    if git != proposed['git'] or entries != proposed['entries']: raise ValueError('RECOVERY_REQUIRED: local workspace changed during staging.')
    op['phase'] = 'uploading'; imp.write_json_atomic(pending, op)
    ssh, host = imp.ssh_command(op['vm'])
    request = {'transfer_id':transfer, 'endpoint':upd.endpoint(pair), 'base':base, 'proposed':proposed}
    remote = imp.remote(ssh, host, pair['workspace_id'], 'batch_begin', request)
    if remote['phase'] == 'uploading':
        shell = ' '.join(shlex.quote(x) for x in ssh)
        destination = host + ':' + shlex.quote(remote['upload_path'].rstrip('/') + '/')
        result = subprocess.run(['rsync', '-r', '--checksum', '--partial', '-e', shell, '--', str(staging / 'files') + '/', destination])
        if result.returncode: raise ValueError('FAILED_RECOVERABLE: upload interrupted; retry with --resume.')
    git, entries, _ = upd.snapshot(dest)
    if git != proposed['git'] or entries != proposed['entries']: raise ValueError('RECOVERY_REQUIRED: local workspace changed before publication.')
    op['phase'] = 'publishing'; imp.write_json_atomic(pending, op)
    result = imp.remote(ssh, host, pair['workspace_id'], 'batch_apply', request)
    if result.get('checkpoint') != proposed: raise ValueError('RECOVERY_REQUIRED: remote acknowledgment differs.')
    git, entries, _ = upd.snapshot(dest)
    if git != proposed['git'] or entries != proposed['entries']: raise ValueError('RECOVERY_REQUIRED: local workspace changed during push.')
    next_pair = dict(pair, acknowledgment='acknowledged', generation=proposed['generation'], parent_id=pair['checkpoint_id'], checkpoint_id=transfer, entries=proposed['entries'], git=proposed['git'], remote_recovery_path=result['recovery_path'])
    imp.write_json_atomic(pairfile, next_pair)
    receipt = {'status':'SUCCESS', 'transfer_id':transfer, 'files':len(changed), 'destination':str(dest), 'vm':op['vm'], 'remote_recovery_path':result['recovery_path']}
    imp.write_json_atomic(pairfile.with_suffix('.push-last.json'), receipt)
    pending.unlink()
    # Staging only contains an additional verified copy; the VM recovery artifacts remain.
    shutil.rmtree(staging, ignore_errors=True)
    print(json.dumps(receipt, ensure_ascii=True, indent=None if as_json else 2))
    return 0
