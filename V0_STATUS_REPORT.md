# Relay V0 Status Report

**As of:** 13 October 2026, Asia/Kolkata

## Executive summary

Relay V0 has proven the core development loop on a real DigitalOcean VM:

```text
Mac workspace → Relay push → always-on VM workspace
phone → SSH + tmux + Codex on the VM → Relay pull → Mac workspace
```

The VM—not the phone and not the Mac—is where Codex runs, files change, Docker
builds execute, and long-running terminal sessions live. The Mac can be closed
once the VM handoff is complete. The phone currently acts through Termius; the
next product milestone is a phone-first control interface that removes terminal
directory navigation from the everyday workflow.

## What has been completed

### 1. Real cloud development VM

An Ubuntu 24.04.5 DigitalOcean Basic Droplet is running in Bangalore:

| Capability | Verified state |
|---|---|
| Compute | 2 vCPU, 3.8 GiB RAM |
| Disk | 77 GiB total, about 70 GiB free at review time |
| Base tools | Git, tmux, Python 3 + venv/pip, Docker, Node 22 |
| Codex | Codex CLI 0.162.1 installed |
| Containers | Docker 29.1.3 active |
| Future isolation | KVM access available for the `relay` user |
| Persistence | VM survived a reboot; Docker and the tmux workspace session recovered |

The VM uses the non-root `relay` account. SSH password login and root SSH login
are disabled. Only `relay` may log in over SSH, using an authorized key. UFW is
enabled with a default-deny inbound policy. SSH is permitted only over the
private Tailscale interface; the public SSH port has been removed.

### 2. Phone access to the same VM workspace

Termius on the phone has its own dedicated Ed25519 key, authorized for `relay`.
The Mac's private SSH key was not copied to the phone.

The persistent terminal session is:

```bash
tmux new -A -s gem-po-cloud
cd ~/.relay-v0/workspaces/GeM_PO_Verification
codex
```

`tmux` makes the session survive phone disconnections. Codex writes directly to
the VM workspace, rather than to a copy on the phone.

### 3. Relay CLI V0

The executable is [relay](relay). It supports:

```bash
relay doctor [--vm NAME]
relay push --project DIR [--vm NAME]
relay connect --project DIR [--vm NAME]
relay pull --project DIR [--vm NAME] [--apply]
```

`--vm` accepts either a Lima VM name or a normal OpenSSH alias, so the same
command works for the local Mac test VM and the DigitalOcean host.

#### Mac to VM: `relay push`

`push` transfers:

1. A Git bundle for the committed base revision.
2. Separate binary patches for staged and unstaged tracked edits.
3. Every non-ignored untracked file.

The VM restores the base revision, applies the patches, verifies their
SHA-256 hashes, and records an internal Git handoff snapshot at
`refs/relay/synced`.

Ignored content such as `.env`, `node_modules`, and `.venv` stays local by
design. `.gitignore` is therefore a security boundary: a non-ignored secret
would be transferred.

#### VM to Mac: `relay pull`

`pull` compares the VM's current state to `refs/relay/synced`. It builds a
temporary Git index containing tracked and non-ignored untracked files, then
creates a binary Git patch from that temporary tree. This means newly created
VM files are included without staging them in the VM user's actual Git index.

`relay pull --apply` refuses to modify the Mac when:

- the Mac has moved to a different base commit since the handoff; or
- the remote patch does not apply cleanly.

When it succeeds, Relay applies the delta locally and advances the VM snapshot.
The original Mac edits are not echoed back because they were already present in
the snapshot.

### 4. Verified project workload

The GeM PO Verification workspace was restored at:

```text
/home/relay/.relay-v0/workspaces/GeM_PO_Verification
```

The VM completed the project's Node/Playwright Docker build and a loopback-only
AWS Lambda-style invocation returned HTTP 200 with the expected validation
response for an empty request. No AWS deployment or AWS credentials were used.

The project currently has intentionally uncommitted working state on both sides:

```text
M README.md
M serverless.yml
?? testfrommobile.md
```

The new mobile-created file was used to validate automatic untracked-file return
and is now included in the handoff snapshot.

### 5. Relay behavior verified end to end

The following cases have been tested:

| Scenario | Result |
|---|---|
| Mac dirty tracked changes to VM | Restored and hash-verified |
| VM Codex/tmux workflow | Works in a persistent tmux session |
| Tracked VM delta to Mac | Patch export and guarded apply work |
| New VM untracked file to Mac | Automatically returned as a Git creation patch |
| New Mac untracked file to VM | Automatically restored without `--include` |
| Ignored `.env` file | Excluded from transfer |
| macOS Finder `._` sidecar | Excluded from transfer |
| VM reboot | SSH, Docker, Tailscale service, and tmux workspace session recovered |

## Current architecture

```text
                         Git bundle + binary patches
Mac repository  ─────────────────────────────────────►  VM workspace
     ▲                                                     │
     │                                                     │ Codex edits files
     │                                                     ▼
     └──────── Git delta since refs/relay/synced ───── Phone via SSH + tmux
```

This is intentionally a handoff model, not a mounted filesystem or background
continuous-sync product. Git is the source-state transport; Docker/Python/Node
dependencies are reconstructed on the VM.

## Security and operational status

### In place

- SSH keys only; no SSH passwords.
- Root login disabled.
- Dedicated phone key rather than sharing the Mac's private key.
- Firewall enabled.
- Docker exposed only through its local Unix socket.
- Project test service bound to loopback during validation.
- Codex authenticated on the VM through the user-controlled device login flow.

### Still required

The VM, Mac, and phone are enrolled in the Tailnet. Both the Mac and phone have
verified ordinary key-based SSH connections to the VM over Tailscale. UFW now
allows SSH only on `tailscale0`, permits Tailscale's encrypted UDP transport on
port 41641, and blocks inbound public SSH; a public-IP SSH attempt was verified
to time out. The Mac's `relay-do-v0` SSH alias now uses the VM's private
Tailscale address.

Do not expose a raw terminal, Codex app-server, or unauthenticated web API on
the public IP. The Relay controller remains the next private-only service to
design and build.

### P1 Codex app-server compatibility spike — completed

The installed VM binary (`codex-cli 0.162.1`) has been inspected through its
generated JSON schema and a loopback-only stdio probe. The probe confirmed
that a client can:

- list threads for an **exact canonical workspace path**;
- start a workspace-scoped thread, send a turn, receive streamed
  `item/agentMessage/delta` events, and observe `turn/completed`;
- read and resume that thread; and
- find persisted workspace threads after starting a new app-server process.

One important compatibility result: this build recorded a newly created
app-server thread with source `vscode`, rather than `appServer`. Relay must
therefore associate threads using its own workspace registry plus the exact
canonical `cwd`; it must not use Codex source-kind as an ownership or security
boundary.

Additional safety checks passed on the VM:

- A command approval request was surfaced to the client, explicitly declined,
  and the requested unique `/tmp` file was confirmed absent.
- `turn/interrupt` was accepted for an in-flight turn and ended it with status
  `interrupted`. The agent had not begun its harmless test command, so this
  verifies turn cancellation, not termination of a running external process.
- A persisted idle workspace thread can be read (including turn history) and
  resumed by a new app-server process.
- The existing GeM tmux/CLI conversation is detected as having an active
  writer. Its metadata remains readable, but `thread/resume` refuses with an
  active-writer error rather than allowing a second controller.

Relay will therefore use **Approach B** for the first PWA: it may continue
idle/app-server-managed conversations, but a tmux-owned active conversation is
shown as unavailable for sending with an explicit Termius fallback. The PWA
must never silently take it over, fork it, or issue a competing turn.

## Ideal goal

Relay should become a personal, provider-independent remote development
computer that a developer can continue from a Mac or phone without manually
finding directories, reconfiguring dependencies, or losing agent context.

```text
Mac                 Relay control plane                 Cloud VM
───                 ───────────────────                 ────────
Capture / resume ─► workspace + environment record ─► running workspace
Review returned ◄─ diffs, files, status, conversations ◄─ Codex + tools

Phone PWA ─────────► select workspace / continue chat ─► same VM session
```

The ideal user experience is:

1. Select a project from a phone-friendly workspace list.
2. See its current VM status, branch, changed files, active Codex chats, and
   last sync direction.
3. Resume or start a Codex conversation already rooted in that workspace.
4. Send prompts, receive streamed output, review diffs, and approve actions.
5. Return to the Mac and explicitly pull or review the VM delta.
6. Move again without needing to rediscover paths or recreate the environment.

The phone is the control plane. The VM remains the execution plane.

## Recommended next build: Relay Mobile PWA

The next build should be a minimal PWA, not a raw browser terminal and not a
native mobile app. Its first release should solve the specific Termius problems
already observed: opening in the home directory, finding the right workspace,
and resuming the correct chat.

### PWA V0 scope

- List known VM workspaces with repository name, path, Git status, and sync
  state.
- Open a workspace without manually entering a directory.
- List and continue Codex conversations for that workspace.
- Send prompts and stream Codex responses.
- Show changed files and allow export/review of the VM-to-Mac delta.
- Keep Termius as an emergency terminal fallback.

### PWA V0 architecture

```text
Phone PWA
  │ authenticated private connection
  ▼
Tailscale network
  ▼
Relay controller on the VM
  ├── workspace registry and Git status
  ├── Relay push/pull status
  └── local Codex app-server bridge
        └── selected VM workspace
```

Codex app-server is appropriate for conversation history, streaming events, and
approvals, but its WebSocket transport is experimental. It must remain local to
the VM behind the Relay controller and Tailscale rather than being directly
published to the internet. See the [Codex app-server documentation](https://learn.chatgpt.com/docs/app-server).

## Roadmap after the PWA

### Relay V1: repeatable handoffs

- Update an existing remote workspace from the Mac instead of refusing a second
  `push`.
- Detect both-side changes and provide an explicit three-way merge workflow.
- Maintain a durable transfer history with rollback points.
- Show file-level transfer plans before applying.

### Relay V2: portable environment reconstruction

- Detect Node, Python, Docker, and service requirements.
- Record environment manifests and package-lock hashes.
- Rebuild dependencies on the VM rather than copying caches.
- Add controlled secret references rather than transferring `.env` files.

### Relay V3: isolated agent runners

- Keep the trusted interactive workspace VM separate from untrusted execution.
- Add a dedicated, capacity-planned Firecracker runner host only when isolated
  code execution is a real requirement.
- Do not place Firecracker workloads beside personal SSH keys and Codex
  credentials on the current VM.

## Definition of success

Relay reaches its intended first product milestone when the following is routine:

```text
Start work on Mac
  → hand off to VM
  → close Mac
  → continue the same workspace and Codex chat from phone
  → review VM changes on phone
  → resume safely on Mac later
```

The current V0 has proven the handoff and execution portions. The PWA is the
next step that turns this from an expert terminal workflow into a usable mobile
product.
