import os
from pathlib import Path
import subprocess
import tempfile
import unittest

RELAY = Path(__file__).resolve().parents[1] / 'relay'


class PushSelectionTests(unittest.TestCase):
    def test_push_includes_ignored_project_data_and_omits_dependency_directories(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            home = root / 'home'
            home.mkdir()
            project = root / 'project'
            project.mkdir()
            tools = root / 'bin'
            tools.mkdir()
            ssh = tools / 'ssh'
            ssh.write_text('#!/bin/sh\nshift\nif [ "$#" -eq 1 ]; then exec /bin/sh -c "$1"; else exec "$@"; fi\n')
            ssh.chmod(0o755)
            scp = tools / 'scp'
            scp.write_text('#!/usr/bin/env python3\nimport os, pathlib, shutil, sys\na = [x for x in sys.argv[1:] if x not in ("-p", "-q")]\ndest = pathlib.Path(os.environ["HOME"]) / a[-1].split(":", 1)[1]\nshutil.copy2(a[-2], dest)\n')
            scp.chmod(0o755)
            env = {**os.environ, 'HOME': str(home), 'PATH': str(tools) + os.pathsep + os.environ['PATH']}
            def git(*args):
                subprocess.run(['git', '-C', str(project), *args], check=True, capture_output=True, env=env)
            git('init', '-q')
            git('config', 'user.name', 'Test')
            git('config', 'user.email', 'test@example.com')
            (project / '.gitignore').write_text('.env\n*.bak\n')
            git('add', '.gitignore')
            git('commit', '-qm', 'initial')
            (project / '.env').write_text('TOKEN=test')
            (project / 'data.bak').write_bytes(b'backup\0')
            (project / 'node_modules').mkdir()
            (project / 'node_modules' / 'skip').write_text('cache')
            result = subprocess.run([str(RELAY), 'push', '--project', str(project), '--vm', 'test-vm'], capture_output=True, text=True, env=env)
            self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
            remote = home / '.relay-v0' / 'workspaces' / 'project'
            self.assertEqual((remote / '.env').read_text(), 'TOKEN=test')
            self.assertEqual((remote / 'data.bak').read_bytes(), b'backup\0')
            self.assertFalse((remote / 'node_modules').exists())
            self.assertEqual((home / '.relay-v0' / 'incoming').stat().st_mode & 0o777, 0o700)


if __name__ == '__main__': unittest.main()
