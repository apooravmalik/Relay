import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

from relay_lib import export_workspace as engine


@unittest.skipUnless(sys.platform.startswith('linux'), 'Linux writer fence')
class WriterFenceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='relay-writer-fence-')
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name).resolve()
        self.root = self.home / 'workspace'
        self.root.mkdir()
        self.file = self.root / 'file'
        self.file.write_text('original')

    def test_fails_closed_when_a_writer_is_already_open(self):
        with self.file.open('a'):
            with self.assertRaisesRegex(RuntimeError, 'source_busy'):
                with engine.WriterFence(self.root):
                    self.fail('An open writer must prevent verification.')
        with engine.WriterFence(self.root) as fence:
            self.assertEqual(self.file.read_text(), 'original')
            fence.check()

    def test_namespace_change_invalidates_the_fence(self):
        with engine.WriterFence(self.root) as fence:
            (self.root / 'added').mkdir()
            with self.assertRaisesRegex(RuntimeError, 'writer_conflict'):
                fence.check()

    def test_checkpoint_write_restores_pending_state_if_namespace_changes_during_sync(self):
        workspace_id, transfer, endpoint = 'a' * 16, 'b' * 32, 'c' * 64
        with patch.object(Path, 'home', return_value=self.home):
            manifest, _ = engine.capture(self.root, workspace_id)
            base = {key: manifest[key] for key in ('workspace_id', 'source_path', 'transfer_id', 'git', 'entries')}
            base.update(endpoint=endpoint, parent_id=None, generation=0, schema_version=1)
            proposed = dict(base, parent_id=base['transfer_id'], transfer_id=transfer, generation=1)
            engine.checkpoint(self.root, workspace_id, {'action': 'init', 'endpoint': endpoint, 'checkpoint': base})
            export = self.home / '.relay-v0/exports' / transfer
            export.mkdir()
            engine._push_write_json(export / 'manifest.json', proposed)
            engine.checkpoint(self.root, workspace_id, {'action': 'prepare', 'endpoint': endpoint, 'checkpoint': proposed})
            sync_directory = engine._batch_sync_dir

            def sync_with_late_change(directory):
                sync_directory(directory)
                if not (self.root / 'external-directory').exists():
                    os.mkdir(self.root / 'external-directory')

            with engine.WriterFence(self.root) as fence, engine.checkpoint_fence(workspace_id, fence):
                with patch.object(engine, '_batch_sync_dir', side_effect=sync_with_late_change):
                    with self.assertRaisesRegex(RuntimeError, 'writer_conflict'):
                        engine.checkpoint(self.root, workspace_id, {'action': 'commit', 'endpoint': endpoint, 'transfer_id': transfer})
            current = engine.checkpoint(self.root, workspace_id, {'action': 'get', 'endpoint': endpoint})
            self.assertEqual(current, {'checkpoint': base, 'pending': proposed})
            self.assertTrue((self.root / 'external-directory').is_dir())
