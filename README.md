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
unstaged binary patches, and every non-ignored untracked file. It restores
remotely and verifies both Git patch hashes.

The first push records an internal handoff snapshot on the VM. `pull` exports only
the changes made after that snapshot, so it does not echo the Mac's original
dirty files back. Its binary Git patch includes tracked changes and newly created,
non-ignored untracked files. `--apply` first verifies the same local Git base and
a clean patch application; otherwise it refuses without changing the local
workspace.

The test target is not a mount. Relay copies an archive over SSH, matching the
future cloud transport boundary.

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
