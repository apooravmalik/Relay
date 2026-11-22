"""Opt-in Git acceptance against a private disposable SSH fixture."""

import hashlib
import json
import os
from pathlib import Path
import shlex
import sqlite3
import subprocess
import tempfile
import unittest

from relay_lib.test_vm_plain_push import RELAY, VM


@unittest.skipUnless(VM, 'set RELAY_DISPOSABLE_TEST_VM to an SSH alias')
class RealSshGitHandoffTest(unittest.TestCase):
    def test_two_round_trips_commit_and_merge(self):
        config = Path.home() / '.ssh' / 'config'

        def remote(code, *args):
            command = shlex.join(['python3', '-c', code, *map(str, args)])
            return subprocess.check_output(['ssh', '-F', str(config), '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8',
                                            VM, command], text=True, timeout=30).strip()

        root = remote("import tempfile; print(tempfile.mkdtemp(prefix='relay-git-e2e-', dir='/tmp'))")
        self.addCleanup(remote, """import shutil, sys
from pathlib import Path
p = Path(sys.argv[1])
assert p.parent == Path('/tmp') and p.name.startswith('relay-git-e2e-')
shutil.rmtree(p)
""", root)
        source = root + '/workspace'
        workspace = hashlib.sha256(os.fsencode(source)).hexdigest()[:16]
        initialize = r"""import subprocess, sys
from pathlib import Path
root = Path(sys.argv[1])
(root / 'home').mkdir(mode=0o700)
workspace = root / 'workspace'
workspace.mkdir(mode=0o700)
(workspace / 'version.txt').write_text('base\n')
(workspace / 'sections.txt').write_text('top\n' + '\n'.join(f'separator-{i}' for i in range(12)) + '\nbottom\n')
def git(*args): subprocess.run(['git', '-C', str(workspace), *args], check=True)
git('init', '-q')
git('add', 'version.txt', 'sections.txt')
git('-c', 'user.name=Relay Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture')
(workspace / '.relayignore').write_text('protect .env\nexclude local-only.db\n')
(workspace / '.env').write_bytes(b'TOKEN=VM-fixture')
(workspace / 'local-only.db').write_bytes(b'VM only')
"""
        remote(initialize, root)
        with tempfile.TemporaryDirectory(prefix='relay-git-desktop-') as temporary:
            desktop = Path(temporary)
            local_home = desktop / 'home'
            local_home.mkdir()
            binary = desktop / 'bin'
            binary.mkdir()
            wrapper = binary / 'ssh'
            wrapper.write_text('#!/usr/bin/env python3\n' + f"""
import os, shlex, subprocess, sys
args = sys.argv[1:]
host, *command = args
prefix = shlex.join(['env', {('HOME=' + root + '/home')!r}, {('RELAY_WORKSPACE_ROOTS=' + source)!r}])
command = prefix + ' ' + (command[0] if len(command) == 1 else shlex.join(command))
invocation = ['ssh', '-F', {str(config)!r}, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', host, command]
if os.environ.get('RELAY_DROP_ACK') and command.endswith(' git_ack_push'):
    result = subprocess.run(invocation, executable='/usr/bin/ssh', stdout=subprocess.DEVNULL)
    sys.exit(result.returncode or 255)
os.execv('/usr/bin/ssh', invocation)
""")
            wrapper.chmod(0o700)
            rsync_wrapper = binary / 'rsync'
            rsync_wrapper.write_text("""#!/usr/bin/env python3
import os
import sys
args = ['/usr/bin/rsync', *sys.argv[1:]]
if os.environ.get('RELAY_INTERRUPT_RSYNC'):
    args = ['/usr/bin/timeout', '--signal=INT', '4', '/usr/bin/rsync', '--bwlimit=256', *sys.argv[1:]]
os.execv(args[0], args)
""")
            rsync_wrapper.chmod(0o700)
            env = {**os.environ, 'HOME': str(local_home), 'PATH': str(binary) + os.pathsep + os.environ['PATH']}

            def relay(command, *options, exit_code=0):
                invocation = [str(RELAY), command, '--vm', VM, '--workspace', workspace, '--json', *options]
                result = subprocess.run(invocation, env=env, capture_output=True, text=True, timeout=120)
                self.assertEqual(result.returncode, exit_code, result.stdout + result.stderr)
                self.assertNotIn('TOKEN=', result.stdout)
                return json.loads(result.stdout)

            def local_git(*args):
                return subprocess.check_output(['git', '-C', str(project), *args], text=True).strip()

            def vm_git(*args):
                return remote("import subprocess,sys; subprocess.run(['git','-C',*sys.argv[1:]],check=True)", source, *args)

            def vm_write(name, data):
                remote("from pathlib import Path; import sys; (Path(sys.argv[1])/sys.argv[2]).write_text(sys.argv[3])", source, name, data)

            def vm_read(name):
                return remote("from pathlib import Path; import sys; print((Path(sys.argv[1])/sys.argv[2]).read_text(),end='')", source, name)

            first = relay('pull', '--into', str(desktop))
            project = Path(first['destination'])
            self.assertEqual((project / '.env').read_bytes(), b'TOKEN=VM-fixture')
            self.assertFalse((project / 'local-only.db').exists())
            (project / 'local-only.db').write_text('PC only')
            (project / 'large.bin').write_bytes(b'x' * (11 * 1024 * 1024))
            database = sqlite3.connect(project / 'snapshot.sqlite')
            database.execute('CREATE TABLE details(value)')
            database.execute("INSERT INTO details VALUES ('restored')")
            database.commit()
            database.close()
            base = local_git('rev-parse', 'HEAD')
            checkpoint = first['transfer_id']
            for turn in range(2):
                (project / 'version.txt').write_text(f'staged-{turn}')
                local_git('add', 'version.txt')
                (project / 'version.txt').write_text(f'working-{turn}')
                preview = relay('push', '--project', str(project), '--dry-run')
                if turn == 0:
                    env['RELAY_INTERRUPT_RSYNC'] = '1'
                    failed = relay('push', '--project', str(project), '--expect', preview['plan_id'], exit_code=1)
                    self.assertIn('FAILED_RECOVERABLE', failed['message'])
                    self.assertEqual(vm_read('version.txt'), 'base')
                    del env['RELAY_INTERRUPT_RSYNC']
                    pushed = relay('push', '--project', str(project), '--resume')
                else:
                    pushed = relay('push', '--project', str(project), '--expect', preview['plan_id'])
                self.assertEqual(pushed['parent_id'], checkpoint)
                self.assertEqual(vm_git('show', ':version.txt'), f'staged-{turn}')
                self.assertEqual(vm_read('version.txt'), f'working-{turn}')
                vm_write('phone.txt', f'phone-{turn}')
                vm_git('add', 'phone.txt')
                vm_write('phone.txt', f'phone-working-{turn}')
                if turn == 0:
                    remote("import sys; p=open(sys.argv[1], 'r+b'); p.seek(0); p.write(b'VM'); p.close()", source + '/large.bin')
                    env['RELAY_INTERRUPT_RSYNC'] = '1'
                    failed = relay('pull', '--update', '--into', str(project), exit_code=1)
                    self.assertIn('FAILED_RECOVERABLE', failed['message'])
                    self.assertFalse((project / 'phone.txt').exists())
                    del env['RELAY_INTERRUPT_RSYNC']
                    resumed = subprocess.run([str(RELAY), 'pull', '--vm', VM, '--resume-update', str(project), '--json'],
                                             env=env, text=True, capture_output=True, timeout=120)
                    self.assertEqual(resumed.returncode, 0, resumed.stdout + resumed.stderr)
                    pulled = json.loads(resumed.stdout)
                else:
                    pulled = relay('pull', '--update', '--into', str(project))
                self.assertEqual(pulled['parent_id'], pushed['transfer_id'])
                checkpoint = pulled['transfer_id']
                self.assertEqual(local_git('show', ':phone.txt'), f'phone-{turn}')
                self.assertEqual((project / 'phone.txt').read_text(), f'phone-working-{turn}')
                self.assertEqual(local_git('rev-parse', 'HEAD'), base)
                self.assertEqual(vm_git('rev-parse', 'HEAD'), base)
            self.assertEqual(vm_read('local-only.db'), 'VM only')
            self.assertEqual((project / 'local-only.db').read_text(), 'PC only')
            self.assertEqual(remote("import hashlib,sys; print(hashlib.file_digest(open(sys.argv[1],'rb'),'sha256').hexdigest())",
                                    source + '/large.bin'), hashlib.sha256((project / 'large.bin').read_bytes()).hexdigest())
            self.assertEqual(remote("import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); print(c.execute('SELECT value FROM details').fetchone()[0]); c.close()",
                                    source + '/snapshot.sqlite'), 'restored')

            sections = (project / 'sections.txt').read_text()
            (project / 'sections.txt').write_text(sections.replace('top', 'PC top'))
            vm_write('sections.txt', sections.replace('bottom', 'VM bottom'))
            review = relay('merge', '--project', str(project))
            self.assertEqual(review['conflicts'], [])
            merged = relay('merge', '--project', str(project), '--approve', review['plan_id'])
            self.assertEqual(merged['parent_id'], checkpoint)
            self.assertIn('PC top', vm_read('sections.txt'))
            self.assertIn('VM bottom', (project / 'sections.txt').read_text())
            local_git('-c', 'user.name=Relay Fixture', '-c', 'user.email=fixture@example.invalid',
                      'commit', '-qm', 'approved fixture commit')
            commit = local_git('rev-parse', 'HEAD')
            self.assertIn('COMMIT_APPROVAL_REQUIRED', relay('push', '--project', str(project), exit_code=1)['message'])
            env['RELAY_DROP_ACK'] = '1'
            lost = relay('push', '--project', str(project), '--commit', commit, exit_code=1)
            self.assertIn('Could not obtain a response over SSH', lost['message'])
            self.assertEqual(vm_git('rev-parse', 'HEAD'), commit)
            del env['RELAY_DROP_ACK']
            receipt = relay('push', '--project', str(project), '--resume')
            self.assertEqual(receipt['parent_id'], merged['checkpoint_id'])
            self.assertEqual(receipt['generation'], merged['generation'] + 1)
            self.assertEqual(relay('push', '--project', str(project), '--resume')['checkpoint_id'],
                             receipt['checkpoint_id'])


if __name__ == '__main__':
    unittest.main()
