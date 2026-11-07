import os
from pathlib import Path
import tempfile
import unittest

from relay_lib.manifest import inventory


class ManifestTests(unittest.TestCase):
    def test_detects_content_and_mode_changes(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "a file"
            path.write_bytes(b"before\0")
            before = inventory(temp)
            path.write_bytes(b"after\0")
            os.chmod(path, 0o755)
            after = inventory(temp)
            self.assertNotEqual(before[0]["sha256"], after[0]["sha256"])
            self.assertTrue(after[0]["executable"])

    def test_rejects_symlinks_in_snapshot(self):
        with tempfile.TemporaryDirectory() as temp:
            (Path(temp) / "escape").symlink_to("/etc")
            with self.assertRaisesRegex(ValueError, "symlinks"):
                inventory(temp)


if __name__ == "__main__":
    unittest.main()
