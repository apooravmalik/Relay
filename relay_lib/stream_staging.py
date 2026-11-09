"""Build verified private transfer candidates without loading files into RAM."""
import hashlib
import os
from pathlib import Path
import shutil
import stat


class StagingError(ValueError):
    pass


def stage_file(source, destination, entry, chunk_size=1024 * 1024):
    """Copy and hash one regular file, resuming a verified partial prefix.

    The destination must be inside an already-private operation directory.
    Existing final files are never replaced. The caller owns cleanup and the
    operation journal; no checkpoint is advanced here.
    """
    source = Path(source); destination = Path(destination)
    if destination.exists() or destination.is_symlink():
        raise StagingError('A staged final file already exists.')
    if entry.get('type') != 'file' or entry.get('size', -1) < 0 or chunk_size < 1:
        raise StagingError('Invalid file manifest.')
    destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    partial = destination.with_name(destination.name + '.partial')
    if partial.is_symlink(): raise StagingError('Partial file is a symlink.')
    existing = partial.stat().st_size if partial.exists() else 0
    if existing > entry['size']: raise StagingError('Partial file exceeds expected size.')
    required = entry['size'] - existing
    if shutil.disk_usage(destination.parent).free < required + 1024 * 1024:
        raise StagingError('Insufficient disk space for staged file and headroom.')
    source_fd = os.open(source, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0))
    flags = os.O_RDWR | os.O_CREAT | getattr(os, 'O_NOFOLLOW', 0)
    try:
        with os.fdopen(source_fd, 'rb') as src:
            before = os.fstat(src.fileno())
            if not stat.S_ISREG(before.st_mode) or before.st_size != entry['size'] or stat.S_IMODE(before.st_mode) & 0o777 != entry['mode']:
                raise StagingError('Source type or size changed.')
            fd = os.open(partial, flags, 0o600)
            with os.fdopen(fd, 'r+b') as out:
                partial_stat = os.fstat(out.fileno())
                if not stat.S_ISREG(partial_stat.st_mode) or partial_stat.st_nlink != 1: raise StagingError('Partial path is not a private regular file.')
                digest = hashlib.sha256()
                remaining = existing
                while remaining:
                    size = min(chunk_size, remaining)
                    old = out.read(size); block = src.read(size)
                    if len(old) != size or old != block: raise StagingError('Partial file does not match the current source.')
                    digest.update(block); remaining -= size
                while True:
                    block = src.read(chunk_size)
                    if not block: break
                    out.write(block); digest.update(block)
                out.flush(); os.fsync(out.fileno())
                after = os.fstat(src.fileno())
                if (before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns) or digest.hexdigest() != entry['sha256']:
                    raise StagingError('Source changed or failed checksum verification.')
                os.fchmod(out.fileno(), entry['mode'])
                os.fsync(out.fileno())
        # The final name is created without replacing any pre-existing entry.
        os.link(partial, destination, follow_symlinks=False)
        os.unlink(partial)
        d = os.open(destination.parent, os.O_RDONLY)
        try: os.fsync(d)
        finally: os.close(d)
    except BaseException:
        raise
    return {'size': entry['size'], 'sha256': entry['sha256'], 'mode': entry['mode']}
