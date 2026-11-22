import tempfile
import unittest
from pathlib import Path

from relay_lib import export_workspace, import_workspace


class RelayIgnoreTests(unittest.TestCase):
    def test_rules_match_components_and_root_relative_globs(self):
        rules = export_workspace.parse_relayignore(
            b'protect .env\nprotect credentials/**\nexclude scratch/**\nexclude local-only.db\n')
        disposition = lambda path: export_workspace.relayignore_disposition(path, rules)
        self.assertEqual(disposition('nested/.env'), 'protect')
        self.assertEqual(disposition('credentials/sub/key.txt'), 'protect')
        self.assertEqual(disposition('other/credentials/key.txt'), 'transfer')
        self.assertEqual(disposition('scratch/nested/a'), 'exclude')
        self.assertEqual(disposition('other/local-only.db'), 'exclude')
        self.assertEqual(disposition('.relayignore'), 'metadata')

    def test_exclusion_precedes_protection_and_defaults_protect_secrets(self):
        rules = export_workspace.parse_relayignore(b'protect secrets/**\nexclude secrets/.env\n')
        self.assertEqual(export_workspace.relayignore_disposition('secrets/.env', rules), 'exclude')
        self.assertEqual(export_workspace.relayignore_disposition('nested/.env.production', []), 'protect')
        self.assertEqual(export_workspace.relayignore_disposition('private.pem', []), 'protect')

    def test_malformed_rules_are_rejected(self):
        for data in (b'ignore file', b'exclude ../file', b'exclude /file',
                     b'exclude foo/**bar', b'exclude foo/[abc]', b'\xff'):
            with self.subTest(data=data), self.assertRaisesRegex(RuntimeError, 'invalid_policy'):
                export_workspace.parse_relayignore(data)

    def test_nonregular_policy_blocks_capture_and_preview(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / '.relayignore').mkdir()
            (root / 'secret').write_text('dummy secret')
            with self.assertRaisesRegex(RuntimeError, 'invalid_policy'):
                export_workspace.inspect(root)

    def test_resume_rejects_old_snapshot_with_policy_before_transfer(self):
        state = {'manifest': {'git': {}, 'entries': [{'path': '.relayignore', 'type': 'file'}]}}
        with self.assertRaisesRegex(ValueError, 'unsupported_policy'):
            import_workspace.finish_transfer(None, state, None)


if __name__ == '__main__':
    unittest.main()
