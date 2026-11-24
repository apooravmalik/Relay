# Relay V1.4 — Persistent Agent Sessions & Reconnection

## Implementation status — 23 November 2026

The local candidate implements phases A–D and their fixture tests. It has not been
deployed or accepted on a physical phone. See [V1.4 progress record](CURRENT_PROGRESS_VM.md)
for measured results and [deployment](RELAY_V1_4_DEPLOYMENT.md) for the required
administrator-installed cgroup prerequisite. Checklist completion below means the
local implementation and automated gate; production/process/device gates remain
explicitly open.

## Objective

Implement durable, server-owned Codex turn execution so that phone and browser connections are subscribers rather than owners of the agent lifecycle.

Before implementation, inspect the current repository at the latest committed baseline. Preserve all existing Git and plain workspace handoffs, shared checkpoints, merge and recovery logic, and PWA functionality.

## Phase A — Client-disconnect durability

1. Decouple Codex execution from the HTTP streaming request.
2. Create persistent session identities and metadata.
3. Introduce explicit session states: `STARTING`, `RUNNING`, `CANCEL_REQUESTED`, `COMPLETED`, `FAILED`, `INTERRUPTED`, and `UNCERTAIN`.
4. Persist ordered agent events with monotonically increasing per-session event IDs.
5. Support authenticated clients reconnecting and replaying events after a supplied cursor, without event loss between replay and live subscription.
6. Ensure closing the browser, locking the phone, navigating away, or losing network connectivity does not cancel an active turn.
7. Retain explicit Stop functionality with reliable cancellation confirmation.
8. Prevent duplicate executions caused by repeated start requests or network retries using idempotency keys.
9. Preserve existing workspace locks throughout execution, including cancellation and completion transitions.

## Phase B — Crash and restart reconciliation

1. Persist enough metadata to identify sessions that were active when the controller stopped.
2. On restart, reconcile persisted sessions with actual Codex processes and workspace execution state.
3. Never assume an agent has stopped merely because an HTTP connection, Node process, or filesystem lock disappeared.
4. If the previous execution cannot be proven stopped or safely reattached, mark the session and workspace `UNCERTAIN`.
5. Block new conflicting agent execution and workspace handoffs while execution remains uncertain.
6. Implement a safe, auditable recovery path.
7. Do not silently restart an interrupted agent turn or repeat a user prompt.

Host-restart continuation is not required in this milestone. Safe detection and recovery are required.

## Phase C — PWA integration

1. Show running, completed, stopped, failed, and uncertain sessions accurately.
2. Allow a user to leave and reopen the same session.
3. Replay missed events and then subscribe to live events.
4. Preserve existing conversation history, model selection, file views, and previews.
5. Make Stop an explicit action, independent of stream disconnection.
6. Provide clear recovery messaging when a session cannot safely continue.
7. Support multiple browser subscribers without creating duplicate turns.

## Phase D — Security and resource controls

1. Authenticate and authorize every session operation.
2. Keep execution logs private to the authorized workspace owner.
3. Treat stored agent events as potentially containing credentials, source code, and other sensitive data.
4. Define bounded event retention, per-session storage limits, and cleanup.
5. Do not write protected content to logs unnecessarily.
6. Preserve the current single-owner security boundary. Do not claim tenant isolation.
7. Keep session metadata and event-log writes durable enough for the documented recovery guarantees.

## Required tests

- [ ] Disconnect a phone during an active turn and verify execution continues.
- [ ] Reconnect and recover all missed events in order.
- [ ] Reconnect with a stale or duplicate event cursor.
- [ ] Connect two browser clients to the same session.
- [ ] Repeat a start request and verify only one turn executes.
- [ ] Request cancellation during active file writes.
- [ ] Disconnect during cancellation.
- [ ] Attempt a Git or plain workspace handoff during active execution.
- [ ] Crash the controller during an active turn.
- [ ] Restart with an orphaned Codex process.
- [ ] Verify `UNCERTAIN` workspaces refuse unsafe transfers.
- [ ] Test event-storage errors, retention limits, and interrupted event writes.
- [ ] Verify existing PWA and handoff integration tests still pass.

## Deliverables

- [ ] Implemented session manager and PWA integration.
- [ ] Persistence and recovery design.
- [ ] Automated and real VM integration tests.
- [ ] Explicitly documented durability guarantees.
- [ ] Remaining limitations.
- [ ] Updated progress report.

## Scope restrictions

Do not add Claude Code, Gemini, Firecracker orchestration, multi-tenant accounts, npm packaging, or unrelated features.

Do not promise seamless continuation across controller crashes or host restarts unless independently implemented and verified.

## Acceptance criterion

A developer can start a Codex task from Relay's PWA, close their phone for several minutes, reopen the application, see the task's accumulated output and status, and continue interacting with the same session. Explicit cancellation and workspace handoff locks must remain correct throughout.

## Implementation baseline and observed gaps

Planning baseline inspected on 23 November 2026: `a0c34cc` — `Implement repeat Git workspace handoffs`. The design below is implemented in the local candidate where checked; unchecked gates still require their stated evidence.

Existing baseline checks run on that date: `npm test` passed all 46 tests; Python discovery ran 75 tests with 73 passes and two real-SSH suites skipped because no disposable target alias was supplied. These results verify the existing baseline, not V1.4 behavior.

| Current code | Observed behavior | Required change |
| --- | --- | --- |
| `pwa/server.mjs`: both conversation turn POST handlers | Own execution inside an HTTP response; `interruptOnDisconnect` requests cancellation when the response closes | Separate start, execution, subscription, and cancellation |
| `pwa/lib/codex.mjs`: `activeTurns`, `withServer`, `streamConversation` | Turn handles live only in Node memory; a local app-server is started for each operation and closed in `finally` | Expose execution lifecycle and process identity to a session manager; retain normal conversation APIs |
| `pwa/public/app.js`: `sendPrompt`, `handleSseChunk`, Stop handler | Reads a POST stream without event IDs; a broken connection becomes an error; busy state is local to the page | Discover sessions, replay by cursor, reconnect, and derive execution state from the server |
| `pwa/server.mjs`: `lockWorkspaceTurn` | Holds a `flock` helper through the request's execution lifecycle | Session execution owns this lock, including Stop and finalization |
| `relay_lib/export_workspace.py`: `turn_lock` and action dispatch | Git handoff and capture paths use a turn lock; other plain transfer actions use separate transfer locks | Audit every transfer path and add one consistent execution guard; preserve existing lock ordering |
| `pwa/test/server.test.mjs` | Includes a test asserting that disconnect interrupts the turn | Replace that expectation with durability tests while preserving explicit Stop tests |
| `deploy/relay-pwa.service` | Repository unit runs `/opt/relay`; controller state is outside the checkout | Record the deployed build separately, verify the actual unit, and migrate controller and SSH helpers together |

The checkout's 66 tracked files and the deployed `/opt/relay` copy are different locations. Updating this checkout alone does not deploy a controller change. `CURRENT_PROGRESS.md` contains older observations and must be updated from new evidence rather than treated as the current implementation inventory.

## Proposed design

User decisions recorded on 23 November 2026: task-created dev servers run until the task ends and then stop; retain terminal events for seven days and session metadata for 30 days; allow two concurrent tasks across different workspaces with one per workspace; require per-task process tracking and a compatible desktop CLI update. See the [decision register](RELAY_V1_4_DECISIONS.md). Technical implementation details below remain subject to their verification gates.

### Identity, ownership, and execution

- A conversation is an existing Codex thread. A Relay session represents one submitted turn and has its own stable UUID, even before Codex returns a thread or turn ID. Continuing a conversation creates another session linked to the same thread. Reopening a session never submits another prompt.
- The session manager owns execution, cancellation, persistence, and locks. HTTP handlers authenticate, authorize, and delegate. Subscription cleanup removes only the subscriber.
- Permit one Relay execution per canonical workspace across conversations. Keep independent workspaces usable, with a configurable controller limit initially set to two active executions. Do not introduce a task queue in this milestone.
- Hold a controller singleton lock for each state directory. Two controllers must not reconcile or execute against the same store concurrently. Resolve workspace identity from the canonical path using the existing ID scheme.

### Persistence and event ordering

- Proposed store: `~/.relay-v0/controller/sessions/sessions.sqlite`, outside workspaces and transfer payloads, with versioned schema and private directory/file permissions (`0700`/`0600`, including WAL and backup files).
- Use SQLite transactions for session state, ordered events, idempotency records, and workspace execution guards. Proposed settings: WAL, `synchronous=FULL`, foreign keys, bounded busy timeout, and explicit handling of disk-full and corruption. This VM has Node `v22.18.0` with experimental `node:sqlite` available; selecting and pinning the supported runtime remains a release prerequisite. Python readers must be compatible with the same database schema.
- Persist session ID, owner, canonical workspace identity, thread/turn IDs when known, model and effort, timestamps, state and reason, request digest/key, controller generation, host boot ID, process identity and start time, process-scope identity, terminal result, cancellation intent, and last committed event ID. Keep prompt content only in private storage where needed; never copy it into operational logs.
- Assign contiguous per-session event IDs inside serialized transactions. Commit before publishing an event. Commit state changes and their corresponding status events together. Store only the event types needed for the PWA, including user input, assistant output, reasoning summaries, thread binding, status, and sanitized errors; do not archive every raw protocol message.
- Store a workspace guard in the same transaction as session creation. It blocks starts and transfers in all nonterminal states, including `UNCERTAIN`. Keep task-created dev servers running during active execution; automatically stop them during finalization before clearing the guard. An absent OS lock cannot override these records. Unknown schema, corrupt records, or an unreadable initialized store block unsafe operations.
- Retain a durable initialization/schema marker so a missing database after initialization cannot be mistaken for a clean installation. Define first-install migration before enabling execution; never silently replace a damaged store with an empty one.
- Start crash boundaries must be explicit: persist reservation before spawning; persist process identity before sending `turn/start`; if an external side effect may have occurred before its acknowledgment was saved, quarantine rather than resubmit. There is no atomic transaction spanning SQLite and Codex.

### State and Stop contract

| State | Meaning and allowed next steps |
| --- | --- |
| `STARTING` | Request and workspace reservation persisted; may become `RUNNING`, `CANCEL_REQUESTED`, proven-safe `FAILED`/`INTERRUPTED`, or `UNCERTAIN` |
| `RUNNING` | Codex turn identity recorded; may become `CANCEL_REQUESTED`, `COMPLETED`, proven-safe `FAILED`/`INTERRUPTED`, or `UNCERTAIN` |
| `CANCEL_REQUESTED` | Stop intent persisted, including requests before a turn ID exists; remains blocking until completion/stop evidence arrives |
| `COMPLETED` | Successful turn completion and execution finalization confirmed |
| `FAILED` | Execution failed and its end was confirmed; unknown process state belongs in `UNCERTAIN` |
| `INTERRUPTED` | Cancellation or interruption confirmed; PWA displays “Stopped” or an explanatory interrupted status |
| `UNCERTAIN` | Execution safety cannot be established; blocks new execution and handoffs until evidence-based recovery |

- Terminal states are `COMPLETED`, `FAILED`, and `INTERRUPTED`. `UNCERTAIN` is a blocking recovery state, not successful cancellation.
- A Stop POST persists intent and returns `202`; the PWA shows “Stopping…” until a committed terminal event arrives. A `turn/interrupt` RPC acknowledgment alone does not confirm stopped execution.
- Stop is idempotent. Handle Stop before spawn, during `turn/start`, during writes, after completion, and from another browser. A completion/Stop race records the actual confirmed outcome rather than reporting a false cancellation.
- Use a proposed 30-second cancellation acknowledgment deadline. On timeout, inspect execution evidence; do not unlock on timeout or escalate to an unverified process kill. Expose `UNCERTAIN` if termination cannot be established.
- Finalization verifies the turn outcome, stops task-created dev servers and other relevant owned descendants, confirms their execution scope is empty, and removes session-owned preview publications. Keep the session nonterminal with a visible finishing/cleanup phase until this completes. Then commit the terminal event and clear the durable guard before releasing the OS lock. Cleanup applies to successful, failed, and explicitly stopped tasks; a browser disconnect must not trigger it. Do not stop unrelated or pre-existing services. If cleanup or finalization persistence fails, retain blocking state and reconcile; unproven termination becomes `UNCERTAIN`. Release errors cannot report a successful handoff opportunity.

### Shared handoff guard

- Reuse `controller/handoff-locks/<workspace-id>.lock`. For both execution and transfer publication: acquire the shared OS lock, check the durable guard under that lock, then proceed or refuse. Use short database transactions and define a single lock order to avoid deadlocks.
- Audit `capture`, `git_capture`, `git_*` actions, `push_one`, `batch_begin`, `batch_apply`, manifest/export operations, checkpoint prepare/commit, and merge publication/recovery. Read-only status may remain available; snapshot/copy and mutation paths must not bypass an active or uncertain execution. Checkpoint reads needed for inspection remain available.
- Transfer stages may release the OS lock between commands, but each subsequent capture/publication/acknowledgment must revalidate the execution guard and its existing checkpoint/journal preconditions. A session start must also honor pending transfer publication before spawning.
- Keep checkpoint schemas, index/worktree distinction, protected/excluded file policy, and resumable publication journals intact. Extend the guard around these operations rather than replacing their recovery logic.
- SSH helpers must consult the persistent guard without requiring a live HTTP controller. Some helpers are shipped as standalone Python payloads: either embed the small versioned guard reader or explicitly package its dependency. An import available only in the checkout is insufficient.
- Coordinate the controller and helper rollout. An older helper that ignores session guards cannot safely coexist with enabled durable sessions; require compatible helper protocol/version before transfer writes. Document that an old, unmodified client cannot be retroactively made to enforce a new protocol, and prevent its use in the supported deployment.

### HTTP and replay contract

Proposed workspace-scoped API, all behind the existing owner authorization:

| Operation | Proposed endpoint and behavior |
| --- | --- |
| Start | `POST /api/workspaces/:wid/sessions`: prompt, optional thread ID, model/effort, idempotency key and original creation timestamp; returns `202` with durable session identity |
| Discover | `GET /api/workspaces/:wid/sessions?threadId=…`: active/uncertain and retained recent sessions; supports a lost start response before a thread ID exists |
| Inspect | `GET /api/workspaces/:wid/sessions/:sid`: state, thread binding, last event ID, replay availability, safe recovery information |
| Subscribe | `GET /api/workspaces/:wid/sessions/:sid/events?after=N`: authenticated SSE with `id:` fields and replay followed by live events |
| Stop | `POST /api/workspaces/:wid/sessions/:sid/stop`: persists cancellation intent, independent of subscriber presence |
| Recovery inspection | `GET /api/workspaces/:wid/sessions/:sid/recovery`: sanitized execution evidence and supported next action |
| Recovery action | `POST /api/workspaces/:wid/sessions/:sid/recovery`: explicit, authorized action against a checked evidence generation; append an audit record |

- Scope idempotency to owner + canonical workspace + key. Atomically persist a unique key, normalized request digest, session, and guard before execution. Same key and body returns the original session; same key with a different body returns `409`. Concurrent retries and lost responses must not spawn twice.
- Retain idempotency metadata for 30 days. Proposed new-request freshness window: 24 hours using an unchanged original creation timestamp. Look up retained keys before freshness checks; once a key is purged, reject stale retries with `410` instead of launching a replacement. Document this bounded retry contract.
- Validate cursor as a nonnegative safe integer. Replaying from an older or duplicate cursor is allowed; clients apply each event ID once. A cursor ahead of the server's last committed ID returns a structured error. An expired replay range returns `410` plus the safe path to conversation history/status, never a silent gap.
- Use the persisted event table as the source for replay and live delivery. Each subscriber repeatedly reads IDs greater than its cursor; commit notifications only wake the reader, with a periodic database recheck to cover lost notifications. Subscribe/wakeup registration and recheck must avoid the catch-up race. No direct live-event path may bypass storage.
- Bound each subscriber's output buffer. Disconnect a slow reader and let it replay later; do not stall execution or accumulate unbounded memory. Heartbeats have no event ID and do not change execution state.
- Adapt existing new/saved conversation turn routes to the manager during transition so old PWA assets cannot invoke the old disconnect-cancels lifecycle. Avoid maintaining two execution owners. Keep the existing Stop route as a scoped adapter if needed during rollout.

### Restart reconciliation and recovery

- Before accepting starts or transfers on an initialized store, regard persisted nonterminal records as blocking, even while reconciliation runs. The Python guard must independently enforce this while the controller is absent.
- Record Linux boot ID, PID plus process start time, controller generation, and a verifiable execution scope. A PID existing, a missing `flock`, or a recent heartbeat is insufficient proof either way; PID reuse must not identify an unrelated process as this session.
- V1.4 defaults to no live reattachment after controller death: a stdio app-server connection cannot be assumed recoverable. If a verified process scope proves all relevant execution stopped, record an interrupted/failed outcome and recovery evidence. If it does not, mark `UNCERTAIN` and retain the guard.
- Implement a per-execution process scope (for example a managed systemd service/cgroup) with verifiable membership and termination, as accepted under Q-04. Verify its real deployment and descendant behavior; detached or untracked writers require uncertainty. Do not infer safety from the main Codex PID exiting. The live service currently has no cgroup delegation or user manager, and `NoNewPrivileges` prevents sudo elevation: prepare an administrator-installed deployment prerequisite rather than assuming the controller can install one itself.
- Track task-created preview/dev servers as task-owned processes: they may run while execution is active and must be stopped when the task ends. Verify detached/daemonized descendants remain tracked. Keep unrelated or pre-existing services outside task cleanup; arbitrary external writers remain outside Relay's ownership guarantee and must be paused for handoffs.
- Move automatic preview registration into active-session handling: the current PWA detects/publishes preview links only after turn completion, which would be too late under the accepted server-lifetime policy. Persist session ownership of each publication and make registration idempotent. A subscriber replay must not recreate a stopped preview or duplicate publication; task finalization removes owned links as well as stopping owned servers.
- Recovery first inspects recorded identities and scope, then offers termination of verified owned execution if supported, then rechecks that relevant writers stopped. Record actor, time, reason, checked generation, and evidence before clearing a guard. Never signal an unrelated/reused PID, and never use a “clear lock” button as proof of safety.
- If proof remains unavailable, retain uncertainty and give an actionable administrator runbook. A changed host boot ID can prove prior-host processes ended, but inspect pending transfer journals and current workspace state before allowing a new operation. Preserve interrupted edits and checkpoints; recovery does not roll files back automatically.
- A graceful shutdown rejects new starts, preserves subscriber independence, and either drains turns or follows the verified cancellation path. Forced termination is covered by reconciliation. Deployment and rollback must not bypass active guards or downgrade an unknown schema.

### Security, storage limits, and PWA behavior

- Apply the configured Tailnet-owner check to every start/read/replay/stop/recovery operation. Verify session owner, current workspace access, and thread/workspace membership before resuming; an ID is not authorization. Keep local-development bypass explicit and disabled in deployment.
- Preserve loopback binding and verify the trusted Tailscale proxy/header boundary; browser-controlled identity headers must not provide remote access. Define same-origin/CSRF checks for mutations. Session IDs, prompts, and log bodies must not enter generic request/error logs.
- Accepted retention: seven days of terminal event logs and 30 days of metadata/idempotency records. Implemented storage budgets are 64 MiB of event data per session and 1 GiB for controller events. Enforce serialized event size and process-output buffering limits as well. Verify these budgets against the VM's disk capacity before release.
- At a per-session output limit (60 MiB, reserving 4 MiB of the 64 MiB budget for controls), request a controlled stop while reserving space for status events. Never delete active or uncertain evidence to make room. If storage fails or the hard limit is reached, stop accepting new work and attempt verified cancellation; retained nonterminal guard state blocks transfers if final persistence fails. No guarantee can cover output that never reached durable storage.
- Cleanup targets terminal sessions only, respects short-lived replay readers, and reports expired ranges explicitly. Keep compact audit/idempotency records without prompt bodies after event expiry. Bound database/WAL growth and checkpoint/backup usage; use SQLite-aware backups and test their restoration.
- The PWA discovers authoritative sessions on workspace/conversation open and on resume. Store only session selection, idempotency identity, and a cursor with its matching rendered state locally; avoid persisting agent output in browser storage by default.
- Never use a stored cursor with an empty transcript. On a fresh page, rebuild retained session output from its beginning or load a server snapshot with its matching cursor. Merge completed Codex history and Relay replay by thread/turn/message identity so user prompts and assistant text do not appear twice. Establish stable message IDs or a documented turn-boundary rendering strategy before implementation.
- Distinguish “Reconnecting…” from execution failure. Disable conflicting submission based on server state, allow navigation between views, and reconnect with backoff when online/visible. Disconnect an old view's subscriber without stopping its turn. Two browsers observe the same execution and Stop outcome.
- Map `CANCEL_REQUESTED` to “Stopping…” and `UNCERTAIN` to a recovery view. Preserve model/effort, uploads, Markdown, file/diff views, conversation history/hiding, and loopback previews. Hide a conversation without deleting or orphaning its active session; keep active sessions discoverable.

## Open points and implementation gates

These are the concrete points to close with code, decisions, or test evidence. Suggested defaults above permit implementation to start; the process-scope and cross-language guard questions must be settled before claiming crash safety.

Track measured evidence, accepted user choices, and partial closure in the [V1.4 decision register](RELAY_V1_4_DECISIONS.md). Q-01 through Q-05 are answered; no product question from that set remains pending. The first audit verified local SQLite interoperability and Codex message identifiers. The local session store, process-scope driver, compatible helper guards, API, PWA and recovery are implemented and fixture-tested. Actual delegated cgroup, compatible rollout, paired desktop and physical-phone verification remain open.

| ID | Open point | Proposed direction | Completion evidence |
| --- | --- | --- | --- |
| OP-01 | Supported durable-store runtime | SQLite; pin Node support and verify Python interoperability | Transaction, permissions, WAL, disk-full, and recovery fixtures on the target VM |
| OP-02 | Session versus conversation identity | One session per turn, many sessions per Codex thread | New chat before thread creation, saved chat, lost start response, and continuation tests |
| OP-03 | Spawn/start ambiguity | Persist intent before side effects; never auto-retry ambiguous starts | Kill at each persistence/spawn/start boundary; one prompt execution or quarantined uncertainty |
| OP-04 | Reliable stop evidence and process ownership | Implement the accepted per-task scope; stop task-created dev servers at task end; quarantine unproven cleanup | Live VM orphan, detached writer, PID reuse, server cleanup, cancellation, and systemd restart tests |
| OP-05 | Guard coverage across all transfers | Shared OS lock plus persistent guard in Node and standalone Python helper | Git/plain initial and repeat transfers, merge, checkpoint, resume and legacy-path coverage |
| OP-06 | Atomic catch-up and live subscription | Persisted ID queries as the only delivery source | Inject events at every replay/live boundary; identical ordered output in two clients |
| OP-07 | History/replay duplication | Bind thread/turn/item identity or define a turn-boundary snapshot | Reload a partially rendered turn and a completed turn without missing or duplicated text |
| OP-08 | Idempotency expiry and reconnect UX | Retained keys plus stale-request rejection; retry the original key/body | Lost POST response, simultaneous requests, restart, changed payload and expired-key tests |
| OP-09 | Limits and failure policy | Review proposed budgets; stop safely before exhaustion | Bounded disk/memory/WAL, slow readers, quota, disk-full and failed-finalization tests |
| OP-10 | Recovery interface and audit | Evidence-based inspect/terminate/recheck with generation checks | Authorized recovery succeeds only with stop evidence; unknown writers remain blocked |
| OP-11 | Deployment compatibility | Update controller, PWA and SSH helpers as one compatible release | Recorded deployed revision/schema/helper version; no old-helper guard bypass |
| OP-12 | Actual device acceptance | Physical phone on the private Tailnet and a paired desktop | Multi-minute phone lock/offline test, Stop, two browsers and post-turn handoff receipts |

## Ordered execution checklist

1. [ ] **Baseline and design contract.** Record checkout/deployed revisions and existing local/SSH test results; inspect the actual service unit and Codex lifecycle on a disposable fixture. Settle OP-01 through OP-05, schema, state transitions, cancellation evidence, lock order, and supported runtime. Record limits and the no-automatic-restart guarantee.
2. [x] **Durable store and shared guard.** Implement schema/migration, transactional event/state writes, idempotency, singleton ownership, Node/Python guard readers, transfer-path coverage and fail-closed behavior. Gate: corrupted/missing initialized storage and controller absence cannot permit a conflicting write.
3. [x] **Server-owned execution and explicit Stop.** Refactor Codex execution handles and session manager, persist spawn/start boundaries, retain locks, and detach HTTP lifecycle. Gate: start-response loss and zero subscribers do not cancel or duplicate execution; Stop does not unlock early.
4. [x] **Session API and replay.** Add scoped routes, ordered SSE, cursor rules, subscription backpressure and compatibility adapters. Gate: two subscribers, replay/live races and repeated requests all pass.
5. [x] **Restart reconciliation and recovery.** Implement evidence collection, `UNCERTAIN` handling, recovery/audit flow and startup gates. Gate: orphaned/unknown writers block both turns and Git/plain handoffs; no prompt is restarted automatically.
6. [x] **PWA session flow.** Add discovery/resume, transcript reconciliation, reconnect status, explicit Stop and recovery messages. Gate: fresh page and existing page both recover the same session and preserve the current PWA functions.
7. [ ] **Resource/security hardening.** Finish owner/thread scoping, CSRF/proxy checks, limits, retention, backup/restore and storage-failure behavior. Gate: unauthorized replay/Stop/recovery fails and resource failures cannot bypass guards.
8. [ ] **Automated and VM E2E.** Execute the [V1.4 runbook](RELAY_V1_4_SESSION_E2E_TEST_PLAN.md), then the existing [handoff runbook](RELAY_E2E_TEST_PLAN.md). Resolve failures before rollout. Mark physical-device checks separately from simulated tests.
9. [ ] **Deploy and report.** Deploy compatible artifacts to the private VM, verify loopback listener/local HTTP and private proxy behavior, perform the physical phone run, and update `CURRENT_PROGRESS.md` with verified guarantees, receipts, remaining limitations and rollback constraints.

## Implementation files

- Add `pwa/lib/sessions.mjs`, `pwa/lib/session-store.mjs`, and a shared workspace execution-guard module; choose the final module split during implementation.
- Refactor `pwa/lib/codex.mjs` and `pwa/server.mjs`; extend `pwa/lib/workspaces.mjs` with session/readiness metadata.
- Update `pwa/public/app.js`, `pwa/public/index.html`, and `pwa/public/styles.css` for session status, reconnect, Stop, and recovery.
- Extend guard enforcement in `relay_lib/export_workspace.py` and the CLI/helper dispatch paths used by plain, Git, merge, and recovery operations. Preserve the existing transfer engines.
- Add session/store/recovery HTTP and browser integration tests; extend Python handoff tests with durable guard fixtures. Add an opt-in real VM session suite with its own disposable state and controller unit.
- Update deployment/runtime configuration, this plan, the V1.4 runbook, `README.md`, and `CURRENT_PROGRESS.md` when behavior is implemented and verified.

## Guarantees to document after verification

- Phone/browser disconnection does not stop a running server-owned turn. Within retained event ranges, clients can reconstruct every committed Relay event in order; duplicate delivery is possible and is deduplicated by ID.
- Accepted starts are deduplicated within the documented key-retention contract; stale retries are rejected rather than executed again. Ambiguous external starts are quarantined rather than repeated.
- Stop remains pending until execution outcome is confirmed. Active, cancelling, uncertain, or unfinalized execution prevents conflicting Relay work and workspace handoffs.
- Controller crash recovery provides safe reconciliation and recovery, not seamless continuation. Events not committed before a crash may be unavailable. Host-restart continuation is outside this milestone.
- Guarantees assume functioning local durable storage and compatible deployed helpers, and cover Relay-owned execution within the verified process scope. Arbitrary external writers, malicious same-user processes, and tenant isolation are outside this single-owner boundary.
