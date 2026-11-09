import unittest
from relay_lib.transfer_plan import build_plan


def file(path, digest, size=1):
    return {'path': path, 'type': 'file', 'sha256': digest, 'mode': 0o600, 'size': size}


class TransferPlanTests(unittest.TestCase):
    def test_multiple_files_large_file_and_runtime_are_listed_without_content(self):
        base = [file('.env', 'old'), file('large.bin', 'old', 20_000_000), file('gone', 'old')]
        local = [file('.env', 'new'), file('large.bin', 'new', 20_000_000), file('added', 'new')]
        plan = build_plan(base, local, base)
        self.assertEqual(plan['local_changes'], {'.env': 'modified', 'added': 'added', 'gone': 'deleted', 'large.bin': 'modified'})
        self.assertEqual(plan['estimated_bytes'], 20_000_002)
        self.assertEqual(plan['files'][0]['category'], 'sensitive-runtime')
        self.assertEqual(plan['status'], 'LOCAL_AHEAD')

    def test_delete_against_modified_descendant_is_conflict(self):
        base = [{'path': 'dir', 'type': 'directory'}, file('dir/file', 'old')]
        self.assertEqual(build_plan(base, [], [base[0], file('dir/file', 'new')])['status'], 'CONFLICT')

    def test_disjoint_changes_are_reported_but_not_merged(self):
        base = [file('one', 'old'), file('two', 'old')]
        plan = build_plan(base, [file('one', 'new'), base[1]], [base[0], file('two', 'new')])
        self.assertEqual(plan['status'], 'BOTH_CHANGED')
        self.assertEqual(plan['conflicts'], [])

    def test_invalid_or_duplicate_paths_rejected(self):
        with self.assertRaises(ValueError): build_plan([], [file('../secret', 'x')], [])
        with self.assertRaises(ValueError): build_plan([], [file('a', 'x'), file('a', 'y')], [])


if __name__ == '__main__': unittest.main()
