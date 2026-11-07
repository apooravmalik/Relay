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


def inspect(root):
    git = run_git(root, 'rev-parse', '--show-toplevel', check=False)
    meta = {'mode': 'plain', 'head': None, 'branch': None}
    tracked = None
    if git.returncode == 0:
        if Path(os.fsdecode(git.stdout.rstrip(b'\n'))).resolve() != root: error('unsupported_git_state', 'Register the Git repository root, not a subdirectory.')
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


def main():
    try:
        workspace_id, action = sys.argv[1:3]
        if action == 'list':
            print(json.dumps({'schema_version': 1, 'workspaces': [{'id': hashlib.sha256(os.fsencode(str(root))).hexdigest()[:16], 'name': root.name} for root in workspace_roots()]}, ensure_ascii=True))
            return
        root = resolve_workspace(workspace_id)
        if action == 'preview':
            git, entries, exclusions = inspect(root)
            result = {'schema_version': 1, 'workspace_id': workspace_id, 'source_path': str(root), 'name': root.name, 'git': git, 'estimated_files': sum(x['type'] == 'file' for x in entries), 'estimated_bytes': sum(x.get('size', 0) for x in entries), 'exclusions': exclusions, 'excluded_entries': len(exclusions), 'blockers': [], 'limitations': ['Live-tree estimates; pause independent writers during capture.', 'Symlinks, nested repositories and Git attributes are not supported.', 'Git-ignored files, secrets, keys and database files are included; stop database writers or provide a consistent backup.']}
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
