"""Atomic publication of a verified directory without replacing a destination.

The caller is responsible for verifying and journaling the staged directory
before publication and for reconciling a crash after the rename.
"""
import ctypes
import errno
import os
import sys


def publish_noreplace(source, destination):
    """Rename a directory atomically, failing if destination already exists.

    The kernel performs the existence check and rename as one operation. This
    intentionally has no check-then-rename fallback on unsupported systems.
    """
    source = os.fsencode(source)
    destination = os.fsencode(destination)
    libc = ctypes.CDLL(None, use_errno=True)
    if sys.platform.startswith('linux'):
        try:
            rename = libc.renameat2
        except AttributeError as exc:
            raise OSError(errno.ENOTSUP, 'atomic no-replace rename is unavailable') from exc
        rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
        rename.restype = ctypes.c_int
        result = rename(-100, source, -100, destination, 1)  # AT_FDCWD, RENAME_NOREPLACE
    elif sys.platform == 'darwin':
        try:
            rename = libc.renamex_np
        except AttributeError as exc:
            raise OSError(errno.ENOTSUP, 'atomic no-replace rename is unavailable') from exc
        rename.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint]
        rename.restype = ctypes.c_int
        result = rename(source, destination, 0x00000004)  # RENAME_EXCL
    else:
        raise OSError(errno.ENOTSUP, 'atomic no-replace rename is unavailable on this platform')
    if result:
        code = ctypes.get_errno()
        raise OSError(code, os.strerror(code), os.fsdecode(destination))
