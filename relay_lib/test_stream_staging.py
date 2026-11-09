import hashlib
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from relay_lib.stream_staging import stage_file, StagingError


class StreamStagingTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name); self.source = self.root / 'source'; self.dest = self.root / 'staging' / 'file'
        self.data = b'private synthetic token\n' * 500000
        self.source.write_bytes(self.data); self.source.chmod(0o600)
        self.entry = {'type': 'file', 'size': len(self.data), 'sha256': hashlib.sha256(self.data).hexdigest(), 'mode': 0o600}

    def test_file_over_ten_mib_is_streamed_and_verified(self):
        self.assertGreater(len(self.data), 10 * 1024 * 1024)
        stage_file(self.source, self.dest, self.entry, chunk_size=65536)
        self.assertEqual(hashlib.sha256(self.dest.read_bytes()).hexdigest(), self.entry['sha256'])
        self.assertEqual(self.dest.stat().st_mode & 0o777, 0o600)

    def test_valid_partial_resumes_and_bad_partial_fails_closed(self):
        self.dest.parent.mkdir()
        partial = self.dest.with_name('file.partial')
        partial.write_bytes(self.data[:123456])
        stage_file(self.source, self.dest, self.entry, chunk_size=65536)
        self.assertEqual(self.dest.stat().st_size, len(self.data))
        self.dest.unlink(); partial.write_bytes(b'wrong')
        with self.assertRaises(StagingError): stage_file(self.source, self.dest, self.entry)
        self.assertFalse(self.dest.exists())
        self.assertEqual(partial.read_bytes(), b'wrong')

    def test_existing_destination_and_low_space_never_overwrite(self):
        self.dest.parent.mkdir(); self.dest.write_text('keep')
        with self.assertRaises(StagingError): stage_file(self.source, self.dest, self.entry)
        self.assertEqual(self.dest.read_text(), 'keep')
        self.dest.unlink()
        with patch('relay_lib.stream_staging.shutil.disk_usage', return_value=type('Usage', (), {'free': 0})()):
            with self.assertRaises(StagingError): stage_file(self.source, self.dest, self.entry)
        self.assertFalse(self.dest.exists())


if __name__ == '__main__': unittest.main()
