"""Inventory regular files for a future workspace import.

This module does not perform a transfer or make a live tree into a snapshot.
"""

import hashlib
import os
from pathlib import Path
import stat


def inventory(root):
    """Return file hashes and modes; reject links and special files.

    Callers must provide a quiescent, private snapshot directory. Rejecting
    symlinks is deliberate until safe link restoration is implemented.
    """
    root = Path(root)
    if root.is_symlink() or not root.is_dir():
        raise ValueError("snapshot root must be a real directory")
    entries = []
    for current, dirs, files in os.walk(root, followlinks=False):
        dirs.sort()
        files.sort()
        for name in dirs + files:
            path = Path(current) / name
            info = path.lstat()
            relative = path.relative_to(root).as_posix()
            if stat.S_ISLNK(info.st_mode):
                raise ValueError(f"symlinks are not supported: {relative}")
            if stat.S_ISDIR(info.st_mode):
                entries.append({"path": relative, "type": "directory"})
            elif stat.S_ISREG(info.st_mode):
                digest = hashlib.sha256()
                flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
                with os.fdopen(os.open(path, flags), "rb") as stream:
                    opened = os.fstat(stream.fileno())
                    if not stat.S_ISREG(opened.st_mode) or (opened.st_dev, opened.st_ino) != (info.st_dev, info.st_ino):
                        raise ValueError(f"file changed during inventory: {relative}")
                    for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                        digest.update(chunk)
                    after = os.fstat(stream.fileno())
                    if (opened.st_size, opened.st_mtime_ns, opened.st_ctime_ns) != (after.st_size, after.st_mtime_ns, after.st_ctime_ns):
                        raise ValueError(f"file changed during inventory: {relative}")
                entries.append({"path": relative, "type": "file", "size": info.st_size,
                                "executable": bool(info.st_mode & 0o111), "sha256": digest.hexdigest()})
            else:
                raise ValueError(f"unsupported file type: {relative}")
    return sorted(entries, key=lambda entry: entry["path"])
