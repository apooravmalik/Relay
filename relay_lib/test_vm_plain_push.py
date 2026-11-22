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
                def relay(*args, expected_exit=0):
                    r = subprocess.run([str(RELAY), *args], env=env, capture_output=True, text=True, timeout=120)
                    self.assertEqual(r.returncode, expected_exit, r.stdout + r.stderr)
                    return json.loads(r.stdout)

                def push(*options, expected_exit=0):
                    return relay('push', '--workspace', workspace, '--project', str(project), '--vm', VM,
                                 '--json', *options, expected_exit=expected_exit)

                def pull_update(*options, expected_exit=0):
                    return relay('pull', '--workspace', workspace, '--into', str(project), '--update', '--vm', VM,
                                 '--json', *options, expected_exit=expected_exit)

                def cloud_text(name):
                    return remote('from pathlib import Path; import sys; print((Path(sys.argv[1])/sys.argv[2]).read_text())', source, name)

                listing = relay('workspaces', '--vm', VM, '--json')
                self.assertIn(workspace, {item['id'] for item in listing['workspaces']})
                import_args = ('pull', '--workspace', workspace, '--into', str(local / 'projects'), '--vm', VM, '--json')
                self.assertEqual(relay(*import_args, '--dry-run')['git']['mode'], 'plain')
                imported = relay(*import_args)
                self.assertEqual(imported['workspace_id'], workspace)
                project = local / 'projects' / 'source'
                self.assertEqual((project / 'file').read_text(), 'before')
                self.assertIn('destination_exists', relay(*import_args, '--dry-run')['blockers'])
                (project / 'file').write_text('local feature')
                receipt = push('--file', 'file')
                self.assertEqual(cloud_text('file'), 'local feature')
                self.assertEqual(remote("from pathlib import Path; import sys; print((Path(sys.argv[1])/'file').read_text())", receipt['remote_recovery_path'].rsplit('/', 1)[0]), 'before')
                remote("from pathlib import Path; import sys; (Path(sys.argv[1])/'file').write_text('phone feature')", source)
                pull_update()
                self.assertEqual((project / 'file').read_text(), 'phone feature')
                self.assertEqual((project / '.env').read_text(), 'TOKEN=synthetic')
                (project / 'file').write_text('batch local')
                (project / '.env').write_text('TOKEN=updated-synthetic')
                (project / 'extra').mkdir()
                (project / 'extra' / 'large.bin').write_bytes(b'z' * (11 * 1024 * 1024))
                plan = push('--dry-run')
                self.assertEqual(plan['status'], 'LOCAL_AHEAD')
                self.assertEqual(plan['local_changes']['extra/large.bin'], 'added')
                self.assertIn('.env', plan['local_changes'])
                self.assertNotIn('updated-synthetic', json.dumps(plan))
                batch = push()
                self.assertEqual(batch['status'], 'SUCCESS')
                self.assertEqual(cloud_text('file'), 'batch local')
                self.assertEqual(cloud_text('.env'), 'TOKEN=updated-synthetic')
                large_digest = remote("from pathlib import Path; import hashlib,sys; print(hashlib.sha256((Path(sys.argv[1])/'extra/large.bin').read_bytes()).hexdigest())", source)
                self.assertEqual(large_digest, hashlib.sha256((project / 'extra/large.bin').read_bytes()).hexdigest())
                remote("from pathlib import Path; import sys; p=Path(sys.argv[1]); (p/'file').write_text('phone batch'); (p/'extra'/'phone.txt').write_text('phone addition')", source)
                self.assertEqual(pull_update('--dry-run')['status'], 'CLOUD_AHEAD')
                pull_update()
                self.assertEqual((project / 'file').read_text(), 'phone batch')
                self.assertEqual((project / 'extra' / 'phone.txt').read_text(), 'phone addition')
                self.assertEqual((project / '.env').read_text(), 'TOKEN=updated-synthetic')

                (project / 'file').write_text('desktop round two')
                (project / 'extra' / 'desktop.txt').write_text('desktop addition')
                self.assertEqual(push('--dry-run')['status'], 'LOCAL_AHEAD')
                self.assertEqual(push()['status'], 'SUCCESS')
                self.assertEqual(cloud_text('file'), 'desktop round two')
                self.assertEqual(cloud_text('extra/desktop.txt'), 'desktop addition')
                remote("from pathlib import Path; import sys; p=Path(sys.argv[1]); (p/'file').write_text('phone round two'); (p/'extra'/'phone.txt').write_text('phone edit')", source)
                self.assertEqual(pull_update('--dry-run')['status'], 'CLOUD_AHEAD')
                pull_update()
                self.assertEqual((project / 'file').read_text(), 'phone round two')
                self.assertEqual((project / 'extra' / 'phone.txt').read_text(), 'phone edit')
                self.assertEqual((project / 'extra' / 'desktop.txt').read_text(), 'desktop addition')
                self.assertEqual(pull_update('--dry-run')['status'], 'NO_OP')
                self.assertEqual(push('--dry-run')['status'], 'IN_SYNC')

                (project / 'file').write_text('desktop divergence')
                remote("from pathlib import Path; import sys; (Path(sys.argv[1])/'file').write_text('cloud divergence')", source)
                self.assertEqual(push('--dry-run')['status'], 'CONFLICT')
                self.assertIn('CONFLICT', push(expected_exit=1)['message'])
                self.assertIn('CONFLICT', pull_update(expected_exit=1)['message'])
                self.assertEqual((project / 'file').read_text(), 'desktop divergence')
                self.assertEqual(cloud_text('file'), 'cloud divergence')
        finally:
            remote("import shutil,sys; from pathlib import Path; p=Path(sys.argv[1]); assert p.parent==Path('/tmp') and p.name.startswith('relay-push-fixture-'); shutil.rmtree(p)", root)
