import errno
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from relay_lib.publication import publish_noreplace


class PublicationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / 'staged'
        self.source.mkdir()
        (self.source / 'file').write_text('staged')
        self.destination = self.root / 'destination'

    def test_publishes_directory(self):
        publish_noreplace(self.source, self.destination)
        self.assertFalse(self.source.exists())
        self.assertEqual((self.destination / 'file').read_text(), 'staged')

    def test_existing_directory_or_symlink_is_never_replaced(self):
        for kind in ('directory', 'symlink'):
            with self.subTest(kind=kind):
                if kind == 'directory':
                    self.destination.mkdir()
                else:
                    self.destination.symlink_to(self.root / 'missing')
                with self.assertRaises(OSError) as caught:
                    publish_noreplace(self.source, self.destination)
                self.assertEqual(caught.exception.errno, errno.EEXIST)
                self.assertEqual((self.source / 'file').read_text(), 'staged')
                if kind == 'directory': self.destination.rmdir()
                else: self.destination.unlink()

    def test_unsupported_platform_fails_closed(self):
        with patch('relay_lib.publication.sys.platform', 'unsupported'):
            with self.assertRaises(OSError) as caught:
                publish_noreplace(self.source, self.destination)
        self.assertEqual(caught.exception.errno, errno.ENOTSUP)
        self.assertTrue(self.source.is_dir())
        self.assertFalse(self.destination.exists())


if __name__ == '__main__':
    unittest.main()
