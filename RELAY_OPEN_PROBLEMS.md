# Relay — Open Problems and Validation Backlog

**Last reviewed:** 20 October 2026

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

**Required fix:** install a Mac Relay Agent as a `launchd` service. It makes an
outbound authenticated Tailnet connection, polls only signed jobs referencing
registered workspace IDs, and executes the local transfer. The PWA must show
`Mac offline`, `queued`, `transferring`, `verified`, `conflict`, or `failed`.

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

### RLY-003 · VM-only non-Git workspaces are not yet a first-class CLI pull

**Status:** Partially proven

Git delta pull works. A complete non-Git workspace export from the VM to a new
Mac folder has been proven manually, but `relay pull` does not yet provide this
as a transactional product command.

**Failure path:** copying into an existing local folder could mix or overwrite
unrelated files. A partial network transfer could be mistaken for a complete
workspace.

**Required fix:** add an explicit `relay pull --workspace-export --destination
PATH` mode. It must require a new/empty destination, transfer a manifest with
path/size/SHA-256, verify it, and never infer a merge or delete local files.

### RLY-004 · Push conflict semantics need a formal preflight

**Status:** Partially proven

`relay push` can capture Git state, patches, and non-ignored untracked files.
The system still needs an explicit remote-handoff preflight when the VM has
changed since the last synchronized snapshot.

**Failure path:** a Mac-originated push could overwrite newer Codex work on the
VM if the remote is treated as an unconditional restore target.

**Required fix:** compare the current VM manifest/snapshot to the recorded
handoff before restore. Require an explicit conflict decision or a separate
three-way merge workflow.

### RLY-014 · Diverged Mac and VM commits have no resolution workflow

**Status:** Current limitation

Relay records a shared checkpoint and transfers file-tree deltas; it does not
automatically merge two independently created Git commits. If the Mac and VM
both advance from the same checkpoint, Relay refuses the next unsafe push or
pull rather than overwrite either copy.

**Failure path:** a developer commits Mac work, Codex commits VM work, and the
two histories become sibling commits. A normal Git merge may require a
same-line conflict, and automatically choosing either version could lose work.

**Required fix:** add an explicit divergence-resolution flow that preserves
both snapshots, presents per-file/base-Mac-VM diffs, allows a user to resolve
conflicts, verifies the resolved tree, and only then writes a new shared Relay
checkpoint. Do not silently merge, rebase, or advance a checkpoint.

### RLY-012 · `relay push` is currently first-handoff only

**Status:** Current limitation

The prototype refuses a push when the target VM workspace already exists. This
protects existing VM work, but it also means the intended repeatable loop —
Mac changes → `relay push` → same VM workspace — is not yet implemented.

**Failure path:** deleting or replacing the existing VM folder to force another
push could discard phone/Codex changes. Treating the folder as an unconditional
restore target would have the same risk in reverse.

**Required fix:** turn push into a snapshot-based update. It must first compare
the VM's recorded handoff snapshot to its current manifest, then either stage
and verify the new Mac snapshot, reject a conflict, or offer an explicit merge
flow. No automatic deletion of an existing workspace.

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

V0 transfers source state. Node/Python dependencies, Docker images, databases,
volumes, background services, and local tool versions are not yet captured as
portable, validated environment state.

**Failure path:** the VM receives the files but a build, Playwright workflow,
or local database-backed application does not run the same way as it did on the
Mac.

**Required fix:** record environment manifests (lockfile hashes, runtime
versions, devcontainer/Docker configuration, selected service snapshots) and
rebuild dependencies on the VM. Treat architecture-specific artifacts such as
`node_modules` as disposable caches, not portable source state.

### RLY-009 · Secrets require explicit references, not accidental file transfer

**Status:** Current limitation

Ignored files such as `.env` are intentionally excluded, but a non-ignored
secret can still be transferred with ordinary untracked files. There is no
secret-reference model yet.

**Failure path:** a developer commits or leaves a credential unignored and
Relay copies it to the VM, a manifest, or future audit data.

**Required fix:** add preflight secret scanning/warnings and a later
user-controlled secret-reference mechanism. Do not log secret values, and do
not treat `.gitignore` as the sole production security boundary.

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

1. Build the Mac Relay Agent and signed job queue; prove offline, expired,
   duplicate, and successful jobs.
2. Add transactional non-Git workspace export and test interrupted transfer,
   target-not-empty, hash mismatch, and retry.
3. Add ownership/preflight checks and test simultaneous Mac/VM edits.
4. Make preview readiness observable and test delayed startup, wrong port,
   public listener rejection, and shutdown.
5. Capture environment manifests for one Node + Python + Playwright project;
   prove a clean VM rebuild.
6. Finish Firecracker P2 isolation before any external beta access.

## Closed / do not re-open without a new reproduction

- Untracked files are included in the current Git handoff path in both
  directions; this was tested with a mobile-created file.
- The VM, Mac, and phone can connect privately through Tailscale; public SSH is
  not the normal access path.
- A persistent tmux/Codex workflow on the VM survives ordinary phone
  disconnection and VM reboot.
