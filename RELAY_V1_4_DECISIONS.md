# Relay V1.4 — Evidence and decision register

Recorded on 23 November 2026 against checkout `a0c34cc`. This register distinguishes measured facts, implementation proposals, and unanswered user decisions. No product choice below is treated as approved merely because a recommendation exists.

The user answered Q-01 through Q-05 on 23 November 2026: dev servers must remain running until the task is complete and then stop; use the recommendations for the other four questions. Those product decisions are closed. Their implementation and verification remain open.

## Evidence collected

### E-01 — Deployed controller and runtime

- The live service executes `/usr/local/bin/node /opt/relay/pwa/server.mjs`, as user/group `relay`, from `/opt/relay`.
- Both the shell and service executable resolve to Node `v22.18.0`. Python is `3.12.3`; Codex is `0.162.1`.
- SHA-256 comparisons matched the checkout and deployed copies of `pwa/server.mjs`, `pwa/lib/codex.mjs`, `pwa/lib/workspaces.mjs`, `pwa/lib/previews.mjs`, and `relay_lib/export_workspace.py`. This is evidence for those five files, not a claim that every deployment artifact or its provenance is verified.
- The actual unit has `ReadWritePaths=/home/relay`, whereas the repository example lists only the controller directory. Implementation and deployment must use the actual unit as evidence and reconcile this drift intentionally.
- The current listener is `127.0.0.1:4388`. A local health request without an owner identity returned HTTP `401`. Tailscale Serve has a proxy to that listener and reports no enabled Funnel configuration. Full authorization/proxy-bypass testing remains pending.
- Observed capacity: approximately 64 GiB free disk, 3.8 GiB total memory, and no swap. Capacity alone does not establish acceptable concurrency or storage budgets.

### E-02 — SQLite interoperability and process-crash probe

A disposable directory and database were created outside the repository and production controller state. Node and Python subprocesses exercised these cases; fixture processes were terminated by their exact subprocess handles and the directory was removed afterwards.

| Check | Observed result |
| --- | --- |
| Node built-in SQLite availability | Available, with the runtime's experimental API warning; SQLite `3.50.2` |
| Python SQLite availability | Available; SQLite `3.45.1` |
| Node configuration | WAL mode; `synchronous=FULL` read back as `2` |
| Python read of a Node transaction | Passed |
| Concurrent Python read while Node held an uncommitted write | Saw only the prior committed state |
| SIGKILL before Node transaction commit | Uncommitted state/event changes rolled back together; integrity check returned `ok` |
| SIGKILL after commit while WAL existed | Committed state/event changes remained visible; integrity check returned `ok` |
| Node read of a Python commit | Passed |
| Fixture permissions | Directory `0700`; database and observed sidecars had no group/other permissions |

This closes the narrow feasibility question of local Node/Python SQLite interoperability for these versions. It does not implement a session store, establish host power-loss durability, test production throughput, or verify disk-full, corruption, migration, retention, database deletion, WAL growth, backup restoration, and directory-fsync behavior. Runtime support/pinning and those tests remain OP-01 work.

Reproduction outline: initialize two tables in one Node SQLite WAL database with `synchronous=FULL`; read them using Python `sqlite3` in `mode=ro`; pause a Node writer before/after `COMMIT`; SIGKILL that exact fixture writer; inspect both tables and `PRAGMA integrity_check`; write through Python and read back through Node. Keep each probe in a new private temporary directory.

### E-03 — Codex protocol identities and interruption

Generated JSON schemas using the installed `codex app-server generate-json-schema` in a temporary directory; no inference turn or user conversation was started or interrupted.

- `AgentMessageDeltaNotification` requires `threadId`, `turnId`, `itemId`, and `delta`.
- `ReasoningSummaryTextDeltaNotification` requires those identities plus `summaryIndex`.
- User and assistant thread items have stable `id` fields. Item lifecycle notifications also carry thread/turn identities.
- `TurnCompletedNotification` carries `threadId` and a turn including ID/status. The installed status enum is `completed`, `interrupted`, `failed`, or `inProgress`.
- `TurnInterruptResponse` is an object acknowledgment; terminal outcome arrives separately. Current [official OpenAI app-server documentation](https://learn.chatgpt.com/docs/app-server) likewise distinguishes requesting interruption from the final turn notification and describes stdio and version-specific schema generation.

Engineering consequence: retain these identities in Relay events and conversation history, filter notifications to the expected thread/turn, and reconcile rendered output by item identity. The current adapter flattens messages and drops identifiers that the installed protocol provides. This resolves identifier availability for OP-07; the renderer/replay implementation and its race tests remain open.

An interrupted turn notification describes Codex turn status. It is not independent proof that every detached writer or server on the VM has stopped.

### E-04 — Process ownership is a release blocker

- The host uses cgroup v2. The live unit has `KillMode=control-group`, `Delegate=no`, and a shared `/system.slice/relay-pwa.service` cgroup.
- The inspection process and the active implementation conversation are themselves in that live service cgroup. Restarting or killing this unit would affect the current work; this audit did neither.
- The service cgroup and membership/control files are not writable by the current service user. A user-systemd query failed with no available user bus; `user@1000.service` is inactive and `loginctl` reports the user is not logged in or lingering.
- Consequently, neither delegated per-task cgroups nor a working user-service manager can be assumed available. The presence of `systemd-run` alone does not establish usable task scopes.
- A subsequent `sudo -n true` probe failed because the live service has `NoNewPrivileges` set. Privileged installation cannot be performed through elevation from this service context. Prepare the scope mechanism and installation procedure in the repository, test on an appropriately configured disposable service, and have a host administrator apply the deployment prerequisite through an administrative connection.

The unit's group-wide kill setting is not proof of per-task crash behavior. OP-04 requires either a verified deployment mechanism for per-task ownership/termination or conservative uncertainty with a documented manual recovery path. This audit did not create a scope, change delegation, enable a user manager, alter privileges, or test killing production descendants.

### E-05 — Transfer guard coverage and old desktop clients

- `import_workspace.py` reads its local `export_workspace.py` into `HELPER` and invokes it remotely using `python3 -c` over SSH. The helper is supplied by the desktop checkout, not selected from the deployed controller directory.
- `capture` and `git_capture` acquire `turn_lock`; Git remote handoff actions also acquire it.
- Plain `push_one`, `batch_begin`, and `batch_apply` use export/batch locks in their current implementations without the shared turn guard at dispatch. Checkpoint mutations have their own endpoint lock. The full action/lock inventory must be completed before guard implementation.
- `_push_assert_idle` explicitly calls itself advisory. `lsof` scans do not exclude a writer starting after the scan.

Engineering consequence: compatible helpers must check persistent execution state under the shared workspace lock, including controller downtime. Old clients that ship old code can bypass a new reader unless they are retired or transfer execution is redesigned around an enforced server entrypoint. A version field checked only by a new client is not enforcement against the old code path. OP-05/OP-11 therefore include a desktop compatibility decision and an explicit supported-boundary statement.

## Accepted user decisions

These answers are explicit user choices, recorded on 23 November 2026. They supersede the earlier recommendations where they differ.

| Question | Decision | Status | Implementation consequence |
| --- | --- | --- | --- |
| Q-01 | Keep task-created preview/development servers running while the task is active; stop them when the task ends | Accepted; overrides the earlier keep-after-completion recommendation | Verify cleanup before reporting terminal status and releasing handoff protection |
| Q-02 | Seven days of terminal event logs; 30 days of session/idempotency metadata | Accepted recommendation | Implement retention without deleting Codex conversation history or active/uncertain evidence |
| Q-03 | Up to two concurrent tasks in different workspaces; one per workspace | Accepted recommendation | Enforce admission limits and test independent workspaces |
| Q-04 | Require verifiable per-task process tracking and its deployment prerequisites | Accepted recommendation | Prepare a scope mechanism; verify cleanup/crash evidence on a fixture before rollout |
| Q-05 | Require a compatible desktop Relay CLI update | Accepted recommendation | Upgrade controller and desktop helper protocol together; retire old clients from the supported workflow |

For Q-01, the agent's final message alone does not finish Relay finalization. Keep the session's execution protection until task-owned dev servers and other relevant descendants are confirmed stopped. Show a finishing/cleanup phase while the existing nonterminal state is retained. Remove only preview publications owned by that session. Apply cleanup to successful, failed, and explicitly stopped tasks; loss of a browser subscriber must not trigger cleanup. If cleanup cannot be confirmed, mark `UNCERTAIN` and keep handoffs blocked. Do not terminate unrelated or pre-existing servers merely because they use the same workspace or port.

The current `sendPrompt` flow publishes detected previews after completion. Implementation must move publication into active-session handling, with persistent ownership and idempotency, so previews are usable while the task is active and are not recreated when missed events are replayed after cleanup.

For Q-04, allowing a deployment change does not prove a cgroup design works or require immediate interruption of the live service. Build and verify the migration on a dedicated fixture before production rollout. The current service cannot elevate to install this prerequisite (E-04); an administrator installation step is a deployment dependency, not another unanswered product preference.

For Q-05, compatibility must be stated honestly within Relay's single-owner boundary: a same-user SSH client can execute arbitrary code. This milestone cannot turn full SSH access into tenant isolation. Requiring updated clients is a supported-workflow rule, not a claim that old or malicious same-user code is technically confined.

## Implementation status — 23 November 2026

OP-01–OP-10 now have a local implementation and automated evidence. SQLite schema
1, private permissions, transactional guards/events, idempotency/expiry, retention,
quota/disk-full and interrupted-write tests are implemented. Session identities
bind to thread/turn/item IDs; the PWA rebuilds retained output on a fresh page.
Database-driven replay, bounded subscribers, explicit Stop and audited recovery
are implemented. Shared Python guards cover supported transfer entrypoints.

The process-scope driver uses delegated cgroup v2 with no production process-group
fallback. It records scope identity before spawn and persists an initialization
fence before starting Codex work. Unfenced startup ambiguity remains UNCERTAIN;
an empty scope alone is insufficient. Fixtures test actual controller SIGKILL,
orphaned execution, descendant-server cleanup, cancellation and recovery, but use
an injected process driver. They do not prove production cgroup behavior.

The Node suite reports 63 passes and one cgroup skip (64 total). The rendered
mobile Chromium fixture passes page closure/replay, two subscribers, Stop,
file navigation and recovery. See [V1.4 progress record](CURRENT_PROGRESS_VM.md) for
Python results and [E2E results](RELAY_V1_4_SESSION_E2E_TEST_PLAN.md).

OP-04 remains open for actual delegated-cgroup and real-Codex evidence. OP-05
requires paired desktop Git/plain receipts with the updated helper. OP-09 requires
operational backup/restore and resource validation on the deployed candidate.
OP-11 and OP-12 remain open: administrator prerequisite installation, compatible
rollout and physical-phone acceptance. The prepared
[deployment/recovery runbook](RELAY_V1_4_DEPLOYMENT.md) explains the current
NoNewPrivileges/delegation blocker. No live service was restarted or deployment
claimed. The implementation checklist deliberately leaves rollout and full E2E
unchecked.
