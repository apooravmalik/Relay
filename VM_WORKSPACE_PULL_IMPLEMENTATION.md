# VM workspace pull: implementation design

**Date:** 8 November 2026  
**Status:** Proposed implementation; no new transfer code deployed  
**Related:** [testing PRD](RELAY_TESTING_PRD.md), RLY-003, RLY-012 and RLY-014 in
[the open-problems log](RELAY_OPEN_PROBLEMS.md).

## 1. User contract

When a user requests a VM workspace on their PC, Relay creates a project folder
under a chosen local projects directory and transfers the selected workspace.

- **Plain directory:** transfer the included files directly. Do not initialize
  Git, require a Git remote, or manufacture a commit.
- **Git repository with commits:** restore the VM's captured `HEAD` and its
  reachable history, then restore staged changes, unstaged changes and included
  untracked files. Do not require that the commits exist on GitHub or elsewhere.
- **Git initialized without any commits:** preserve the unborn branch and
  staged/untracked distinction without creating a synthetic initial commit.

“Latest commit” means the checked-out VM `HEAD` at snapshot time, not the tip of
some other branch or upstream remote. Import must not run an implicit upstream
`git pull`, merge, rebase or reset on either machine.

Initial import writes to a **new, absent destination**. An existing path,
including an empty directory or symlink, is a conflict in v1. Offer another
folder name; never silently merge into or delete an existing local project.
An intentional future update to a registered local project is a distinct
operation requiring conflict checks. Until supported, it returns a clear error
or imports a separate named copy.

## 2. Researched transport choice

**Recommendation: rsync over SSH, from an immutable export to private local
staging, followed by manifest verification and final directory publication.**
This is an engineering recommendation for Relay's resumable Linux/macOS import,
not a claim that rsync alone supplies a transactional workspace protocol.

The official [rsync manual](https://www.samba.org/ftp/rsync/rsync.1) documents
remote-shell transfer, partial-transfer directories and delayed updates. It
describes delayed updates as closer to atomic, not an atomic directory-wide
transaction. Relay therefore supplies its own staging and publication protocol.
Use capabilities supported by both installed rsync versions and check them
with `relay doctor`; do not assume the system rsync on macOS has modern flags.

| Option | Decision for first release |
|---|---|
| rsync over SSH | Selected for resumable snapshot transfer; no public rsync daemon |
| tar/scp over SSH | Fits today's prototype, but whole-archive retry and safe extraction add work; defer as a fallback |
| Git clone/pull only | Insufficient for plain directories and dirty Git state |
| Copy live `.git` | Reject: host-specific metadata, config and hooks are not the portable state contract |
| Mounted filesystem/continuous sync | Outside this explicit import operation |

[Git bundle documentation](https://git-scm.com/docs/git-bundle) states that
bundles contain selected reachable commits/refs but omit index and working-tree
state, configuration and hooks. Use a self-contained bundle for the selected
history plus separate dirty-state payloads. Export only the selected branch's
ancestry by default, not all branches, stashes and private Relay refs.

[Git diff](https://git-scm.com/docs/git-diff) supports binary patches with full
object IDs. [Git apply](https://git-scm.com/docs/git-apply) distinguishes applying
to the index/worktree together from applying only to working-tree files. This
allows Relay to preserve staged and unstaged differences separately.

If an archive fallback is introduced later, follow [GNU tar's extraction
guidance](https://www.gnu.org/software/tar/manual/html_section/Security.html):
extract into a protected empty location and avoid unsafe path/overwrite options.
It still needs the same manifest, containment and resource-limit checks.

## 3. Proposed interface and compatibility

Examples below are **new interface proposals**, not commands supported today:

```bash
relay pull --workspace WORKSPACE_ID --into ~/Projects --vm relay-do-v0 --dry-run
relay pull --workspace WORKSPACE_ID --into ~/Projects --vm relay-do-v0
relay pull --workspace WORKSPACE_ID --into ~/Projects --name rag-lab --vm relay-do-v0
relay pull --resume TRANSFER_ID --vm relay-do-v0
```

Resolve the workspace by stable registry ID, not basename or arbitrary remote
path. `--into` is an existing, locally selected parent; an optional `--name`
must be one safe filename component. Preview destination, Git mode/commit,
included bytes/files, exclusions, detected blockers and estimated space.

Keep the current `relay pull --project DIR [--apply]` delta behavior unchanged.
Reject mixed legacy/import options. Stream progress and diagnostics to stderr;
offer a versioned JSON result for integration.

The local CLI performs the write. A phone PWA cannot directly create arbitrary
directories on an offline PC. Phone-triggered import later needs a separately
enrolled outbound PC agent, selected destination roots and queued-job status.
That agent is not a dependency for CLI-based v1 import.

## 4. Components and protocol

Keep Bash as the existing CLI entry point and delegate the new operation to a
Python 3 helper for structured manifests, safe paths, hashing and state files.
Add Python and rsync capability checks; do not silently install dependencies.
Suggested modules:

```text
relay                         argument dispatch and backward compatibility
relay_lib/import_workspace.py local orchestration, publication and recovery
relay_lib/export_workspace.py VM snapshot creation and snapshot-ID validation
relay_lib/manifest.py          canonical manifest, path/type checks and hashes
relay_lib/git_export.py        Git-state capture and reconstruction
```

Use the same versioned helper protocol on both hosts. Return JSON from remote
operations and invoke fixed executable/argument structures, never interpolate
workspace names into arbitrary shell code. Remote access is restricted to a
registered canonical workspace and the owner's export directory. Initial
enrollment may extend the current configured-root registry with stable IDs.

```text
plan → capture → snapshot_ready → transferring → verifying
     → restoring_git → publishing → completed
```

Plain imports skip Git restoration. Errors are explicit states, including
`source_busy`, `source_changed`, `destination_exists`, `unsupported_git_state`,
`permission_denied`, `disk_full`, `verification_failed` and `interrupted`.

## 5. Stable capture on the VM

Create a uniquely named owner-only export under the Relay state directory,
outside the project. Record the requested workspace identity and real path.
Refuse a different root, an active competing transfer or insufficient space.

Acquire a workspace export lock and coordinate a pause with Relay-managed
writers. Ask users to stop independent writers and watchers for the capture.
An advisory lock does not stop an arbitrary terminal/editor; if the workspace
cannot be quiesced, fail with `source_busy`. Require the same behavior for plain
directories, not only Git workspaces.

Capture into independent storage: do not use hardlinks to mutable source files.
Copy through no-follow file operations, verify captured bytes and compare
source metadata/content and Git state before/after capture. Treat a mismatch
as `source_changed` and retry only a bounded number of times. These comparisons
detect many races but are not proof of a simultaneous filesystem snapshot;
the supported consistency contract requires paused writers. Record that
limitation. A filesystem snapshot adapter can strengthen it later.

After capture, seal the payload and manifest as immutable to the export
protocol; subsequent PC transfer and resume use that snapshot, not live files.
Release the writer pause once capture is sealed. The VM can resume work while
the PC receives the older, explicitly identified snapshot. If malicious actors
can write as the same VM user, this protocol is not an isolation boundary.

## 6. Payload by project type

### Plain directory

Create `payload/files/` containing only policy-selected regular files,
directories and supported symlinks. Preserve bytes, safe relative paths,
executable bits and empty directories. Use local ownership; do not preserve
VM UID/GID, ACLs, setuid bits or device files. Record any unsupported metadata.
Do not create `.git` in the final project.

### Git repository with commits

1. Resolve Git state with Git commands, including canonical top-level and
   common Git directory; do not assume `.git` is a directory. Linked worktrees
   use separate metadata and shared refs, as described in the
   [worktree documentation](https://git-scm.com/docs/git-worktree).
2. Pin captured `HEAD`, object format and symbolic branch/detached state. Build
   a self-contained bundle in export-owned scratch storage containing its
   ancestry and an export ref. Do not add commits/refs to the user's repository.
3. Capture `HEAD → index` and `index → working tree` binary patches, with
   external diff/textconv disabled. Copy included untracked files separately.
   Use NUL-delimited file lists; never parse filenames by whitespace or lines.
4. In local staging, verify the bundle, create a fresh repository without
   checkout, restore captured `HEAD` and its branch/detached state, then check
   and apply the staged patch to both index and worktree. Check and apply the
   unstaged patch to the worktree only; finally restore untracked payload.
5. Verify the commit ID, index tree, staged/unstaged patches, untracked list,
   deletions, modes and final included-file manifest against the capture.

Do not synthesize a commit from uncommitted changes. Preserve a file that has
both staged and unstaged edits. Ensure checkout/patch behavior does not silently
convert line endings; mismatch against the manifest is a hard failure.

Use a controlled Git environment for capture/restoration: no copied hooks,
credential helpers, external filters, text conversions or source Git config.
Do not run project tasks or fetch upstream automatically. Restore an original
remote URL only through a validated, credential-free allowlisted field; never
make the temporary bundle path the permanent origin. Otherwise leave the
remote unset and report it.

### Git initialized, no commits

Detect an unborn branch separately from a corrupted repository. Restore it as
an unborn local repository, capture staged content from the index and final
working content separately, then recreate the index and overlay final files.
Do not make a bundle or invent a commit. Verify staged/untracked state.

### Explicitly unsupported Git states in v1

Reject merge-conflicted/unmerged indexes, ongoing merge/rebase/cherry-pick,
sparse checkouts, unresolved shallow/partial object dependencies, submodules,
nested repositories and Git LFS content until each has an explicit tested
export contract. Also reject special index states that cannot be reconstructed
faithfully. Never present pointer files or missing objects as a complete import.
Detect these before a large transfer, and report how to resolve the blocker.
Plain mode must not silently flatten an initialized unsupported repository.

## 7. Selection, exclusions and secrets

Apply a versioned policy and show it in the dry run:

- Git: include tracked content and non-ignored untracked files; omit raw Git
  internals and use the Git payload contract instead. Do not let an exclude
  rule silently remove tracked content while claiming exact Git restoration.
- Plain directories: include hidden source/config files by default, subject
  to explicit Relay ignore rules and sensitive/cache exclusions. Git ignore
  semantics are not assumed for a non-Git folder.
- Exclude dependency caches, virtual environments, build caches, telemetry,
  secrets such as real `.env` and private-key files, and runtime/database
  storage by policy. Keep `.env.example` and selected sanitized test artifacts.
  Exclusions and any resulting non-equivalence are visible before transfer.
- Block on a detected secret in tracked content or selected history. History
  can contain deleted credentials; limiting refs reduces scope but is not a
  secret-removal mechanism. Do not rewrite history automatically, and do not
  claim scanning guarantees absence. Provide remediation before retrying.
- Use fixture canaries to test failure/report redaction. Never print matching
  secret contents, credential-bearing URLs or whole configuration files.

Container volumes and a running database are not source files; offer separate
consistent data-export mechanisms later. File import does not recreate runtime
services or install dependencies.

## 8. Manifest, transfer and local publication

The manifest has a schema version, transfer/workspace/owner IDs, source path
identity, capture time, Git metadata, selection policy, exclusions, file count,
total bytes and ordered entries. Each entry records a safe relative path,
type, size, SHA-256 and permitted mode; directories have no content hash and
symlinks record the literal link target. Record payload hashes for bundle and
patches. Bind transfer state to the manifest digest. Use a lossless filename
encoding; reject names the receiving filesystem cannot represent.

On the PC create an owner-only sibling staging directory on the destination
filesystem. Keep resumable payload and final project subdirectories distinct
so transport files never appear in the project. Transfer via SSH with host-key
verification; do not disable it. Use negotiated rsync partial-transfer support,
no dereferencing, and no owner/group or special-file replication. Do not use
`--inplace` or deletion options against a user's destination. SHA-256 manifest
validation is separate from transport checksums.

Validate path components and use no-follow operations: reject absolute paths,
`..`, escaping links, unexpected files/types, devices, FIFOs and sockets.
Reject case/Unicode-normalization collisions for the target filesystem. Internal
relative symlinks may be preserved as links after validation; never traverse
them while writing. Break hardlink relationships into independent file copies.
Check file count/byte limits, available space and both export and reconstruction
overhead before proceeding; stop safely on late disk exhaustion.

Only publish after verification and Git reconstruction pass. Serialize imports
by local destination and use an atomic **no-replace** rename on the same
filesystem, implemented with a platform-tested helper for Linux/macOS. A
normal check-then-rename is vulnerable to destination-creation races; refuse
unsupported publication semantics. If the destination appears, leave it
untouched and retain a resumable staged result.

After publication, atomically record a local mapping and receipt outside the
project: VM identity, workspace ID, destination real path, manifest digest,
captured commit/index/worktree identifiers and import time. If a crash occurs
between publication and receipt, reconcile the operation journal with the
verified published directory before retrying. Never infer successful import
only from a folder's existence.

## 9. Resume, cleanup and future handoffs

Resume only when transfer ID, owner, destination and sealed manifest match.
Check the remote snapshot still exists; never silently resume from a new source
revision. Reverify all final payloads. Allow an idempotent completion lookup
for a completed transfer instead of importing duplicates after a lost response.

Keep unfinished snapshots for a bounded configurable period (initial proposal:
24 hours, with an explicit disk quota). Pin actively used exports, expose expiry
and disk usage, and clean up only paths owned by the transfer registry. Retain a
small redacted receipt after payload cleanup.

Record an import checkpoint per PC destination. Do not advance the VM's global
legacy `refs/relay/synced` just because another PC downloaded it: that could
change the baseline for a different local copy. A subsequent incremental pull
must select a destination-specific checkpoint and compare local changes with
the captured VM state. Plain-directory updates need a manifest-based conflict
protocol. These follow-up updates are not implied by implementing first import.

## 10. Implementation sequence and acceptance tests

1. Add explicit import CLI dispatch, registry lookup, dry run and compatibility
   checks; keep legacy behavior unchanged.
2. Implement stable plain-directory capture, manifest transfer, resume,
   verification, safe publication and receipts. Prove that no Git is created.
3. Add committed Git export/restoration and unborn Git support; verify VM-only
   commits and independent staged/unstaged state. Detect unsupported states.
4. Add exclusions, diagnostic events and secret-canary tests; integrate doctor
   and the VM-first RAG test journey.
5. Run Linux and macOS filesystem/rsync/Git integration tests. Defer Windows
   claims until native or WSL-specific semantics are independently validated.

Required tests include plain/hidden/empty/Unicode/binary/executable files;
spaces, quotes and newline filenames; branch/detached/unborn Git; staged delete
with a recreated untracked file; staged and unstaged edits to the same file;
VM-only commits; worktree reconstruction; refused LFS/submodules/sparse states;
valid/escaping symlinks; case collisions; secret canaries; active capture
writers; changed snapshot; interrupted/corrupt transfers; full disks; existing
destination and publication races; crash after publication; resume expiry;
multiple PCs; mapping recovery; and regression tests for legacy patch pull.

**Release criterion:** a newly VM-created plain folder remains plain on the PC;
a supported Git project has exactly the selected VM commit and dirty state;
all included bytes match; exclusions are disclosed; interrupted runs never
publish incomplete projects; existing local work and VM state remain intact.

## 11. Research boundary

The linked official manuals support the transport and Git primitives. Snapshot
coordination, manifests, policy, destination publication, CLI design and receipts
are proposed Relay architecture and must be validated with implementation tests.
No external manual establishes these as already implemented Relay guarantees.
