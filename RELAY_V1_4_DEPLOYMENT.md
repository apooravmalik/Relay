# Relay V1.4 deployment and recovery

The implementation requires Linux cgroup v2 and a delegated task subtree. There is no production process-group fallback. Browser disconnection never requests cancellation. Task-owned servers run while the turn is active and are killed as part of verified finalization before terminal status and handoff unlock.

## Prerequisites and candidate installation

The runtime tested here is Node 22.18.0 (`node:sqlite`, currently experimental), Python 3.12.3 and Codex 0.162.1. Install compatible Node/Python/Codex, `flock`, `ss`, Git, rsync and the existing transfer prerequisites. Use a local filesystem with working SQLite WAL/fsync semantics. Back up controller state with SQLite's backup API or while the controller is fully drained; copying only a live main database omits WAL data.

Keep the existing owner login and private Tailscale Serve configuration. The application binds to loopback and trusts the proxy's owner header within the single-owner VM boundary. Do not expose the loopback controller directly through a public proxy that accepts arbitrary identity headers. Keep `RELAY_ALLOW_LOCAL_DEV` disabled in deployment.

1. Deploy the candidate checkout as one artifact, including `pwa`, `relay_lib/session_scope_exec.py`, and `deploy/relay-handoff`. Retain the previous artifact and record the revision/hash. Update the paired desktop CLI before handoffs. The controller migrates session storage to schema 3 for atomic publication. Older controllers and installed helpers cannot operate against the new schema.
2. Use a dedicated candidate systemd unit/workspace/state directory first. Adapt the example drop-in's cgroup path to the candidate unit name. Set the same `RELAY_CONTROLLER_STATE_DIR` in the controller and SSH transfer environment. Default is `/home/relay/.relay-v0/controller`; session state is private and excluded from workspace transfers.
   Set a separate `RELAY_WORKSPACE_REGISTRY_FILE`, `RELAY_WORKSPACE_ROOTS`,
   `RELAY_PROJECT_ROOTS`, and `RELAY_PREFERENCES_FILE` for the candidate too.
   Otherwise it also lists the live service's registered workspaces while its
   separate guards cannot coordinate with the live service. Verify the candidate
   lists only disposable workspaces. Configure the matching registry, roots and
   controller state in the SSH helper environment before testing handoffs.
   Install the guarded helper on the VM as an executable symlink to the checkout's `deploy/relay-handoff`. Use `~/.relay-v0/bin/relay-handoff` for the default controller or a separate path for the candidate. For a candidate, put `relay-handoff.env` beside the symlink with the VM-owned settings below, matching the PWA. The service account must be able to read the checkout and access the same SQLite store and workspaces.

   ```bash
   RELAY_CONTROLLER_STATE_DIR=/home/relay/.relay-v14-test/controller
   RELAY_WORKSPACE_REGISTRY_FILE=/home/relay/.relay-v14-test/controller/workspaces.json
   RELAY_WORKSPACE_ROOTS=/home/relay/.relay-v14-test/workspaces
   ```

   On the desktop, set `RELAY_REMOTE_HELPER` to the candidate helper's absolute VM path. The new CLI will not combine it with client-supplied controller, registry, or workspace roots. For the default helper path the CLI discovers the installation automatically. The embedded helper remains for standalone transfers without a controller database. Limit managed workspaces to compatible Relay workflows and do not grant a second controller or legacy transfer job write access to them. A same-user shell or external editor can still write files directly.
3. An administrator must install [relay-pwa-v14.conf](deploy/relay-pwa-v14.conf) under the appropriate unit's drop-in directory and reload systemd. The current live controller has `NoNewPrivileges=true`; `sudo` from that service cannot install delegation. Keep that protection rather than turning it off for privilege escalation. Apply this prerequisite through an administrative connection.
4. Drain existing tasks and transfers before restarting/deploying. The existing live implementation conversation is inside `relay-pwa.service`; restarting it interrupts that conversation. Use a separate administrative session and the tested candidate deployment procedure.
5. Run `node deploy/check-v14-prerequisites.mjs` inside the candidate service's execution context. A shell elsewhere on the VM can have different cgroup permissions and does not validate the service. Then run the opt-in cgroup test: `RELAY_TEST_DELEGATED_CGROUP=1 node --test pwa/test/session-scope-vm.test.mjs`. That test creates only its own scope and loopback fixture server, including a detached descendant; do not set the flag on an undelegated or production task scope.
6. Run `npm test`, the Python suite, the real SSH handoff suites and the [physical phone runbook](RELAY_V1_4_SESSION_E2E_TEST_PLAN.md). Verify `ss -ltnH 'sport = :4388'` shows only loopback and obtain a local authorized health response before checking the private Tailnet URL. Health without owner identity should return `401`.

New tasks return `503` when delegation is unavailable. This is a deployment blocker, not a reason to bypass ownership checks. The database and initialization markers deliberately fail closed if damaged or missing after initialization.

## Recovery guarantees and procedure

Session state and monotonically ordered events are stored transactionally in SQLite with WAL and `synchronous=FULL`; publish occurs after commit. Uncommitted events can be lost in a crash. Replay covers retained committed events, with client deduplication by ID. The application does not promise host power-loss durability beyond the filesystem/SQLite guarantees or automatic continuation of a crashed turn.

After restart, pending sessions block execution and transfers immediately. A recorded scope with matching host boot ID, cgroup path and inode can prove it is empty only after the persisted initialization fence proves the child joined it (or a turn ID was recorded). Before that fence, a pre-join spawn wrapper could still exist outside an empty scope; recovery conservatively remains UNCERTAIN even if the scope is empty. A changed host boot ID proves prior-host processes ended. Missing or mismatched scope evidence remains `UNCERTAIN`; disappearance of a PID, HTTP connection or lock is not stop evidence. No prompt is repeated automatically.

1. Open the uncertain session in the PWA, or inspect `GET /api/workspaces/:wid/sessions/:sid/recovery` through the authorized controller.
2. Use **Recheck execution** to resolve only when current evidence proves stopped. Use **Terminate owned task and recover** to kill a positively identified owned scope, including its descendants, and recheck membership. Generation checks reject stale recovery actions. Recovery records actor, time and evidence in the private database.
3. If the scope identity is missing or cannot be verified, keep the guard intact. From an administrator connection inspect the recorded scope and pending transfer journals. Do not delete `workspace_guards`, lock files, initialization markers or session rows to force a handoff.
4. If reliable stop evidence is otherwise unavailable, a controlled host reboot provides a new boot ID. After restarting the compatible controller, verify interrupted task status, preserved edits and transfer journal recovery before another writer/handoff. A reboot is an administrator recovery action; Relay never initiates it automatically.
5. Restore damaged storage from a verified SQLite-aware backup before enabling work. Preserve the damaged copy for inspection. An unknown schema or missing initialized store must not be replaced with an empty database. Do not downgrade to an older controller/helper that ignores persisted guards while any session is active or uncertain.

For a pending handoff, use the original CLI resume command and the same VM helper configuration. The reservation stays active between SSH calls and if a process dies; there is no timeout that clears it. For a first import, `relay pull --abort-import TRANSFER_ID` releases an interrupted import before local publication has begun. A repeat pull may use `--abort-update` if its original destination and checkpoint still verify. If resume cannot verify the journal, keep the reservation and the retained files for inspection. Before upgrading or restoring a older controller backup, reconcile existing transfer journals and drain tasks. Do not roll back the database past a transfer that has changed either workspace.

Retention defaults: terminal event logs seven days; session/idempotency metadata and audit records thirty days. Active/uncertain evidence is retained. Event budgeting includes row overhead, with 64 MiB per session and 1 GiB across sessions; reserved control space permits safe stopping near the limit. Slow subscribers disconnect and replay later. SQLite page reclamation/checkpointing runs during cleanup. These limits bound retained event data; they are not a guarantee about every byte of filesystem overhead or arbitrary external process output.

Start retries reuse the original key, payload and creation timestamp. Matching retained keys return the same session. Changed payloads conflict. After metadata expiry, an original timestamp older than 24 hours is rejected with `410`; it cannot silently start another execution. Expired event replay returns `410` and directs the user to saved Codex conversation history, which Relay's retention does not delete.

## Verification limitations

Actual delegated-cgroup/real-Codex, paired-SSH and physical-phone acceptance must be recorded on the deployment used. Injected process-group fixtures exercise HTTP, child-server lifetime and persistence, but do not establish production cgroup containment. Keep these outcomes separate in the progress report.
