import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from relay_lib import monitor_rag


class MonitorTests(unittest.TestCase):
    def test_records_after_two_failures_without_duplicates_and_notes_recovery(self):
        with tempfile.TemporaryDirectory() as temp:
            log = Path(temp) / 'problems.md'
            log.write_text('# Problems\n')
            with patch.object(monitor_rag, 'ISSUES', log):
                state = {}
                monitor_rag.record({'rag_app': 'Unavailable.'}, state)
                self.assertNotIn('Unavailable.', log.read_text())
                monitor_rag.record({'rag_app': 'Unavailable.'}, state)
                monitor_rag.record({'rag_app': 'Unavailable.'}, state)
                self.assertEqual(log.read_text().count('Unavailable.'), 1)
                monitor_rag.record({'connection': 'Offline.'}, state)
                self.assertNotIn('recovery', log.read_text())
                monitor_rag.record({}, state)
                self.assertIn('Monitor recovery — rag_app', log.read_text())

    def test_health_checks_distinguish_unavailable_containers(self):
        response = {'pwa': 'active', 'app': 200, 'qdrant': 200, 'containers': {'rag-lab-app-1': 'running healthy', 'rag-lab-qdrant-1': 'running'}}
        with patch.object(monitor_rag.subprocess, 'run') as run:
            run.return_value.returncode = 0
            run.return_value.stdout = json.dumps(response)
            self.assertEqual(monitor_rag.check(), {})
            response['containers']['rag-lab-app-1'] = 'restarting'
            response['app'] = None
            run.return_value.stdout = json.dumps(response)
            self.assertIn('rag_app', monitor_rag.check())


if __name__ == '__main__': unittest.main()
