# Relay V0 prototype

This is a narrow rehearsal of Relay's first handoff: a dirty Git working tree
moves from macOS to an SSH target, then can be used through a remote `tmux`
session. `--vm` accepts either a Lima VM name or a normal SSH host alias from
`~/.ssh/config`.

```bash
./relay doctor --vm relay-v0
./relay push --project /absolute/path/to/project --vm relay-v0
./relay connect --project /absolute/path/to/project --vm relay-v0
./relay pull --project /absolute/path/to/project --vm relay-v0 > remote.patch
./relay pull --project /absolute/path/to/project --vm relay-v0 --apply
```

`push` transfers a Git bundle for the base commit, separate staged and
unstaged binary patches, and every non-ignored untracked file. It restores
remotely and verifies both Git patch hashes.

The first push records an internal handoff snapshot on the VM. `pull` exports only
the changes made after that snapshot, so it does not echo the Mac's original
dirty files back. Its binary Git patch includes tracked changes and newly created,
non-ignored untracked files. `--apply` first verifies the same local Git base and
a clean patch application; otherwise it refuses without changing the local
workspace.

The test target is not a mount. Relay copies an archive over SSH, matching the
future cloud transport boundary.
