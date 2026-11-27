# Relay — Open Problems and Validation Backlog

**Last reviewed:** 27 November 2026 (older entries retain their historical status except where updated below)

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

**Status:** Implemented for paired workspace handoffs; legacy and broader validation remain open

`relay push` can capture Git state, patches, and untracked files including
Git-ignored files, apart from excluded dependency/cache directories.
Paired plain and Git handoffs compare each endpoint with the saved checkpoint;
diverged changes are refused or sent through the reviewed merge workflow.
The legacy `--project` path remains separate from that paired protocol.

**Failure path:** a Mac-originated push could overwrite newer Codex work on the
VM if the remote is treated as an unconditional restore target.

**Remaining work:** validate the preflight and recovery on the remaining target
platforms and keep the legacy path's guarantees clearly separated.

### RLY-014 · Diverged Mac and VM commit resolution needs broader validation

**Status:** Reviewed history workflow implemented; broader validation open

The legacy handoff does not merge independently created commits. The paired
workspace protocol provides an explicit reviewed history workflow; it still
needs the platform and physical-phone validation listed below.

**Failure path:** a developer commits Mac work, Codex commits VM work, and the
two histories become sibling commits. A normal Git merge may require a
same-line conflict, and automatically choosing either version could lose work.

**Current support:** `relay merge` retains snapshots and provides a private
history-review repository. A reviewed commit descending from both heads must be
explicitly approved before publication. Local fixtures cover divergent history;
manual phone and cross-platform acceptance remain open. Do not silently merge,
rebase, or advance a checkpoint.

### RLY-012 · Repeat handoff support is incomplete

**Status:** Plain and Git repeat handoffs implemented and exercised over SSH; broader acceptance open

A destination-specific, journaled plain-folder push and repeat pull completed a
RAG workspace cycle. Git repeat push/pull preserves the index and working tree;
reviewed merge and explicit commit transfer are supported for eligible states.
On 25 November, isolated real SSH fixtures passed two plain and Git round trips,
divergence refusal, interrupted transfer recovery and dropped-ack recovery. The
Git fixture tested a non-overlapping merge and explicit commit transfer. Native
macOS and full physical-phone acceptance remain open. Legacy first-handoff Git
push still refuses an existing target.

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

**Status:** Atomic publication implemented; release validation tracked separately

Previously a multi-file push could expose a mix of old and new files. New plain
batch pushes and Git publications build and verify a complete replacement before
atomically exchanging it with the original. The original directory, including
destination-local data, is retained. Managed VM reservations recognize both
recorded directory identities until verification and acknowledgment complete.

For a pending push, use `relay push --workspace ID --project DIR --inspect`
and `--resume` with the same options. `--rollback` restores a verified original
before acknowledgment and retains the proposed tree if it was exchanged.
Previously interrupted per-file journals retain their legacy resume path.
Release and platform verification remain tracked under RLY-020 and RLY-023.

### RLY-016 · External writers cannot be reliably locked out

**Status:** Linux VM writer fence implemented; deployment validation pending

A writer that opened a file after the last idle scan could save into the retained
tree during acknowledgment. Relay would report success while the edit was absent
from the live tree. The VM helper now requires Linux file leases and monitors
directory changes while capturing and during the atomic swap and acknowledgment.
When activity invalidates the fence, it retains both copies and refuses to
acknowledge. Git pushes check both trees again when acknowledgment is separate.

Pause unmanaged editors and services through the transfer. The guard requires
a compatible Linux filesystem and sufficient descriptors. Namespace monitoring
and file leases are not a security boundary against privileged processes, and
native desktop writers are outside the VM fence. Database backup consistency
remains tracked in RLY-021.

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

### RLY-019 · File types and cross-filesystem handoffs are limited

**Status:** Open

The paired batch path supports plain workspaces with regular files and supported
directories, and Git repeat sync supports eligible repositories. Symlinks, special files, file/directory type
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

### RLY-027 · Recovery buttons overlapped by long messages on mobile

**Status:** Fixed in test candidate; physical-phone verification remains

A Playwright real-VM crash test showed the message list covering the recovery
buttons at a 390 × 844 viewport. A long-message crash fixture reproduced the
failure before the fix. The chat layout now assigns fixed grid rows to recovery,
messages, and composer controls; the fixture and real-VM recheck passed after
the change. Validate on physical devices before closing the item.

### RLY-026 · Process cleanup fixture intermittently reports UNCERTAIN

**Status:** Fixture fix implemented and exercised; production cleanup remains covered by RLY-023

On 25 November, the full Node suite's real-process completion fixture reported
`UNCERTAIN` instead of `COMPLETED`; its isolated rerun and a subsequent full
suite passed. A later Stop fixture also failed intermittently. The captured
failure was an `ESRCH` from reading a procfs stat file while the test
process exited. The injected test fixture now treats that result like a missing
process. Four concurrent reruns of the real-process fixture passed. This changes
only the test fixture; production cgroup checks were not relaxed.

**Remaining work:** retain diagnostics and continue production cgroup and real
Codex cleanup verification under RLY-023; reopen this issue if the fixture fails
again for this or another reason.

### RLY-022 · Sent messages appear late in the chat

**Status:** Partially fixed — candidate verified; phone and reopen latency remain open

On 24 November, two phone-sized Playwright runs measured 1.39–1.54 seconds
from Send to backend acceptance and 3.04–3.14 seconds until the user's message
became visible. The UI waits for the start request and session loading before
rendering the input. Slow requests can leave the user without timely feedback.

**Required fix:** show the sent message and a clear sending state promptly,
then reconcile it with the persisted session input without duplicates. Preserve
the existing idempotency key, lost-response recovery, error handling, and
attachment behavior; never imply acceptance before the server confirms it.
Also investigate slow workspace/conversation loading on reopen. Measure on the
real candidate and add deterministic browser tests for slow and failed requests.

**Evidence:** `pwa/test/session-live-playwright.mjs`; a real Codex task resumed
after browser closure, and 46 backend text events matched both browser views.
That pass does not establish an acceptable Send latency or physical-phone behavior.

On 25 November, the candidate showed an optimistic message with a Sending state;
one live phone-sized browser run showed it in 106 ms and acceptance in 1,662 ms.
The test continued after closing the app and matched backend events in two
reopened browsers. The rendered fixture holds and rejects the start request to
check immediate feedback, preserved draft, and retry without duplicates. Session
restoration no longer waits for the workspace conversation list, and a browser
fixture verifies replay while that list is held. Physical-phone timing, slower
uploads and other session-history/model request delays remain to be verified.
On 26 November, an offline Playwright test first failed because no offline state
was displayed. The candidate now shows Offline and reopens the event stream when
network access returns. A live browser test confirmed the heartbeat advanced and
both browsers replayed the backend output. Physical-phone behavior remains open.

### RLY-023 · V1.4 release-level session and handoff tests remain incomplete

**Status:** Open — candidate and partial browser verification only

The candidate passed a two-minute browser closure without an event subscriber,
browser-simulated offline/reconnect, Stop during writes, guarded initial plain
and Git import, and preview cleanup on Stop. A separate
transient VM controller passed a real Codex crash test: SSH was blocked while
the controller was absent and an unverified recovery stayed blocked after restart.
These do not substitute for a physical phone or exhaustive crash tests. Remaining
tests include:

- A physical phone: lock or close for at least two minutes, airplane-mode
  interruption, reconnect, output replay, and no duplicate prompt or message.
- Verify handoffs during cancellation itself; the tested workflow covered an
  active task and the state after confirmed Stop.
- Paired desktop Git and plain repeat handoffs and merge recovery with the
  candidate's matching controller state and helper.
- Deploy the shared SQLite workspace reservations from RLY-025 and verify them
  with the installed helper over real SSH and a real Codex task. Repeat the
  parent/child race, directory identity check, and transfer crash/retry cases,
  including a mismatched or incompatible helper.
- Dedicated-controller crash, orphaned or detached writer, uncertainty, audited
  recovery, stale identity, and storage-failure cases with actual cgroups and
  real Codex. A mocked process driver is not production containment evidence.
- Preview availability and cleanup on success, failure and Stop; verify unrelated
  servers remain running. Check authorization, rollout/rollback, backup/restore,
  resource limits, and the remaining S01–S19 cases at their required layers.

Record the candidate revision, versions, device, session identities, event
evidence, and receipts without exposing private output. See
[the V1.4 E2E plan](RELAY_V1_4_SESSION_E2E_TEST_PLAN.md).

### RLY-024 · Candidate workspace registry is shared with the live PWA

**Status:** Candidate registry and configured helper verified for guarded initial plain and Git imports; broader coverage remains

The original test configuration used a separate controller state and test root
but read the live workspace registry. The candidate now has a separate registry.
Independent controller guards still must not be used for the same workspace.

**Required fix:** give the candidate a separate `RELAY_WORKSPACE_REGISTRY_FILE`,
verify only disposable workspaces are listed, and use matching candidate state
for the desktop helper. Drain candidate tasks before changing or restarting its
service. Do not run both controllers against the same workspace with independent
guards.

On 25 November, the candidate service was configured with a separate registry,
and its workspace list showed only disposable roots. The live service remained
active. The updated desktop helper accepts an explicit complete remote controller
configuration; against the real candidate it refused plain and Git imports while
Codex tasks were writing and imported after verified Stop. Repeat transfers under
the candidate guard remain unverified. Old helpers and arbitrary same-user SSH
remain outside this supported boundary.

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

**26 November evidence:** a Playwright test started a real task-owned loopback
server, opened a private preview, closed and reopened the browser, and confirmed
the server and its route were removed before Stop completed. Completion/failure
cleanup and unrelated-server cases remain open.

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

1. Finish V1.4 acceptance (RLY-023): real Codex crash/recovery, paired Git and
   plain handoffs under the candidate guard, preview cleanup, and physical-phone
   offline/reconnect and Stop checks. Monitor the cleanup fixture fix (RLY-026)
   and verify remaining UI/phone timing (RLY-022).
2. Exercise crash and retry boundaries, disk-full behavior and external-writer
   coordination on a separate disposable VM and native macOS/Linux (RLY-003,
   RLY-004, RLY-012, RLY-014–016, RLY-019–020).
3. Design incremental repeat pull and secure artifact retention (RLY-017–018),
   and validate application-consistent database backup/restore (RLY-021).
4. Address product work separately: controlled phone sync/terminal, durable
   ownership, model compatibility, environment handoff and CLI packaging
   (RLY-001–002, RLY-006–009, RLY-013). Validate preview readiness (RLY-005).
5. Keep multi-user onboarding and Firecracker isolation gated until their
   dedicated architecture and security validation are complete (RLY-010–011).

## Closed / do not re-open without a new reproduction

- Untracked files are included in the current Git handoff path in both
  directions; this was tested with a mobile-created file.
- The VM, Mac, and phone can connect privately through Tailscale; public SSH is
  not the normal access path.
- A persistent tmux/Codex workflow on the VM survives ordinary phone
  disconnection and VM reboot.

### RLY-025 · Share execution guards across overlapping workspace paths

**Status:** Done — implemented and verified locally on 27 November 2026

An active task in a parent workspace and an operation in its registered child
could address the same files through different guards. The PWA and installed VM
helper now check the same SQLite store for overlapping workspace paths. Managed
transfer reservations persist across SSH commands, and a completed retry can
acknowledge the recorded checkpoint without publishing again.

[Local Playwright coverage](pwa/test/session-browser-handoff.mjs) used the
PWA and a real helper with disposable workspaces and a simulated task. It
verified simultaneous starts, unrelated siblings, changed directory identity,
attachment refusal, and recovery when the helper was killed during upload or
after checkpoint commit. The Node suite passed 68 tests and the Python suite
passed 83; three opt-in VM tests were skipped.

Candidate rollout and end-to-end validation over real SSH and Codex are tracked
under RLY-023. Direct SSH commands and external editors are outside the managed
reservation protocol.
