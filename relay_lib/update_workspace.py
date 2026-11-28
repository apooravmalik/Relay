"""Conservative repeat pulls for plain imported workspaces.

The retained previous directory is a recovery artifact, not a backup service.
Independent writers must be stopped for the entire operation.
"""
import ctypes
import errno
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import uuid

from relay_lib import export_workspace
from relay_lib.publication import publish_noreplace


def state_dir():
    path = Path.home() / '.relay-v0' / 'pairings'
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(path, 0o700)
    return path


def pairing_path(destination):
    return state_dir() / (hashlib.sha256(os.fsencode(str(destination))).hexdigest() + '.json')


def installation_id(write_json):
    path = state_dir() / 'installation.json'
    if not path.exists():
        # Exclusive creation avoids replacing an identity created concurrently.
        try:
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, 'w') as f:
                json.dump({'id': uuid.uuid4().hex}, f); f.flush(); os.fsync(f.fileno())
        except FileExistsError: pass
    return json.loads(path.read_text())['id']


def initial_pair(state, write_json):
    manifest = state['manifest']
    version = 1 if manifest['git']['mode'] == 'plain' else 2
    return {'schema_version': version, 'checkpoint_schema': version, 'installation_id': installation_id(write_json),
        'workspace_id': manifest['workspace_id'], 'vm': state['vm'], 'destination': state['destination'],
        'source_path': manifest['source_path'], 'checkpoint_id': manifest['transfer_id'],
        'parent_id': None, 'acknowledgment': 'pending', 'git': manifest['git'], 'entries': manifest['entries'],
        'exclusions': manifest['exclusions'], 'policy': 'existing-import-inclusion-v1'}


def pair_import(state, write_json):
    path = pairing_path(Path(state['destination']))
    if path.exists():
        current = json.loads(path.read_text())
        if current.get('checkpoint_id') == state['manifest']['transfer_id']: return
        raise ValueError('A different pairing already exists for this destination; recovery required.')
    write_json(path, initial_pair(state, write_json))


def swap(a, b):
    libc = ctypes.CDLL(None, use_errno=True)
    if sys.platform.startswith('linux'):
        fn = getattr(libc, 'renameat2', None)
        args = (-100, os.fsencode(a), -100, os.fsencode(b), 2)
    elif sys.platform == 'darwin':
        fn = getattr(libc, 'renamex_np', None)
        args = (os.fsencode(a), os.fsencode(b), 2)  # RENAME_SWAP
    else: fn = None
    if fn is None: raise OSError(errno.ENOTSUP, 'Atomic directory exchange unavailable')
    if fn(*args):
        code = ctypes.get_errno(); raise OSError(code, os.strerror(code))


def sync_directory(path):
    fd = os.open(path, os.O_RDONLY)
    try: os.fsync(fd)
    finally: os.close(fd)


def sync_tree(root):
    for current, dirs, files in os.walk(root, topdown=False):
        for name in files:
            fd = os.open(Path(current) / name, os.O_RDONLY)
            try: os.fsync(fd)
            finally: os.close(fd)
        sync_directory(current)


def changes(base, current):
    a = {x['path']: x for x in base}; b = {x['path']: x for x in current}
    return {p: ('added' if p not in a else 'deleted' if p not in b else 'modified')
            for p in sorted(a.keys() | b.keys()) if a.get(p) != b.get(p)}


def snapshot(root):
    try: return export_workspace.inspect(root, allow_parent_git=True)
    except RuntimeError as exc: raise ValueError(str(exc)) from exc


def endpoint(pair):
    return hashlib.sha256((pair['installation_id'] + '\0' + pair['destination']).encode()).hexdigest()


def cp(pair, manifest=None):
    version = pair.get('checkpoint_schema', 1)
    if manifest is not None:
        version = manifest.get('checkpoint_schema', version)
    return {'schema_version': version, 'workspace_id': pair['workspace_id'], 'endpoint': endpoint(pair),
            'source_path': pair['source_path'], 'generation': pair.get('generation', 0) + (1 if manifest else 0),
            'parent_id': pair['checkpoint_id'] if manifest else pair.get('parent_id'),
            'transfer_id': manifest['transfer_id'] if manifest else pair['checkpoint_id'],
            'entries': manifest['entries'] if manifest else pair['entries'],
            'git': manifest['git'] if manifest else pair['git']}


def remote_cp(importer, vm, pair, action, checkpoint=None, transfer_id=None):
    ssh, host = importer.ssh_command(vm)
    request = {'endpoint': endpoint(pair), 'action': action}
    if checkpoint is not None: request['checkpoint'] = checkpoint
    if transfer_id is not None: request['transfer_id'] = transfer_id
    return importer.remote(ssh, host, pair['workspace_id'], 'checkpoint', request)


def excluded_snapshot(root, exclusions):
    """Fingerprint local-only directories so they can survive a pull."""
    import stat
    output = []
    for relative in exclusions:
        if not relative or relative.startswith('/') or any(p in ('', '.', '..') for p in relative.split('/')): raise ValueError('Invalid excluded path.')
        source = root / relative
        st = source.lstat()
        if stat.S_ISREG(st.st_mode):
            output.append({'path': relative, 'type': 'file', 'mode': stat.S_IMODE(st.st_mode) & 0o777,
                           'size': st.st_size, 'sha256': export_workspace.sha(source)})
            continue
        if not stat.S_ISDIR(st.st_mode):
            raise ValueError('UNSUPPORTED: excluded paths must be regular files or directories.')
        for current, dirs, files in os.walk(source, followlinks=False, onerror=lambda exc: (_ for _ in ()).throw(exc)):
            dirs.sort(); files.sort()
            directory = Path(current)
            st = directory.lstat()
            if not stat.S_ISDIR(st.st_mode): raise ValueError('UNSUPPORTED: special files in local excluded data.')
            output.append({'path':directory.relative_to(root).as_posix(), 'type':'directory', 'mode':stat.S_IMODE(st.st_mode) & 0o777})
            for name in files:
                path = directory / name; st = path.lstat()
                if not stat.S_ISREG(st.st_mode): raise ValueError('UNSUPPORTED: symlinks or special files in local excluded data.')
                try: digest = export_workspace.sha(path)
                except RuntimeError as exc: raise ValueError(str(exc)) from exc
                output.append({'path':path.relative_to(root).as_posix(), 'type':'file', 'mode':stat.S_IMODE(st.st_mode) & 0o777, 'size':st.st_size, 'sha256':digest})
            if any((directory / name).is_symlink() for name in dirs): raise ValueError('UNSUPPORTED: symlinks in local excluded data.')
    return sorted(output, key=lambda x:x['path'])


def verify_with_preserved(project, manifest, exclusions, fingerprint, importer):
    importer.verify_project(project, manifest, ignore_paths=exclusions)
    if excluded_snapshot(project, exclusions) != fingerprint:
        raise ValueError('RECOVERY_REQUIRED: local excluded data changed during transfer.')


def run(args, importer):
    dest = Path(args.into).expanduser().absolute()
    if dest.is_symlink() or not dest.is_dir() or dest.resolve() != dest:
        raise ValueError('Destination must be an existing canonical directory, without symlinks.')
    pairfile = pairing_path(dest)
    if not pairfile.is_file(): raise ValueError('Destination is not paired; existing folders cannot be imported over.')
    lockfile = pairfile.with_suffix('.lock')
    with lockfile.open('a') as lock:
        try: fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError: raise ValueError('BUSY: another transfer holds the pairing lock.')
        pair = json.loads(pairfile.read_text())
        if (pair['installation_id'] != installation_id(importer.write_json_atomic) or pair['destination'] != str(dest)
                or pair['workspace_id'] != args.workspace or pair['vm'] != args.vm):
            raise ValueError('Pairing identity, workspace or VM does not match.')
        if pairfile.with_suffix('.merge-pending.json').exists(): raise ValueError('RECOVERY_REQUIRED: a merge is pending.')
        pending = pairfile.with_suffix('.pending.json')
        if pending.exists(): raise ValueError('RECOVERY_REQUIRED: inspect or resume the pending update: ' + str(pending))
        if pairfile.with_suffix('.push-pending.json').exists(): raise ValueError('RECOVERY_REQUIRED: a push is pending for this destination.')
        if pair['git']['mode'] != 'plain':
            from relay_lib import git_handoff
            return git_handoff.start(args, importer, dest, pairfile, pair, 'pull')
        if args.commit or args.expect:
            raise ValueError('--commit and --expect require a Git pairing.')
        local_git, local_entries, local_exclusions = snapshot(dest)
        ssh, host = importer.ssh_command(args.vm)
        preview = importer.remote(ssh, host, args.workspace, 'preview')
        if preview['source_path'] != pair['source_path'] or preview['git']['mode'] != 'plain':
            raise ValueError('UNSUPPORTED: source identity or Git state changed.')
        policies = {'checkpoint': pair['git'].get('policy_digest'), 'local': local_git.get('policy_digest'),
                    'vm': preview['git'].get('policy_digest')}
        if len(set(policies.values())) != 1:
            message = 'POLICY_MISMATCH: match the checkpoint policy or import into a new folder.'
            if args.dry_run:
                print(json.dumps({'status': 'BLOCKED', 'policy': policies, 'blockers': [message]}))
                return 0
            raise ValueError(message)
        if local_git != pair['git']:
            raise ValueError('CONFLICT: local workspace Git state changed; no files changed.')
        local = changes(pair['entries'], local_entries)
        cloud = changes(pair['entries'], preview['entries'])
        conflicts = sorted(set(local) & set(cloud))
        plan = {'status': 'CONFLICT' if conflicts else 'LOCAL_AHEAD' if local else 'CLOUD_AHEAD' if cloud else 'NO_OP',
                'checkpoint_id': pair['checkpoint_id'], 'local_changes': local, 'cloud_changes': cloud,
                'conflicts': conflicts, 'estimated_bytes': preview['estimated_bytes'], 'local_exclusions_preserved': local_exclusions,
                'limitations': ['Pause independent writers throughout capture and publication.', 'Renames are shown as delete and add.', 'Local changes require manual reconciliation; excluded directories are preserved when supported.']}
        if args.dry_run:
            print(json.dumps(plan, ensure_ascii=True, indent=None if args.json else 2)); return 0
        if local:
            raise ValueError('CONFLICT: local changes detected; no files changed. Use --dry-run to inspect.')
        preserved = excluded_snapshot(dest, local_exclusions)
        remote_state = remote_cp(importer, args.vm, pair, 'get')
        if remote_state['checkpoint'] is None and remote_state['pending'] is None:
            remote_state = remote_cp(importer, args.vm, pair, 'init', cp(pair))
        if remote_state['checkpoint'] != cp(pair) or remote_state['pending'] is not None:
            raise ValueError('RECOVERY_REQUIRED: remote checkpoint differs or a transfer is pending.')
        if not cloud:
            print(json.dumps(plan, ensure_ascii=True)); return 0
        print('relay: pause independent writers on both endpoints until the update finishes', file=sys.stderr)
        captured = importer.remote(ssh, host, args.workspace, 'capture')
        manifest = captured['manifest']
        if manifest['source_path'] != pair['source_path'] or manifest['git']['mode'] != 'plain': raise ValueError('Source identity changed.')
        if manifest['entries'] != preview['entries']: raise ValueError('BUSY: source changed since preview; retry.')
        staging = Path(tempfile.mkdtemp(prefix='.relay-update-', dir=dest.parent))
        operation = {'schema_version': 1, 'phase': 'downloading', 'destination': str(dest), 'staging': str(staging),
                     'pairing': str(pairfile), 'base': pair, 'manifest': manifest, 'vm': args.vm,
                     'export_path': captured['export_path'], 'excluded_paths': local_exclusions, 'excluded_fingerprint': preserved}
        importer.write_json_atomic(pending, operation)
        return finish(operation, pending, importer, args.json)


def finish(op, pending, importer, as_json):
    dest = Path(op['destination']); staging = Path(op['staging']); candidate = staging / 'project'
    manifest = op['manifest']; base = op['base']
    excluded_paths = op.get('excluded_paths', []); excluded_fingerprint = op.get('excluded_fingerprint', [])
    if staging.parent != dest.parent or not staging.name.startswith('.relay-update-') or staging.is_symlink() or not staging.is_dir():
        raise ValueError('RECOVERY_REQUIRED: invalid staging directory.')
    if op['phase'] in ('publishing', 'published', 'acknowledging'):
        # Candidate is the old directory after the atomic exchange. Never guess
        # if neither side matches the recorded states.
        base_manifest = {'entries': base['entries'], 'git': base['git']}
        try:
            verify_with_preserved(dest, manifest, excluded_paths, excluded_fingerprint, importer)
            verify_with_preserved(candidate, base_manifest, excluded_paths, excluded_fingerprint, importer)
        except (OSError, ValueError):
            if op['phase'] != 'publishing':
                raise ValueError('RECOVERY_REQUIRED: publication state differs; preserve both directories and inspect ' + str(staging))
            # A crash may have happened after journaling but before exchange.
            try:
                verify_with_preserved(dest, base_manifest, excluded_paths, excluded_fingerprint, importer)
                verify_with_preserved(candidate, manifest, excluded_paths, excluded_fingerprint, importer)
                ssh, host = importer.ssh_command(op['vm'])
                latest = importer.remote(ssh, host, base['workspace_id'], 'preview')
                if latest['source_path'] != base['source_path'] or latest['entries'] != manifest['entries'] or latest['git'] != manifest['git']:
                    raise ValueError('Source changed.')
                swap(candidate, dest)
                sync_directory(staging); sync_directory(dest.parent)
                verify_with_preserved(dest, manifest, excluded_paths, excluded_fingerprint, importer)
                verify_with_preserved(candidate, base_manifest, excluded_paths, excluded_fingerprint, importer)
            except (OSError, ValueError):
                raise ValueError('RECOVERY_REQUIRED: publication state differs; preserve both directories and inspect ' + str(staging))
    else:
        ssh, host = importer.ssh_command(op['vm'])
        remote_cp(importer, op['vm'], base, 'begin_pull', cp(base, manifest))
        payload = importer.download_export(ssh, host, op, staging,
                                          'FAILED_RECOVERABLE: download interrupted; use --resume-update with destination.')
        importer.verify_payload(payload, manifest)
        if candidate.exists(): shutil.rmtree(candidate)
        importer.reconstruct(payload, candidate, manifest)
        if excluded_snapshot(dest, excluded_paths) != excluded_fingerprint: raise ValueError('BUSY: local excluded data changed during transfer.')
        for rel in excluded_paths:
            source = dest / rel; target = candidate / rel
            if target.exists() or target.is_symlink(): raise ValueError('CONFLICT: excluded local directory collides with candidate.')
            target.parent.mkdir(parents=True, exist_ok=True)
            if source.is_dir():
                shutil.copytree(source, target, copy_function=shutil.copy2)
            else:
                shutil.copy2(source, target, follow_symlinks=False)
        verify_with_preserved(candidate, manifest, excluded_paths, excluded_fingerprint, importer)
        if excluded_snapshot(dest, excluded_paths) != excluded_fingerprint: raise ValueError('BUSY: local excluded data changed while copying.')
        sync_tree(candidate); sync_directory(staging)
        latest = importer.remote(ssh, host, base['workspace_id'], 'preview')
        if latest['source_path'] != base['source_path'] or latest['entries'] != manifest['entries'] or latest['git'] != manifest['git']:
            raise ValueError('BUSY: source changed after capture; no destination files changed.')
        verify_with_preserved(dest, {'entries': base['entries'], 'git': base['git']}, excluded_paths, excluded_fingerprint, importer)
        artifact_id, workspace, group = export_workspace.pc_recovery(dest, manifest['transfer_id'])
        witness = export_workspace._tree_fingerprint(dest)
        op['recovery_artifact'] = export_workspace.seal_recovery(artifact_id, dest, workspace, group, witness)
        if export_workspace._tree_fingerprint(dest) != witness:
            raise ValueError('BUSY: local files changed while archiving the previous workspace.')
        remote_cp(importer, op['vm'], base, 'prepare', cp(base, manifest))
        op['phase'] = 'publishing'; importer.write_json_atomic(pending, op)
        swap(candidate, dest)
        sync_directory(staging); sync_directory(dest.parent)
        # Detect edits racing publication, retaining both directories on mismatch.
        verify_with_preserved(dest, manifest, excluded_paths, excluded_fingerprint, importer)
        try: verify_with_preserved(candidate, {'entries': base['entries'], 'git': base['git']}, excluded_paths, excluded_fingerprint, importer)
        except (OSError, ValueError): raise ValueError('RECOVERY_REQUIRED: destination changed during publication; both copies retained in ' + str(staging))
        op['phase'] = 'published'; importer.write_json_atomic(pending, op)
    # A checkpoint acknowledges the captured version, not subsequent source edits.
    # Before the first commit, refuse a stale capture; after a lost commit response,
    # the acknowledged checkpoint is historical and later source edits are allowed.
    remote_state = remote_cp(importer, op['vm'], base, 'get')
    if remote_state['checkpoint'] != cp(base, manifest):
        if remote_state['checkpoint'] != cp(base) or remote_state['pending'] != cp(base, manifest):
            raise ValueError('RECOVERY_REQUIRED: remote checkpoint or pending transfer differs.')
        ssh, host = importer.ssh_command(op['vm'])
        latest = importer.remote(ssh, host, base['workspace_id'], 'preview')
        if latest['source_path'] != base['source_path'] or latest['entries'] != manifest['entries'] or latest['git'] != manifest['git']:
            raise ValueError('RECOVERY_REQUIRED: source changed before acknowledgment; both local copies retained in ' + str(staging))
    op['phase'] = 'acknowledging'; importer.write_json_atomic(pending, op)
    remote_state = remote_cp(importer, op['vm'], base, 'commit', transfer_id=manifest['transfer_id'])
    if remote_state['checkpoint'] != cp(base, manifest) or remote_state['pending'] is not None:
        raise ValueError('RECOVERY_REQUIRED: remote acknowledgment does not match.')
    artifact_id = op.get('recovery_artifact')
    if not artifact_id:
        artifact_id, workspace, group = export_workspace.pc_recovery(dest, manifest['transfer_id'])
        op['recovery_artifact'] = export_workspace.seal_recovery(
            artifact_id, candidate, workspace, group, export_workspace._tree_fingerprint(candidate))
        importer.write_json_atomic(pending, op)
    new = dict(base, acknowledgment='acknowledged', generation=base.get('generation', 0) + 1,
               parent_id=base['checkpoint_id'], checkpoint_id=manifest['transfer_id'],
               entries=manifest['entries'], git=manifest['git'], exclusions=manifest['exclusions'])
    importer.write_json_atomic(Path(op['pairing']), new)
    op['phase'] = 'acknowledged'
    importer.write_json_atomic(pending, op)
    return finish_acknowledged(op, pending, importer, new, as_json)


def finish_acknowledged(op, pending, importer, pair, as_json):
    staging = Path(op['staging'])
    candidate = staging / 'project'
    retained = {'recovery_path': str(candidate)}
    if op.get('recovery_artifact'):
        retained = export_workspace.finish_recovery(op['recovery_artifact'], None, candidate)
    receipt = {'status': 'SUCCESS', 'checkpoint_id': pair['checkpoint_id'], 'parent_id': pair['parent_id'],
               'destination': op['destination'], 'vm': op['vm'], **retained}
    importer.write_json_atomic(Path(op['pairing']).with_suffix('.pull-last.json'), receipt)
    pending.unlink()
    if op.get('recovery_artifact'):
        shutil.rmtree(staging, ignore_errors=True)
    else:
        shutil.rmtree(staging / 'payload', ignore_errors=True)
    print(json.dumps(receipt, ensure_ascii=True, indent=None if as_json else 2))
    return 0


def resume(args, importer):
    dest = Path(args.resume_update).expanduser().absolute()
    path = pairing_path(dest).with_suffix('.pending.json')
    lockfile = pairing_path(dest).with_suffix('.lock')
    with lockfile.open('a') as lock:
        try: fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError: raise ValueError('BUSY: another transfer holds the pairing lock.')
        if not path.exists():
            pairfile = pairing_path(dest); pair = json.loads(pairfile.read_text())
            receipt = json.loads(pairfile.with_suffix('.pull-last.json').read_text())
            if receipt['destination'] != str(dest) or receipt['vm'] != args.vm or pair['checkpoint_id'] != receipt['checkpoint_id']:
                raise ValueError('RECOVERY_REQUIRED: completed receipt identity differs.')
            git, entries, _ = snapshot(dest)
            remote = remote_cp(importer, args.vm, pair, 'get')
            if git != pair['git'] or entries != pair['entries'] or remote['checkpoint'] != cp(pair) or remote['pending'] is not None:
                raise ValueError('RECOVERY_REQUIRED: completed receipt no longer matches both endpoints.')
            print(json.dumps(receipt, ensure_ascii=True)); return 0
        op = json.loads(path.read_text())
        if op['destination'] != str(dest) or op['vm'] != args.vm or op['pairing'] != str(pairing_path(dest)): raise ValueError('Transfer identity mismatch.')
        if op.get('kind') == 'git':
            from relay_lib import git_handoff
            return git_handoff.finish(op, path, importer, args.json)
        if op['phase'] == 'acknowledged':
            pair = json.loads(Path(op['pairing']).read_text())
            verify_with_preserved(dest, op['manifest'], op.get('excluded_paths', []), op.get('excluded_fingerprint', []), importer)
            remote = remote_cp(importer, op['vm'], op['base'], 'get')
            if pair['checkpoint_id'] != op['manifest']['transfer_id'] or remote['checkpoint'] != cp(op['base'], op['manifest']) or remote['pending'] is not None:
                raise ValueError('RECOVERY_REQUIRED: acknowledged state does not match both endpoints.')
            staging = Path(op['staging'])
            if staging.parent != dest.parent or not staging.name.startswith('.relay-update-') or staging.is_symlink():
                raise ValueError('RECOVERY_REQUIRED: invalid staging directory.')
            return finish_acknowledged(op, path, importer, pair, args.json)
        return finish(op, path, importer, args.json)


def payload_status(staging, manifest, importer):
    """Describe incomplete downloads without revealing file contents."""
    root = staging / 'payload'
    result = {'verified': [], 'missing': [], 'invalid': []}
    for item in manifest['payload']:
        relative = importer.safe_path(item['path'])
        path = root / relative
        try:
            # Never follow a symlink when reporting transfer progress.
            components = [root, *[root.joinpath(*relative.split('/')[:n]) for n in range(1, len(relative.split('/')) + 1)]]
            if any(part.is_symlink() for part in components):
                result['invalid'].append(relative)
            elif not path.exists():
                result['missing'].append(relative)
            elif not path.is_file() or path.stat().st_size != item['size'] or importer.digest(path) != item['sha256']:
                result['invalid'].append(relative)
            else:
                result['verified'].append(relative)
        except OSError:
            result['invalid'].append(relative)
    return result


def manage(args, importer):
    dest = Path(args.inspect_update or args.abort_update).expanduser().absolute()
    pairfile = pairing_path(dest); path = pairfile.with_suffix('.pending.json')
    with pairfile.with_suffix('.lock').open('a') as lock:
        try: fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError: raise ValueError('BUSY: another transfer holds the pairing lock.')
        op = json.loads(path.read_text()); base = op['base']; manifest = op['manifest']
        if op['destination'] != str(dest) or op['vm'] != args.vm or op['pairing'] != str(pairfile): raise ValueError('Transfer identity mismatch.')
        if op.get('kind') == 'git' and args.abort_update:
            staging = Path(op['staging'])
            if (staging.is_symlink() or staging.parent != dest.parent or
                    not staging.name.startswith('.relay-update-') or
                    (staging / 'publication' / 'journal.json').exists()):
                raise ValueError('Publication may have started. Inspect and resume the Git handoff.')
            git, entries, _ = snapshot(dest)
            if git != base['git'] or entries != base['entries']:
                raise ValueError('Destination changed. Preserve the staging folder for recovery.')
            current = remote_cp(importer, args.vm, base, 'get')
            if current['checkpoint'] != op['prior'] or current['pending'] not in (None, op['proposed']):
                raise ValueError('Remote checkpoint differs. Inspect and resume the Git handoff.')
            remote_cp(importer, args.vm, base, 'abort', transfer_id=manifest['transfer_id'])
            archive = path.with_name(manifest['transfer_id'] + '.aborted.json')
            os.replace(path, archive)
            print(json.dumps({'status': 'ABORTED', 'staging': op['staging'], 'journal': str(archive)}))
            return 0
        if args.inspect_update:
            try:
                remote = remote_cp(importer, args.vm, base, 'get')
                remote_checkpoint = (remote['checkpoint'] or {}).get('transfer_id')
                remote_pending = (remote['pending'] or {}).get('transfer_id')
                remote_status = 'reachable'
            except (OSError, ValueError):
                remote_checkpoint = remote_pending = None
                remote_status = 'unreachable'
            staging = Path(op['staging'])
            if staging.parent != dest.parent or not staging.name.startswith('.relay-update-') or staging.is_symlink() or not staging.is_dir():
                raise ValueError('RECOVERY_REQUIRED: invalid staging directory.')
            progress = payload_status(staging, manifest, importer) if op['phase'] == 'downloading' else None
            print(json.dumps({'phase': op['phase'], 'transfer_id': manifest['transfer_id'], 'destination': str(dest),
                              'staging': op['staging'], 'remote_status': remote_status,
                              'remote_checkpoint': remote_checkpoint, 'remote_pending': remote_pending,
                              'payload_files': progress}, ensure_ascii=True)); return 0
        remote = remote_cp(importer, args.vm, base, 'get')
        if op['phase'] not in ('downloading', 'publishing'):
            raise ValueError('RECOVERY_REQUIRED: publication may have happened; resume rather than abort.')
        # Abort only while the original is provably present and the remote has not committed.
        verify_with_preserved(dest, {'entries': base['entries'], 'git': base['git']}, op.get('excluded_paths', []), op.get('excluded_fingerprint', []), importer)
        candidate = Path(op['staging']) / 'project'
        if op['phase'] == 'publishing': verify_with_preserved(candidate, manifest, op.get('excluded_paths', []), op.get('excluded_fingerprint', []), importer)
        if remote['checkpoint'] != cp(base): raise ValueError('RECOVERY_REQUIRED: remote checkpoint advanced; resume.')
        remote_cp(importer, args.vm, base, 'abort', transfer_id=manifest['transfer_id'])
        # Retain staging for explicit review; never delete possible user data.
        archive = path.with_name(manifest['transfer_id'] + '.aborted.json')
        os.replace(path, archive)
        print(json.dumps({'status': 'ABORTED', 'staging': op['staging'], 'journal': str(archive)})); return 0
