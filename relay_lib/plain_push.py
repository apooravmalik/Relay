#!/usr/bin/env python3
"""Explicit, guarded single-file push for a previously imported plain folder."""
import argparse
import base64
import fcntl
import json
import os
from pathlib import Path
import sys
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from relay_lib import import_workspace as imp, update_workspace as upd
from relay_lib.transfer_plan import build_plan


def main(argv=None):
    if argv is None: argv = sys.argv[1:]
    if not any(arg == '--file' or arg.startswith('--file=') for arg in argv) and '--dry-run' not in argv:
        from relay_lib import batch_push
        return batch_push.main(argv)
    parser = argparse.ArgumentParser(prog='relay push')
    parser.add_argument('--workspace', required=True)
    parser.add_argument('--project', required=True)
    parser.add_argument('--file', help='one existing relative file path (required for execution)')
    parser.add_argument('--vm', default='relay-v0')
    parser.add_argument('--dry-run', action='store_true')
    parser.add_argument('--json', action='store_true')
    parser.add_argument('--resume', action='store_true')
    args = parser.parse_args(argv)
    try:
        dest = Path(args.project).expanduser().absolute()
        if dest.is_symlink() or not dest.is_dir() or dest.resolve() != dest: raise ValueError('Project must be an existing canonical directory.')
        if len(args.workspace) != 16 or any(c not in '0123456789abcdef' for c in args.workspace): raise ValueError('Invalid workspace ID.')
        if not args.file and not args.dry_run: raise ValueError('UNSUPPORTED: multi-file push is preview-only; specify --file for a single-file push.')
        path = imp.safe_path(args.file) if args.file else None
        pairfile = upd.pairing_path(dest)
        pending = pairfile.with_suffix('.push-pending.json')
        with pairfile.with_suffix('.lock').open('a') as lock:
            try: fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError: raise ValueError('BUSY: another transfer holds the pairing lock.')
            if pairfile.with_suffix('.pending.json').exists(): raise ValueError('RECOVERY_REQUIRED: a pull is pending.')
            if args.resume:
                if args.dry_run: raise ValueError('--resume cannot be used with --dry-run.')
                op = json.loads(pending.read_text())
                if op['destination'] != str(dest) or op['vm'] != args.vm or op['base']['workspace_id'] != args.workspace or op['path'] != path: raise ValueError('Pending push identity differs.')
                return finish(op, pending, pairfile, args.json)
            if pending.exists(): raise ValueError('RECOVERY_REQUIRED: resume the pending push first.')
            ssh, host = imp.ssh_command(args.vm)
            if pairfile.exists():
                pair = json.loads(pairfile.read_text())
                if pair['installation_id'] != upd.installation_id(imp.write_json_atomic) or pair['destination'] != str(dest) or pair['workspace_id'] != args.workspace or pair['vm'] != args.vm: raise ValueError('Pairing identity mismatch.')
            else:
                matches = []
                for receipt_path in (Path.home() / '.relay-v0' / 'imports').glob('*.json'):
                    if receipt_path.name.endswith('.pending.json'): continue
                    receipt = json.loads(receipt_path.read_text())
                    if receipt.get('destination') == str(dest) and receipt.get('workspace_id') == args.workspace and receipt.get('vm') == args.vm: matches.append(receipt)
                if len(matches) != 1: raise ValueError('UNPAIRED: exactly one matching import receipt is required.')
                receipt = matches[0]
                original = imp.remote(ssh, host, args.workspace, 'export_manifest', {'transfer_id': receipt['transfer_id']})
                if original['sha256'] != receipt['manifest_sha256']: raise ValueError('Original export does not match the import receipt.')
                manifest = original['manifest']
                # The installation identity is created only for an actual transfer.
                pair = {'schema_version':1, 'installation_id': None if args.dry_run else upd.installation_id(imp.write_json_atomic),
                        'workspace_id':args.workspace, 'vm':args.vm, 'destination':str(dest), 'source_path':manifest['source_path'],
                        'checkpoint_id':manifest['transfer_id'], 'parent_id':None, 'acknowledgment':'pending',
                        'git':manifest['git'], 'entries':manifest['entries'], 'exclusions':manifest['exclusions'], 'policy':'existing-import-inclusion-v1'}
            if pair['git']['mode'] != 'plain': raise ValueError('UNSUPPORTED: only plain folders are supported.')
            git, entries, _ = upd.snapshot(dest)
            remote = imp.remote(ssh, host, args.workspace, 'preview')
            local_changes = upd.changes(pair['entries'], entries)
            cloud_changes = upd.changes(pair['entries'], remote['entries'])
            plan = build_plan(pair['entries'], entries, remote['entries'])
            plan.update({'workspace_id':args.workspace, 'destination':str(dest), 'selected_file':path})
            if args.dry_run:
                print(json.dumps(plan, ensure_ascii=True, indent=None if args.json else 2)); return 0
            if git != pair['git'] or remote['git'] != pair['git'] or remote['source_path'] != pair['source_path'] or cloud_changes: raise ValueError('CONFLICT: VM workspace differs from the common baseline.')
            if local_changes != {path:'modified'}: raise ValueError('UNSUPPORTED or CONFLICT: exactly the selected existing file must be modified locally.')
            old = {x['path']:x for x in pair['entries']}.get(path)
            new = {x['path']:x for x in entries}.get(path)
            if not old or not new or old['type'] != 'file' or new['type'] != 'file' or new['size'] > 10 * 1024 * 1024: raise ValueError('UNSUPPORTED: selected file must be an existing regular file of at most 10 MiB.')
            target = dest / path
            if any(dest.joinpath(*path.split('/')[:n]).is_symlink() for n in range(1, len(path.split('/')) + 1)): raise ValueError('UNSUPPORTED: symlinks are not supported.')
            content = target.read_bytes()
            import hashlib
            if hashlib.sha256(content).hexdigest() != new['sha256']: raise ValueError('BUSY: local file changed during capture.')
            if not pairfile.exists(): imp.write_json_atomic(pairfile, pair)
            base = upd.cp(pair)
            remote_state = upd.remote_cp(imp, args.vm, pair, 'get')
            if remote_state['checkpoint'] is None and remote_state['pending'] is None: remote_state = upd.remote_cp(imp, args.vm, pair, 'init', base)
            if remote_state['checkpoint'] != base or remote_state['pending'] is not None: raise ValueError('RECOVERY_REQUIRED: remote checkpoint differs.')
            transfer = uuid.uuid4().hex
            manifest = {'transfer_id':transfer, 'entries':entries, 'git':git}
            op = {'destination':str(dest), 'vm':args.vm, 'path':path, 'pair':pair, 'base':base,
                  'proposed':upd.cp(pair, manifest), 'content':base64.b64encode(content).decode('ascii')}
            imp.write_json_atomic(pending, op)
            return finish(op, pending, pairfile, args.json)
    except (OSError, ValueError, KeyError, TypeError) as exc:
        return imp.fail(args, 'push_failed', str(exc))


def finish(op, pending, pairfile, as_json):
    pair = op['pair']; proposed = op['proposed']; dest = Path(op['destination'])
    git, entries, _ = upd.snapshot(dest)
    if git != proposed['git'] or entries != proposed['entries']: raise ValueError('RECOVERY_REQUIRED: local workspace changed; pending push remains.')
    ssh, host = imp.ssh_command(op['vm'])
    result = imp.remote(ssh, host, pair['workspace_id'], 'push_one', {'transfer_id':proposed['transfer_id'], 'path':op['path'], 'endpoint':upd.endpoint(pair), 'base':op['base'], 'proposed':proposed, 'content':op['content']})
    if result.get('checkpoint') != proposed: raise ValueError('RECOVERY_REQUIRED: remote acknowledgment differs.')
    git, entries, _ = upd.snapshot(dest)
    if git != proposed['git'] or entries != proposed['entries']: raise ValueError('RECOVERY_REQUIRED: local workspace changed during push; pending push remains.')
    next_pair = dict(pair, acknowledgment='acknowledged', generation=proposed['generation'], parent_id=pair['checkpoint_id'], checkpoint_id=proposed['transfer_id'], entries=proposed['entries'], git=proposed['git'], remote_recovery_path=result['recovery_path'])
    imp.write_json_atomic(pairfile, next_pair)
    pending.unlink()
    print(json.dumps({'status':'SUCCESS', 'transfer_id':proposed['transfer_id'], 'path':op['path'], 'remote_recovery_path':result['recovery_path']}, ensure_ascii=True, indent=None if as_json else 2))
    return 0


if __name__ == '__main__': sys.exit(main())
