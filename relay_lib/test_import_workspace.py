import hashlib
import contextlib
import io
import json
import os
import resource
import sqlite3
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from relay_lib import import_workspace

RELAY = Path(__file__).resolve().parents[1] / 'relay'


class ImportPreviewTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        self.source = self.base / 'source'
        self.source.mkdir()
        self.dest = self.base / 'projects'
        self.dest.mkdir()
        self.bin = self.base / 'bin'
        self.bin.mkdir()
        ssh = self.bin / 'ssh'
        ssh.write_text('#!/bin/sh\nshift\nexec /bin/sh -c "$1"\n')
        ssh.chmod(0o755)
        rsync = self.bin / 'rsync'
        rsync.write_text('#!/usr/bin/env python3\nimport os, sys, shlex, shutil, pathlib\nif os.environ.get("RELAY_TEST_INTERRUPT"): sys.exit(12)\nsrc = shlex.split(sys.argv[-2].split(":", 1)[1])[0]\nshutil.copytree(src, sys.argv[-1], dirs_exist_ok=True)\nif os.environ.get("RELAY_TEST_CORRUPT"):\n p = pathlib.Path(sys.argv[-1]) / "files" / "file"\n p.write_bytes(b"corrupt")\n')
        rsync.chmod(0o755)
        registry = self.base / 'registry.json'
        registry.write_text(json.dumps({'roots': [str(self.source)]}))
        self.env = {**os.environ, 'HOME': str(self.base), 'PATH': str(self.bin) + os.pathsep + os.environ['PATH'], 'RELAY_WORKSPACE_REGISTRY_FILE': str(registry)}
        self.workspace_id = hashlib.sha256(os.fsencode(str(self.source))).hexdigest()[:16]

    def run_relay(self, *args):
        return subprocess.run([str(RELAY), 'pull', *args], env=self.env, capture_output=True, text=True)

    def test_preview_is_read_only_and_reports_conflict(self):
        (self.source / '.hidden').write_bytes(b'abc')
        (self.source / '.env').write_text('SECRET')
        (self.dest / 'source').mkdir()
        result = self.run_relay('--workspace', self.workspace_id, '--into', str(self.dest), '--dry-run', '--json')
        self.assertEqual(result.returncode, 0, result.stderr)
        data = json.loads(result.stdout)
        self.assertEqual(data['git']['mode'], 'plain')
        self.assertEqual(data['estimated_files'], 2)
        self.assertEqual(data['excluded_entries'], 0)
        self.assertIn('destination_exists', data['blockers'])
        self.assertNotIn('SECRET', result.stdout)
        self.assertEqual(list((self.dest / 'source').iterdir()), [])

    def test_unknown_workspace_fails_closed(self):
        preview = self.run_relay('--workspace', '0' * 16, '--into', str(self.dest), '--dry-run', '--json')
        self.assertEqual(json.loads(preview.stdout)['error'], 'workspace_not_found')
        self.assertEqual(list(self.dest.iterdir()), [])

    def test_mixed_legacy_and_import_options_are_rejected(self):
        result = self.run_relay('--workspace', self.workspace_id, '--into', str(self.dest), '--project', str(self.source), '--apply')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(list(self.dest.iterdir()), [])

    def test_unborn_git_is_identified(self):
        subprocess.run(['git', 'init', '-q', str(self.source)], check=True)
        result = self.run_relay('--workspace', self.workspace_id, '--into', str(self.dest), '--dry-run', '--json')
        self.assertEqual(result.returncode, 0, result.stderr)
        data = json.loads(result.stdout)
        self.assertEqual(data['git']['mode'], 'git_unborn')
        self.assertEqual(data['blockers'], [])

    def test_import_plain_files(self):
        (self.source / '.hidden').write_bytes(b'abc\0def')
        (self.source / 'empty').mkdir()
        result = self.run_relay('--workspace', self.workspace_id, '--into', str(self.dest), '--json')
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        project = self.dest / 'source'
        self.assertEqual((project / '.hidden').read_bytes(), b'abc\0def')
        self.assertTrue((project / 'empty').is_dir())
        self.assertFalse((project / '.git').exists())

    def test_import_git_preserves_staged_and_unstaged(self):
        subprocess.run(['git', 'init', '-q', str(self.source)], check=True)
        def git(*args):
            return subprocess.run(['git', '-C', str(self.source), *args], check=True, capture_output=True).stdout
        git('config', 'user.name', 'Test')
        git('config', 'user.email', 'test@example.com')
        (self.source / 'file').write_text('committed\n')
        git('add', 'file')
        git('commit', '-qm', 'initial')
        (self.source / 'file').write_text('staged\n')
        git('add', 'file')
        (self.source / 'file').write_text('unstaged\n')
        (self.source / 'new file').write_text('untracked')
        expected_status = git('status', '--porcelain=v1', '-z')
        expected_head = git('rev-parse', 'HEAD')
        result = self.run_relay('--workspace', self.workspace_id, '--into', str(self.dest), '--json')
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        project = self.dest / 'source'
        def local(*args):
            return subprocess.run(['git', '-C', str(project), *args], check=True, capture_output=True).stdout
        self.assertEqual(local('rev-parse', 'HEAD'), expected_head)
        self.assertEqual(local('status', '--porcelain=v1', '-z'), expected_status)
        self.assertEqual((project / 'file').read_text(), 'unstaged\n')

    def test_import_unborn_git(self):
        subprocess.run(['git', 'init', '-q', str(self.source)], check=True)
        (self.source / 'file').write_text('staged')
        subprocess.run(['git', '-C', str(self.source), 'add', 'file'], check=True)
        (self.source / 'file').write_text('working')
        result = self.run_relay('--workspace', self.workspace_id, '--into', str(self.dest), '--json')
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        project = self.dest / 'source'
        self.assertEqual(subprocess.run(['git', '-C', str(project), 'status', '--porcelain=v1'], capture_output=True, check=True).stdout, b'AM file\n')

    def test_large_staged_blob_import_under_memory_limit(self):
        subprocess.run(['git', 'init', '-q', str(self.source)], check=True)
        with (self.source / 'database.bin').open('wb') as file:
            file.truncate(80 * 1024 * 1024)
        subprocess.run(['git', '-C', str(self.source), 'add', 'database.bin'], check=True)
        def limit_memory():
            resource.setrlimit(resource.RLIMIT_AS, (96 * 1024 * 1024, 96 * 1024 * 1024))
        result = subprocess.run([str(RELAY), 'pull', '--workspace', self.workspace_id, '--into', str(self.dest), '--json'], env=self.env, capture_output=True, text=True, preexec_fn=limit_memory)
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        self.assertEqual((self.dest / 'source' / 'database.bin').stat().st_size, 80 * 1024 * 1024)

    def test_lfs_pointer_is_rejected(self):
        subprocess.run(['git', 'init', '-q', str(self.source)], check=True)
        (self.source / 'file').write_bytes(b'version https://git-lfs.github.com/spec/v1\noid sha256:' + b'0' * 64 + b'\nsize 123\n')
        subprocess.run(['git', '-C', str(self.source), 'add', 'file'], check=True)
        result = self.run_relay('--workspace', self.workspace_id, '--into', str(self.dest), '--json')
        self.assertEqual(json.loads(result.stdout)['error'], 'unsupported_git_state')
        self.assertFalse((self.dest / 'source').exists())

    def test_detached_git_and_staged_delete_with_recreated_file(self):
        def git(*args):
            return subprocess.run(['git', '-C', str(self.source), *args], check=True, capture_output=True).stdout
        git('init', '-q')
        git('config', 'user.name', 'Test')
        git('config', 'user.email', 'test@example.com')
        (self.source / 'file').write_text('committed')
        git('add', 'file')
        git('commit', '-qm', 'initial')
        git('checkout', '-q', '--detach')
        git('rm', '-q', 'file')
        (self.source / 'file').write_text('recreated')
        expected = git('status', '--porcelain=v1', '-z')
        result = self.run_relay('--workspace', self.workspace_id, '--into', str(self.dest), '--json')
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        project = self.dest / 'source'
        actual = subprocess.run(['git', '-C', str(project), 'status', '--porcelain=v1', '-z'], capture_output=True, check=True).stdout
        self.assertEqual(actual, expected)
        self.assertNotEqual(subprocess.run(['git', '-C', str(project), 'symbolic-ref', '-q', 'HEAD']).returncode, 0)

    def test_corrupt_transfer_does_not_publish(self):
        (self.source / 'file').write_text('safe')
        self.env['RELAY_TEST_CORRUPT'] = '1'
        result = self.run_relay('--workspace', self.workspace_id, '--into', str(self.dest), '--json')
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.dest / 'source').exists())

    def test_existing_destination_is_untouched(self):
        destination = self.dest / 'source'
        destination.mkdir()
        (destination / 'keep').write_text('mine')
        result = self.run_relay('--workspace', self.workspace_id, '--into', str(self.dest), '--json')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual((destination / 'keep').read_text(), 'mine')

    def test_secret_in_history_is_preserved_without_disclosure(self):
        def git(*args):
            subprocess.run(['git', '-C', str(self.source), *args], check=True, capture_output=True)
        git('init', '-q')
        git('config', 'user.name', 'Test')
        git('config', 'user.email', 'test@example.com')
        canary = 'AKIA' + 'A' * 16
        (self.source / 'file').write_text(canary)
        git('add', 'file')
        git('commit', '-qm', 'initial')
        (self.source / 'file').write_text('removed credential')
        git('add', 'file')
        git('commit', '-qm', 'remove')
        result = self.run_relay('--workspace', self.workspace_id, '--into', str(self.dest), '--json')
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        self.assertNotIn(canary, result.stdout + result.stderr)
        history = subprocess.run(['git', '-C', str(self.dest / 'source'), 'show', 'HEAD~1:file'], check=True, capture_output=True).stdout
        self.assertEqual(history, canary.encode())

    def test_ignored_data_secrets_and_build_outputs_are_imported(self):
        subprocess.run(['git', 'init', '-q', str(self.source)], check=True)
        (self.source / '.gitignore').write_text('.env\n*.sqlite\n*.bak\n*.key\ndist/\n')
        (self.source / '.env').write_text('TOKEN=private')
        (self.source / 'id_test.key').write_bytes(b'private key test')
        (self.source / 'id_test.key').chmod(0o600)
        (self.source / 'database.bak').write_bytes(b'backup\0bytes')
        (self.source / 'dist').mkdir()
        (self.source / 'dist' / 'app.js').write_text('built')
        (self.source / 'node_modules').mkdir()
        (self.source / 'node_modules' / 'dependency').write_text('omit')
        (self.source / '.venv').mkdir()
        (self.source / '.venv' / 'package').write_text('omit')
        db = sqlite3.connect(self.source / 'state.sqlite')
        self.addCleanup(db.close)
        db.execute('pragma journal_mode=wal')
        db.execute('create table example(value text)')
        db.execute("insert into example values ('kept')")
        db.commit()
        result = self.run_relay('--workspace', self.workspace_id, '--into', str(self.dest), '--json')
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        project = self.dest / 'source'
        self.assertEqual((project / '.env').read_text(), 'TOKEN=private')
        self.assertEqual((project / 'id_test.key').stat().st_mode & 0o777, 0o600)
        self.assertEqual((project / 'database.bak').read_bytes(), b'backup\0bytes')
        self.assertEqual((project / 'dist' / 'app.js').read_text(), 'built')
        self.assertFalse((project / 'node_modules').exists())
        self.assertFalse((project / '.venv').exists())
        self.assertTrue((project / 'state.sqlite-wal').exists())
        with sqlite3.connect(project / 'state.sqlite') as restored:
            self.assertEqual(restored.execute('select value from example').fetchone()[0], 'kept')

    def test_linked_worktree_git_file_is_not_copied(self):
        repo = self.base / 'repo'
        subprocess.run(['git', 'init', '-q', str(repo)], check=True)
        subprocess.run(['git', '-C', str(repo), 'config', 'user.name', 'Test'], check=True)
        subprocess.run(['git', '-C', str(repo), 'config', 'user.email', 'test@example.com'], check=True)
        (repo / 'file').write_text('committed')
        subprocess.run(['git', '-C', str(repo), 'add', 'file'], check=True)
        subprocess.run(['git', '-C', str(repo), 'commit', '-qm', 'initial'], check=True)
        self.source.rmdir()
        subprocess.run(['git', '-C', str(repo), 'worktree', 'add', '-q', '-b', 'feature', str(self.source)], check=True)
        (self.source / 'file').write_text('worktree change')
        result = self.run_relay('--workspace', self.workspace_id, '--into', str(self.dest), '--json')
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        project = self.dest / 'source'
        self.assertTrue((project / '.git').is_dir())
        self.assertEqual((project / 'file').read_text(), 'worktree change')

    def test_resume_interrupted_transfer_and_lookup_receipt(self):
        (self.source / 'file').write_text('resume me')
        self.env['RELAY_TEST_INTERRUPT'] = '1'
        failed = self.run_relay('--workspace', self.workspace_id, '--into', str(self.dest), '--json')
        self.assertNotEqual(failed.returncode, 0)
        self.assertFalse((self.dest / 'source').exists())
        pending = list((self.base / '.relay-v0' / 'imports').glob('*.pending.json'))
        self.assertEqual(len(pending), 1)
        transfer = pending[0].name.split('.')[0]
        del self.env['RELAY_TEST_INTERRUPT']
        resumed = self.run_relay('--resume', transfer, '--json')
        self.assertEqual(resumed.returncode, 0, resumed.stdout + resumed.stderr)
        self.assertEqual((self.dest / 'source' / 'file').read_text(), 'resume me')
        lookup = self.run_relay('--resume', transfer, '--json')
        self.assertEqual(json.loads(lookup.stdout)['transfer_id'], transfer)

    def test_symlink_and_case_collisions_fail_without_publication(self):
        (self.source / 'link').symlink_to('/etc/passwd')
        result = self.run_relay('--workspace', self.workspace_id, '--into', str(self.dest), '--json')
        self.assertEqual(json.loads(result.stdout)['error'], 'unsupported_file')
        self.assertFalse((self.dest / 'source').exists())
        (self.source / 'link').unlink()
        (self.source / 'Name').write_text('first')
        (self.source / 'name').write_text('second')
        result = self.run_relay('--workspace', self.workspace_id, '--into', str(self.dest), '--json')
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.dest / 'source').exists())

    def test_intent_to_add_is_rejected(self):
        subprocess.run(['git', 'init', '-q', str(self.source)], check=True)
        (self.source / 'file').write_text('intent')
        subprocess.run(['git', '-C', str(self.source), 'add', '-N', 'file'], check=True)
        result = self.run_relay('--workspace', self.workspace_id, '--into', str(self.dest), '--json')
        self.assertEqual(json.loads(result.stdout)['error'], 'unsupported_git_state')
        self.assertFalse((self.dest / 'source').exists())

    def test_resume_reconciles_crash_after_publication(self):
        (self.source / 'file').write_text('published')
        with patch.dict(os.environ, self.env, clear=True), patch.object(import_workspace, 'complete_transfer', side_effect=OSError('simulated crash')), contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            result = import_workspace.main(['--workspace', self.workspace_id, '--into', str(self.dest), '--json'])
        self.assertEqual(result, 1)
        self.assertEqual((self.dest / 'source' / 'file').read_text(), 'published')
        pending = list((self.base / '.relay-v0' / 'imports').glob('*.pending.json'))
        self.assertEqual(len(pending), 1)
        resumed = self.run_relay('--resume', pending[0].name.split('.')[0], '--json')
        self.assertEqual(resumed.returncode, 0, resumed.stderr + resumed.stdout)


if __name__ == '__main__':
    unittest.main()
