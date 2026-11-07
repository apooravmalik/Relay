# Relay current progress

**Updated:** 6 November 2026  
**Repository:** `main`, based on commit `7867334` (27 October 2026)

## Overall state

Relay is a working V0 prototype, not yet a complete handoff product. The core
Git workspace transfer and an always-on VM workflow were previously verified
on a DigitalOcean droplet. A private phone PWA is implemented and its live
health, workspace list and conversation list have been checked from Linux;
the complete phone-to-Codex flow has not yet been independently verified.

## Implemented in this workspace

### Workspace handoff CLI

- `relay doctor`, `push`, `connect`, and `pull` use a Lima VM or SSH alias.
- Push transfers a Git bundle, staged and unstaged binary patches, and
  non-ignored untracked files. It verifies patch hashes and records a handoff
  snapshot on the VM. Ignored files and dependencies are not transferred.
- Pull exports tracked and non-ignored untracked changes since that snapshot.
  Applying checks the local Git base and whether the patch applies cleanly.
- The October test record covers dirty workspaces, new files, ignored files,
  a VM reboot, and a real project Docker build. See
  [V0_STATUS_REPORT.md](V0_STATUS_REPORT.md) for the historical evidence.

### Phone PWA and controller

- A Node HTTP controller serves a mobile interface for explicitly configured
  workspace roots. It displays workspace Git metadata, saved conversations,
  and changed files, with scoped text and diff previews.
- The interface supports new and saved Codex chats, streamed responses,
  hiding chats without deleting their history, and speech input when the
  browser provides it. Active conversations owned by a terminal may require
  continuing in Termius instead of attaching a competing writer.
- The controller starts a local Codex app-server over stdio. It forwards message
  deltas to the phone as server-sent events. Conversations remain in Codex;
  Relay stores hidden-chat preferences separately.
- The server binds to loopback, checks the configured Tailnet owner identity,
  and is intended to be published privately with Tailscale Serve. A systemd
  unit and deployment example are included. Codex turns run with full VM
  access and without interactive approval prompts; this is a single-owner
  controller, not a multi-user isolation boundary.
- A web manifest and service worker are present. The service worker currently
  handles activation only; it does not provide an offline app cache. Image
  uploads and image storage are not implemented.

### Shed research

- [SHED_DESIGN_ANALYSIS.md](SHED_DESIGN_ANALYSIS.md) documents Shed's phone
  design, its SSE/polling model, local server and tunnel, and host-side file
  storage. This was a source and demo-screenshot review, not a live Mac or
  real-phone test.
- Shed-inspired PWA design changes have not yet been implemented or deployed.

## Verification and setup

- `npm test`: **12 of 12 tests passed** on the Linux machine on 3 November.
  These tests do not substitute for a live VM or phone end-to-end test.
- Fedora has Tailscale 1.98.8 installed; `tailscaled` is enabled and active.
  This Linux machine has joined the tailnet, and a Tailscale ping to the
  DigitalOcean VM succeeded on 3 November 2026.
- A dedicated Ed25519 key (`~/.ssh/relay_do_fedora`) and `relay-do-v0` SSH
  alias have been created on Linux. The key was authorized via the DigitalOcean
  recovery console, and SSH and `relay doctor` succeeded on 6 November.
- The VM's Relay PWA service is enabled and active. Its private Tailscale
  Serve HTTPS health endpoint and workspace list responded from Linux, and the
  GeM workspace conversation list loaded. A live phone interaction and a
  complete Codex turn remain to be tested. No tmux sessions were present at
  the time of the check.

## Next implementation steps

See [PWA_NEXT_STEPS.md](PWA_NEXT_STEPS.md) for the prioritized checklist and
acceptance criteria. The first milestone combines reliable message streaming
and recovery with a better mobile conversation experience.

1. Verify the existing phone-to-Codex-to-diff flow, including interruptions.
2. Improve streaming recovery, accurate status and mobile conversation UX.
3. Design and implement scoped image attachments and artifact previews with
   size limits, cleanup, path containment, and reliable Git exclusion.
4. Add safe repeat handoffs, durable writer ownership and explicit conflict
   handling. Phone-requested Mac sync needs a Mac agent and must account for
   the Mac being offline.
5. Add environment reconstruction and controlled secret references; the
   current source transfer does not reproduce the whole environment.

See [RELAY_OPEN_PROBLEMS.md](RELAY_OPEN_PROBLEMS.md) for the detailed risk and
verification backlog. Avoid a percentage-complete estimate: no agreed scope
or weighted milestones exist for the final product.
