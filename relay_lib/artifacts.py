"""Private, authenticated transfer archives and their retention policy."""
from contextlib import contextmanager
import errno
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import tarfile
import tempfile
import time

ARTIFACT_ID = re.compile(r'(?:export|vm|pc|content)-[0-9a-f]{32,64}')
RECIPIENT = re.compile(r'age1[0-9a-z]{58}')


class ArtifactError(RuntimeError, ValueError):
    pass


def fail(code, message):
    raise ArtifactError(f'{code}: {message}')


def _number(name, default, *, allow_zero=False):
    value = os.environ.get(name, str(default))
    if not value.isdecimal() or int(value) < (0 if allow_zero else 1):
        fail('invalid_artifact_policy', f'{name} must be a valid storage policy integer.')
    return int(value)


def _sync(directory):
    fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def _private_dir(directory):
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = directory.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid():
        fail('artifact_storage', 'Artifact storage must be an owned directory.')
    os.chmod(directory, 0o700)


def _private_file(path):
    try:
        info = path.lstat()
    except FileNotFoundError:
        fail('artifact_missing', 'The requested artifact is unavailable.')
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077:
        fail('artifact_storage', 'Artifact files and identities must be private regular files.')
    return info


def _json(path, record):
    fd, temp = tempfile.mkstemp(dir=path.parent, prefix='.record-')
    try:
        with os.fdopen(fd, 'w') as stream:
            json.dump(record, stream, sort_keys=True)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp, path)
        _sync(path.parent)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)


def _tool(name):
    path = shutil.which(name)
    if not path:
        fail('artifact_encryption_unavailable', 'Install age and age-keygen to use Relay artifact storage.')
    return path


def validate_recipient(value):
    if not isinstance(value, str) or not RECIPIENT.fullmatch(value):
        fail('invalid_request', 'A native age public recipient is required.')
    return value


def _archive_id(value):
    if not isinstance(value, str) or not ARTIFACT_ID.fullmatch(value):
        fail('invalid_request', 'Invalid artifact identity.')
    return value


def _archive_members(source):
    yield source, 'payload'
    if source.is_dir() and not source.is_symlink():
        for current, dirs, files in os.walk(source, followlinks=False, onerror=_raise):
            for name in sorted(dirs + files):
                item = Path(current) / name
                yield item, 'payload/' + item.relative_to(source).as_posix()


def _raise(exc):
    raise exc


def _archive_size(source):
    # PAX includes long paths, link targets, and per-member metadata.
    total = 10240
    for item, arcname in _archive_members(source):
        info = item.lstat()
        if not (stat.S_ISREG(info.st_mode) or stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode)):
            fail('unsupported_file', 'Special files cannot be retained in a recovery archive.')
        length = info.st_size if stat.S_ISREG(info.st_mode) else 0
        names = len(os.fsencode(arcname))
        if stat.S_ISLNK(info.st_mode):
            names += len(os.fsencode(os.readlink(item)))
        total += 2048 + ((names + 511) // 512) * 512 + ((length + 511) // 512) * 512
    # age framing, final authentication tag, and recipient headers.
    return total + (total // 65536 + 1) * 32 + 4096


class ArtifactStore:
    def __init__(self, base=None, *, now=None):
        self.base = Path(base) if base else Path.home() / '.relay-v0'
        self.root = self.base / 'artifacts'
        self.now = now or time.time
        self.ttl = _number('RELAY_ARTIFACT_TTL_SECONDS', 14 * 86400)
        self.limit = _number('RELAY_ARTIFACT_LIMIT_BYTES', 8 * 1024**3)
        self.free_floor = _number('RELAY_ARTIFACT_FREE_BYTES', 16 * 1024**2, allow_zero=True)

    @contextmanager
    def locked(self, *, shared=False):
        _private_dir(self.base)
        _private_dir(self.root)
        descriptor = os.open(self.root / '.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        with os.fdopen(descriptor, 'rb') as lock:
            fcntl.flock(lock, fcntl.LOCK_SH if shared else fcntl.LOCK_EX)
            yield

    def _identity(self):
        override = os.environ.get('RELAY_ARTIFACT_IDENTITY')
        path = Path(override) if override else self.base / 'artifact-identity.agekey'
        if not path.is_absolute():
            fail('artifact_encryption_unavailable', 'The age identity path must be absolute.')
        if not os.path.lexists(path):
            if override or any(self.root.glob('*.age')):
                fail('artifact_encryption_unavailable', 'Restore the original age identity before accessing artifacts.')
            with tempfile.NamedTemporaryFile(mode='w+b', dir=self.base) as key:
                result = subprocess.run([_tool('age-keygen')], stdout=key, stderr=subprocess.DEVNULL)
                if result.returncode:
                    fail('artifact_encryption_unavailable', 'Could not initialize the artifact identity.')
                key.flush()
                os.fsync(key.fileno())
                try:
                    os.link(key.name, path, follow_symlinks=False)
                except FileExistsError:
                    pass
                _sync(path.parent)
        _private_file(path)
        return path

    def _recipient(self):
        result = subprocess.run([_tool('age-keygen'), '-y', str(self._identity())],
                                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
        if result.returncode:
            fail('artifact_encryption_unavailable', 'Could not read the artifact identity.')
        return validate_recipient(result.stdout.strip())

    def recipient(self):
        with self.locked():
            return self._recipient()

    def _find(self, artifact_id):
        record = self.root / (_archive_id(artifact_id) + '.json')
        if not os.path.lexists(record):
            return None
        _private_file(record)
        result = json.loads(record.read_text())
        if not isinstance(result, dict) or result.get('id') != artifact_id:
            fail('artifact_storage', 'Artifact metadata is inconsistent.')
        return result

    def _records(self):
        return [self._find(path.stem) for path in sorted(self.root.glob('*.json'))
                if ARTIFACT_ID.fullmatch(path.stem)]

    def _archive(self, artifact_id):
        return self.root / (_archive_id(artifact_id) + '.age')

    def _usage(self):
        # Also count orphaned ciphertext left behind by a hard interruption.
        return sum(_private_file(path).st_size for path in self.root.glob('*.age'))

    def _pinned(self, records):
        latest = {}
        pinned = set()
        for item in records:
            if item['state'] == 'pending':
                pinned.add(item['id'])
            if item['state'] == 'ready' and item.get('group'):
                key = item['group']
                order = (item.get('completed_ns', 0), item['id'])
                if key not in latest or order > latest[key]:
                    latest[key] = order
        if any(item['id'].startswith('content-') for item in records):
            def retain(snapshot):
                if not isinstance(snapshot, dict):
                    return
                keys = ['file-' + item['sha256'] for item in snapshot.get('entries', []) if item['type'] == 'file']
                keys += ['blob-' + item['oid'] for item in snapshot.get('git', {}).get('index', [])]
                pinned.update('content-' + hashlib.sha256(key.encode('ascii')).hexdigest() for key in keys)

            pairings = self.base / 'pairings'
            for path in pairings.glob('*.json'):
                if re.fullmatch(r'[0-9a-f]{64}', path.stem):
                    retain(json.loads(path.read_text()))
            for path in pairings.glob('*.merges/*.json'):
                plan = json.loads(path.read_text())
                if plan.get('phase') in ('review', 'publishing'):
                    for key in ('prior', 'local', 'cloud', 'candidate', 'proposed'):
                        retain(plan.get(key))
        return pinned | {item[1] for item in latest.values()}

    def _cleanup(self, workspace=None):
        records = self._records()
        keep = self._pinned(records)
        expired = []
        for record in records:
            if (workspace is not None and record['workspace'] != workspace or
                    record['id'] in keep or self.now() - record['created'] < self.ttl):
                continue
            archive = self._archive(record['id'])
            if os.path.lexists(archive):
                _private_file(archive)
                archive.unlink()
            (self.root / (record['id'] + '.json')).unlink()
            expired.append(record['id'])
        # An interrupted archive install may leave unreferenced ciphertext.
        known = {record['id'] for record in records}
        for path in self.root.glob('*.age') if workspace is None else ():
            if path.stem not in known and self.now() - _private_file(path).st_mtime >= self.ttl:
                path.unlink()
        if expired:
            _sync(self.root)
        return expired

    def cleanup(self, workspace=None):
        with self.locked():
            removed = self._cleanup(workspace)
            return {'removed': removed, 'used_bytes': self._usage(), 'limit_bytes': self.limit}

    def _check_space(self, size):
        if self._usage() + size > self.limit:
            fail('artifact_quota', 'Retention quota is full. Recover pending transfers or increase the artifact quota.')
        if shutil.disk_usage(self.root).free < size + self.free_floor:
            fail('insufficient_space', 'Insufficient disk space for a verified recovery archive.')

    def admit(self, size):
        with self.locked():
            self._cleanup()
            self._check_space(size)

    def seal(self, artifact_id, source, *, workspace=None, group=None, recipient=None, pending=False, witness=None):
        archive = self._archive(artifact_id)
        source = Path(source)
        with self.locked():
            self._cleanup()
            existing = self._find(artifact_id)
            if existing is not None:
                _private_file(archive)
                if (existing['workspace'], existing['group'], existing.get('witness')) != (workspace, group, witness):
                    fail('artifact_storage', 'The retained artifact no longer matches this transfer.')
                return archive
            if os.path.lexists(archive):
                _private_file(archive)
                archive.unlink()
            size = _archive_size(source)
            self._check_space(size)
            self._encrypt_tree(source, archive, recipient, size)
            _json(archive.with_suffix('.json'), {
                'id': artifact_id, 'workspace': workspace, 'group': group,
                'created': int(self.now()), 'state': 'pending' if pending else 'ready',
                'witness': witness,
            })
            return archive

    def _encrypt_tree(self, source, archive, recipient, estimate):
        recipients = ['-r', self._recipient()]
        if recipient:
            recipients += ['-r', validate_recipient(recipient)]
        try:
            with tempfile.NamedTemporaryFile(dir=self.root) as out:
                with subprocess.Popen([_tool('age'), '--encrypt', *recipients], stdin=subprocess.PIPE,
                                      stdout=out, stderr=subprocess.DEVNULL) as cipher:
                    try:
                        with tarfile.open(fileobj=cipher.stdin, mode='w|', format=tarfile.PAX_FORMAT) as bundle:
                            bundle.add(source, arcname='payload')
                    finally:
                        cipher.stdin.close()
                    if cipher.wait():
                        fail('artifact_storage', 'Could not encrypt the archive. Check available disk space.')
                actual = os.fstat(out.fileno()).st_size
                if actual > estimate:
                    self._check_space(actual)
                os.fsync(out.fileno())
                os.link(out.name, archive, follow_symlinks=False)
                _sync(self.root)
        except OSError as exc:
            if exc.errno in (errno.ENOSPC, errno.EDQUOT, errno.EPIPE):
                fail('insufficient_space', 'Could not write the encrypted recovery archive.')
            raise

    def mark(self, artifact_id, *, pending):
        with self.locked():
            record = self._find(artifact_id)
            if record is None:
                return
            if pending:
                self._get(artifact_id, record['workspace'])
            if pending and record['state'] == 'ready':
                record['state'] = 'pending'
            elif not pending and (record['state'] == 'pending' or 'completed_ns' not in record):
                record.update(state='ready', completed_ns=time.time_ns())
            else:
                return
            _json(self.root / (artifact_id + '.json'), record)

    def _get(self, artifact_id, workspace):
        record = self._find(artifact_id)
        if not record or record['workspace'] != workspace:
            fail('artifact_missing', 'The requested artifact is unavailable or expired.')
        if self.now() - record['created'] >= self.ttl and artifact_id not in self._pinned(self._records()):
            fail('artifact_expired', 'This transfer artifact expired. Start a fresh capture if needed.')
        archive = self._archive(artifact_id)
        _private_file(archive)
        return archive, record

    def get(self, artifact_id, workspace=None):
        with self.locked(shared=True):
            return self._get(artifact_id, workspace)[0]

    def list(self, workspace=None):
        with self.locked(shared=True):
            records = self._records()
            pinned = self._pinned(records)
            return [{key: item[key] for key in ('id', 'state', 'created')} | {'pinned': item['id'] in pinned}
                    for item in records if item['workspace'] == workspace and
                    (item['id'] in pinned or self.now() - item['created'] < self.ttl)]

    def stream(self, artifact_id, workspace, output):
        with self.locked(shared=True):
            archive, _ = self._get(artifact_id, workspace)
            result = subprocess.run([_tool('age'), '--decrypt', '-i', str(self._identity()), str(archive)],
                                    stdout=output, stderr=subprocess.DEVNULL)
            if result.returncode:
                fail('artifact_corrupt', 'The encrypted artifact could not be authenticated.')


def _archive_path(name):
    parts = name.split('/')
    if parts[0] != 'payload' or any(part in ('', '.', '..') or '\x00' in part for part in parts):
        fail('artifact_corrupt', 'Archive contains an invalid path.')
    return parts


def unpack(stream, scratch):
    """Extract one authenticated tar into a fresh private staging directory."""
    seen, directories = set(), []
    with tarfile.open(fileobj=stream, mode='r|') as bundle:
        for item in bundle:
            parts = _archive_path(item.name)
            path = scratch.joinpath(*parts)
            if item.name in seen or any(not scratch.joinpath(*parts[:n]).is_dir() or
                                        scratch.joinpath(*parts[:n]).is_symlink() for n in range(1, len(parts))):
                fail('artifact_corrupt', 'Archive paths overlap or follow a link.')
            seen.add(item.name)
            if item.isdir():
                path.mkdir(mode=0o700)
                directories.append((path, item.mode & 0o777))
            elif item.isfile():
                with bundle.extractfile(item) as source, path.open('xb') as target:
                    shutil.copyfileobj(source, target)
                path.chmod(item.mode & 0o777)
            elif item.islnk():
                target = scratch.joinpath(*_archive_path(item.linkname))
                if item.linkname not in seen or target.is_symlink() or not target.is_file():
                    fail('artifact_corrupt', 'Archive hard link points to an unknown file.')
                os.link(target, path)
            elif item.issym():
                path.symlink_to(item.linkname)
            else:
                fail('artifact_corrupt', 'Archive contains an unsupported file type.')
    # tar may stop before age has authenticated its final chunk.
    while stream.read(65536):
        pass
    for path, mode in reversed(directories):
        path.chmod(mode)
    if 'payload' not in seen:
        fail('artifact_corrupt', 'Archive has no payload.')
    return scratch / 'payload'


def decrypt_archive(archive, store, scratch):
    with store.locked(shared=True), subprocess.Popen(
            [_tool('age'), '--decrypt', '-i', str(store._identity()), str(archive)],
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL) as cipher:
        try:
            payload = unpack(cipher.stdout, scratch)
        finally:
            cipher.stdout.close()
        if cipher.wait():
            fail('artifact_corrupt', 'The encrypted artifact could not be authenticated.')
        return payload
