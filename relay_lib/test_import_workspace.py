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

from relay_lib import import_workspace, update_workspace

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
        rsync.write_text('#!/usr/bin/env python3\nimport os, sys, shlex, shutil, pathlib\nif os.environ.get("RELAY_TEST_INTERRUPT"): sys.exit(12)\nsrc = sys.argv[-2]\ndst = sys.argv[-1]\nif ":" in src: src = shlex.split(src.split(":", 1)[1])[0]\nif ":" in dst: dst = shlex.split(dst.split(":", 1)[1])[0]\nshutil.copytree(src, dst, dirs_exist_ok=True)\nif os.environ.get("RELAY_TEST_CORRUPT"):\n p = pathlib.Path(sys.argv[-1]) / "files" / "file"\n p.write_bytes(b"corrupt")\n')
        rsync.chmod(0o755)
        registry = self.base / 'registry.json'
        registry.write_text(json.dumps({'roots': [str(self.source)]}))
        self.env = {**os.environ, 'HOME': str(self.base), 'PATH': str(self.bin) + os.pathsep + os.environ['PATH'], 'RELAY_WORKSPACE_REGISTRY_FILE': str(registry)}
        self.workspace_id = hashlib.sha256(os.fsencode(str(self.source))).hexdigest()[:16]

    def run_relay(self, *args):
        return subprocess.run([str(RELAY), 'pull', *args], env=self.env, capture_output=True, text=True)

    def run_push(self, project, path, *extra):
        return subprocess.run([str(RELAY), 'push', '--workspace', self.workspace_id, '--project', str(project), '--file', path, '--json', *extra], env=self.env, capture_output=True, text=True)

    def test_plain_single_file_push_preserves_runtime_and_repeat_pull(self):
        (self.source / '.env').write_text('TOKEN=secret')
        (self.source / 'file').write_text('old')
        self.assertEqual(self.run_relay('--workspace', self.workspace_id, '--into', str(self.dest), '--json').returncode, 0)
        project = self.dest / 'source'
        (project / 'file').write_text('local feature')
        preview = self.run_push(project, 'file', '--dry-run')
        self.assertEqual(preview.returncode, 0, preview.stdout + preview.stderr)
        self.assertEqual(json.loads(preview.stdout)['local_changes'], {'file':'modified'})
        pushed = self.run_push(project, 'file')
        self.assertEqual(pushed.returncode, 0, pushed.stdout + pushed.stderr)
        self.assertNotIn('TOKEN=secret', pushed.stdout + pushed.stderr)
        self.assertEqual((self.source / 'file').read_text(), 'local feature')
        self.assertEqual((self.source / '.env').read_text(), 'TOKEN=secret')
        self.assertEqual(Path(json.loads(pushed.stdout)['remote_recovery_path']).read_text(), 'old')
        (self.source / 'file').write_text('cloud feature')
        pull = self.run_relay('--workspace', self.workspace_id, '--into', str(project), '--update', '--json')
        self.assertEqual(pull.returncode, 0, pull.stdout + pull.stderr)
        self.assertEqual((project / 'file').read_text(), 'cloud feature')

    def test_plain_push_can_transfer_selected_ignored_env_without_disclosure(self):
        (self.source / '.env').write_text('TOKEN=before-synthetic')
        (self.source / '.env').chmod(0o600)
        self.assertEqual(self.run_relay('--workspace', self.workspace_id, '--into', str(self.dest), '--json').returncode, 0)
        project = self.dest / 'source'
        (project / '.env').write_text('TOKEN=after-synthetic')
        result = self.run_push(project, '.env')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertNotIn('TOKEN=', result.stdout + result.stderr)
        self.assertEqual((self.source / '.env').read_text(), 'TOKEN=after-synthetic')
        self.assertEqual((self.source / '.env').stat().st_mode & 0o777, 0o600)

    def test_plain_push_adopts_verified_older_import_receipt(self):
        (self.source / 'file').write_text('old')
        self.assertEqual(self.run_relay('--workspace', self.workspace_id, '--into', str(self.dest), '--json').returncode, 0)
        project = self.dest / 'source'
        with patch.dict(os.environ, self.env, clear=True):
            update_workspace.pairing_path(project).unlink()
        (project / 'file').write_text('updated')
        result = self.run_push(project, 'file')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual((self.source / 'file').read_text(), 'updated')

    def test_plain_push_refuses_open_workspace_file(self):
        (self.source / 'file').write_text('old')
        self.assertEqual(self.run_relay('--workspace', self.workspace_id, '--into', str(self.dest), '--json').returncode, 0)
        project = self.dest / 'source'
        (project / 'file').write_text('updated')
        with (self.source / 'file').open('r'):
            result = self.run_push(project, 'file')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('source_busy', result.stdout)
        self.assertEqual((self.source / 'file').read_text(), 'old')
        resumed = self.run_push(project, 'file', '--resume')
        self.assertEqual(resumed.returncode, 0, resumed.stdout + resumed.stderr)

    def test_multifile_push_preview_and_execution(self):
        (self.source / 'first').write_text('old')
        (self.source / 'second').write_text('old')
        self.assertEqual(self.run_relay('--workspace', self.workspace_id, '--into', str(self.dest), '--json').returncode, 0)
        project = self.dest / 'source'
        (project / 'first').write_text('new')
        (project / 'second').write_text('new')
        command = [str(RELAY), 'push', '--workspace', self.workspace_id, '--project', str(project), '--json']
        preview = subprocess.run([*command, '--dry-run'], env=self.env, capture_output=True, text=True)
        self.assertEqual(preview.returncode, 0, preview.stdout + preview.stderr)
        self.assertEqual(json.loads(preview.stdout)['local_changes'], {'first':'modified', 'second':'modified'})
        actual = subprocess.run(command, env=self.env, capture_output=True, text=True)
        self.assertEqual(actual.returncode, 0, actual.stdout + actual.stderr)
        self.assertEqual((self.source / 'first').read_text(), 'new')
        self.assertEqual((self.source / 'second').read_text(), 'new')
        receipt = subprocess.run([*command, '--resume'], env=self.env, capture_output=True, text=True)
        self.assertEqual(receipt.returncode, 0, receipt.stdout + receipt.stderr)
        self.assertEqual(json.loads(receipt.stdout)['transfer_id'], json.loads(actual.stdout)['transfer_id'])

    def test_multifile_push_add_delete_large_runtime_and_repeat_pull(self):
        (self.source / 'delete').write_text('old')
        (self.source / '.env').write_text('TOKEN=old')
        self.assertEqual(self.run_relay('--workspace', self.workspace_id, '--into', str(self.dest), '--json').returncode, 0)
        project = self.dest / 'source'
        (project / 'delete').unlink()
        (project / '.env').write_text('TOKEN=new')
        (project / 'newdir').mkdir()
        (project / 'newdir' / 'large').write_bytes(b'x' * (11 * 1024 * 1024))
        command = [str(RELAY), 'push', '--workspace', self.workspace_id, '--project', str(project), '--json']
        pushed = subprocess.run(command, env=self.env, capture_output=True, text=True)
        self.assertEqual(pushed.returncode, 0, pushed.stdout + pushed.stderr)
        self.assertNotIn('TOKEN=', pushed.stdout + pushed.stderr)
        self.assertEqual((self.source / '.env').read_text(), 'TOKEN=new')
        self.assertFalse((self.source / 'delete').exists())
        self.assertEqual((self.source / 'newdir' / 'large').stat().st_size, 11 * 1024 * 1024)
        (self.source / 'newdir' / 'phone').write_text('remote')
        pull = self.run_relay('--workspace', self.workspace_id, '--into', str(project), '--update', '--json')
        self.assertEqual(pull.returncode, 0, pull.stdout + pull.stderr)
        self.assertEqual((project / 'newdir' / 'phone').read_text(), 'remote')

    def test_multifile_push_recovers_interruption_after_first_exchange(self):
        from relay_lib import batch_push, export_workspace
        (self.source / 'one').write_text('old one')
        (self.source / 'two').write_text('old two')
        self.assertEqual(self.run_relay('--workspace', self.workspace_id, '--into', str(self.dest), '--json').returncode, 0)
        project = self.dest / 'source'
        (project / 'one').write_text('new one'); (project / 'two').write_text('new two')
        original_remote = import_workspace.remote
        original_exchange = export_workspace._batch_exchange
        def crash_after_exchange(a, b):
            original_exchange(a, b)
            raise OSError('simulated crash after exchange')
        def inject(ssh, host, workspace, action, request=None):
            if action == 'batch_apply':
                with patch.object(export_workspace, '_batch_exchange', side_effect=crash_after_exchange):
                    return export_workspace.batch_apply(self.source, workspace, request)
            return original_remote(ssh, host, workspace, action, request)
        with patch.dict(os.environ, self.env, clear=True), patch.object(import_workspace, 'remote', side_effect=inject), contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            failed = batch_push.main(['--workspace', self.workspace_id, '--project', str(project), '--json'])
        self.assertEqual(failed, 1)
        self.assertEqual((self.source / 'one').read_text(), 'new one')
        self.assertEqual((self.source / 'two').read_text(), 'old two')
        command = [str(RELAY), 'push', '--workspace', self.workspace_id, '--project', str(project), '--json', '--resume']
        resumed = subprocess.run(command, env=self.env, capture_output=True, text=True)
        self.assertEqual(resumed.returncode, 0, resumed.stdout + resumed.stderr)
        recovery = Path(json.loads(resumed.stdout)['remote_recovery_path'])
        self.assertEqual((recovery / 'incoming' / 'one').read_text(), 'old one')
        self.assertEqual((self.source / 'one').read_text(), 'new one')
        self.assertEqual((self.source / 'two').read_text(), 'new two')

    def test_multifile_push_refuses_deleting_directory_with_excluded_vm_data(self):
        (self.source / 'folder').mkdir(); (self.source / 'folder' / 'file').write_text('old')
        (self.source / 'folder' / 'node_modules').mkdir(); (self.source / 'folder' / 'node_modules' / 'keep').write_text('keep')
        self.assertEqual(self.run_relay('--workspace', self.workspace_id, '--into', str(self.dest), '--json').returncode, 0)
        project = self.dest / 'source'; (project / 'folder' / 'file').unlink(); (project / 'folder').rmdir()
        result = subprocess.run([str(RELAY), 'push', '--workspace', self.workspace_id, '--project', str(project), '--json'], env=self.env, capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual((self.source / 'folder' / 'file').read_text(), 'old')
        self.assertEqual((self.source / 'folder' / 'node_modules' / 'keep').read_text(), 'keep')

    def test_multifile_push_recovers_add_and_delete_after_rename(self):
        from relay_lib import batch_push, export_workspace
        for kind in ('add', 'delete'):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory(dir=self.base) as temp:
                parent = Path(temp); source = parent / 'source'; dest = parent / 'dest'; source.mkdir(); dest.mkdir()
                (source / 'existing').write_text('old')
                registry = parent / 'registry.json'; registry.write_text(json.dumps({'roots':[str(source)]}))
                env = {**self.env, 'HOME':str(parent), 'RELAY_WORKSPACE_REGISTRY_FILE':str(registry)}
                workspace = hashlib.sha256(os.fsencode(str(source))).hexdigest()[:16]
                initial = subprocess.run([str(RELAY), 'pull', '--workspace', workspace, '--into', str(dest), '--json'], env=env, capture_output=True, text=True)
                self.assertEqual(initial.returncode, 0, initial.stdout + initial.stderr)
                project = dest / 'source'
                if kind == 'add': (project / 'added').write_text('new')
                else: (project / 'existing').unlink()
                original_remote = import_workspace.remote; original_rename = export_workspace._batch_noreplace
                def crash_after_rename(a, b):
                    original_rename(a, b); raise OSError('crash after rename')
                def inject(ssh, host, workspace_id, action, request=None):
                    if action == 'batch_apply':
                        with patch.object(export_workspace, '_batch_noreplace', side_effect=crash_after_rename):
                            return export_workspace.batch_apply(source, workspace_id, request)
                    return original_remote(ssh, host, workspace_id, action, request)
                with patch.dict(os.environ, env, clear=True), patch.object(import_workspace, 'remote', side_effect=inject), contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                    result = batch_push.main(['--workspace', workspace, '--project', str(project), '--json'])
                self.assertEqual(result, 1)
                resumed = subprocess.run([str(RELAY), 'push', '--workspace', workspace, '--project', str(project), '--json', '--resume'], env=env, capture_output=True, text=True)
                self.assertEqual(resumed.returncode, 0, resumed.stdout + resumed.stderr)
                if kind == 'add': self.assertEqual((source / 'added').read_text(), 'new')
                else:
                    self.assertFalse((source / 'existing').exists())
                    recovery = Path(json.loads(resumed.stdout)['remote_recovery_path'])
                    self.assertEqual((recovery / 'backup' / '0').read_text(), 'old')

    def test_multifile_push_recovers_lost_final_acknowledgment(self):
        from relay_lib import batch_push
        (self.source / 'one').write_text('one'); (self.source / 'two').write_text('two')
        self.assertEqual(self.run_relay('--workspace', self.workspace_id, '--into', str(self.dest), '--json').returncode, 0)
        project = self.dest / 'source'; (project / 'one').write_text('new one'); (project / 'two').write_text('new two')
        original_remote = import_workspace.remote
        def inject(ssh, host, workspace, action, request=None):
            result = original_remote(ssh, host, workspace, action, request)
            if action == 'batch_apply': raise ValueError('lost response')
            return result
        with patch.dict(os.environ, self.env, clear=True), patch.object(import_workspace, 'remote', side_effect=inject), contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            result = batch_push.main(['--workspace', self.workspace_id, '--project', str(project), '--json'])
        self.assertEqual(result, 1)
        resumed = subprocess.run([str(RELAY), 'push', '--workspace', self.workspace_id, '--project', str(project), '--json', '--resume'], env=self.env, capture_output=True, text=True)
        self.assertEqual(resumed.returncode, 0, resumed.stdout + resumed.stderr)
        self.assertEqual((self.source / 'one').read_text(), 'new one')
        self.assertEqual((self.source / 'two').read_text(), 'new two')

    def test_multifile_push_refuses_cloud_divergence(self):
        (self.source / 'one').write_text('old one'); (self.source / 'two').write_text('old two')
        self.assertEqual(self.run_relay('--workspace', self.workspace_id, '--into', str(self.dest), '--json').returncode, 0)
        project = self.dest / 'source'
        (project / 'one').write_text('local one'); (project / 'two').write_text('local two')
        (self.source / 'one').write_text('remote one')
        result = subprocess.run([str(RELAY), 'push', '--workspace', self.workspace_id, '--project', str(project), '--json'], env=self.env, capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual((self.source / 'one').read_text(), 'remote one')
        self.assertEqual((self.source / 'two').read_text(), 'old two')

    def test_multifile_push_resumes_interrupted_upload(self):
        (self.source / 'one').write_text('old')
        (self.source / 'two').write_text('old')
        self.assertEqual(self.run_relay('--workspace', self.workspace_id, '--into', str(self.dest), '--json').returncode, 0)
        project = self.dest / 'source'
        (project / 'one').write_text('new')
        (project / 'two').write_text('new')
        command = [str(RELAY), 'push', '--workspace', self.workspace_id, '--project', str(project), '--json']
        self.env['RELAY_TEST_INTERRUPT'] = '1'
        failed = subprocess.run(command, env=self.env, capture_output=True, text=True)
        self.assertNotEqual(failed.returncode, 0)
        self.assertEqual((self.source / 'one').read_text(), 'old')
        self.assertEqual((self.source / 'two').read_text(), 'old')
        del self.env['RELAY_TEST_INTERRUPT']
        resumed = subprocess.run([*command, '--resume'], env=self.env, capture_output=True, text=True)
        self.assertEqual(resumed.returncode, 0, resumed.stdout + resumed.stderr)
        self.assertEqual((self.source / 'one').read_text(), 'new')
        self.assertEqual((self.source / 'two').read_text(), 'new')

    def test_plain_push_refuses_remote_or_extra_local_changes(self):
        (self.source / 'file').write_text('old')
        (self.source / '.env').write_text('TOKEN=old')
        self.assertEqual(self.run_relay('--workspace', self.workspace_id, '--into', str(self.dest), '--json').returncode, 0)
        project = self.dest / 'source'
        (project / 'file').write_text('local')
        (self.source / '.env').write_text('TOKEN=remote')
        pushed = self.run_push(project, 'file')
        self.assertNotEqual(pushed.returncode, 0)
        self.assertEqual((self.source / 'file').read_text(), 'old')
        self.assertEqual((self.source / '.env').read_text(), 'TOKEN=remote')
        (self.source / '.env').write_text('TOKEN=old')
        (project / '.env').write_text('TOKEN=local')
        pushed = self.run_push(project, 'file')
        self.assertNotEqual(pushed.returncode, 0)
        self.assertEqual((self.source / 'file').read_text(), 'old')

    def test_plain_push_resumes_after_lost_response(self):
        from relay_lib import plain_push
        (self.source / 'file').write_text('old')
        self.assertEqual(self.run_relay('--workspace', self.workspace_id, '--into', str(self.dest), '--json').returncode, 0)
        project = self.dest / 'source'
        (project / 'file').write_text('local')
        original = import_workspace.remote
        def lost(ssh, host, workspace, action, request=None):
            result = original(ssh, host, workspace, action, request)
            if action == 'push_one': raise ValueError('lost response')
            return result
        with patch.dict(os.environ, self.env, clear=True), patch.object(import_workspace, 'remote', side_effect=lost), contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            result = plain_push.main(['--workspace', self.workspace_id, '--project', str(project), '--file', 'file', '--json'])
        self.assertEqual(result, 1)
        self.assertEqual((self.source / 'file').read_text(), 'local')
        resumed = self.run_push(project, 'file', '--resume')
        self.assertEqual(resumed.returncode, 0, resumed.stdout + resumed.stderr)
        self.assertEqual((self.source / 'file').read_text(), 'local')
        self.assertEqual(Path(json.loads(resumed.stdout)['remote_recovery_path']).read_text(), 'old')

    def test_remote_git_subdirectory_is_still_rejected(self):
        subprocess.run(['git', 'init', '-q', str(self.base)], check=True)
        (self.source / 'file').write_text('source')
        result = self.run_relay('--workspace', self.workspace_id, '--into', str(self.dest), '--json')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(json.loads(result.stdout)['error'], 'unsupported_git_state')
        self.assertFalse((self.dest / 'source').exists())

    def test_plain_import_inside_parent_git_repository_can_repeat_pull(self):
        subprocess.run(['git', 'init', '-q', str(self.dest)], check=True)
        (self.source / 'file').write_text('first')
        imported = self.run_relay('--workspace', self.workspace_id, '--into', str(self.dest), '--json')
        self.assertEqual(imported.returncode, 0, imported.stdout + imported.stderr)
        (self.source / 'file').write_text('second')
        project = self.dest / 'source'
        updated = self.run_relay('--workspace', self.workspace_id, '--into', str(project), '--update', '--json')
        self.assertEqual(updated.returncode, 0, updated.stdout + updated.stderr)
        self.assertFalse((project / '.git').exists())
        self.assertEqual((project / 'file').read_text(), 'second')

    def test_repeat_pull_preserves_local_excluded_directories(self):
        (self.source / 'file').write_text('old')
        self.assertEqual(self.run_relay('--workspace', self.workspace_id, '--into', str(self.dest), '--json').returncode, 0)
        project = self.dest / 'source'
        (project / '__pycache__').mkdir(); (project / '__pycache__' / 'local.pyc').write_bytes(b'local cache')
        (self.source / 'file').write_text('remote change')
        result = self.run_relay('--workspace', self.workspace_id, '--into', str(project), '--update', '--json')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual((project / 'file').read_text(), 'remote change')
        self.assertEqual((project / '__pycache__' / 'local.pyc').read_bytes(), b'local cache')
        self.assertEqual((Path(json.loads(result.stdout)['recovery_path']) / '__pycache__' / 'local.pyc').read_bytes(), b'local cache')
        receipt = self.run_relay('--resume-update', str(project), '--json')
        self.assertEqual(receipt.returncode, 0, receipt.stdout + receipt.stderr)
        self.assertEqual(json.loads(receipt.stdout)['checkpoint_id'], json.loads(result.stdout)['checkpoint_id'])

    def test_repeat_pull_rejects_symlinks_in_excluded_directories(self):
        (self.source / 'file').write_text('old')
        self.assertEqual(self.run_relay('--workspace', self.workspace_id, '--into', str(self.dest), '--json').returncode, 0)
        project = self.dest / 'source'
        (project / '__pycache__').mkdir(); (project / '__pycache__' / 'link').symlink_to('/tmp')
        (self.source / 'file').write_text('remote')
        result = self.run_relay('--workspace', self.workspace_id, '--into', str(project), '--update', '--json')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual((project / 'file').read_text(), 'old')
        self.assertTrue((project / '__pycache__' / 'link').is_symlink())

    def test_repeat_plain_pull_and_conflict_preserves_runtime_data(self):
        (self.source / '.env').write_text('TOKEN=first')
        (self.source / 'old').write_text('old')
        first = self.run_relay('--workspace', self.workspace_id, '--into', str(self.dest), '--json')
        self.assertEqual(first.returncode, 0, first.stderr + first.stdout)
        project = self.dest / 'source'
        (self.source / '.env').write_text('TOKEN=second')
        (self.source / 'old').unlink()
        (self.source / 'new').write_text('new')
        args = ('--workspace', self.workspace_id, '--into', str(project), '--update', '--json')
        preview = self.run_relay(*args, '--dry-run')
        self.assertEqual(preview.returncode, 0, preview.stdout + preview.stderr)
        plan = json.loads(preview.stdout)
        self.assertEqual(plan['cloud_changes']['.env'], 'modified')
        self.assertNotIn('TOKEN=', preview.stdout + preview.stderr)
        update = self.run_relay(*args)
        self.assertEqual(update.returncode, 0, update.stdout + update.stderr)
        receipt = json.loads(update.stdout)
        self.assertEqual((project / '.env').read_text(), 'TOKEN=second')
        self.assertFalse((project / 'old').exists())
        self.assertEqual((Path(receipt['recovery_path']) / '.env').read_text(), 'TOKEN=first')
        (project / '.env').write_text('TOKEN=local')
        (self.source / '.env').write_text('TOKEN=cloud')
        conflict = self.run_relay(*args, '--dry-run')
        self.assertEqual(json.loads(conflict.stdout)['conflicts'], ['.env'])
        self.assertNotIn('TOKEN=', conflict.stdout + conflict.stderr)
        refused = self.run_relay(*args)
        self.assertNotEqual(refused.returncode, 0)
        self.assertEqual((project / '.env').read_text(), 'TOKEN=local')
        self.assertEqual((self.source / '.env').read_text(), 'TOKEN=cloud')

    def test_update_recovery_after_exchange_before_acknowledgment(self):
        (self.source / 'file').write_text('first')
        self.assertEqual(self.run_relay('--workspace', self.workspace_id, '--into', str(self.dest), '--json').returncode, 0)
        project = self.dest / 'source'
        (self.source / 'file').write_text('second')
        original = import_workspace.write_json_atomic
        def fail_ack(path, data):
            if data.get('parent_id') and data.get('recovery_path'):
                raise OSError('simulated acknowledgment failure')
            return original(path, data)
        with patch.dict(os.environ, self.env, clear=True), patch.object(import_workspace, 'write_json_atomic', side_effect=fail_ack), contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            result = import_workspace.main(['--workspace', self.workspace_id, '--into', str(project), '--update', '--json'])
        self.assertEqual(result, 1)
        self.assertEqual((project / 'file').read_text(), 'second')
        resumed = self.run_relay('--resume-update', str(project), '--json')
        self.assertEqual(resumed.returncode, 0, resumed.stdout + resumed.stderr)
        self.assertEqual((project / 'file').read_text(), 'second')
        (self.source / 'file').write_text('third')
        third = self.run_relay('--workspace', self.workspace_id, '--into', str(project), '--update', '--json')
        self.assertEqual(third.returncode, 0, third.stdout + third.stderr)
        self.assertEqual((project / 'file').read_text(), 'third')

    def test_crash_after_preparation_before_publication_can_resume_or_abort(self):
        (self.source / 'file').write_text('first')
        self.assertEqual(self.run_relay('--workspace', self.workspace_id, '--into', str(self.dest), '--json').returncode, 0)
        project = self.dest / 'source'
        (self.source / 'file').write_text('second')
        with patch.dict(os.environ, self.env, clear=True), patch.object(update_workspace, 'swap', side_effect=OSError('crash before exchange')), contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            result = import_workspace.main(['--workspace', self.workspace_id, '--into', str(project), '--update', '--json'])
        self.assertEqual(result, 1)
        self.assertEqual((project / 'file').read_text(), 'first')
        status = self.run_relay('--inspect-update', str(project), '--json')
        self.assertEqual(json.loads(status.stdout)['phase'], 'publishing')
        self.assertIsNotNone(json.loads(status.stdout)['remote_pending'])
        resumed = self.run_relay('--resume-update', str(project), '--json')
        self.assertEqual(resumed.returncode, 0, resumed.stdout + resumed.stderr)
        self.assertEqual((project / 'file').read_text(), 'second')
        self.assertEqual((Path(json.loads(resumed.stdout)['recovery_path']) / 'file').read_text(), 'first')

    def test_inspect_reports_missing_and_corrupt_downloads_without_values(self):
        (self.source / '.env').write_text('TOKEN=old')
        (self.source / 'file').write_text('old')
        self.assertEqual(self.run_relay('--workspace', self.workspace_id, '--into', str(self.dest), '--json').returncode, 0)
        project = self.dest / 'source'
        (self.source / '.env').write_text('TOKEN=new')
        (self.source / 'file').write_text('new')
        self.env['RELAY_TEST_INTERRUPT'] = '1'
        self.assertNotEqual(self.run_relay('--workspace', self.workspace_id, '--into', str(project), '--update', '--json').returncode, 0)
        pending = next((self.base / '.relay-v0' / 'pairings').glob('*.pending.json'))
        state = json.loads(pending.read_text())
        payload = Path(state['staging']) / 'payload' / 'files'
        payload.mkdir(parents=True, exist_ok=True)
        (payload / '.env').write_text('TOKEN=bad')
        result = self.run_relay('--inspect-update', str(project), '--json')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        progress = json.loads(result.stdout)['payload_files']
        self.assertIn('files/.env', progress['invalid'])
        self.assertIn('files/file', progress['missing'])
        self.assertNotIn('TOKEN=', result.stdout + result.stderr)
        with patch.dict(os.environ, self.env, clear=True), patch.object(import_workspace, 'remote', side_effect=ValueError('offline')), contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(import_workspace.main(['--inspect-update', str(project), '--json']), 0)
        self.assertEqual(json.loads(output.getvalue())['remote_status'], 'unreachable')
        del self.env['RELAY_TEST_INTERRUPT']
        resumed = self.run_relay('--resume-update', str(project), '--json')
        self.assertEqual(resumed.returncode, 0, resumed.stdout + resumed.stderr)
        self.assertEqual((project / '.env').read_text(), 'TOKEN=new')

    def test_source_change_after_publication_never_acknowledges_stale_capture(self):
        (self.source / 'file').write_text('first')
        self.assertEqual(self.run_relay('--workspace', self.workspace_id, '--into', str(self.dest), '--json').returncode, 0)
        project = self.dest / 'source'
        (self.source / 'file').write_text('second')
        original = update_workspace.swap
        def swap_and_edit(a, b):
            original(a, b)
            (self.source / 'file').write_text('third')
        with patch.dict(os.environ, self.env, clear=True), patch.object(update_workspace, 'swap', side_effect=swap_and_edit), contextlib.redirect_stdout(io.StringIO()) as output, contextlib.redirect_stderr(io.StringIO()):
            result = import_workspace.main(['--workspace', self.workspace_id, '--into', str(project), '--update', '--json'])
        self.assertEqual(result, 1)
        self.assertIn('source changed before acknowledgment', output.getvalue())
        self.assertEqual((project / 'file').read_text(), 'second')
        inspect = json.loads(self.run_relay('--inspect-update', str(project), '--json').stdout)
        self.assertNotEqual(inspect['transfer_id'], inspect['remote_checkpoint'])
        self.assertEqual(inspect['transfer_id'], inspect['remote_pending'])
        self.assertEqual((Path(inspect['staging']) / 'project' / 'file').read_text(), 'first')
        self.assertEqual((self.source / 'file').read_text(), 'third')

    def test_lost_remote_ack_response_resumes_idempotently(self):
        (self.source / 'file').write_text('first')
        self.assertEqual(self.run_relay('--workspace', self.workspace_id, '--into', str(self.dest), '--json').returncode, 0)
        project = self.dest / 'source'
        (self.source / 'file').write_text('second')
        original = update_workspace.remote_cp
        def lost(importer, vm, pair, action, checkpoint=None, transfer_id=None):
            result = original(importer, vm, pair, action, checkpoint, transfer_id)
            if action == 'commit': raise OSError('lost acknowledgment response')
            return result
        with patch.dict(os.environ, self.env, clear=True), patch.object(update_workspace, 'remote_cp', side_effect=lost), contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            result = import_workspace.main(['--workspace', self.workspace_id, '--into', str(project), '--update', '--json'])
        self.assertEqual(result, 1)
        status = self.run_relay('--inspect-update', str(project), '--json')
        self.assertEqual(status.returncode, 0, status.stdout + status.stderr)
        self.assertEqual(json.loads(status.stdout)['phase'], 'acknowledging')
        aborted = self.run_relay('--abort-update', str(project), '--json')
        self.assertNotEqual(aborted.returncode, 0)
        resumed = self.run_relay('--resume-update', str(project), '--json')
        self.assertEqual(resumed.returncode, 0, resumed.stdout + resumed.stderr)
        self.assertEqual((project / 'file').read_text(), 'second')
        self.assertEqual((Path(json.loads(resumed.stdout)['recovery_path']) / 'file').read_text(), 'first')

    def test_abort_interrupted_download_leaves_original_and_remote_base(self):
        (self.source / 'file').write_text('first')
        self.assertEqual(self.run_relay('--workspace', self.workspace_id, '--into', str(self.dest), '--json').returncode, 0)
        project = self.dest / 'source'
        (self.source / 'file').write_text('second')
        self.env['RELAY_TEST_INTERRUPT'] = '1'
        self.assertNotEqual(self.run_relay('--workspace', self.workspace_id, '--into', str(project), '--update', '--json').returncode, 0)
        del self.env['RELAY_TEST_INTERRUPT']
        inspected = self.run_relay('--inspect-update', str(project), '--json')
        self.assertEqual(json.loads(inspected.stdout)['phase'], 'downloading')
        result = self.run_relay('--abort-update', str(project), '--json')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual((project / 'file').read_text(), 'first')
        retry = self.run_relay('--workspace', self.workspace_id, '--into', str(project), '--update', '--json')
        self.assertEqual(retry.returncode, 0, retry.stdout + retry.stderr)

    def test_update_rejects_unpaired_and_git_destinations(self):
        other = self.dest / 'other'
        other.mkdir()
        (other / 'keep').write_text('local')
        args = ('--workspace', self.workspace_id, '--into', str(other), '--update', '--json')
        self.assertNotEqual(self.run_relay(*args).returncode, 0)
        self.assertEqual((other / 'keep').read_text(), 'local')
        subprocess.run(['git', 'init', '-q', str(self.source)], check=True)
        self.assertEqual(self.run_relay('--workspace', self.workspace_id, '--into', str(self.dest), '--json').returncode, 0)
        git_project = self.dest / 'source'
        result = self.run_relay('--workspace', self.workspace_id, '--into', str(git_project), '--update', '--json')
        self.assertIn('UNSUPPORTED', result.stdout)
        self.assertTrue((git_project / '.git').is_dir())

    def test_update_interrupted_download_resumes(self):
        (self.source / 'file').write_text('first')
        self.assertEqual(self.run_relay('--workspace', self.workspace_id, '--into', str(self.dest), '--json').returncode, 0)
        project = self.dest / 'source'
        (self.source / 'file').write_text('second')
        self.env['RELAY_TEST_INTERRUPT'] = '1'
        result = self.run_relay('--workspace', self.workspace_id, '--into', str(project), '--update', '--json')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual((project / 'file').read_text(), 'first')
        del self.env['RELAY_TEST_INTERRUPT']
        resumed = self.run_relay('--resume-update', str(project), '--json')
        self.assertEqual(resumed.returncode, 0, resumed.stdout + resumed.stderr)
        self.assertEqual((project / 'file').read_text(), 'second')

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
