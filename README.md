# Relay V0 prototype

This is a narrow rehearsal of Relay's first handoff: a dirty Git working tree
moves from macOS to an SSH target, then can be used through a remote `tmux`
session. `--vm` accepts either a Lima VM name or a normal SSH host alias from
`~/.ssh/config`.

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
the error reports a transfer ID; retry with `relay pull --resume TRANSFER_ID
--vm relay-do-v0`. Successful imports leave a receipt under `~/.relay-v0/imports`.

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
Relay's capture lock coordinates other imports only; the before-and-after scan
does not replace pausing independent writers or a filesystem snapshot. VM
exports currently remain under `~/.relay-v0/exports`; automatic expiry and disk
quota enforcement are not yet implemented. A copied `.bak` still needs to be
restored with SQL Server. Stop SQLite writers and close connections, or place a
consistent SQLite backup in the workspace before copying; Relay does not
automatically create database backups or restore database services. Data stored
outside the workspace, including separate Docker volumes, is not included.
The legacy `pull --project` delta does not export Git-ignored changes; use a
new workspace import for those files until a destination update workflow exists.

## Private phone PWA

The PWA is a private controller for the existing VM—not a browser terminal. It
lists registered workspaces, opens saved Codex chats, streams a new prompt,
shows changed files and diffs, and uses browser speech-to-text when supported.
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
