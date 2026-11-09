# Relay — Open Problems and Validation Backlog

**Last reviewed:** 10 November 2026

This is the working list of problems found while testing the Mac → VM → phone
workflow. A problem is closed only after it has reproducible test evidence; a
design idea alone is not a fix.

## How to read this log

- **P0** — could lose work, expose a machine, or make the main handoff unsafe.
- **P1** — blocks the intended phone-first experience or a reliable transfer.
- **P2** — important product capability, but the current private single-user
  workflow can still operate without it.
- **Current** means proven in the existing P1 setup. **Planned** is not yet an
  implementation claim.

## P0 — Sync correctness and safety

### RLY-001 · There is no phone-requested Mac → VM sync

**Status:** Planned

The PWA and Codex run on the VM. They cannot safely ask the Mac to run
`relay push`, because the VM has no restricted relay service on the Mac and
must not receive general SSH/shell access to it.

**Failure path:** the Mac is asleep, offline, has no Tailscale connection, or
has changed locally. A direct VM-to-Mac SSH design would expose the personal
Mac to the VM and to prompt-controlled agent actions.

**Current direction:** keep transfers human-initiated from the local CLI. A
phone-requested Mac transfer is not part of V1.3 and must not require a Mac
background agent or grant the VM arbitrary access to the Mac.

### RLY-002 · No durable writable-owner state prevents concurrent editing

**Status:** Planned

Today the CLI protects Git patch application with base checks, but Relay does
not yet keep a durable ownership record saying whether the Mac or VM is the
sole active writer for every workspace.

**Failure path:** a developer edits the Mac while Codex edits the VM. A later
push or pull may require a merge; it must never silently overwrite either side.

**Required fix:** record workspace ID, Mac path, VM path, source base, manifest
hash, handoff timestamp, and owner. Only a hash-verified handoff changes owner.
Conflicts leave both copies untouched and visible to the user.

### RLY-003 · First-import safety and cross-platform validation remain incomplete

**Status:** First import implemented; hardening and platform validation open

`relay pull --workspace ID --into DIR` imports a registered VM-created plain or
supported Git workspace into a new PC folder using staging, a manifest, hash
checks and a no-replace publication. A real plain RAG workspace and Qdrant
snapshot were imported and tested on Linux. Git edge cases are covered by
automated tests and a committed-Git VM import was exercised. The capture still
requires paused writers and has not been validated as an atomic filesystem
snapshot or on native macOS/Windows.

**Failure path:** copying into an existing local folder could mix or overwrite
unrelated files. A partial network transfer could be mistaken for a complete
workspace.

**Remaining work:** strengthen writer coordination, space/resource limits,
export retention, filesystem-race handling and platform coverage. Keep the
requirement that the destination path is absent, including an empty directory.

### RLY-004 · Push conflict semantics need a formal preflight

**Status:** Partially proven

`relay push` can capture Git state, patches, and untracked files including
Git-ignored files, apart from excluded dependency/cache directories.
The system still needs an explicit remote-handoff preflight when the VM has
changed since the last synchronized snapshot.

**Failure path:** a Mac-originated push could overwrite newer Codex work on the
VM if the remote is treated as an unconditional restore target.

**Required fix:** compare the current VM manifest/snapshot to the recorded
handoff before restore. Require an explicit conflict decision or a separate
three-way merge workflow.

### RLY-014 · Diverged Mac and VM commits have no resolution workflow

**Status:** Current limitation

The legacy handoff records a checkpoint and transfers file-tree deltas; it does
not automatically merge two independently created Git commits. First import
restores the VM's captured HEAD into a separate new directory. The legacy
pull checks the local base, but this is not a complete divergence-resolution
protocol for both histories.

**Failure path:** a developer commits Mac work, Codex commits VM work, and the
two histories become sibling commits. A normal Git merge may require a
same-line conflict, and automatically choosing either version could lose work.

**Required fix:** add an explicit divergence-resolution flow that preserves
both snapshots, presents per-file/base-Mac-VM diffs, allows a user to resolve
conflicts, verifies the resolved tree, and only then writes a new shared Relay
checkpoint. Do not silently merge, rebase, or advance a checkpoint.

### RLY-012 · Repeat handoff support is incomplete

**Status:** Plain-folder multi-file round trip exercised; Git repeat sync open

A destination-specific, journaled plain-folder push and repeat pull completed a
RAG workspace cycle. Git repeat push/pull, automatic conflict resolution and
broader platform verification remain unsupported. Legacy first-handoff Git push
still refuses an existing target.

**Failure path:** treating an existing VM workspace as an unconditional restore
target could discard phone or local work.

**Remaining work:** extend only verified, conflict-aware flows; preserve both
versions and advance checkpoints only after verified acknowledgment.

### RLY-013 · Relay is not yet installable with `npx`

**Status:** Current limitation

The current `relay` executable is a local Bash prototype. The repository's
`package.json` is private and defines PWA scripts only; it has no published
package or `bin` entry.

**Failure path:** a new user cannot run `npx relay ...` reliably, pin a version,
or receive a vetted installer. Shell aliases and copied scripts make upgrades
and trust boundaries unclear.

**Required fix:** package the CLI deliberately: a small Node launcher or
portable binary, explicit `bin` command, versioned release artifact,
configuration/bootstrap flow, and a separate secure VM enrollment step. Keep
the transfer protocol independent of npm so non-Node users are not excluded.

### RLY-015 · Multi-file publication is not atomic across the whole workspace

**Status:** Open — recoverable, not atomically visible

A batch push journals and publishes files individually. A crash or concurrent
reader may observe a partially updated tree until the transfer is resumed;
prior versions are retained for recovery and a checkpoint is not acknowledged
until verification. This is not a single atomic workspace transaction.

**Remaining work:** test interruption at every publication boundary, provide
clear inspect/resume and safe rollback where possible, and prevent readers and
writers from treating a partially published workspace as complete.

### RLY-016 · External writers cannot be reliably locked out

**Status:** Open — writers must be paused

Relay locks coordinate Relay transfers. The VM open-file check is advisory and
cannot prevent an editor, database, or a process holding an old file descriptor
from writing during or after verification.

**Remaining work:** establish and test a practical writer-quiescence protocol;
continue to detect divergence, preserve recovery copies, and refuse when safety
cannot be established. Do not claim checksums alone prevent concurrent writes.

### RLY-017 · Repeat pull transfers the entire captured workspace

**Status:** Open — performance and storage

The observed RAG return pull transferred roughly 550 MB even though only three
small files changed. Captures, hashing and recovery copies can consume time and
disk proportional to the full workspace.

**Remaining work:** design and validate incremental, resumable transfers and
explicit free-space checks without weakening the full-manifest validation or
excluding required ignored data.

### RLY-018 · Transfer and recovery artifacts need retention and encryption

**Status:** Open

VM exports, push recovery copies, and local retained directories may contain
`.env`, application data and credentials. Current private permissions are not
encryption, and artifacts are not automatically expired or quota-limited.

**Remaining work:** protect durable artifacts, add bounded retention and safe
cleanup, preserve the last necessary recovery point, and test disk-full paths.
Do not silently exclude project runtime files.

### RLY-019 · File types, cross-filesystem and Git repeat support are limited

**Status:** Open

The paired batch path supports plain workspaces with regular files and supported
directories. Git repeat sync, symlinks, special files, file/directory type
transitions and cross-filesystem VM publication remain unsupported and must
fail explicitly. Local excluded directories are preserved on pull only when
they contain supported types.

**Remaining work:** prioritize and validate additional types and Git index
fidelity; retain safe refusal for the rest.

### RLY-020 · Release-level recovery and platform validation is incomplete

**Status:** Open

Local fixtures and an isolated temporary workspace on the existing VM exercised
multi-file push, interruption recovery, a synthetic `.env`, an 11 MiB file and
repeat pull. One real RAG cycle completed. This does not establish exhaustive
crash coverage, an independent disposable-VM test or native macOS correctness.

**Remaining work:** test every transaction boundary, concurrent writers, disk
exhaustion and native macOS/Linux behavior on separate disposable systems.

### RLY-021 · Live database consistency is not guaranteed by file hashes

**Status:** Open

A byte-for-byte copy of a running database may not be logically consistent.
The RAG round trip did not test a live database; Qdrant and the app were stopped.

**Remaining work:** validate Qdrant snapshot/restore and PostgreSQL consistent
export/restore, record versions, and refuse or clearly label unsupported raw
live database captures.

## P1 — Phone and PWA reliability

### RLY-005 · Preview URLs depend on a fragile development-server contract

**Status:** Partially proven

The intended safe pattern is: Codex starts a server on VM loopback, verifies a
local HTTP response, reports `http://localhost:PORT`, and Relay exposes a
Tailnet-only preview route. The PWA cannot create a working link if nothing is
listening when the check runs.

**Failure path:** Codex reports a URL before the server is ready, starts on an
unexpected port, or binds publicly. The user sees a broken preview or a refused
link rather than the site.

**Required fix:** detect and retain the reported port per workspace, use a
bounded readiness retry, require `127.0.0.1`/`::1`, verify HTTP locally, and
show the exact listener/error state in the PWA. Never use Tailscale Funnel or a
public `0.0.0.0` listener.

### RLY-006 · Phone cannot yet request a controlled terminal session

**Status:** Planned

The PWA is a chat/files interface. Termius is still the fallback for commands,
tmux attachment, and debugging a running process.

**Failure path:** adding an unbounded raw terminal to the PWA would make phone
navigation difficult and could unintentionally create a second writer for an
active Codex/tmux chat.

**Required fix:** define a workspace-scoped terminal surface with an explicit
session choice and active-writer lock. It must be private to the Tailnet and
must not publish Codex app-server or a general terminal port directly.

### RLY-007 · Model and effort changes mid-conversation need a compatibility contract

**Status:** Unverified

The PWA must not assume every installed Codex app-server supports changing
thread settings during an active conversation. An earlier compatibility error
required the experimental API capability.

**Failure path:** the UI says settings changed but the backend rejects the
request, loses a message, or applies settings to a different thread.

**Required fix:** version-gate the capability, persist the requested versus
applied settings, and offer a new-thread fallback when the installed Codex
version cannot change them safely.

## P1 — Environment portability

### RLY-008 · Code handoff is not yet full environment handoff

**Status:** Current limitation

First import transfers selected workspace files, including database files and
backups, and one Qdrant snapshot was restored on the PC. Dependencies, Docker
images, external volumes, database services and local tool versions are not
automatically captured or recreated as portable, validated environment state.

**Failure path:** the VM receives the files but a build, Playwright workflow,
or local database-backed application does not run the same way as it did on the
Mac.

**Required fix:** record environment manifests (lockfile hashes, runtime
versions, devcontainer/Docker configuration, selected service snapshots) and
rebuild dependencies on the VM. Treat architecture-specific artifacts such as
`node_modules` as disposable caches, not portable source state.

### RLY-009 · Deliberate secret transfer needs lifecycle and retention controls

**Status:** Current limitation

The current user-selected policy deliberately transfers `.env`, keys and
Git-ignored project files. VM exports can retain those files indefinitely;
there is no secret-reference model, automatic redaction or export expiry yet.

**Failure path:** a workspace or retained export contains credentials and is
copied, retained, or shared beyond the intended machines or users.

**Required fix:** make inclusion and retention visible and controllable, add
secure cleanup and optional secret-reference workflows, and avoid logging
secret values. Do not use `.gitignore` as the transfer policy. See
[workspace data policy](VM_WORKSPACE_DATA_POLICY.md).

## P2 — Operating the service beyond one user

### RLY-010 · Shared compute and Firecracker isolation are not product-ready

**Status:** P2 lab only

Firecracker is appropriate for isolated tenant runners, but it is not a
replacement for the trusted persistent personal workspace VM. Per-user CPU,
memory, disk, network, lifecycle, image, and credential boundaries must be
enforced before any tenant receives a runner.

**Failure path:** a tenant VM exhausts host CPU/memory/disk, reaches another
tenant or host control socket, or keeps an abandoned runner alive and consuming
cost.

**Required fix:** finish the Firecracker checkpoints with cgroups, jailer
identities, network namespaces, quotas, teardown, host/guest isolation tests,
and a scheduler. Do not onboard users or transfer real workspaces/credentials
until those tests pass.

### RLY-011 · Current PWA access model is single-owner, not beta onboarding

**Status:** Planned

The deployed PWA is private to the owner's Tailnet. It does not yet have a
multi-user identity, workspace authorization, quota, billing, audit, or
revocation model.

**Failure path:** exposing the current PWA to other users could give someone
access to another user's workspace, preview, logs, or Codex conversation.

**Required fix:** introduce a tenant model before beta: authenticated identity,
per-tenant workspace registry, isolated runner, scoped credentials, audit trail,
resource quotas, and immediate revocation.

## Verification queue

1. Exercise crash and retry boundaries for both endpoints on a separate
   disposable VM and on native macOS and Linux.
2. Validate multi-file publication, local exclusions, conflicting edits,
   disk-full behavior and external-writer coordination.
3. Reduce repeat-pull transfer volume without weakening verification.
4. Add artifact encryption, quotas and safe retention/cleanup.
5. Validate Qdrant and PostgreSQL application-consistent backup and restore.
6. Verify private preview readiness and keep multi-tenant isolation separate.

## Closed / do not re-open without a new reproduction

- Untracked files are included in the current Git handoff path in both
  directions; this was tested with a mobile-created file.
- The VM, Mac, and phone can connect privately through Tailscale; public SSH is
  not the normal access path.
- A persistent tmux/Codex workflow on the VM survives ordinary phone
  disconnection and VM reboot.
