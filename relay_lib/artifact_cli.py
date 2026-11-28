"""Inspect, expire, or restore a local or registered VM recovery archive."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from relay_lib import artifacts, import_workspace
from relay_lib.publication import publish_noreplace


def main():
    parser = argparse.ArgumentParser(prog='relay artifacts')
    parser.add_argument('action', choices=('list', 'cleanup', 'restore'))
    parser.add_argument('--vm')
    parser.add_argument('--workspace')
    parser.add_argument('--artifact')
    parser.add_argument('--into', type=Path)
    args = parser.parse_args()
    if bool(args.vm) != bool(args.workspace):
        parser.error('--vm and --workspace must be provided together.')
    if args.action == 'restore' and not (args.artifact and args.into):
        parser.error('restore requires --artifact and --into.')
    try:
        store = artifacts.ArtifactStore()
        ssh, host = import_workspace.ssh_command(args.vm) if args.vm else (None, None)
        if args.action != 'restore':
            result = (import_workspace.remote(ssh, host, args.workspace, 'artifact_' + args.action)
                      if args.vm else store.cleanup() if args.action == 'cleanup' else {'artifacts': store.list()})
        else:
            destination = args.into.expanduser().absolute()
            if os.path.lexists(destination):
                raise ValueError('Restore destination already exists.')
            with tempfile.TemporaryDirectory(dir=destination.parent, prefix='.relay-restore-') as temporary:
                scratch = Path(temporary)
                if args.vm:
                    command = import_workspace.remote_command(args.workspace, 'artifact_stream')
                    with subprocess.Popen([*ssh, host, command], stdin=subprocess.PIPE, stdout=subprocess.PIPE) as remote:
                        remote.stdin.write(json.dumps({'artifact_id': args.artifact}).encode())
                        remote.stdin.close()
                        try:
                            restored = artifacts.unpack(remote.stdout, scratch)
                        finally:
                            remote.stdout.close()
                        if remote.wait():
                            raise ValueError('VM recovery archive could not be authenticated.')
                else:
                    with store.locked(shared=True):
                        archive, _ = store._get(args.artifact, None)
                        restored = artifacts.decrypt_archive(archive, store, scratch)
                publish_noreplace(restored, destination)
            result = {'artifact_id': args.artifact, 'destination': str(destination)}
        print(json.dumps(result))
        return 0
    except (OSError, ValueError, subprocess.SubprocessError, tarfile.TarError) as exc:
        return import_workspace.fail(argparse.Namespace(json=True), 'artifact_failed', str(exc))


if __name__ == '__main__':
    sys.exit(main())
