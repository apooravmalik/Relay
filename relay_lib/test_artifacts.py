"""Tests for encrypted recovery storage and bounded retention."""
import os
from pathlib import Path
import shutil
import tempfile
import unittest

from relay_lib import artifacts


@unittest.skipUnless(shutil.which('age') and shutil.which('age-keygen'), 'age tools are required')
class ArtifactStoreTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name) / 'relay'
        self.source = Path(self.temporary.name) / 'source'
        self.source.mkdir()
        (self.source / '.env').write_text('TOKEN=synthetic-secret')
        self.previous = {key: os.environ.get(key) for key in (
            'RELAY_ARTIFACT_TTL_SECONDS', 'RELAY_ARTIFACT_LIMIT_BYTES',
            'RELAY_ARTIFACT_FREE_BYTES')}
        self.addCleanup(self.restore_environment)
        os.environ['RELAY_ARTIFACT_TTL_SECONDS'] = '10'
        os.environ['RELAY_ARTIFACT_LIMIT_BYTES'] = str(1024 * 1024)
        os.environ['RELAY_ARTIFACT_FREE_BYTES'] = '0'

    def restore_environment(self):
        for key, value in self.previous.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    def test_archive_is_encrypted_and_restorable(self):
        store = artifacts.ArtifactStore(self.base)
        archive = store.seal('vm-' + 'a' * 32, self.source, workspace='workspace', group='vm:test')
        self.assertNotIn(b'TOKEN=synthetic-secret', archive.read_bytes())
        with tempfile.TemporaryDirectory() as target:
            payload = artifacts.decrypt_archive(archive, store, Path(target))
            self.assertEqual((payload / '.env').read_text(), 'TOKEN=synthetic-secret')

    def test_expiry_keeps_newest_ready_and_pending_artifacts(self):
        clock = [100]
        store = artifacts.ArtifactStore(self.base, now=lambda: clock[0])
        first = store.seal('vm-' + 'b' * 32, self.source, workspace='workspace', group='vm:test')
        store.mark(first.stem, pending=False)
        clock[0] = 120
        second = store.seal('vm-' + 'c' * 32, self.source, workspace='workspace', group='vm:test')
        store.mark(second.stem, pending=False)
        pending = store.seal('vm-' + 'd' * 32, self.source, workspace='workspace', group='vm:other', pending=True)
        clock[0] = 200
        store.cleanup('workspace')
        self.assertFalse(first.exists())
        self.assertTrue(second.exists())
        self.assertTrue(pending.exists())

    def test_quota_refusal_does_not_install_partial_artifact(self):
        os.environ['RELAY_ARTIFACT_LIMIT_BYTES'] = '1'
        store = artifacts.ArtifactStore(self.base)
        with self.assertRaisesRegex(artifacts.ArtifactError, 'artifact_quota'):
            store.seal('vm-' + 'e' * 32, self.source, workspace='workspace', group='vm:test')
        self.assertFalse((store.root / ('vm-' + 'e' * 32 + '.age')).exists())


if __name__ == '__main__':
    unittest.main()
