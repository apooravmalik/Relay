"""Opt-in disposable remote fixture; never points at a registered live workspace."""
import hashlib
import json
import os
from pathlib import Path
import shlex
import subprocess
import tempfile
import unittest

RELAY = Path(__file__).resolve().parents[1] / 'relay'
VM = os.environ.get('RELAY_DISPOSABLE_TEST_VM')


@unittest.skipUnless(VM, 'set RELAY_DISPOSABLE_TEST_VM to an SSH alias for an isolated /tmp fixture')
class RealSshPlainPushTest(unittest.TestCase):
    def test_import_push_and_pull_with_synthetic_runtime_file(self):
        ssh_config = str(Path.home() / '.ssh' / 'config')
        def remote(code, *arguments):
            command = 'python3 -c ' + shlex.quote(code) + ''.join(' ' + shlex.quote(str(x)) for x in arguments)
            return subprocess.run(['/usr/bin/ssh', '-F', ssh_config, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', VM, command], check=True, capture_output=True, text=True).stdout.strip()
        root = remote("import tempfile; print(tempfile.mkdtemp(prefix='relay-push-fixture-', dir='/tmp'))")
        self.assertTrue(root.startswith('/tmp/relay-push-fixture-'))
        try:
            remote("from pathlib import Path; import sys; p=Path(sys.argv[1]); (p/'home').mkdir(mode=0o700); (p/'source').mkdir(mode=0o700); (p/'source'/'file').write_text('before'); (p/'source'/'.env').write_text('TOKEN=synthetic')", root)
            source = root + '/source'
            workspace = hashlib.sha256(os.fsencode(source)).hexdigest()[:16]
            with tempfile.TemporaryDirectory(prefix='relay-push-local-') as local:
                local = Path(local); (local / 'home').mkdir(); (local / 'bin').mkdir(); (local / 'projects').mkdir()
                wrapper = local / 'bin' / 'ssh'
                wrapper.write_text("#!/usr/bin/env python3\n" +
                    "import os,shlex,sys\n" +
                    "args=sys.argv[1:]; host=args.pop(0)\n" +
                    "remote='env HOME='+shlex.quote(" + repr(root + '/home') + ")+ ' RELAY_WORKSPACE_ROOTS='+shlex.quote(" + repr(source) + ")+ ' '+ (args[0] if len(args)==1 else ' '.join(shlex.quote(x) for x in args))\n" +
                    "os.execv('/usr/bin/ssh',['ssh','-F'," + repr(ssh_config) + ",' -o'.strip(),'BatchMode=yes','-o','ConnectTimeout=8',host,remote])\n")
                wrapper.chmod(0o700)
                env = {**os.environ, 'HOME':str(local / 'home'), 'PATH':str(local / 'bin') + os.pathsep + os.environ['PATH']}
                def relay(*args):
                    r = subprocess.run([str(RELAY), *args], env=env, capture_output=True, text=True, timeout=120)
                    self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
                    return json.loads(r.stdout)
                relay('pull', '--workspace', workspace, '--into', str(local / 'projects'), '--vm', VM, '--json')
                project = local / 'projects' / 'source'
                (project / 'file').write_text('local feature')
                receipt = relay('push', '--workspace', workspace, '--project', str(project), '--file', 'file', '--vm', VM, '--json')
                self.assertEqual(remote("from pathlib import Path; import sys; print((Path(sys.argv[1])/'file').read_text())", source), 'local feature')
                self.assertEqual(remote("from pathlib import Path; import sys; print((Path(sys.argv[1])/'file').read_text())", receipt['remote_recovery_path'].rsplit('/', 1)[0]), 'before')
                remote("from pathlib import Path; import sys; (Path(sys.argv[1])/'file').write_text('phone feature')", source)
                relay('pull', '--workspace', workspace, '--into', str(project), '--update', '--vm', VM, '--json')
                self.assertEqual((project / 'file').read_text(), 'phone feature')
                self.assertEqual((project / '.env').read_text(), 'TOKEN=synthetic')
                (project / 'file').write_text('batch local')
                (project / '.env').write_text('TOKEN=updated-synthetic')
                (project / 'extra').mkdir()
                (project / 'extra' / 'large.bin').write_bytes(b'z' * (11 * 1024 * 1024))
                batch = relay('push', '--workspace', workspace, '--project', str(project), '--vm', VM, '--json')
                self.assertEqual(batch['status'], 'SUCCESS')
                self.assertEqual(remote("from pathlib import Path; import sys; print((Path(sys.argv[1])/'file').read_text())", source), 'batch local')
                remote("from pathlib import Path; import sys; p=Path(sys.argv[1]); (p/'file').write_text('phone batch'); (p/'extra'/'phone.txt').write_text('phone addition')", source)
                relay('pull', '--workspace', workspace, '--into', str(project), '--update', '--vm', VM, '--json')
                self.assertEqual((project / 'file').read_text(), 'phone batch')
                self.assertEqual((project / 'extra' / 'phone.txt').read_text(), 'phone addition')
                self.assertEqual((project / '.env').read_text(), 'TOKEN=updated-synthetic')
        finally:
            remote("import shutil,sys; from pathlib import Path; p=Path(sys.argv[1]); assert p.parent==Path('/tmp') and p.name.startswith('relay-push-fixture-'); shutil.rmtree(p)", root)
