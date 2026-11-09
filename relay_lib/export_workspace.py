"""Remote, read-only workspace capture helper, executed by the local CLI over SSH."""
import hashlib
import fcntl
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import uuid


def error(code, message):
    raise RuntimeError(code + ': ' + message)


def run_git(root, *args, check=True, env=None, output=subprocess.PIPE):
    clean = {k: v for k, v in os.environ.items() if not k.startswith('GIT_')}
    clean.update(GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL='/dev/null', GIT_TERMINAL_PROMPT='0', GIT_OPTIONAL_LOCKS='0')
    if env: clean.update(env)
    result = subprocess.run(['git', '-C', str(root), *args], stdout=output, stderr=subprocess.PIPE, env=clean)
    if check and result.returncode:
        error('unsupported_git_state', 'Git could not read the workspace safely.')
    return result


def workspace_roots():
    registry = Path(os.environ.get('RELAY_WORKSPACE_REGISTRY_FILE', Path.home() / '.relay-v0/controller/workspaces.json'))
    try:
        roots = json.loads(registry.read_text()).get('roots', [])
        if not isinstance(roots, list): roots = []
    except (OSError, ValueError, AttributeError): roots = []
    roots += os.environ.get('RELAY_WORKSPACE_ROOTS', '').split(os.pathsep)
    seen = set()
    for item in roots:
        if not isinstance(item, str) or not os.path.isabs(item): continue
        try:
            root = Path(item).resolve(strict=True)
            if root.is_dir() and root not in seen:
                seen.add(root)
                yield root
        except OSError: pass


def resolve_workspace(workspace_id):
    for root in workspace_roots():
        if hashlib.sha256(os.fsencode(str(root))).hexdigest()[:16] == workspace_id:
            return root
    error('workspace_not_found', 'Workspace ID is not registered or is unavailable to the SSH session.')


def excluded_directory(name):
    return name.lower() in {'.git', 'node_modules', '.venv', 'venv', '__pycache__', '.cache'}


def sha(path):
    h = hashlib.sha256()
    flags = os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0)
    with os.fdopen(os.open(path, flags), 'rb') as f:
        before = os.fstat(f.fileno())
        if not stat.S_ISREG(before.st_mode): error('source_changed', 'A file changed type during capture.')
        for chunk in iter(lambda: f.read(1024 * 1024), b''): h.update(chunk)
        after = os.fstat(f.fileno())
        if (before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns):
            error('source_changed', 'A file changed during capture; pause writers and retry.')
    return h.hexdigest()


def inspect(root, allow_parent_git=False):
    git = run_git(root, 'rev-parse', '--show-toplevel', check=False)
    meta = {'mode': 'plain', 'head': None, 'branch': None}
    tracked = None
    if git.returncode == 0 and Path(os.fsdecode(git.stdout.rstrip(b'\n'))).resolve() != root:
        if not allow_parent_git or (root / '.git').exists() or (root / '.git').is_symlink():
            error('unsupported_git_state', 'Register the Git repository root, not a subdirectory.')
        git = None
    if git is not None and git.returncode == 0:
        head = run_git(root, 'rev-parse', '--verify', 'HEAD', check=False)
        branch = run_git(root, 'symbolic-ref', '-q', 'HEAD', check=False)
        meta = {'mode': 'git_committed' if head.returncode == 0 else 'git_unborn', 'head': head.stdout.decode().strip() if head.returncode == 0 else None, 'branch': branch.stdout.decode().strip() if branch.returncode == 0 else None}
        if not meta['head'] and not meta['branch']: error('unsupported_git_state', 'Cannot resolve unborn branch.')
        gitdir = Path(os.fsdecode(run_git(root, 'rev-parse', '--absolute-git-dir').stdout.rstrip(b'\n')))
        if any((gitdir / name).exists() for name in ('MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer')): error('unsupported_git_state', 'Finish the merge, rebase or cherry-pick first.')
        if run_git(root, 'rev-parse', '--is-shallow-repository').stdout.strip() == b'true': error('unsupported_git_state', 'Shallow repositories are not supported.')
        if run_git(root, 'config', '--get', 'core.sparseCheckout', check=False).stdout.strip().lower() == b'true': error('unsupported_git_state', 'Sparse checkout is not supported.')
        if run_git(root, 'ls-files', '-u', '-z').stdout: error('unsupported_git_state', 'Resolve unmerged index entries first.')
        if run_git(root, 'ls-files', '-v', '-z').stdout and any(x[:1] != b'H' for x in run_git(root, 'ls-files', '-v', '-z').stdout.split(b'\0') if x): error('unsupported_git_state', 'Special index flags are not supported.')
        entries = run_git(root, 'ls-files', '--stage', '-z').stdout.split(b'\0')
        flags = re.findall(rb'\tflags: ([0-9a-fA-F]+)\n', run_git(root, 'ls-files', '--debug', '-z').stdout)
        if len(flags) != sum(bool(entry) for entry in entries) or any(int(flag, 16) & 0x20000000 for flag in flags):
            error('unsupported_git_state', 'Intent-to-add or unsupported index flags are not supported.')
        tracked = set()
        index = []
        for entry in entries:
            if not entry: continue
            header, path = entry.split(b'\t', 1)
            mode, oid, stage = header.split(b' ')
            if mode not in (b'100644', b'100755') or stage != b'0': error('unsupported_git_state', 'Submodules, symlink index entries and conflicts are not supported.')
            name = os.fsdecode(path)
            if any(excluded_directory(part) for part in name.split('/')[:-1]): error('excluded_tracked_file', 'Tracked content is inside an excluded dependency or cache directory.')
            tracked.add(name)
            index.append({'path': name, 'mode': mode.decode(), 'oid': oid.decode()})
        meta['index'] = index
        meta['object_format'] = run_git(root, 'rev-parse', '--show-object-format').stdout.decode().strip()
        if run_git(root, 'config', '--get-regexp', r'^(extensions\.partialclone|remote\..*\.promisor)$', check=False).returncode == 0: error('unsupported_git_state', 'Partial repositories are not supported.')
        if (root / '.gitattributes').exists(): error('unsupported_git_state', 'Repositories with attributes require filter and LFS validation, which is not supported yet.')
    elif (root / '.git').exists() or (root / '.git').is_symlink(): error('unsupported_git_state', 'Git metadata could not be inspected.')
    entries = []
    exclusions = []
    for current, dirs, files in os.walk(root, followlinks=False, onerror=lambda e: error('permission_denied', 'Cannot read workspace.')):
        dirs.sort(); files.sort()
        for name in list(dirs):
            p = Path(current) / name
            rel = p.relative_to(root).as_posix()
            if excluded_directory(name): dirs.remove(name); exclusions.append(rel); continue
            if p.is_symlink(): error('unsupported_file', 'Symlinks are not supported by this importer.')
            if (p / '.git').exists() or (p / '.git').is_symlink(): error('unsupported_git_state', 'Nested repositories are not supported.')
            entries.append({'path': rel, 'type': 'directory'})
        for name in files:
            p = Path(current) / name
            rel = p.relative_to(root).as_posix()
            if rel == '.git': exclusions.append(rel); continue
            if tracked is not None and name == '.gitattributes': error('unsupported_git_state', 'Repositories with Git attributes require filter and LFS validation, which is not supported yet.')
            st = p.lstat()
            if not stat.S_ISREG(st.st_mode): error('unsupported_file', 'Symlinks and special files are not supported by this importer.')
            entries.append({'path': rel, 'type': 'file', 'size': st.st_size, 'mode': stat.S_IMODE(st.st_mode) & 0o777, 'sha256': sha(p)})
    entries.sort(key=lambda e: e['path'])
    return meta, entries, sorted(exclusions)


def capture(root, workspace_id):
    # Compare complete inventories and index before and after copying. Independent
    # writers must still be paused: scans are not an atomic filesystem snapshot.
    export_root = Path.home() / '.relay-v0' / 'exports'
    export_root.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(export_root, 0o700)
    lock = open(export_root / (workspace_id + '.lock'), 'a')
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        lock.close()
        error('source_busy', 'Another capture is already in progress for this workspace.')
    before = inspect(root)
    transfer = uuid.uuid4().hex
    target = export_root / transfer
    target.mkdir(mode=0o700)
    try:
        files = target / 'files'; files.mkdir()
        for entry in before[1]:
            dest = files / entry['path']
            if entry['type'] == 'directory': dest.mkdir(parents=True, exist_ok=True)
            else:
                dest.parent.mkdir(parents=True, exist_ok=True)
                src = root / entry['path']
                with os.fdopen(os.open(src, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0)), 'rb') as source, open(dest, 'xb') as out: shutil.copyfileobj(source, out)
                os.chmod(dest, entry['mode'])
                if sha(dest) != entry['sha256']: error('source_changed', 'Workspace changed during capture; pause writers and retry.')
        meta = before[0]
        if meta['mode'].startswith('git_'):
            blobs = target / 'blobs'; blobs.mkdir()
            for item in meta['index']:
                blob = blobs / item['oid']
                if not blob.exists():
                    with blob.open('xb') as output:
                        run_git(root, 'cat-file', 'blob', item['oid'], output=output)
                    with blob.open('rb') as saved:
                        if saved.read(43).startswith(b'version https://git-lfs.github.com/spec/v1\n'):
                            error('unsupported_git_state', 'Git LFS content is not supported.')
            if meta['head']:
                scratch = target / 'scratch.git'
                clean = {k: v for k, v in os.environ.items() if not k.startswith('GIT_')}
                clean.update(GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL='/dev/null', GIT_TERMINAL_PROMPT='0')
                subprocess.run(['git', 'init', '--bare', '--quiet', '--object-format=' + meta['object_format'], str(scratch)], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=clean)
                run_git(scratch, '-c', 'core.hooksPath=/dev/null', 'fetch', '--quiet', '--no-tags', '--', str(root), meta['head'])
                run_git(scratch, 'update-ref', 'refs/relay/export', meta['head'])
                run_git(scratch, 'bundle', 'create', str(target / 'history.bundle'), 'refs/relay/export')
                shutil.rmtree(scratch)
        if inspect(root) != before: error('source_changed', 'Workspace changed during capture; pause writers and retry.')
        payload = []
        for path in sorted(target.rglob('*')):
            if path.is_file(): payload.append({'path': path.relative_to(target).as_posix(), 'size': path.stat().st_size, 'sha256': sha(path)})
        manifest = {'schema_version': 1, 'transfer_id': transfer, 'workspace_id': workspace_id, 'source_path': str(root), 'name': root.name, 'created_at': int(time.time()), 'git': meta, 'entries': before[1], 'exclusions': before[2], 'payload': payload, 'consistency': 'independent writers must be paused during capture'}
        (target / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=True, sort_keys=True, separators=(',', ':')))
        return manifest, str(target)
    except BaseException:
        shutil.rmtree(target, ignore_errors=True)
        raise
    finally:
        lock.close()


def checkpoint(root, workspace_id, request):
    """Private per-destination checkpoint with idempotent prepare/commit."""
    endpoint = request.get('endpoint', '')
    if not re.fullmatch(r'[0-9a-f]{64}', endpoint): error('invalid_request', 'Invalid endpoint identity.')
    folder = Path.home() / '.relay-v0' / 'checkpoints' / workspace_id
    folder.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(folder.parent.parent, 0o700)
    os.chmod(folder.parent, 0o700)
    os.chmod(folder, 0o700)
    file = folder / (endpoint + '.json')
    with open(folder / (endpoint + '.lock'), 'a') as lock:
        os.chmod(lock.name, 0o600)
        fcntl.flock(lock, fcntl.LOCK_EX)
        current = json.loads(file.read_text()) if file.exists() else {'checkpoint': None, 'pending': None}
        action = request.get('action')
        proposed = request.get('checkpoint')
        if action in ('init', 'prepare'):
            if not isinstance(proposed, dict) or proposed.get('workspace_id') != workspace_id or proposed.get('endpoint') != endpoint or proposed.get('source_path') != str(root): error('invalid_request', 'Checkpoint identity mismatch.')
            transfer = proposed.get('transfer_id', '')
            if not re.fullmatch(r'[0-9a-f]{32}', transfer): error('invalid_request', 'Invalid transfer ID.')
            saved = json.loads((Path.home() / '.relay-v0' / 'exports' / transfer / 'manifest.json').read_text())
            if saved['workspace_id'] != workspace_id or saved['source_path'] != str(root) or saved['entries'] != proposed.get('entries') or saved['git'] != proposed.get('git'): error('checkpoint_mismatch', 'Checkpoint does not match the captured export.')
        if action == 'init':
            if current['checkpoint'] is None and current['pending'] is None:
                if proposed.get('generation') != 0 or proposed.get('parent_id') is not None: error('checkpoint_mismatch', 'Invalid initial generation.')
                current['checkpoint'] = proposed
            elif current['checkpoint'] != proposed: error('checkpoint_mismatch', 'Remote checkpoint differs; inspect recovery state.')
        elif action == 'prepare':
            base = current['checkpoint']
            if not base or proposed.get('parent_id') != base['transfer_id'] or proposed.get('generation') != base['generation'] + 1: error('checkpoint_mismatch', 'Remote base checkpoint differs.')
            if current['pending'] not in (None, proposed): error('source_busy', 'A different transfer is pending for this destination.')
            current['pending'] = proposed
        elif action == 'commit':
            if current['checkpoint'] and current['checkpoint']['transfer_id'] == request.get('transfer_id') and current['pending'] is None: return current
            if not current['pending'] or current['pending']['transfer_id'] != request.get('transfer_id'): error('checkpoint_mismatch', 'No matching prepared checkpoint.')
            current['checkpoint'] = current['pending']; current['pending'] = None
        elif action == 'abort':
            if current['pending'] and current['pending']['transfer_id'] != request.get('transfer_id'): error('checkpoint_mismatch', 'A different transfer is pending.')
            current['pending'] = None
        elif action != 'get': error('invalid_request', 'Unknown checkpoint action.')
        if action != 'get':
            fd, temp = tempfile.mkstemp(prefix='.checkpoint-', dir=folder)
            try:
                with os.fdopen(fd, 'w') as stream:
                    json.dump(current, stream, sort_keys=True); stream.flush(); os.fsync(stream.fileno())
                os.replace(temp, file)
                d = os.open(folder, os.O_RDONLY)
                try: os.fsync(d)
                finally: os.close(d)
            finally:
                if os.path.exists(temp): os.unlink(temp)
        return current


def export_manifest(root, workspace_id, request):
    transfer = request.get('transfer_id', '')
    if not re.fullmatch(r'[0-9a-f]{32}', transfer): error('invalid_request', 'Invalid transfer ID.')
    path = Path.home() / '.relay-v0' / 'exports' / transfer / 'manifest.json'
    raw = path.read_bytes()
    manifest = json.loads(raw)
    if manifest['workspace_id'] != workspace_id or manifest['source_path'] != str(root): error('checkpoint_mismatch', 'Original export identity differs.')
    return {'manifest': manifest, 'sha256': hashlib.sha256(raw).hexdigest()}


def _push_assert_idle(root):
    # Advisory check only. It cannot exclude a new external writer after scanning.
    if not shutil.which('lsof'): error('source_busy', 'Install lsof and pause workspace processes before pushing.')
    result = subprocess.run(['lsof', '-w', '+D', str(root)], stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30)
    if result.returncode not in (0, 1) or result.stdout.strip() or result.stderr.strip():
        error('source_busy', 'Workspace is in use or open files cannot be verified; stop writers and retry.')


def push_one(root, workspace_id, request):
    """Publish exactly one existing regular file, retaining the old inode."""
    import base64
    import ctypes
    transfer = request.get('transfer_id', '')
    relative = request.get('path', '')
    endpoint = request.get('endpoint', '')
    if not re.fullmatch(r'[0-9a-f]{32}', transfer) or not re.fullmatch(r'[0-9a-f]{64}', endpoint): error('invalid_request', 'Invalid transfer identity.')
    if not isinstance(relative, str) or not relative or relative.startswith('/') or '\x00' in relative or any(x in ('', '.', '..') for x in relative.split('/')): error('invalid_request', 'Invalid file path.')
    if any(excluded_directory(x) for x in relative.split('/')): error('unsupported_file', 'Excluded directories cannot be targeted.')
    base = request['base']; proposed = request['proposed']
    if base.get('workspace_id') != workspace_id or base.get('endpoint') != endpoint or base.get('source_path') != str(root): error('checkpoint_mismatch', 'Base identity differs.')
    if proposed.get('workspace_id') != workspace_id or proposed.get('endpoint') != endpoint or proposed.get('source_path') != str(root) or proposed.get('transfer_id') != transfer or proposed.get('parent_id') != base.get('transfer_id') or proposed.get('generation') != base.get('generation', -1) + 1: error('checkpoint_mismatch', 'Proposed identity differs.')
    old = {x['path']: x for x in base['entries']}; new = {x['path']: x for x in proposed['entries']}
    if set(old) != set(new) or old.get(relative, {}).get('type') != 'file' or new.get(relative, {}).get('type') != 'file' or any(old[k] != new[k] for k in old if k != relative) or old[relative] == new[relative] or base['git'] != proposed['git'] or base['git']['mode'] != 'plain': error('unsupported_file', 'Only one existing plain-workspace file may change per transfer.')
    data = base64.b64decode(request.get('content', ''), validate=True)
    if len(data) > 10 * 1024 * 1024 or len(data) != new[relative]['size'] or hashlib.sha256(data).hexdigest() != new[relative]['sha256']: error('invalid_request', 'File content does not match the proposed manifest or exceeds 10 MiB.')
    target = root / relative
    directory = Path.home() / '.relay-v0' / 'pushes' / transfer
    directory.parent.mkdir(mode=0o700, parents=True, exist_ok=True); os.chmod(directory.parent, 0o700)
    lock_path = Path.home() / '.relay-v0' / 'exports' / (workspace_id + '.lock')
    lock_path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    with lock_path.open('a') as lock:
        try: fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError: error('source_busy', 'Another workspace capture or push is running.')
        state_path = directory / 'journal.json'; candidate = directory / 'file'
        identity = {'workspace_id': workspace_id, 'path': relative, 'base': base, 'proposed': proposed}
        if state_path.exists():
            state = json.loads(state_path.read_text())
            if state['identity'] != identity: error('checkpoint_mismatch', 'Transfer identity changed.')
        else:
            current = checkpoint(root, workspace_id, {'action':'get', 'endpoint': endpoint})
            if current['checkpoint'] != base or current['pending'] is not None: error('checkpoint_mismatch', 'Remote base or pending transfer differs.')
            meta, entries, _ = inspect(root)
            if meta != base['git'] or entries != base['entries']: error('conflict', 'VM workspace differs from the shared baseline.')
            _push_assert_idle(root)
            directory.mkdir(mode=0o700, exist_ok=True)
            if candidate.exists():
                if candidate.is_symlink() or sha(candidate) != new[relative]['sha256']: error('recovery_required', 'Staged file differs.')
            else:
                with candidate.open('xb') as f:
                    f.write(data); f.flush(); os.fsync(f.fileno())
            os.chmod(candidate, new[relative]['mode'])
            state = {'identity': identity, 'phase': 'prepared'}
            _push_write_json(state_path, state)
        export = Path.home() / '.relay-v0' / 'exports' / transfer
        export.mkdir(mode=0o700, exist_ok=True)
        export_meta = {'workspace_id': workspace_id, 'source_path': str(root), 'entries': proposed['entries'], 'git': proposed['git']}
        if (export / 'manifest.json').exists():
            if json.loads((export / 'manifest.json').read_text()) != export_meta: error('checkpoint_mismatch', 'Transfer manifest differs.')
        else: _push_write_json(export / 'manifest.json', export_meta)
        current = checkpoint(root, workspace_id, {'action':'get', 'endpoint':endpoint})
        if current['checkpoint'] == base and current['pending'] is None:
            checkpoint(root, workspace_id, {'action':'prepare', 'endpoint':endpoint, 'checkpoint':proposed})
        elif not ((current['checkpoint'] == base and current['pending'] == proposed) or (current['checkpoint'] == proposed and current['pending'] is None)):
            error('checkpoint_mismatch', 'Remote checkpoint cannot be reconciled.')
        if state['phase'] in ('prepared', 'publishing'):
            def matches(path, entry):
                try:
                    return not path.is_symlink() and path.is_file() and path.stat().st_size == entry['size'] and (path.stat().st_mode & 0o777) == entry['mode'] and sha(path) == entry['sha256']
                except OSError: return False
            if matches(target, old[relative]) and matches(candidate, new[relative]):
                meta, entries, _ = inspect(root)
                if meta != base['git'] or entries != base['entries']: error('conflict', 'VM workspace changed during preparation.')
                if any((root.joinpath(*relative.split('/')[:n])).is_symlink() for n in range(1, len(relative.split('/')) + 1)): error('unsupported_file', 'Symlink encountered.')
                _push_assert_idle(root)
                state['phase'] = 'publishing'; _push_write_json(state_path, state)
                libc = ctypes.CDLL(None, use_errno=True)
                fn = getattr(libc, 'renameat2', None)
                if fn is None: error('unsupported_file', 'Atomic exchange unavailable.')
                if fn(-100, os.fsencode(candidate), -100, os.fsencode(target), 2): raise OSError(ctypes.get_errno(), 'Atomic exchange failed.')
                for parent in (directory, target.parent):
                    fd = os.open(parent, os.O_RDONLY)
                    try: os.fsync(fd)
                    finally: os.close(fd)
            if not matches(target, new[relative]) or not matches(candidate, old[relative]): error('recovery_required', 'Both versions were retained but publication cannot be verified.')
            meta, entries, _ = inspect(root)
            if meta != proposed['git'] or entries != proposed['entries']: error('recovery_required', 'Workspace changed during publication; previous file retained.')
            state['phase'] = 'published'; _push_write_json(state_path, state)
        if state['phase'] in ('published', 'acknowledged'):
            meta, entries, _ = inspect(root)
            if meta != proposed['git'] or entries != proposed['entries'] or not candidate.is_file() or sha(candidate) != old[relative]['sha256']:
                error('recovery_required', 'Workspace or recovery copy changed after publication.')
            current = checkpoint(root, workspace_id, {'action':'commit', 'endpoint':endpoint, 'transfer_id':transfer})
            if current['checkpoint'] != proposed or current['pending'] is not None: error('recovery_required', 'Remote acknowledgment differs.')
            state['phase'] = 'acknowledged'; _push_write_json(state_path, state)
            return {'status':'SUCCESS', 'transfer_id':transfer, 'recovery_path':str(candidate), 'checkpoint':current['checkpoint']}
        error('recovery_required', 'Unknown transfer phase.')


def _push_write_json(path, data):
    fd, tmp = tempfile.mkstemp(prefix='.relay-push-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as stream:
            json.dump(data, stream, sort_keys=True); stream.flush(); os.fsync(stream.fileno())
        os.replace(tmp, path)
        fd = os.open(path.parent, os.O_RDONLY)
        try: os.fsync(fd)
        finally: os.close(fd)
    finally:
        if os.path.exists(tmp): os.unlink(tmp)

def _batch_paths(base, proposed):
    import unicodedata
    old = {x['path']: x for x in base['entries']}; new = {x['path']: x for x in proposed['entries']}
    if len(old) != len(base['entries']) or len(new) != len(proposed['entries']): error('invalid_request', 'Duplicate paths.')
    folded = set()
    for path, entry in new.items():
        if not isinstance(path, str) or not path or path.startswith('/') or '\x00' in path or any(part in ('', '.', '..') or excluded_directory(part) for part in path.split('/')): error('invalid_request', 'Unsafe path.')
        norm = unicodedata.normalize('NFC', path).casefold()
        if norm in folded: error('unsupported_file', 'Case or Unicode path collision.')
        folded.add(norm)
        if entry['type'] not in ('file', 'directory'): error('unsupported_file', 'Unsupported file type.')
    ops = []
    for path in sorted(old.keys() | new.keys()):
        a, b = old.get(path), new.get(path)
        if a == b: continue
        if a and b and a['type'] != b['type']: error('unsupported_file', 'File/directory type changes are not supported.')
        entry = b or a
        if entry['type'] == 'directory': action = 'mkdir' if b else 'rmdir'
        else: action = 'modify' if a and b else 'add' if b else 'delete'
        ops.append({'path':path, 'action':action, 'old':a, 'new':b})
    rank = {'mkdir':0, 'modify':1, 'add':1, 'delete':2, 'rmdir':3}
    ops.sort(key=lambda op:(rank[op['action']], -op['path'].count('/') if op['action']=='rmdir' else op['path'].count('/') if op['action']=='mkdir' else 0, op['path']))
    return ops


def _batch_identity(root, workspace_id, request):
    transfer = request.get('transfer_id', ''); endpoint = request.get('endpoint', '')
    if not re.fullmatch(r'[0-9a-f]{32}', transfer) or not re.fullmatch(r'[0-9a-f]{64}', endpoint): error('invalid_request', 'Invalid transfer identity.')
    base = request['base']; proposed = request['proposed']
    if base.get('workspace_id') != workspace_id or base.get('endpoint') != endpoint or base.get('source_path') != str(root) or base.get('git', {}).get('mode') != 'plain': error('checkpoint_mismatch', 'Base identity differs.')
    if proposed.get('workspace_id') != workspace_id or proposed.get('endpoint') != endpoint or proposed.get('source_path') != str(root) or proposed.get('transfer_id') != transfer or proposed.get('parent_id') != base.get('transfer_id') or proposed.get('generation') != base.get('generation', -1) + 1 or proposed.get('git') != base.get('git'): error('checkpoint_mismatch', 'Proposed identity differs.')
    return {'workspace_id':workspace_id, 'base':base, 'proposed':proposed, 'endpoint':endpoint, 'transfer_id':transfer}


def _batch_directory(transfer):
    root = Path.home() / '.relay-v0' / 'batch-pushes'
    root.mkdir(mode=0o700, parents=True, exist_ok=True); os.chmod(root, 0o700)
    return root / transfer


def _batch_lock(workspace_id):
    path = Path.home() / '.relay-v0' / 'exports' / (workspace_id + '.lock')
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    lock = path.open('a')
    try: fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        lock.close(); error('source_busy', 'Another workspace transfer is running.')
    return lock


def batch_begin(root, workspace_id, request):
    identity = _batch_identity(root, workspace_id, request)
    transfer = identity['transfer_id']; directory = _batch_directory(transfer); state_path = directory / 'journal.json'
    with _batch_lock(workspace_id):
        if state_path.exists():
            state = json.loads(state_path.read_text())
            if state['identity'] != identity: error('checkpoint_mismatch', 'Transfer identity changed.')
        else:
            current = checkpoint(root, workspace_id, {'action':'get', 'endpoint':identity['endpoint']})
            if current['checkpoint'] != identity['base'] or current['pending'] is not None: error('checkpoint_mismatch', 'Remote baseline or pending transfer differs.')
            meta, entries, _ = inspect(root)
            if meta != identity['base']['git'] or entries != identity['base']['entries']: error('conflict', 'VM workspace differs from the common baseline.')
            _push_assert_idle(root)
            operations = _batch_paths(identity['base'], identity['proposed'])
            if not operations: error('invalid_request', 'No changes to transfer.')
            _, _, exclusions = inspect(root)
            deleted_dirs = [op['path'] for op in operations if op['action'] == 'rmdir']
            if any(path == directory or path.startswith(directory + '/') for path in exclusions for directory in deleted_dirs):
                error('conflict', 'A directory to be deleted contains excluded VM data.')
            required = sum(op['new'].get('size', 0) for op in operations if op['action'] in ('add', 'modify'))
            if root.stat().st_dev != directory.parent.stat().st_dev: error('unsupported_file', 'Workspace and VM staging must be on the same filesystem.')
            if shutil.disk_usage(directory.parent).free < required + 1024 * 1024: error('insufficient_space', 'Insufficient VM disk space for staging.')
            directory.mkdir(mode=0o700, exist_ok=True)
            for name in ('incoming', 'backup', 'dirslots'):
                (directory / name).mkdir(mode=0o700, exist_ok=True)
            for index, op in enumerate(operations):
                if op['action'] == 'mkdir':
                    slot = directory / 'dirslots' / str(index)
                    slot.mkdir(mode=0o700, exist_ok=True)
                    st = slot.stat(); op['dev'] = st.st_dev; op['ino'] = st.st_ino
            state = {'identity':identity, 'operations':operations, 'phase':'uploading', 'cursor':0}
            _push_write_json(state_path, state)
        return {'phase':state['phase'], 'upload_path':str(directory / 'incoming'), 'transfer_id':transfer}


def _batch_matches(path, entry):
    try:
        st = path.lstat()
        return stat.S_ISREG(st.st_mode) and st.st_size == entry['size'] and stat.S_IMODE(st.st_mode) & 0o777 == entry['mode'] and sha(path) == entry['sha256']
    except OSError: return False


def _batch_noreplace(source, target):
    import ctypes
    libc = ctypes.CDLL(None, use_errno=True); rename = getattr(libc, 'renameat2', None)
    if rename is None: error('unsupported_file', 'Atomic no-replace rename unavailable on the VM.')
    if rename(-100, os.fsencode(source), -100, os.fsencode(target), 1): raise OSError(ctypes.get_errno(), 'Atomic no-replace rename failed.')


def _batch_exchange(source, target):
    import ctypes
    libc = ctypes.CDLL(None, use_errno=True); rename = getattr(libc, 'renameat2', None)
    if rename is None: error('unsupported_file', 'Atomic exchange unavailable on the VM.')
    if rename(-100, os.fsencode(source), -100, os.fsencode(target), 2): raise OSError(ctypes.get_errno(), 'Atomic exchange failed.')


def _batch_sync_dir(path):
    fd = os.open(path, os.O_RDONLY)
    try: os.fsync(fd)
    finally: os.close(fd)


def batch_apply(root, workspace_id, request):
    identity = _batch_identity(root, workspace_id, request)
    directory = _batch_directory(identity['transfer_id']); state_path = directory / 'journal.json'
    with _batch_lock(workspace_id):
        state = json.loads(state_path.read_text())
        if state['identity'] != identity: error('checkpoint_mismatch', 'Transfer identity changed.')
        base, proposed = identity['base'], identity['proposed']; ops = state['operations']
        if state['phase'] == 'uploading':
            expected_files = {op['path'] for op in ops if op['action'] in ('add','modify')}
            actual_files = set()
            incoming = directory / 'incoming'
            for current, dirs, files in os.walk(incoming, followlinks=False):
                if any((Path(current) / name).is_symlink() for name in dirs): error('unsupported_file', 'Symlink in staged payload.')
                for name in files:
                    p = Path(current) / name; rel = p.relative_to(incoming).as_posix()
                    if p.is_symlink() or not p.is_file(): error('unsupported_file', 'Invalid staged payload.')
                    actual_files.add(rel)
            if actual_files != expected_files: error('transfer_incomplete', 'Staged payload is missing files or contains unexpected files.')
            for op in ops:
                if op['action'] in ('add', 'modify'):
                    path = incoming / op['path']; entry = op['new']
                    if path.stat().st_size != entry['size'] or sha(path) != entry['sha256']: error('transfer_incomplete', 'Staged file checksum differs.')
                    os.chmod(path, entry['mode'])
                    with path.open('rb') as f: os.fsync(f.fileno())
            meta, entries, exclusions = inspect(root)
            if meta != base['git'] or entries != base['entries']: error('conflict', 'VM workspace changed during transfer.')
            deleted_dirs = [op['path'] for op in ops if op['action'] == 'rmdir']
            if any(path == directory or path.startswith(directory + '/') for path in exclusions for directory in deleted_dirs):
                error('conflict', 'A directory to be deleted contains excluded VM data.')
            _push_assert_idle(root)
            export = Path.home() / '.relay-v0' / 'exports' / identity['transfer_id']; export.mkdir(mode=0o700, exist_ok=True)
            export_meta = {'workspace_id': workspace_id, 'source_path': str(root), 'entries': proposed['entries'], 'git': proposed['git']}
            if (export / 'manifest.json').exists():
                if json.loads((export / 'manifest.json').read_text()) != export_meta: error('checkpoint_mismatch', 'Transfer manifest differs.')
            else: _push_write_json(export / 'manifest.json', export_meta)
            current = checkpoint(root, workspace_id, {'action':'get', 'endpoint':identity['endpoint']})
            if current['checkpoint'] == base and current['pending'] in (None, proposed): checkpoint(root, workspace_id, {'action':'prepare', 'endpoint':identity['endpoint'], 'checkpoint':proposed})
            elif current['checkpoint'] != proposed or current['pending'] is not None: error('checkpoint_mismatch', 'Remote checkpoint differs.')
            state['phase'] = 'publishing'; _push_write_json(state_path, state)
        if state['phase'] == 'publishing':
            _push_assert_idle(root)
            while state['cursor'] < len(ops):
                index = state['cursor']; op = ops[index]; path = op['path']; parts = path.split('/')
                target = root / path; staged = directory / 'incoming' / path; backup = directory / 'backup' / str(index); slot = directory / 'dirslots' / str(index)
                if any((root.joinpath(*parts[:n])).is_symlink() for n in range(1, len(parts)+1)): error('unsupported_file', 'Symlink encountered in destination.')
                action = op['action']; already = False
                if action == 'modify': already = _batch_matches(target, op['new']) and _batch_matches(staged, op['old'])
                elif action == 'add': already = _batch_matches(target, op['new']) and not os.path.lexists(staged)
                elif action == 'delete': already = not os.path.lexists(target) and _batch_matches(backup, op['old'])
                elif action == 'mkdir':
                    already = target.is_dir() and not target.is_symlink() and not slot.exists() and (target.stat().st_dev, target.stat().st_ino) == (op['dev'], op['ino'])
                elif action == 'rmdir': already = not os.path.lexists(target) and backup.is_dir() and not backup.is_symlink() and not any(backup.iterdir())
                expected = {x['path']:x for x in base['entries']}
                for previous in ops[:index + (1 if already else 0)]:
                    if previous['new'] is None: expected.pop(previous['path'], None)
                    else: expected[previous['path']] = previous['new']
                meta, entries, _ = inspect(root)
                if meta != base['git'] or entries != sorted(expected.values(), key=lambda x:x['path']): error('recovery_required', 'Workspace changed or partially published; prior files are retained.')
                if not already:
                    if action == 'modify':
                        if not _batch_matches(target, op['old']) or not _batch_matches(staged, op['new']): error('recovery_required', 'File preconditions changed.')
                        _batch_exchange(staged, target); _batch_sync_dir(staged.parent); _batch_sync_dir(target.parent)
                    elif action == 'add':
                        if os.path.lexists(target) or not _batch_matches(staged, op['new']): error('recovery_required', 'Added file preconditions changed.')
                        _batch_noreplace(staged, target); _batch_sync_dir(staged.parent); _batch_sync_dir(target.parent)
                    elif action == 'delete':
                        if not _batch_matches(target, op['old']) or os.path.lexists(backup): error('recovery_required', 'Deleted file preconditions changed.')
                        _batch_noreplace(target, backup); _batch_sync_dir(backup.parent); _batch_sync_dir(target.parent)
                    elif action == 'mkdir':
                        if os.path.lexists(target) or not slot.is_dir() or (slot.stat().st_dev, slot.stat().st_ino) != (op['dev'], op['ino']): error('recovery_required', 'Directory preconditions changed.')
                        _batch_noreplace(slot, target); _batch_sync_dir(slot.parent); _batch_sync_dir(target.parent)
                    elif action == 'rmdir':
                        if not target.is_dir() or target.is_symlink() or any(target.iterdir()) or os.path.lexists(backup): error('recovery_required', 'Deleted directory is not empty or changed.')
                        _batch_noreplace(target, backup); _batch_sync_dir(backup.parent); _batch_sync_dir(target.parent)
                        if any(backup.iterdir()): error('recovery_required', 'Deleted directory was modified; retained in recovery.')
                state['cursor'] += 1; _push_write_json(state_path, state)
            meta, entries, _ = inspect(root)
            if meta != proposed['git'] or entries != proposed['entries']: error('recovery_required', 'Published workspace does not match the candidate.')
            state['phase'] = 'published'; _push_write_json(state_path, state)
        if state['phase'] in ('published', 'acknowledged'):
            meta, entries, _ = inspect(root)
            if meta != proposed['git'] or entries != proposed['entries']: error('recovery_required', 'Published workspace changed before acknowledgment.')
            for index, op in enumerate(ops):
                if op['action'] == 'modify' and not _batch_matches(directory / 'incoming' / op['path'], op['old']):
                    error('recovery_required', 'Previous file recovery copy is missing or changed.')
                if op['action'] == 'delete' and not _batch_matches(directory / 'backup' / str(index), op['old']):
                    error('recovery_required', 'Deleted file recovery copy is missing or changed.')
                if op['action'] == 'rmdir':
                    saved = directory / 'backup' / str(index)
                    if not saved.is_dir() or saved.is_symlink() or any(saved.iterdir()): error('recovery_required', 'Deleted directory recovery copy changed.')
            current = checkpoint(root, workspace_id, {'action':'commit', 'endpoint':identity['endpoint'], 'transfer_id':identity['transfer_id']})
            if current['checkpoint'] != proposed or current['pending'] is not None: error('recovery_required', 'Remote acknowledgment differs.')
            state['phase'] = 'acknowledged'; _push_write_json(state_path, state)
            return {'status':'SUCCESS', 'transfer_id':identity['transfer_id'], 'recovery_path':str(directory), 'checkpoint':current['checkpoint']}
        error('recovery_required', 'Unknown batch transfer phase.')

def main():
    try:
        workspace_id, action = sys.argv[1:3]
        if action == 'list':
            print(json.dumps({'schema_version': 1, 'workspaces': [{'id': hashlib.sha256(os.fsencode(str(root))).hexdigest()[:16], 'name': root.name} for root in workspace_roots()]}, ensure_ascii=True))
            return
        root = resolve_workspace(workspace_id)
        if action == 'batch_begin':
            result = batch_begin(root, workspace_id, json.load(sys.stdin))
        elif action == 'batch_apply':
            result = batch_apply(root, workspace_id, json.load(sys.stdin))
        elif action == 'export_manifest':
            result = export_manifest(root, workspace_id, json.load(sys.stdin))
        elif action == 'push_one':
            result = push_one(root, workspace_id, json.load(sys.stdin))
        elif action == 'checkpoint':
            result = checkpoint(root, workspace_id, json.load(sys.stdin))
        elif action == 'preview':
            git, entries, exclusions = inspect(root)
            result = {'schema_version': 1, 'workspace_id': workspace_id, 'source_path': str(root), 'name': root.name, 'git': git, 'entries': entries, 'estimated_files': sum(x['type'] == 'file' for x in entries), 'estimated_bytes': sum(x.get('size', 0) for x in entries), 'exclusions': exclusions, 'excluded_entries': len(exclusions), 'blockers': [], 'limitations': ['Live-tree estimates; pause independent writers during capture.', 'Symlinks, nested repositories and Git attributes are not supported.', 'Git-ignored files, secrets, keys and database files are included; stop database writers or provide a consistent backup.']}
        elif action == 'capture':
            manifest, path = capture(root, workspace_id)
            result = {'manifest': manifest, 'export_path': path}
        else: error('invalid_request', 'Unknown operation.')
        print(json.dumps(result, ensure_ascii=True))
    except Exception as exc:
        message = str(exc)
        code, sep, detail = message.partition(': ')
        if not sep: code, detail = 'capture_failed', 'Capture failed; check permissions, disk space and dependencies.'
        print(json.dumps({'error': code, 'message': detail}, ensure_ascii=True))
        sys.exit(1)


if __name__ == '__main__': main()
