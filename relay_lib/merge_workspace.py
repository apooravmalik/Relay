"""Prepare and explicitly approve a three-way Git workspace reconciliation."""

import argparse
import fcntl
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from relay_lib import export_workspace as engine, git_handoff as handoff, import_workspace as imp
from relay_lib import update_workspace as upd

MAX_TEXT = 512 * 1024


def path_values(snapshot, layer):
    items = snapshot['git']['index'] if layer == 'index' else snapshot['entries']
    return {item['path']: item for item in items}


def content(item, layer, store):
    if item is None or item.get('type') == 'directory':
        return None
    key = 'blob-' + item['oid'] if layer == 'index' else 'file-' + item['sha256']
    result = store / key
    if not result.exists():
        try:
            engine.load_content(key, result)
        except ValueError as exc:
            legacy = Path.home() / '.relay-v0' / 'git-content' / key
            if not str(exc).startswith('artifact_missing:') or not legacy.is_file() or legacy.is_symlink():
                raise ValueError('Baseline content is unavailable. Import a fresh pairing if recovery copies cannot be verified.') from exc
            engine.store_content(key, legacy)
            engine.load_content(key, result)
            legacy.unlink()
    if layer != 'index' and engine.sha(result) != item['sha256']:
        raise ValueError('Retained workspace content checksum differs.')
    return result


def text_version(path):
    if path is None or path.stat().st_size > MAX_TEXT:
        return None
    data = path.read_bytes()
    if b'\0' in data:
        return None
    try:
        return data.decode('utf-8')
    except UnicodeDecodeError:
        return None


def whole_file(path, rules):
    return (engine.relayignore_disposition(path, rules) != 'transfer' or
            path.lower().endswith(('.db', '.sqlite', '.sqlite3', '.dump', '.snapshot', '.bak')))


def merge_text(pc, base, vm, candidate):
    if any(text_version(version) is None for version in (pc, base, vm)):
        return False
    with candidate.open('wb') as stream:
        result = subprocess.run(['git', 'merge-file', '-p', '--', str(pc), str(base), str(vm)],
                                stdout=stream, stderr=subprocess.PIPE)
    return result.returncode == 0


def write_version(project, path, layer, base_item, source, store):
    if layer == 'index':
        with source.open('rb') as stream:
            oid = engine.run_git(project, 'hash-object', '--stdin', stdin=stream).stdout.decode().strip()
        target = store / ('blob-' + oid)
        item = {'path': path, 'mode': base_item['mode'], 'oid': oid}
    else:
        digest = engine.sha(source)
        target = store / ('file-' + digest)
        item = {'path': path, 'mode': base_item['mode'], 'sha256': digest,
                'size': source.stat().st_size, 'type': 'file'}
    if not target.exists():
        # The source may be a file still being edited outside the review folder.
        with tempfile.NamedTemporaryFile(dir=store) as temp:
            with source.open('rb') as stream:
                shutil.copyfileobj(stream, temp)
            temp.flush()
            if layer == 'index':
                temp.seek(0)
                valid = engine.run_git(project, 'hash-object', '--stdin', stdin=temp).stdout.decode().strip() == oid
            else:
                valid = engine.sha(Path(temp.name)) == digest
            if not valid:
                raise ValueError('Reviewed file changed while being captured.')
            engine.store_content(target.name, Path(temp.name))
            os.link(temp.name, target)
    return item


def draft(project, directory, base, local, cloud):
    store = engine.content_store()
    rules = engine.read_policy(project)[1]
    conflicts = {}
    output = {'git': dict(base['git']), 'entries': []}
    if any(side['git']['head'] != base['git']['head'] for side in (local, cloud)):
        raise ValueError('HISTORY_DIVERGED: review and merge the commits in Git before creating a new shared pairing.')
    for side in (local, cloud):
        engine.validate_git_transition(base, side)

    indexes = [path_values(s, 'index') for s in (base, local, cloud)]
    worktrees = [path_values(s, 'worktree') for s in (base, local, cloud)]
    review_file = directory / 'merge-output'
    for layer, values in (('index', indexes), ('worktree', worktrees)):
        merged = []
        for path in sorted(set().union(*values)):
            a, b, c = versions = [v.get(path) for v in values]
            # If each side edits a different layer of the same path, require
            # an explicit choice before interpreting the staged/unstaged split.
            index_changed = [indexes[i].get(path) != indexes[0].get(path) for i in (1, 2)]
            tree_changed = [worktrees[i].get(path) != worktrees[0].get(path) for i in (1, 2)]
            ambiguous = (index_changed[0] and tree_changed[1] or index_changed[1] and tree_changed[0])
            needs_choice = ambiguous and ((layer == 'index' and any(index_changed)) or
                                          (layer == 'worktree' and any(tree_changed))) and b != c
            if b == c:
                selected = b
            elif a == b and not needs_choice:
                selected = c
            elif a == c and not needs_choice:
                selected = b
            else:
                safe = not whole_file(path, rules) and not ambiguous
                can_merge = safe and all(item is not None and item.get('mode') for item in versions)
                can_merge = can_merge and len({item['mode'] for item in versions}) == 1
                paths = [content(item, layer, store) for item in versions] if can_merge else []
                can_merge = can_merge and all(text_version(version) is not None for version in paths)
                if can_merge and merge_text(paths[1], paths[0], paths[2], review_file):
                    selected = write_version(project, path, layer, a, review_file, store)
                else:
                    conflicts[layer + ':' + path] = {'path': path, 'layer': layer, 'versions': versions,
                                                      'whole_file': not safe or not can_merge}
                    continue
            if selected is not None:
                merged.append(selected)
        if layer == 'index':
            output['git']['index'] = merged
        else:
            output['entries'] = merged
    # Path conflicts may arise even when individual file choices look clean.
    # Keep them visible in the plan and validate the chosen layout on approval.
    known = set(conflicts)
    work = {item['path']: item for item in output['entries']}
    for relative in list(work):
        parts = relative.split('/')
        for count in range(1, len(parts)):
            parent = '/'.join(parts[:count])
            if work.get(parent, {}).get('type') != 'directory':
                for path in (parent, relative):
                    key = 'worktree:' + path
                    if key not in known:
                        conflicts[key] = {'path': path, 'layer': 'worktree', 'whole_file': True,
                                          'versions': [mapping.get(path) for mapping in worktrees]}
                        known.add(key)
    output['entries'] = [item for item in output['entries'] if 'worktree:' + item['path'] not in conflicts]
    return output, conflicts


def verify_layout(snapshot):
    entries = path_values(snapshot, 'worktree')
    for path in entries:
        parent = path.rpartition('/')[0]
        if parent and entries.get(parent, {}).get('type') != 'directory':
            raise ValueError('Resolved worktree paths collide or lack a parent directory.')
    index = path_values(snapshot, 'index')
    for path in index:
        parts = path.split('/')
        if any('/'.join(parts[:n]) in index for n in range(1, len(parts))):
            raise ValueError('Resolved index paths collide.')


def review_history(project, directory, base, local, cloud):
    repo = directory / 'history-review'
    repo.mkdir(mode=0o700)
    engine.run_git(repo, '-c', 'init.templateDir=', 'init', '-q', '--object-format=' + base['git']['object_format'])
    local_history = directory / 'pc-history'
    local_history.mkdir(mode=0o700)
    if local['git']['head']:
        engine.make_history_bundle(project, local['git'], local_history)
    for label, side, bundle in (('pc', local, local_history / 'history.bundle'),
                                 ('vm', cloud, directory / 'vm-original' / 'history.bundle')):
        head = side['git']['head']
        if not head:
            continue
        refs = engine.run_git(repo, 'bundle', 'unbundle', str(bundle)).stdout.splitlines()
        if refs != [(head + ' refs/relay/export').encode()]:
            raise ValueError('Retained Git history differs from the captured HEAD.')
        engine.run_git(repo, 'update-ref', 'refs/heads/' + label, head)
    return repo


def read_commit_tree(repo, head, policy_root):
    if head is None:
        return []
    rules = engine.read_policy(policy_root)[1]
    index = []
    for entry in engine.run_git(repo, 'ls-tree', '-r', '-z', head).stdout.split(b'\0'):
        if not entry:
            continue
        metadata, path = entry.split(b'\t', 1)
        mode, kind, oid = metadata.decode().split()
        name = os.fsdecode(path)
        if kind != 'blob' or mode not in ('100644', '100755') or engine.excluded_path(name, rules):
            raise ValueError('History review only supports regular files allowed by the transfer rules.')
        if name == '.relayignore':
            with tempfile.TemporaryFile() as stream:
                engine.run_git(repo, 'cat-file', 'blob', oid, output=stream)
                stream.seek(0)
                from hashlib import sha256
                if sha256(stream.read(65537)).hexdigest() != engine.read_policy(policy_root)[0]:
                    raise ValueError('The selected commit changes the shared transfer policy.')
        index.append({'path': name, 'mode': mode, 'oid': oid})
    return sorted(index, key=lambda item: os.fsencode(item['path']))


def history_candidate(project, state, selected):
    repo = Path(state['history_repo'])
    if not selected or not re.fullmatch(r'[0-9a-f]{40}|[0-9a-f]{64}', selected):
        raise ValueError('Open the private history review repository and approve a full reviewed commit ID with --commit.')
    actual = engine.run_git(repo, 'rev-parse', '--verify', selected + '^{commit}').stdout.decode().strip()
    if actual != selected:
        raise ValueError('The selected ID must name a reviewed commit.')
    directory = Path(state['directory'])
    index = read_commit_tree(repo, selected, project)
    store = engine.content_store()
    tracked = {item['path'] for item in index}
    versions = [state[key] for key in ('prior', 'local', 'cloud')]
    trees = [read_commit_tree(repo, snapshot['git']['head'], project) for snapshot in versions]
    for snapshot, tree in zip(versions, trees):
        tracked.update(item['path'] for item in tree)
        if tree != snapshot['git']['index']:
            raise ValueError('History review requires committing or removing staged changes on both endpoints before planning.')
        live = path_values(snapshot, 'worktree')
        for item in tree:
            entry = live.get(item['path'])
            if not entry or entry['type'] != 'file' or bool(entry['mode'] & 0o100) != (item['mode'] == '100755'):
                raise ValueError('History review requires clean tracked working files on both endpoints.')
            with content(entry, 'worktree', store).open('rb') as stream:
                if engine.run_git(repo, 'hash-object', '--stdin', stdin=stream).stdout.decode().strip() != item['oid']:
                    raise ValueError('History review requires clean tracked working files on both endpoints.')
        head = snapshot['git']['head']
        if head and engine.run_git(repo, 'merge-base', '--is-ancestor', head, selected, check=False).returncode:
            raise ValueError('The reviewed commit must descend from both endpoints and their checkpoint.')

    result = {'git': dict(state['prior']['git'], mode='git_committed', head=selected, index=index), 'entries': []}
    # Reconcile untracked data against the common version, including files
    # ignored by Git. Overlap with a newly tracked path requires user review.
    extras = []
    for snapshot, tree in zip(versions, trees):
        own_tree = {item['path'] for item in tree}
        untracked = [item for item in snapshot['entries'] if item['path'] not in own_tree
                     and (item['type'] == 'file' or
                          not any(path.startswith(item['path'] + '/') for path in own_tree))]
        if any(item['path'] in tracked for item in untracked):
            raise ValueError('A tracked history path collides with an independent untracked file.')
        extras.append(path_values({'entries': untracked}, 'worktree'))
    for path in sorted(set().union(*extras)):
        before, pc, vm = [side.get(path) for side in extras]
        if pc != vm and pc != before and vm != before:
            raise ValueError('Reconcile overlapping untracked changes before approving this history plan.')
        entry = vm if pc == before else pc
        if entry:
            result['entries'].append(entry)
    entries = {item['path']: item for item in result['entries']}
    for item in index:
        with tempfile.NamedTemporaryFile(dir=directory) as stream:
            engine.run_git(repo, 'cat-file', 'blob', item['oid'], output=stream)
            stream.flush()
            version = Path(stream.name)
            write_version(repo, item['path'], 'index', item, version, store)
            entry = write_version(repo, item['path'], 'worktree',
                                  {'mode': 0o755 if item['mode'] == '100755' else 0o644}, version, store)
        entries[item['path']] = entry
    for path in sorted(entries):
        parts = path.split('/')
        for n in range(1, len(parts)):
            name = '/'.join(parts[:n])
            entries.setdefault(name, {'path': name, 'type': 'directory'})
    result['entries'] = sorted(entries.values(), key=lambda item: item['path'])
    verify_layout(result)
    engine.make_history_bundle(repo, result['git'], directory, policy_root=project)
    return result


def preview(state, project):
    if state.get('history_repo'):
        return {'status': 'HISTORY_REVIEW_REQUIRED', 'plan_id': state['id'],
                'history_repository': state['history_repo'],
                'pc_head': state['local']['git']['head'], 'vm_head': state['cloud']['git']['head'],
                'checkpoint_id': state['base']['checkpoint_id'],
                'action': 'Review the pc and vm branches. Approve a commit that descends from both with --commit.',
                'workspace': state['base']['workspace_id'], 'project': str(project)}
    return {'status': 'CONFLICT' if state['conflicts'] else 'REVIEW_REQUIRED',
            'plan_id': state['id'], 'checkpoint_id': state['base']['checkpoint_id'],
            'review_directory': str(Path(state['directory'])),
            'changes_from_pc': upd.changes(state['local']['entries'], state['candidate']['entries']),
            'changes_from_vm': upd.changes(state['cloud']['entries'], state['candidate']['entries']),
            'conflicts': [{'key': key, 'whole_file': entry['whole_file'],
                           'actions': ['pc', 'vm'] + ([] if entry['whole_file'] else ['file:/absolute/path', 'proposal'])}
                          for key, entry in sorted(state['conflicts'].items())],
            'workspace': state['base']['workspace_id'], 'project': str(project)}


def create_plan(args, pair, project, folder):
    ssh, host = imp.ssh_command(args.vm)
    handoff.verify_legacy(imp, pair, ssh, host)
    base = upd.cp(pair)
    if upd.remote_cp(imp, args.vm, pair, 'get') != {'checkpoint': base, 'pending': None}:
        raise ValueError('RECOVERY_REQUIRED: remote checkpoint differs.')
    local = handoff.snapshot(project)
    vm = imp.remote(ssh, host, args.workspace, 'git_preview')
    history = any(side['git']['head'] != base['git']['head'] for side in (vm, local))
    captured = imp.remote(ssh, host, args.workspace, 'git_capture', {'include_history': history})
    cloud = captured['manifest']
    if any(cloud[key] != vm[key] for key in ('git', 'entries', 'source_path')):
        raise ValueError('VM changed during planning. Retry with writers paused.')
    if cloud['source_path'] != pair['source_path']:
        raise ValueError('VM workspace identity changed.')
    if len({s['git'].get('policy_digest') for s in (local, cloud, base)}) != 1:
        raise ValueError('POLICY_MISMATCH: match both endpoints to the checkpoint before creating a merge plan.')
    directory = Path(tempfile.mkdtemp(prefix='.relay-merge-', dir=project.parent))
    payload = imp.download_export(ssh, host, captured, directory, 'Merge export download failed.')
    original = directory / 'vm-original'
    os.rename(payload, original)
    payload = original
    if json.loads((payload / 'manifest.json').read_text()) != cloud:
        raise ValueError('Captured VM manifest differs.')
    imp.verify_payload(payload, cloud)
    engine.retain_git_snapshot(project, local)
    engine.retain_git_snapshot(project, cloud, payload)
    engine.check_git_snapshot(project, local)
    if history:
        for side in (local, cloud):
            engine.validate_git_transition(base, side)
        history_repo = str(review_history(project, directory, base, local, cloud))
        result, conflicts = None, {}
    else:
        history_repo = None
        result, conflicts = draft(project, directory, base, local, cloud)
    state = {'id': uuid.uuid4().hex, 'base': pair, 'prior': base, 'local': local, 'cloud': cloud,
             'candidate': result, 'conflicts': conflicts, 'directory': str(directory), 'phase': 'review',
             'history_repo': history_repo}
    imp.write_json_atomic(folder / (state['id'] + '.json'), state)
    return handoff.print_result(preview(state, project), args.json)


def resolve(args, state, project):
    choices = {}
    for item in args.resolve:
        key, sep, choice = item.partition('=')
        if not sep or key in choices:
            raise ValueError('Use one --resolve LAYER:PATH=pc|vm|file:/absolute/path per conflict.')
        choices[key] = choice
    if choices.keys() != state['conflicts'].keys():
        raise ValueError('Resolve every reported conflict before approving publication.')
    result = state['candidate']
    for key, entry in state['conflicts'].items():
        choice = choices[key]
        old, pc, vm = entry['versions']
        layer = entry['layer']
        if choice in ('pc', 'vm'):
            selected = pc if choice == 'pc' else vm
        elif not entry['whole_file'] and (choice.startswith('file:') or choice == 'proposal'):
            reviewed = Path(choice[5:]) if choice != 'proposal' else proposal_path(state, key)
            if not reviewed.is_absolute() or not reviewed.is_file():
                raise ValueError('Provide a readable absolute path to the reviewed result.')
            selected = write_version(project, entry['path'], layer, pc or vm or old, reviewed, engine.content_store())
        else:
            raise ValueError('This conflict requires choosing an entire PC or VM version.')
        if selected is not None:
            target = result['git']['index'] if layer == 'index' else result['entries']
            target.append(selected)
    result['entries'].sort(key=lambda item: item['path'])
    result['git']['index'].sort(key=lambda item: os.fsencode(item['path']))
    verify_layout(result)
    return result


def proposal_path(state, key):
    from hashlib import sha256
    return Path(state['directory']) / ('proposal-' + sha256(key.encode()).hexdigest())


def assist(args, state, project):
    entry = state['conflicts'].get(args.select)
    if not entry or entry['whole_file']:
        raise ValueError('Select an eligible text conflict for assistance.')
    for layer in ('index', 'worktree'):
        base, pc, vm = [path_values(value, layer) for value in (state['prior'], state['local'], state['cloud'])]
        if base.keys() != pc.keys() or base.keys() != vm.keys():
            raise ValueError('Assistance is unavailable when added or removed paths could be renames.')
    rules = engine.read_policy(project)[1]
    if whole_file(entry['path'], rules):
        raise ValueError('Transfer rules now prohibit assistance for this conflict.')
    ssh, host = imp.ssh_command(args.vm)
    expected = state['prior']['git'].get('policy_digest')
    if (engine.read_policy(project)[0] != expected or
            imp.remote(ssh, host, args.workspace, 'policy')['digest'] != expected):
        raise ValueError('Transfer rules changed after planning. Create a new merge plan.')
    versions = [content(item, entry['layer'], engine.content_store()) for item in entry['versions']]
    values = [text_version(version) for version in versions]
    if any(value is None for value in values):
        raise ValueError('Assistance requires three bounded UTF-8 text versions.')
    meta = {'path': entry['path'], 'layer': entry['layer'], 'versions': ['base', 'pc', 'vm']}
    if not args.provider:
        return handoff.print_result(dict(meta, status='REQUEST_REVIEW'), args.json)
    if not args.approve_request:
        raise ValueError('Review the request preview, then pass --approve-request to send the selected versions.')
    provider = Path(args.provider)
    if not provider.is_absolute() or not provider.is_file():
        raise ValueError('Provider must be the absolute path to a local executable.')
    payload = {'path': meta['path'], 'layer': meta['layer'],
               'versions': dict(zip(meta['versions'], values))}
    result = subprocess.run([str(provider)], input=json.dumps(payload).encode(), stdout=subprocess.PIPE,
                            stderr=subprocess.DEVNULL, timeout=120)
    if result.returncode or len(result.stdout) > MAX_TEXT or b'\0' in result.stdout:
        raise ValueError('Conflict provider failed or returned an invalid proposal.')
    result.stdout.decode('utf-8')
    output = proposal_path(state, args.select)
    output.write_bytes(result.stdout)
    return handoff.print_result(dict(meta, status='PROPOSAL_READY', proposal=str(output)), args.json)


def stage_result(directory, source, proposed):
    operations = engine.validate_git_transition(source, proposed)
    incoming = directory / 'incoming'
    incoming.mkdir(mode=0o700, parents=True, exist_ok=True)
    store = engine.content_store()
    for op in operations:
        if op['action'] in ('add', 'modify'):
            path = incoming / op['path']
            path.parent.mkdir(parents=True, exist_ok=True)
            if not path.exists():
                shutil.copyfile(content(op['new'], 'worktree', store), path)
    blobs = directory / 'blobs'
    blobs.mkdir(mode=0o700, exist_ok=True)
    existing = {item['oid'] for item in source['git']['index']}
    for item in proposed['git']['index']:
        path = blobs / item['oid']
        if item['oid'] not in existing and not path.exists():
            shutil.copyfile(content(item, 'index', store), path)


def publish(args, state, statefile, pending, project, pairfile):
    base = state['prior']
    pair = state['base']
    ssh, host = imp.ssh_command(args.vm)
    if state['phase'] == 'review':
        if args.commit and not state.get('history_repo'):
            raise ValueError('--commit requires an approved history review plan.')
        result = history_candidate(project, state, args.commit) if state.get('history_repo') else resolve(args, state, project)
        proposed = upd.cp(pair, dict(result, transfer_id=state['id'], checkpoint_schema=2))
        engine.check_git_snapshot(project, state['local'])
        vm = imp.remote(ssh, host, args.workspace, 'git_preview')
        if any(state['cloud'][key] != vm[key] for key in ('git', 'entries', 'source_path')):
            raise ValueError('VM changed during review. The proposal was retained. Create a new merge plan.')
        for side in (state['local'], vm):
            engine.check_deletions(engine.validate_git_transition(side, proposed), side['exclusions'])
        state['phase'], state['proposed'] = 'publishing', proposed
        imp.write_json_atomic(statefile, state)
    proposed = state['proposed']
    if proposed['transfer_id'] != state['id']:
        raise ValueError('Merge publication identity differs.')
    if not pending.exists():
        imp.write_json_atomic(pending, {'plan_id': state['id']})
    request = {'base': base, 'proposed': proposed, 'receiving': state['cloud']}
    directory = Path(state['directory'])
    local, upload = directory / 'pc-publication', directory / 'vm-payload'

    def remote(action):
        return imp.remote(ssh, host, args.workspace, action, request)

    if not (local / 'journal.json').exists():
        engine.check_git_snapshot(project, state['local'])
        stage_result(local, state['local'], proposed)
        if state.get('history_repo') and not (local / 'history.bundle').exists():
            os.link(directory / 'history.bundle', local / 'history.bundle')
    status = remote('git_begin')
    if status['upload']:
        stage_result(upload, state['cloud'], proposed)
        if state.get('history_repo') and not (upload / 'history.bundle').exists():
            os.link(directory / 'history.bundle', upload / 'history.bundle')
        handoff.rsync(ssh, str(upload) + '/', host + ':' + shlex.quote(status['directory'] + '/'))
    remote('git_apply')
    artifact_id = engine.publish_git(project, local, state['local'], proposed,
                                     recovery=engine.pc_recovery(project, proposed['transfer_id']))
    engine.retain_git_snapshot(project, proposed)
    ack = remote('git_ack_push')
    if ack['checkpoint'] != proposed:
        raise ValueError('Merge checkpoint acknowledgment differs.')
    retained = {'recovery_path': str(directory)}
    if artifact_id:
        journal = local / 'journal.json'
        publication = json.loads(journal.read_text())
        publication['phase'] = 'acknowledged'
        imp.write_json_atomic(journal, publication)
        retained = engine.finish_recovery(artifact_id, None, local / 'previous')
    retained.update({('remote_' + key): ack[key] for key in ('recovery_path', 'recovery_artifact') if key in ack})
    result = handoff.complete({'base': pair, 'prior': base, 'proposed': proposed, 'direction': 'merge',
                               'destination': str(project), 'vm': args.vm, 'pairing': str(pairfile)},
                              pending, imp, retained, args.json)
    state['phase'] = 'acknowledged'
    imp.write_json_atomic(statefile, state)
    if artifact_id:
        shutil.rmtree(directory, ignore_errors=True)
    return result


def main():
    parser = argparse.ArgumentParser(prog='relay merge')
    parser.add_argument('--workspace', required=True)
    parser.add_argument('--project', required=True)
    parser.add_argument('--vm', default='relay-v0')
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--approve')
    mode.add_argument('--assist')
    mode.add_argument('--resume')
    parser.add_argument('--commit')
    parser.add_argument('--resolve', action='append', default=[])
    parser.add_argument('--select')
    parser.add_argument('--provider')
    parser.add_argument('--approve-request', action='store_true')
    parser.add_argument('--json', action='store_true')
    args = parser.parse_args()
    if args.commit and not args.approve:
        parser.error('--commit requires --approve PLAN_ID')
    try:
        project = Path(args.project).expanduser().resolve(strict=True)
        pairfile = upd.pairing_path(project)
        with pairfile.with_suffix('.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            pair = json.loads(pairfile.read_text())
            if (pair['workspace_id'] != args.workspace or pair['vm'] != args.vm or
                    pair['destination'] != str(project) or
                    pair['installation_id'] != upd.installation_id(imp.write_json_atomic)):
                raise ValueError('Pairing identity differs.')
            if any(pairfile.with_suffix(suffix).exists() for suffix in ('.pending.json', '.push-pending.json')):
                raise ValueError('Resume the pending transfer before reviewing a merge.')
            folder = pairfile.with_suffix('.merges')
            folder.mkdir(mode=0o700, exist_ok=True)
            pending = pairfile.with_suffix('.merge-pending.json')
            selected = args.approve or args.assist or args.resume
            if pending.exists() and json.loads(pending.read_text())['plan_id'] != selected:
                raise ValueError('Resume the pending merge by plan ID first.')
            if not selected:
                return create_plan(args, pair, project, folder)
            if not re.fullmatch(r'[0-9a-f]{32}', selected):
                raise ValueError('Invalid merge plan ID.')
            statefile = folder / (selected + '.json')
            state = json.loads(statefile.read_text())
            if state['base']['checkpoint_id'] != pair['checkpoint_id']:
                receipt = pairfile.with_suffix('.merge-last.json')
                if not args.resume or pair['checkpoint_id'] != selected:
                    raise ValueError('Shared checkpoint changed after review.')
                if not pending.exists() and receipt.exists():
                    return handoff.print_result(json.loads(receipt.read_text()), args.json)
                if state['phase'] != 'publishing':
                    raise ValueError('Pending merge publication state differs.')
            if args.assist:
                return assist(args, state, project)
            if args.resume and state['phase'] == 'review':
                raise ValueError('Approve the merge plan before resuming.')
            return publish(args, state, statefile, pending, project, pairfile)
    except (OSError, RuntimeError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as exc:
        return imp.fail(args, 'merge_failed', str(exc))


if __name__ == '__main__':
    sys.exit(main())
