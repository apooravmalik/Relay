"""Cross-language guard tests: actual Node-created store, standalone SSH helper."""
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from relay_lib import export_workspace as helper


@unittest.skipUnless(shutil.which('node'), 'Node runtime required for cross-language guard fixture')
class SessionGuardTests(unittest.TestCase):
    def setUp(self):
        self.fixture = tempfile.TemporaryDirectory(prefix='relay-guard-')
        self.root = Path(self.fixture.name)
        self.controller = self.root / 'controller'
        self.workspace = self.root / 'workspace'
        self.workspace.mkdir()
        module = (Path(__file__).resolve().parents[1] / 'pwa/lib/session-store.mjs').as_uri()
        script = f"""import {{ SessionStore }} from {json.dumps(module)};
const s=new SessionStore(process.argv[1]+'/sessions',{{requiredMarker:process.argv[1]+'/sessions-required'}});
const body={{text:'fixture',createdAt:Date.now(),idempotencyKey:'guard-fixture-key-123'}};
const {{input,digest}}=SessionStore.request(body);
s.reserve({{owner:'owner',workspace:{{id:'fixture',path:process.argv[2]}},key:body.idempotencyKey,input,digest,bootId:'fixture-boot'}});s.close();"""
        subprocess.run(['node', '--input-type=module', '-e', script, str(self.controller), str(self.workspace)], check=True, capture_output=True)
        self.environment = patch.dict(os.environ, {'RELAY_CONTROLLER_STATE_DIR': str(self.controller)})
        self.environment.start()

    def tearDown(self):
        self.environment.stop()
        self.fixture.cleanup()

    def test_all_capture_publication_and_checkpoint_mutation_paths_refuse_active_and_uncertain(self):
        actions = [
            lambda: helper.capture(self.workspace, 'fixture'),
            lambda: helper.push_one(self.workspace, 'fixture', {}),
            lambda: helper.batch_begin(self.workspace, 'fixture', {}),
            lambda: helper.batch_apply(self.workspace, 'fixture', {}),
            lambda: helper.git_handoff_remote(self.workspace, 'fixture', 'git_apply', {}),
            lambda: helper.export_manifest(self.workspace, 'fixture', {}),
            lambda: helper.checkpoint(self.workspace, 'fixture', {'action': 'prepare'}),
            lambda: helper.checkpoint(self.workspace, 'fixture', {'action': 'commit'}),
            lambda: helper.checkpoint(self.workspace, 'fixture', {'action': 'abort'}),
        ]
        database = self.controller / 'sessions/sessions.sqlite'
        for state in ['STARTING', 'RUNNING', 'CANCEL_REQUESTED', 'UNCERTAIN']:
            with sqlite3.connect(database) as connection:
                connection.execute('UPDATE sessions SET state=?', (state,))
            for action in actions:
                with self.subTest(state=state, action=action), self.assertRaisesRegex(RuntimeError, 'source_busy'):
                    action()
        self.assertEqual(list(self.workspace.iterdir()), [])

    def test_missing_corrupt_or_unknown_store_and_removed_store_directory_fail_closed(self):
        directory = self.controller / 'sessions'
        database = directory / 'sessions.sqlite'
        database.unlink()
        with self.assertRaisesRegex(RuntimeError, 'source_busy'):
            helper.assert_session_idle('fixture')
        database.write_bytes(b'not sqlite')
        with self.assertRaisesRegex(RuntimeError, 'source_busy'):
            helper.assert_session_idle('fixture')
        shutil.rmtree(directory)
        with self.assertRaisesRegex(RuntimeError, 'source_busy'):
            helper.assert_session_idle('fixture')

    def test_terminal_guard_must_be_cleared_and_new_legacy_installations_remain_usable(self):
        database = self.controller / 'sessions/sessions.sqlite'
        with sqlite3.connect(database) as connection:
            connection.execute("UPDATE sessions SET state='COMPLETED'")
        with self.assertRaisesRegex(RuntimeError, 'source_busy'):
            helper.assert_session_idle('fixture')
        with sqlite3.connect(database) as connection:
            connection.execute('DELETE FROM workspace_guards')
        helper.assert_session_idle('fixture')
        with patch.dict(os.environ, {'RELAY_CONTROLLER_STATE_DIR': str(self.root / 'fresh-controller')}):
            helper.assert_session_idle('fixture')


if __name__ == '__main__':
    unittest.main()
