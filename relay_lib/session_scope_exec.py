"""Join a pre-recorded delegated task cgroup before executing any Codex code."""
import os
from pathlib import Path
import sys


def main():
    directory, inode, *command = sys.argv[1:]
    target = Path(directory)
    if not command or not target.name.startswith('relay-task-') or target.resolve() != target or str(target.stat().st_ino) != inode:
        raise RuntimeError('Task scope identity mismatch.')
    # The controller must persist the scope identity before launching this wrapper.
    (target / 'cgroup.procs').write_text(str(os.getpid()))
    relative = str(target.relative_to('/sys/fs/cgroup'))
    if '0::/' + relative not in Path('/proc/self/cgroup').read_text().splitlines():
        raise RuntimeError('Task scope membership could not be verified.')
    os.execvp(command[0], command)


if __name__ == '__main__':
    main()
