# Relay V1.4 — Session implementation and E2E acceptance

Status: local candidate implemented and fixture-tested; production cgroup, real Codex, paired SSH and physical-phone acceptance remain pending. See the [implementation plan](RELAY_V1_4_PERSISTENT_AGENT_SESSIONS_PLAN.md) for design and open points.

## Environment and evidence

- [ ] Record checkout and deployed revisions, Node/Python/Codex versions, database schema, controller/helper protocol versions, actual systemd unit and kill settings, host boot ID, phone OS/browser, desktop OS, and Tailnet proxy configuration.
- [ ] Use separate disposable Git and plain workspaces, an isolated controller state directory, and a dedicated test service. Crash only that controller/process scope; do not interrupt the controller running the implementation conversation. Bind test HTTP to loopback and verify its listener and local response before proxying privately.
- [ ] Use synthetic prompts and dummy file data. Preserve existing checkpoint and merge fixtures. Record session/thread/turn IDs, event ranges, idempotency key, process identities, cancellation evidence, workspace file hashes and transfer/checkpoint receipts. Keep raw sensitive events out of the public result report.
- [x] Add deterministic fake Codex behavior: waitable start/completion, numbered events, controlled file-writing child, interrupt acknowledgment separated from actual stop, orphan/detached writer, and counted `turn/start` calls. Use barriers rather than sleeps for automated race assertions.
- [x] Add the opt-in actual-cgroup fixture `pwa/test/session-scope-vm.test.mjs`. It uses only its own scope and loopback server; execution is still blocked here by missing delegation. Controller restart/orphan tests are in `session-restart.test.mjs`, with an injected fixture process driver.

Local regression commands:

```bash
npm test
python3 -m unittest discover -s relay_lib -p 'test_*.py'
```

Existing real SSH handoff suites require a disposable target alias. A skipped test is not a pass:

```bash
RELAY_DISPOSABLE_TEST_VM=YOUR_TEST_SSH_ALIAS python3 -m unittest -v relay_lib.test_vm_plain_push relay_lib.test_vm_git_handoff
```

For an opt-in live browser run, install Playwright outside the repository and use a
private candidate URL and a registered **disposable** workspace. The test sends a
real Codex prompt, writes a uniquely named heartbeat file, closes and reopens a
phone-sized browser, and opens the same session in a second browser. It leaves the
test session and file in that workspace for review. It does not test a physical phone.
It records Send-to-acceptance and Send-to-visible-message timings, independently
reads the session event stream, and compares streamed and final text with both
browser transcripts. It also takes the first browser offline, checks that the
heartbeat advances, then verifies the same session reconnects. The independent
event-stream observer is attached only after the closure and offline intervals,
so it does not keep the session subscribed during those checks. Timing results
are observations, not release thresholds.

```bash
RELAY_PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs \
RELAY_E2E_URL=https://YOUR_PRIVATE_CANDIDATE_URL/ \
RELAY_E2E_WORKSPACE_ID=YOUR_DISPOSABLE_WORKSPACE_ID \
RELAY_E2E_DISPOSABLE=1 \
RELAY_E2E_BROWSER_EXECUTABLE=/optional/path/to/chrome \
node pwa/test/session-live-playwright.mjs
```

Omit `RELAY_E2E_BROWSER_EXECUTABLE` to use Playwright's installed Chromium. The
default closure and offline periods are six seconds; set
`RELAY_E2E_CLOSED_MS=120000` for the two-minute closure check and optionally set
`RELAY_E2E_OFFLINE_MS` for a longer offline interval. This extends the heartbeat
task automatically. A browser simulation is not a physical-phone test. The
browser host must already be authorized to access the candidate. If the test
fails after starting a task, inspect its printed session and let it finish or stop
it through the PWA before retrying; closing the test browser does not stop it.

The additional `pwa/test/session-live-guard.mjs` test creates a disposable plain
workspace under `RELAY_E2E_ROOT_ID`, starts a real task, verifies that the
candidate refuses a nested task and the configured SSH helper refuses an import
of the workspace and its nested child
while it writes, requests Stop, closes and reopens the browser, and imports after
confirmed termination. This does not test the simultaneous-start race. Set the same variables above, replace
`RELAY_E2E_WORKSPACE_ID` with `RELAY_E2E_ROOT_ID` and set `RELAY_E2E_VM` plus
`RELAY_REMOTE_HELPER` as documented in the deployment guide. It leaves the
remote workspace and local imported fixture for inspection. Its failure cleanup
requests Stop but cannot guarantee termination; inspect the printed session.
Set `RELAY_E2E_GIT=1` and `RELAY_E2E_REMOTE_WORKSPACE_ROOT` to initialize a
disposable Git repository and verify its commit and index after import. The
`session-live-handoff-race.mjs` test holds
the remote shared gate and verifies the candidate refuses a PWA task start; it
requires the same URL, root ID, VM and disposable flag, plus the controller
path in `RELAY_E2E_REMOTE_CONTROLLER_STATE_DIR`.

For a local RLY-025 browser test, run `node pwa/test/session-browser-handoff.mjs`
with `RELAY_PLAYWRIGHT_MODULE` set to Playwright's `index.mjs`. The fixture uses
the installed handoff helper and the real PWA server with an injected task
runner and isolated SQLite storage. It verifies overlapping starts, sibling
independence, path replacement, and recovery after the handoff process is killed.

For a local browser/controller crash fixture, run:

```bash
RELAY_PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs \
RELAY_E2E_BROWSER_EXECUTABLE=/optional/path/to/chrome \
node pwa/test/session-browser-crash.mjs
```

This test kills only its own temporary controller, observes a fixture writer,
checks the standalone helper guard with the controller absent, and verifies the
browser reopens to UNCERTAIN with new tasks and unverified recovery blocked. It
uses an injected process scope and does not replace real-cgroup or real-Codex
crash acceptance.

`pwa/test/session-live-crash.mjs` exercises real Codex and cgroups in a separately
created transient VM service. It requires the Playwright module, `RELAY_E2E_VM`,
absolute `RELAY_E2E_REMOTE_TEST_ROOT` and `RELAY_E2E_REMOTE_CHECKOUT`, plus
`RELAY_E2E_DISPOSABLE=1` and `RELAY_E2E_CRASH_SERVICE=1`. The SSH user must have
noninteractive sudo for that transient service. It kills only its uniquely named
test controller, stops that service afterward, and retains its private fixture
directory for inspection; never point it at an existing service.

```bash
RELAY_PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs \
RELAY_E2E_VM=YOUR_SSH_ALIAS \
RELAY_E2E_REMOTE_TEST_ROOT=/absolute/private/test/root \
RELAY_E2E_REMOTE_CHECKOUT=/absolute/path/to/candidate/checkout \
RELAY_E2E_DISPOSABLE=1 RELAY_E2E_CRASH_SERVICE=1 \
node pwa/test/session-live-crash.mjs
```

`pwa/test/session-live-preview.mjs` uses the same candidate URL, root ID, VM,
Playwright module and disposable flag as the guard test. It starts a real
loopback server through Codex, publishes a session-owned private preview, closes
and reopens the browser, and verifies the server and route are removed on Stop.
If it cannot verify cleanup, inspect the printed session and port before retrying.

## Automated acceptance matrix

The matrix defines required release coverage. Fixture receipts below do not close rows that also require deployed-process or physical-device evidence.

| ID | Layer | Scenario | Required result |
| --- | --- | --- | --- |
| S01 | HTTP + runner | Disconnect immediately after accepted start and while events stream | One turn continues; no implicit interrupt; guard remains held |
| S02 | Store + HTTP | Replay after cursor while new events commit at the catch-up boundary | Every committed event delivered in order; no gap; client applies each ID once |
| S03 | HTTP + browser | Cursor zero, duplicate/stale cursor, negative/malformed/unsafe integer, future cursor and expired range | Valid replay is deterministic; invalid/future cursor errors; expired range explicitly returns recovery/history guidance |
| S04 | HTTP + browser | Two simultaneous subscribers; one disconnects; one becomes a slow reader | Same session and output; no duplicate turn; bounded memory; other subscriber/execution unaffected |
| S05 | Store + runner | Concurrent start retries, lost POST response, same key/different body, retry after restart and expired key | Same accepted request resolves to one session; changed body conflicts; ambiguous execution is never repeated; stale expired request cannot launch |
| S06 | Runner + guard | Stop before thread/turn identity and during active file writes | Intent is retained; no premature unlock; terminal Stop only after confirmed end; file counter stops changing |
| S07 | HTTP + browser | Disconnect during cancellation; Stop from second browser; interrupt acknowledgment without actual stop | Reopen shows persisted state; repeated Stop is safe; acknowledgment alone never reports Stopped |
| S08 | Runner + store | Completion/Stop race and duplicate terminal notifications | One durable terminal outcome, correct status and lock release |
| S09 | Python + HTTP | Git/plain initial/repeat handoff, capture, push, pull, checkpoint mutation, merge publication and resumed transfer during active/cancelling execution | Blocking response before unsafe capture/write/acknowledgment; unchanged files/index/HEAD/checkpoints |
| S10 | Processes + store | Controller SIGKILL during reservation, spawn, thread binding, turn start, active writes, and final commit | Prior nonterminal state blocks restart and transfers; no automatic prompt replay; durable records reconcile or become UNCERTAIN |
| S11 | VM + guard | Orphaned app-server, surviving child, detached writer, reused PID and missing OS lock | No false stop proof; no unrelated process signaled; session and workspace remain UNCERTAIN where evidence is insufficient |
| S12 | VM + recovery | Authorized termination/recheck, stale recovery generation, unverified writer and changed boot ID | Only evidence-supported recovery clears guard; recovery audited; interrupted edits and checkpoint journals preserved |
| S13 | Store + HTTP | Disk full, permission failure, database corruption, missing initialized DB, failed terminal commit, interrupted WAL transaction | No unlogged live publishing, silent reset or unsafe unlock; existing durable guard blocks conflicting work |
| S14 | Store + HTTP | Per-session/global quota, cleanup during replay, oversized event and slow output consumer | Bounded disk/memory/WAL; safe stop/refusal; explicit replay expiry; active/uncertain evidence retained |
| S15 | Auth + HTTP | Missing/wrong owner, wrong workspace/session/thread, direct header injection, cross-origin mutation and local-dev bypass disabled | Unauthorized operations cannot read, start, stop or recover; errors do not leak prompt/event contents |
| S16 | Browser | Fresh reload with stored cursor but empty transcript; partially rendered output; completed thread history plus replay | No missing beginning, duplicate messages, repeated previews or automatic prompt submission |
| S17 | Browser | Navigate to Files/Changes, change workspace, reopen/hide active conversation, suspend/resume, attachment and model selection | Active session remains discoverable and correct; existing PWA features work |
| S18 | Deployment | Two controllers, unknown schema, mismatched helper, controller absent during SSH handoff, candidate rollback | Singleton/version gates hold; conflicting transfers fail closed; rollback cannot bypass durable guards |
| S19 | Processes + browser + guard | Task-created dev server during execution, followed by success, failure or explicit Stop; include a detached server and a pre-existing unrelated server | Task-created server remains available while active, then stops before terminal status/unlock; session-owned preview is removed; unrelated server remains untouched; unproven cleanup becomes UNCERTAIN |

## Real VM and physical phone sequence

### 1. Establish a measurable task

1. Open the candidate PWA on the physical phone through its private Tailnet URL. Open a disposable Git workspace and select a model/effort. Save a screenshot or safe status record.
2. Submit a task such as the following, once:

   > In this disposable workspace only, run a foreground Python task for at least five minutes. Every five seconds append the next integer and a timestamp to `session-heartbeat.txt`, flushing each write. Keep the task in the foreground and do not leave background processes. When it finishes, report the final line count and create `session-done.txt`. Do not change Git history, install packages, or start a network service.

3. Verify the task actually started, has a persisted Relay session ID and Codex turn identity, and is still running. Do not interpret a model's plan or text response as proof that the long task ran. Record its event cursor and heartbeat count.
4. A real model may not emit output at a predictable frequency. Use the deterministic fixture to prove lossless replay; use this task's file writes and real session output to prove actual execution and phone recovery.

### 2. Close the phone and reconnect

1. While the task is active, lock the phone or close the PWA for at least two minutes. From a separate observer, verify that file counts continue advancing and the session remains active with no Stop intent.
2. Attempt a Git handoff from the paired desktop while the phone is closed. It must refuse unsafe work; record the error and unchanged checkpoint/index/HEAD. Use the existing handoff runbook for the exact paired-workspace commands.
3. Reopen the PWA to the same workspace/session. Verify the same session/thread/turn identity, prior output, accumulated output/status, and no duplicate prompt execution. Repeat once using airplane mode and restore the network.
4. Allow completion. Verify the final heartbeat and done file, matching UI/store terminal status, and successful terminal persistence before lock release. Continue with a new prompt in the same conversation and confirm it creates one new turn/session.
5. Repeat in a plain workspace and verify plain handoff refusal while active, then a successful paired handoff after confirmed completion.

### 3. Stop while disconnected

1. Start another measured task. Open the same session in a second authenticated browser. Confirm both show one execution.
2. Request Stop on the phone while the file counter advances, then disconnect immediately. A `202` response or interrupt RPC acknowledgment is not sufficient proof of Stop.
3. Observe the cancellation status from the second browser. Verify Stopped only after the runner confirms termination and the counter stops. Reconnect the phone and verify the same final status/output.
4. Attempt a handoff during cancellation and after confirmed stop. The first must refuse; the second must preserve the stopped task's actual file bytes and existing checkpoint semantics.

### 4. Controller crash and orphan recovery

1. Start a measured task using the dedicated disposable controller unit. Record process start identities, scope membership, guard and event cursor.
2. Kill only the fixture controller process, then attempt a conflicting start and Git/plain transfer with the controller absent. Persistent nonterminal guards must block unsafe work even if the OS lock vanished.
3. Restart the fixture controller. If the relevant execution is proven stopped, verify a recorded interrupted/failed result. If any writer survives or evidence is incomplete, verify session/workspace `UNCERTAIN`; new turns and handoffs must remain blocked. Never expect silent continuation or automatic prompt replay.
4. Use a fixture with a surviving/orphaned child to force the uncertain branch even if systemd normally kills all service children. Exercise the supported inspect/terminate/recheck recovery action and verify audit records and unchanged interrupted edits.
5. Try recovery with a stale generation and a simulated reused PID. Verify refusal and no signal to an unrelated process. If the implementation cannot prove safety, keep the fixture blocked and follow the documented administrator procedure.
6. Repeat storage-failure cases against fixture storage. Verify the recovery screen/status path and Python SSH guards remain safe when final events cannot be committed.

### 5. Existing functionality and rollout

1. Run the existing [Git/plain handoff E2E runbook](RELAY_E2E_TEST_PLAN.md), including two repeat cycles, staged/unstaged distinctions, merge/conflict/recovery and protected/excluded data cases. Preserve receipts.
2. Exercise saved/new chats, model/effort, hiding, uploads, Files/Changes, Markdown and private loopback previews. Confirm resumed event replay does not republish a preview as a duplicate side effect. Run a task that keeps a loopback dev server alive while waiting on a fixture barrier: confirm the preview stays available across phone disconnection, release the barrier, then confirm task-end cleanup removes the owned publication and stops the server before terminal status and handoff unlock. Repeat with failure and explicit Stop. Check a pre-existing unrelated service remains running.
3. Record the exact candidate/deployed revisions and compatible helper version. Verify the actual listener is loopback, a local HTTP health response succeeds, and the private proxy accepts only the owner.
4. Update `CURRENT_PROGRESS.md` and the README with behavior actually verified, device/platform coverage, configured retention/limits, recovery instructions and remaining gaps. Physical-phone and cross-platform tests remain unverified until performed.

## Exit criteria and results

Release only after S01–S19 pass at their required layers, the real VM crash/recovery cases pass, the physical phone acceptance succeeds, and existing handoff regressions pass. A mocked test cannot stand in for process termination proof or a physical phone result.

| Evidence | Result | Reference |
| --- | --- | --- |
| Existing Node baseline | 46 passed, 0 failed on 23 November 2026 | `npm test`, code baseline `a0c34cc` |
| Existing Python baseline | 73 passed, 2 skipped, 0 failed on 23 November 2026 | `python3 -m unittest discover -s relay_lib -p 'test_*.py'`, code baseline `a0c34cc`; the two real SSH suites require a target alias |
| SQLite feasibility probe | Passed Node/Python interoperability, transaction rollback/committed WAL after fixture SIGKILL, and private permissions on 23 November 2026 | [Decision register E-02](RELAY_V1_4_DECISIONS.md); prerequisite evidence only, not a pass for S10/S13 |
| V1.4 Node fixtures | 63 passed, one actual-cgroup test skipped, zero failed; 23 November 2026 | `npm test` (64 tests); deterministic Codex fixtures, real child servers, SIGKILL/orphan recovery, SQLite failure tests. Selected scenarios in S01–S19 have fixture coverage; remaining process/device layers and kill-at-every-boundary cases are pending |
| Rendered mobile browser | Passed on Chromium, 390 × 844; 23 November 2026 | `RELAY_PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node pwa/test/session-browser.mjs`; mock execution, real browser. Closure/replay, history, files, two clients, Stop and recovery |
| Candidate cgroup prerequisite | Passed on dedicated delegated test service; production service remains undelegated | Startup checker and opt-in detached-child cgroup fixture, 24 November 2026 |
| Python handoff and guard regressions | 76 passed, two real-SSH suites skipped, zero failed (78 total); 23 November 2026 | Includes initialized/corrupt/missing storage and guarded transfer entrypoints; existing local Git/plain regressions |
| Real SSH Git/plain regression | Both isolated SSH suites passed sequentially on Linux, 25 November 2026. A later Git rerun using the updated helper passed on 26 November. Earlier runs encountered SSH resets; the retained test fixture was removed. | `RELAY_DISPOSABLE_TEST_VM=relay-do-v0 python3 -m unittest -v relay_lib.test_vm_plain_push relay_lib.test_vm_git_handoff`; fixture data only |
| Real Codex VM session run | Passed a 120-second browser closure with no event-stream subscriber (heartbeat advanced 1→61), simulated offline/reconnect, and matching replay in two browsers. The offline-state test failed before the UI fix. This is not a physical-phone pass. | `session-live-playwright.mjs`; 26 November 2026 |
| Physical phone lock/offline/reopen | Not run | Record device, duration and matching session |
| Explicit Stop and handoff locking | Real Codex writing task: candidate-configured SSH plain and Git imports refused while active; Stop confirmed after browser closure, heartbeat stopped, session reopened, imports succeeded afterward. The PWA gate test failed with HTTP 202 before the fix and passed afterward. Repeated Git cycles on the new candidate and physical-phone cases remain. | `session-live-guard.mjs`, `session-live-handoff-race.mjs`; 26 November 2026 |
| Controller crash/orphan/recovery | Passed local Playwright orphan fixture; an isolated transient real-VM controller run verified a populated owned cgroup, blocked SSH during SIGKILL, reopened UNCERTAIN without replay, and kept SSH blocked after an unverified recheck. A long-message recovery layout failed before its CSS fix and passed afterward. Broader fault points and physical-phone checks remain. | `session-browser-crash.mjs`, `session-live-crash.mjs`; 26 November 2026 |
| Real preview lifetime | A private preview remained available across browser closure; the owned server and route were removed before confirmed Stop, and pre-existing Tailnet route configuration was unchanged. Success/failure completion and unrelated-server-process cases remain. | `session-live-preview.mjs`; 26 November 2026 |

Remaining limitations to state explicitly: no claimed seamless controller/host restart continuation; replay limited to retained committed events; arbitrary external writers outside the verified ownership scope; single-owner authorization rather than tenant isolation.
