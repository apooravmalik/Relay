# Plain workspace handoff

Relay supports an experimental, human-initiated handoff between a registered VM
workspace and a paired local plain directory. Use authenticated SSH, pause
independent writers on both endpoints, and review the preview before applying.
The same workflow is not yet available for repeating Git workspace handoffs.

```bash
./relay workspaces --vm VM
./relay pull --workspace WORKSPACE_ID --into PARENT_DIR --vm VM --dry-run
./relay pull --workspace WORKSPACE_ID --into PARENT_DIR --vm VM

# Later, preview and push all eligible local changes from the paired folder.
./relay push --workspace WORKSPACE_ID --project PAIRED_DIR --vm VM --dry-run
./relay push --workspace WORKSPACE_ID --project PAIRED_DIR --vm VM

# After VM-side work, preview and pull back into the same folder.
./relay pull --workspace WORKSPACE_ID --into PAIRED_DIR --update --vm VM --dry-run
./relay pull --workspace WORKSPACE_ID --into PAIRED_DIR --update --vm VM
```

If a batch push is interrupted, rerun the push with `--resume`. For a pending
repeat pull, use `relay pull --inspect-update PAIRED_DIR --vm VM`, then
`--resume-update` or, where safe, `--abort-update`. Relay retains previous
versions for recovery and reports their locations. Treat those directories and
VM exports as private: they can contain `.env` files, databases or credentials.
They are not automatically encrypted or expired. Do not publish them in Git.

Batch push stages regular-file changes using bounded memory and a resumable
transfer. It can handle files larger than 10 MiB, but needs sufficient staging
and recovery space. It refuses source or destination divergence; it does not
automatically merge. It supports additions, modifications, deletions and
supported directory changes, but file/directory type transitions, symlinks,
special files and cross-filesystem VM publication are unsupported. The VM's
open-file check is advisory; it cannot prevent a new external writer. Multi-file
publication occurs one file at a time and is not atomically visible as a whole.

Repeat pull currently captures the full workspace and may take significant
space and time even when only a few files changed. Local excluded directories
are preserved when their contents are supported regular files and directories.
A raw copy of a running database is not necessarily a consistent backup; use an
application-consistent snapshot or stop the database first.

An isolated temporary fixture can optionally exercise real SSH by setting
`RELAY_DISPOSABLE_TEST_VM` to a trusted SSH alias and running
`python3 -m unittest relay_lib.test_vm_plain_push`. It creates and removes an
isolated temporary directory on that host; it does not test a live project.
