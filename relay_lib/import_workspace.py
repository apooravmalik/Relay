#!/usr/bin/env python3
"""Import an exported VM workspace into a new local directory."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import sys
import tempfile
import unicodedata

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from relay_lib.publication import publish_noreplace

HELPER = (Path(__file__).resolve().parent / 'export_workspace.py').read_text()


def fail(args, code, message):
    data = {'schema_version': 1, 'error': code, 'message': message}
    print(json.dumps(data) if args.json else 'relay: ' + code + ': ' + message, file=sys.stdout if args.json else sys.stderr)
    return 1


def ssh_command(vm):
    config = Path.home() / '.lima' / vm / 'ssh.config'
    ssh = ['ssh']
    host = vm
    if config.is_file():
        ssh += ['-F', str(config)]
        for line in config.read_text().splitlines():
            parts = line.split()
            if len(parts) >= 2 and parts[0].lower() == 'host': host = parts[1]; break
    if not host or host.startswith('-'): raise ValueError('Invalid SSH host.')
    return ssh, host


def remote(ssh, host, workspace, action):
    command = 'python3 -c ' + shlex.quote(HELPER) + ' ' + shlex.quote(workspace) + ' ' + action
    result = subprocess.run([*ssh, host, command], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try: data = json.loads(result.stdout)
    except ValueError: raise ValueError('Could not obtain a response over SSH; check connectivity and remote Python and Git.')
    if result.returncode or 'error' in data: raise ValueError(data.get('error', 'remote_error') + ': ' + data.get('message', 'Remote operation failed.'))
    return data


def safe_path(value):
    if not isinstance(value, str) or not value or value.startswith('/') or '\0' in value or any(p in ('', '.', '..') for p in value.split('/')):
        raise ValueError('Invalid path in snapshot manifest.')
    return value


def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b''): h.update(chunk)
    return h.hexdigest()


def verify_payload(root, manifest):
    expected = {}
    for item in manifest['payload']:
        path = safe_path(item['path'])
        if path in expected: raise ValueError('Duplicate payload path.')
        expected[path] = item
    actual = set()
    for current, dirs, files in os.walk(root, followlinks=False):
        for name in dirs:
            if (Path(current) / name).is_symlink(): raise ValueError('Symlink in payload.')
        for name in files:
            p = Path(current) / name
            rel = p.relative_to(root).as_posix()
            if rel == 'manifest.json': continue
            if p.is_symlink() or not p.is_file(): raise ValueError('Unexpected payload type.')
            actual.add(rel)
            if rel not in expected or p.stat().st_size != expected[rel]['size'] or digest(p) != expected[rel]['sha256']:
                raise ValueError('Payload verification failed.')
    if actual != set(expected): raise ValueError('Payload is incomplete.')
    seen = set()
    for entry in manifest['entries']:
        path = safe_path(entry['path'])
        folded = unicodedata.normalize('NFC', path).casefold()
        if folded in seen: raise ValueError('Case or Unicode path collision.')
        seen.add(folded)
        if entry['type'] not in ('file', 'directory'): raise ValueError('Unsupported entry type.')
        if entry['type'] == 'file':
            payload_entry = expected.get('files/' + path)
            if not payload_entry or payload_entry['sha256'] != entry['sha256'] or payload_entry['size'] != entry['size']: raise ValueError('File manifest mismatch.')


def git(repo, *args, input=None, stdin=None):
    env = {k: v for k, v in os.environ.items() if not k.startswith('GIT_')}
    env.update(GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL='/dev/null', GIT_TERMINAL_PROMPT='0')
    result = subprocess.run(['git', '-C', str(repo), *args], input=input, stdin=stdin, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)
    if result.returncode: raise ValueError('Git reconstruction failed: ' + result.stderr.decode('utf-8', 'replace')[:400])
    return result.stdout


def reconstruct(payload, project, manifest):
    project.mkdir(mode=0o700)
    for entry in manifest['entries']:
        dest = project / entry['path']
        if entry['type'] == 'directory': dest.mkdir(parents=True, exist_ok=True)
        else:
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(payload / 'files' / entry['path'], dest, follow_symlinks=False)
            os.chmod(dest, entry['mode'])
    meta = manifest['git']
    if meta['mode'] == 'plain': return
    if meta['mode'] not in ('git_committed', 'git_unborn') or meta['object_format'] not in ('sha1', 'sha256'): raise ValueError('Unsupported Git metadata.')
    git(project, 'init', '-q', '--object-format=' + meta['object_format'])
    if meta['head']:
        git(project, 'fetch', '--quiet', '--no-tags', str(payload / 'history.bundle'), 'refs/relay/export')
        if git(project, 'rev-parse', 'FETCH_HEAD').decode().strip() != meta['head']: raise ValueError('Bundle HEAD mismatch.')
    if meta['branch']:
        git(project, 'symbolic-ref', 'HEAD', meta['branch'])
        if meta['head']: git(project, 'update-ref', meta['branch'], meta['head'])
    elif meta['head']: git(project, 'update-ref', '--no-deref', 'HEAD', meta['head'])
    else: raise ValueError('Missing unborn branch.')
    records = bytearray()
    for entry in meta['index']:
        path = safe_path(entry['path'])
        oid = entry['oid']
        if not oid or any(c not in '0123456789abcdef' for c in oid): raise ValueError('Invalid Git object ID.')
        blob = payload / 'blobs' / oid
        with blob.open('rb') as source:
            written = git(project, 'hash-object', '-w', '--stdin', stdin=source).decode().strip()
        if written != oid: raise ValueError('Git index object mismatch.')
        if entry['mode'] not in ('100644', '100755'): raise ValueError('Unsupported Git index mode.')
        records.extend((entry['mode'] + ' ' + oid + '\t').encode() + os.fsencode(path) + b'\0')
    if records: git(project, 'update-index', '-z', '--index-info', input=bytes(records))
    expected = bytes(records)
    actual = git(project, 'ls-files', '--stage', '-z')
    # ls-files includes an explicit stage number.
    expected_records = [x.split(b'\t', 1) for x in expected.split(b'\0') if x]
    normalized = b''.join(head + b' 0\t' + path + b'\0' for head, path in expected_records)
    if actual != normalized: raise ValueError('Git index verification failed.')



def write_json_atomic(path, data):
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix='.relay-state-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as stream:
            json.dump(data, stream, ensure_ascii=True, sort_keys=True)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary): os.unlink(temporary)


def verify_project(project, manifest):
    expected = {entry['path']: entry for entry in manifest['entries']}
    actual = set()
    for current, dirs, files in os.walk(project, followlinks=False):
        if Path(current) == project and manifest['git']['mode'] != 'plain' and '.git' in dirs:
            if (project / '.git').is_symlink(): raise ValueError('Invalid Git metadata directory.')
            dirs.remove('.git')
        for name in dirs + files:
            path = Path(current) / name
            rel = path.relative_to(project).as_posix()
            if path.is_symlink() or rel not in expected: raise ValueError('Published project verification failed.')
            entry = expected[rel]
            if entry['type'] == 'directory':
                if not path.is_dir(): raise ValueError('Project directory verification failed.')
            elif not path.is_file() or path.stat().st_size != entry['size'] or digest(path) != entry['sha256'] or (path.stat().st_mode & 0o777) != entry['mode']:
                raise ValueError('Project file verification failed.')
            actual.add(rel)
    if actual != set(expected): raise ValueError('Project is incomplete.')
    meta = manifest['git']
    if meta['mode'] != 'plain':
        expected_index = b''.join((entry['mode'] + ' ' + entry['oid'] + ' 0\t').encode() + os.fsencode(entry['path']) + b'\0' for entry in meta['index'])
        if git(project, 'ls-files', '--stage', '-z') != expected_index: raise ValueError('Git index verification failed.')
        if meta['head'] and git(project, 'rev-parse', 'HEAD').decode().strip() != meta['head']: raise ValueError('Git HEAD verification failed.')
        if meta['branch'] and git(project, 'symbolic-ref', 'HEAD').decode().strip() != meta['branch']: raise ValueError('Git branch verification failed.')


def finish_transfer(args, state, state_file):
    manifest = state['manifest']
    transfer = manifest['transfer_id']
    staging = Path(state['staging'])
    destination = Path(state['destination'])
    if not staging.is_dir() or staging.is_symlink() or staging.parent != destination.parent or not staging.name.startswith('.relay-import-'):
        raise ValueError('Transfer staging directory is unavailable or invalid.')
    if os.path.lexists(destination):
        if state.get('phase') != 'publishing' or (staging / 'project').exists() or destination.is_symlink() or not destination.is_dir():
            raise ValueError('Destination already exists; it has not been changed.')
        verify_payload(staging / 'payload', manifest)
        verify_project(destination, manifest)
        return complete_transfer(args, state, state_file)
    ssh, host = ssh_command(args.vm)
    payload = staging / 'payload'
    payload.mkdir(exist_ok=True)
    print('relay: transferring snapshot ' + transfer, file=sys.stderr)
    shell = ' '.join(shlex.quote(x) for x in ssh)
    source = host + ':' + shlex.quote(state['export_path'].rstrip('/') + '/')
    result = subprocess.run(['rsync', '-r', '--checksum', '--partial', '-e', shell, '--', source, str(payload) + '/'])
    if result.returncode: raise ValueError('Transfer interrupted. Resume with --resume ' + transfer + ' --vm ' + args.vm)
    disk_manifest = json.loads((payload / 'manifest.json').read_text())
    if disk_manifest != manifest: raise ValueError('Snapshot manifest changed during transfer.')
    verify_payload(payload, manifest)
    project = staging / 'project'
    if project.exists(): shutil.rmtree(project)
    reconstruct(payload, project, manifest)
    verify_project(project, manifest)
    state['phase'] = 'publishing'
    write_json_atomic(state_file, state)
    publish_noreplace(project, destination)
    return complete_transfer(args, state, state_file)


def complete_transfer(args, state, state_file):
    manifest = state['manifest']
    transfer = manifest['transfer_id']
    staging = Path(state['staging'])
    payload = staging / 'payload'
    destination = Path(state['destination'])
    receipt = {'schema_version': 1, 'transfer_id': transfer, 'workspace_id': manifest['workspace_id'], 'vm': args.vm, 'destination': str(destination), 'head': manifest['git']['head'], 'exclusions': manifest['exclusions'], 'manifest_sha256': digest(payload / 'manifest.json')}
    receipt_file = state_file.parent / (transfer + '.json')
    write_json_atomic(receipt_file, receipt)
    state_file.unlink()
    shutil.rmtree(staging)
    print(json.dumps(receipt, ensure_ascii=True, indent=None if args.json else 2))
    return 0

def main(argv=None):
    parser = argparse.ArgumentParser(prog='relay pull')
    parser.add_argument('--workspace'); parser.add_argument('--into'); parser.add_argument('--name'); parser.add_argument('--resume')
    parser.add_argument('--vm', default='relay-v0'); parser.add_argument('--dry-run', action='store_true'); parser.add_argument('--json', action='store_true'); parser.add_argument('--list', action='store_true')
    args = parser.parse_args(argv)
    if args.list:
        if args.workspace or args.into or args.name or args.resume or args.dry_run: parser.error('--list cannot be combined with import options')
        try:
            ssh, host = ssh_command(args.vm)
            result = remote(ssh, host, '-', 'list')
            print(json.dumps(result, ensure_ascii=True, indent=None if args.json else 2))
            return 0
        except (OSError, ValueError) as exc:
            return fail(args, 'remote_error', str(exc))
    if args.resume:
        if args.workspace or args.into or args.name or args.dry_run: parser.error('--resume cannot be combined with workspace, destination, or dry-run options')
        if len(args.resume) != 32 or any(c not in '0123456789abcdef' for c in args.resume): parser.error('invalid transfer ID')
        state_file = Path.home() / '.relay-v0' / 'imports' / (args.resume + '.pending.json')
        receipt_file = state_file.with_name(args.resume + '.json')
        try:
            if receipt_file.is_file():
                receipt = json.loads(receipt_file.read_text())
                if receipt['vm'] != args.vm: raise ValueError('VM does not match the recorded transfer.')
                print(json.dumps(receipt, ensure_ascii=True, indent=None if args.json else 2)); return 0
            state = json.loads(state_file.read_text())
            if state['vm'] != args.vm or state['manifest']['transfer_id'] != args.resume: raise ValueError('Transfer identity or VM does not match.')
            return finish_transfer(args, state, state_file)
        except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as exc:
            return fail(args, 'resume_failed', str(exc))
    if not args.workspace or not args.into: parser.error('--workspace and --into are required')
    if len(args.workspace) != 16 or any(c not in '0123456789abcdef' for c in args.workspace): parser.error('workspace ID must be 16 lowercase hexadecimal characters')
    parent = Path(args.into).expanduser()
    if not parent.is_dir(): return fail(args, 'invalid_destination', 'Destination parent must be an existing directory.')
    parent = parent.resolve()
    if args.name and (args.name in ('.', '..') or '/' in args.name or '\0' in args.name): parser.error('--name must be one safe filename component')
    try:
        ssh, host = ssh_command(args.vm)
        preview = remote(ssh, host, args.workspace, 'preview')
        name = args.name or preview['name']
        if name in ('', '.', '..') or '/' in name or '\0' in name: raise ValueError('Workspace name is not a safe destination component; provide --name.')
        destination = parent / name
        preview['destination'] = str(destination)
        if os.path.lexists(destination): preview['blockers'].append('destination_exists')
        if args.dry_run:
            print(json.dumps(preview, ensure_ascii=True, indent=None if args.json else 2)); return 0
        if preview['blockers']: return fail(args, 'destination_exists', 'Destination already exists; use --name to choose another.')
        print('relay: pause independent writers while capturing the workspace', file=sys.stderr)
        captured = remote(ssh, host, args.workspace, 'capture')
        manifest = captured['manifest']
        if manifest['workspace_id'] != args.workspace or manifest['source_path'] != preview['source_path']: raise ValueError('Workspace identity changed.')
        staging = Path(tempfile.mkdtemp(prefix='.relay-import-', dir=parent))
        transfer = manifest['transfer_id']
        if len(transfer) != 32 or any(c not in '0123456789abcdef' for c in transfer): raise ValueError('Invalid transfer ID from VM.')
        state_file = Path.home() / '.relay-v0' / 'imports' / (transfer + '.pending.json')
        state = {'vm': args.vm, 'destination': str(destination), 'staging': str(staging), 'export_path': captured['export_path'], 'manifest': manifest, 'phase': 'transferring'}
        write_json_atomic(state_file, state)
        return finish_transfer(args, state, state_file)
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as exc:
        text = str(exc)
        code, sep, detail = text.partition(': ')
        if sep and code in ('workspace_not_found', 'unsupported_git_state', 'excluded_tracked_file', 'unsupported_file', 'source_changed', 'source_busy', 'permission_denied', 'secret_detected', 'scan_limit'):
            return fail(args, code, detail)
        return fail(args, 'import_failed', text)


if __name__ == '__main__': sys.exit(main())
