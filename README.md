# Relay V0 prototype


The V1.4 persistent-session implementation is available in this checkout. It adds
server-owned turns, reconnect/replay, explicit Stop and guarded recovery. It is
**not deployed or release-accepted**: the live service needs cgroup delegation,
and real Codex/phone/paired-desktop acceptance remains pending. See the
[deployment and recovery guide](RELAY_V1_4_DEPLOYMENT.md) and
[V1.4 verification record](CURRENT_PROGRESS_VM.md).

Relay is a private, single-owner prototype for working on VM workspaces from a
phone and transferring them to or from a PC. Its CLI supports an initial Git
push and legacy patch return, as well as a separate first import of a VM-created
plain or supported Git workspace. `--vm` accepts a Lima VM name or an SSH host
alias from `~/.ssh/config`.

See [current progress](CURRENT_PROGRESS.md) for what has been tested and what
remains, [the workspace data policy](VM_WORKSPACE_DATA_POLICY.md) for transfer
selection and database handling, and [the test problems](PWA_TEST_PROBLEMS.md)
for issues found during the phone-led RAG test.

## Existing Git handoff

```bash
./relay doctor --vm relay-v0
./relay push --project /absolute/path/to/project --vm relay-v0
./relay connect --project /absolute/path/to/project --vm relay-v0
./relay pull --project /absolute/path/to/project --vm relay-v0 > remote.patch
./relay pull --project /absolute/path/to/project --vm relay-v0 --apply
```

`push` transfers a Git bundle for the base commit, separate staged and
unstaged binary patches, and untracked files including Git-ignored project data.
It omits untracked dependency and cache directories. It restores remotely and
verifies both Git patch hashes. It requires a Git repository with a commit.

The first push records an internal handoff snapshot on the VM. `pull` exports only
the changes made after that snapshot, so it does not echo the Mac's original
dirty files back. Its binary Git patch includes tracked changes and newly created,
non-ignored untracked files. `--apply` first verifies the same local Git base and
a clean patch application; otherwise it refuses without changing the local
workspace.

The test target is not a mount. Relay copies an archive over SSH, matching the
future cloud transport boundary.

## Import a VM workspace

Create or open the workspace in the PWA first, so it is registered on the VM.
List its ID, preview the import, and pull it into an existing local parent:

```bash
./relay workspaces --vm relay-do-v0
./relay pull --workspace WORKSPACE_ID --into ~/Projects --vm relay-do-v0 --dry-run
./relay pull --workspace WORKSPACE_ID --into ~/Projects --vm relay-do-v0
```

Pause editors, agents, watchers and other writers while Relay captures the VM
workspace. The destination must not already exist; pass `--name NAME` to select
another folder name. Use `--json` for structured output. If rsync is interrupted,
the error reports a transfer ID; retry with:

```bash
./relay pull --resume TRANSFER_ID --vm relay-do-v0
```

Successful imports leave a receipt under `~/.relay-v0/imports` on the PC.

Plain folders stay plain. Supported Git repositories retain the checked-out
commit and branch or detached state, staged changes, working files and
untracked files, including files ignored by Git. `.env` files, keys, databases,
database backups and build output are included. The `.git` internals and
directories named `node_modules`, `.venv`, `venv`, `__pycache__` and `.cache`
are excluded and listed in the preview and receipt; tracked files inside an
excluded dependency or cache directory block the import. The preview scans the
live tree and reports estimates. Workspaces
configured only in the PWA service environment may not be visible to an SSH
session; workspaces registered through the PWA folder picker are available.

This first implementation rejects symlinks, nested repositories, submodules,
Git attributes, sparse or shallow repositories, merge conflicts and several
other special Git states. Secrets are transferred as project files; no secret
scanner blocks them. Treat the VM, local project and retained export as places
that hold those secrets.
Relay coordinates captures and repeat Git publication with phone chat turns.
Pause independent writers during handoffs. VM
exports currently remain under `~/.relay-v0/exports`; automatic expiry and disk
quota enforcement are not yet implemented. A copied `.bak` still needs to be
restored with SQL Server. Stop SQLite writers and close connections, or place a
consistent SQLite backup in the workspace before copying; Relay does not
automatically create database backups or restore database services. Data stored
outside the workspace, including separate Docker volumes, is not included.
The legacy `pull --project` delta does not export Git-ignored changes; use the
workspace ID workflow for those files.

## Repeat Git handoff

Repeat transfers into a paired Git repository preserve the index and working
files separately. Preview and run them with the same workspace ID and desktop
path. Pass `--expect PLAN_ID` with the dry run's `plan_id` to apply only if both
endpoints still match that preview. A file transfer keeps the current commit. To transfer an existing source
commit, review the staged changes and commit, then pass `--commit FULL_OID`.
Relay updates the receiving ref only when the approved commit descends from its
current commit. Linked worktrees can be imported once but require a standalone
repository on both endpoints for repeat handoffs.

```bash
./relay push --workspace ID --project PATH --vm relay-do-v0 --dry-run --json
./relay push --workspace ID --project PATH --vm relay-do-v0 --json
./relay pull --workspace ID --into PATH --update --vm relay-do-v0 --dry-run --json
./relay pull --workspace ID --into PATH --update --vm relay-do-v0 --json
```

Plain batch pushes and Git handoffs stage a full replacement on the same
filesystem and exchange it with the original as one directory operation.
The previous tree is kept under `previous/` in the reported recovery directory.
The destination needs space for both trees and a filesystem that supports atomic
directory exchange. Pause independent editors and services on both copies from
before capture until acknowledgment. The Linux VM helper also verifies writer
quiescence while capturing and during the swap and checkpoint acknowledgment.
If it cannot hold the fence or sees activity, inspect the pending handoff and
preserve both versions before retrying. File leases can reject write opens on
fenced files. Directory monitoring detects ordinary namespace edits, which
still must be paused. For a running database, take a native backup rather
than transferring its live directory.

For a pending plain batch or Git push, repeat the push command with `--inspect`
to see the publication state, with `--resume` to finish, or with `--rollback`
to restore the verified original before acknowledgment. Rollback retains the
proposed tree if publication occurred. Reviewed merges still use their own
resume command.

A root `.relayignore` uses `protect PATTERN` and `exclude PATTERN`. Blank lines
and lines starting with `#` are allowed. Patterns without a slash match any
component. Patterns containing a slash start at the root. `*` and `?` match
within a component and a component consisting of `**` matches zero or more
components. A matching directory rule applies below that directory. Exclude
takes precedence and leaves endpoint copies local. Relay hides protected file
contents from previews and scoped AI requests. Codex chat retains full VM-user
access. The rule file itself is shared as policy metadata. Keep the same policy
on both endpoints and at the checkpoint. To change it, make a fresh import into
a new folder. Relay refuses to send history containing excluded paths.
`.relayignore` does not rewrite Git history.

Run `./relay merge --workspace ID --project PATH --vm relay-do-v0 --json` to
prepare a review. Then use `--approve PLAN_ID` on the same command. Resolve each
conflict with `--resolve worktree:PATH=pc`, `--resolve index:PATH=vm` or the
actions reported in the plan. A history plan supplies a private repository with
`pc` and `vm` review branches. When the tracked state is clean, review and create
a descendant of both heads there, then pass `--approve PLAN_ID --commit FULL_OID`.
A review or interrupted publication retains its private staging and originals.

For an eligible text conflict, preview the scoped request with
`--assist PLAN_ID --select worktree:PATH`. After reviewing the inputs, add
`--provider /absolute/path/to/executable --approve-request`. The provider reads
JSON on stdin and writes UTF-8 proposal text on stdout. Review the saved proposal
before accepting it with `--approve PLAN_ID --resolve worktree:PATH=proposal`.
Resolve protected files, databases and binaries by choosing an endpoint version.
Resume an interrupted merge with `--resume PLAN_ID`.

## Private phone PWA

The PWA is a private controller for the existing VM—not a browser terminal. It
creates and opens registered folders, lists saved Codex chats, streams turns,
browses visible files, shows changed files and diffs, and uses browser
speech-to-text when supported. A chat attachment is saved under the workspace's
`uploads/` directory and its path is sent to Codex; uploads are limited to
10 MB. A loopback app can be opened through a private Tailscale preview link.
Codex turns launched by the PWA use full VM access with no command approval
prompt. Only grant the Tailnet owner access, and do not keep unrelated secrets
or credentials readable by the `relay` user.

It deliberately does **not** expose a raw shell, arbitrary filesystem reads, or
the Codex app-server protocol. A chat can be hidden from the Relay UI without
deleting its Codex history or its workspace. An active tmux-owned chat remains
read-only; continue it in Termius instead of creating a competing writer.

For local visual work only:

```bash
RELAY_ALLOW_LOCAL_DEV=1 \
RELAY_WORKSPACE_ROOTS="$PWD" \
npm run pwa:dev
```

VM deployment uses [deploy/relay-pwa.service](deploy/relay-pwa.service) with an
environment file outside Git:

```ini
RELAY_ALLOWED_TAILSCALE_LOGIN=your-tailnet-login@example.com
RELAY_WORKSPACE_ROOTS=/home/relay/.relay-v0/workspaces/GeM_PO_Verification
RELAY_PREFERENCES_FILE=/home/relay/.relay-v0/controller/preferences.json
RELAY_PWA_HOST=127.0.0.1
RELAY_PWA_PORT=4388
```

After starting the service, publish only through private Tailscale Serve:

```bash
sudo tailscale serve --bg 4388
```

Never use `tailscale funnel` for Relay. The controller stays on loopback and
requires the owner login injected by Tailscale Serve.

## Run checks

```bash
npm test
python3 -m unittest relay_lib.test_import_workspace relay_lib.test_push_selection relay_lib.test_manifest relay_lib.test_publication relay_lib.test_monitor_rag
```

The [RAG test plan](PWA_RAG_VM_TEST_PLAN.md) covers the phone-to-VM journey and
PC snapshot restore. The imported `rag-lab-test/` is a local test workspace and
is ignored by Git; it is not packaged or deployed with Relay.

The [end to end test plan](RELAY_E2E_TEST_PLAN.md) covers two phone and desktop
handoff cycles for a plain folder and acceptance tests for repeat Git handoffs.
The [Git handoff implementation plan](RELAY_GIT_HANDOFF_BUILD_PLAN.md) describes
the build phases for worktree transfers, `.relayignore`, merge review and deployment.
