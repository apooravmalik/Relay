"""Build a content-free, destination-specific three-way handoff preview."""
from pathlib import PurePosixPath


def _inventory(entries):
    out = {}
    for item in entries:
        path = item['path']
        if not isinstance(path, str) or not path or path.startswith('/') or '\x00' in path or any(part in ('', '.', '..') for part in path.split('/')):
            raise ValueError('Invalid manifest path.')
        if path in out or item['type'] not in ('file', 'directory'):
            raise ValueError('Duplicate or unsupported manifest entry.')
        out[path] = item
    return out


def _changes(base, current):
    return {path: ('added' if path not in base else 'deleted' if path not in current else 'modified')
            for path in sorted(base.keys() | current.keys()) if base.get(path) != current.get(path)}


def _category(path):
    name = PurePosixPath(path).name.lower()
    if name == '.env' or name.startswith('.env.') or name.endswith(('.pem', '.key', '.p12', '.pfx')):
        return 'sensitive-runtime'
    if name.endswith(('.sqlite', '.sqlite3', '.db', '.dump', '.bak', '.snapshot')):
        return 'application-data'
    return 'project-file'


def build_plan(base_entries, local_entries, remote_entries):
    base, local, remote = map(_inventory, (base_entries, local_entries, remote_entries))
    local_changes = _changes(base, local)
    remote_changes = _changes(base, remote)
    conflicts = set(local_changes) & set(remote_changes)
    # Parent/child conflicts matter for directory deletes and type changes.
    for own, other in ((local_changes, remote_changes), (remote_changes, local_changes)):
        for path in own:
            parts = path.split('/')
            for index in range(1, len(parts)):
                parent = '/'.join(parts[:index])
                if parent in other: conflicts.update((parent, path))
    conflicts = sorted(conflicts)
    files = []
    for path, action in local_changes.items():
        entry = local.get(path) or base[path]
        files.append({'path': path, 'action': action, 'type': entry['type'],
                      'size': entry.get('size', 0), 'category': _category(path)})
    return {'local_changes': local_changes, 'cloud_changes': remote_changes, 'conflicts': conflicts,
            'files': files, 'estimated_bytes': sum(f['size'] for f in files if f['type'] == 'file' and f['action'] != 'deleted'),
            'status': 'CONFLICT' if conflicts else 'BOTH_CHANGED' if local_changes and remote_changes else 'LOCAL_AHEAD' if local_changes else 'CLOUD_AHEAD' if remote_changes else 'IN_SYNC'}
