# Relay: UI exploration and developer beta roadmap

Updated 7 November 2026. This is a proposed sequence, not a statement that
the listed work is complete. The existing detailed checklists remain in
[PWA_NEXT_STEPS.md](PWA_NEXT_STEPS.md) and
[RELAY_OPEN_PROBLEMS.md](RELAY_OPEN_PROBLEMS.md).

## Recommended first beta

Recruit a small, assisted cohort of developers. Each tester runs their own
Relay instance on a VM they control, with their own Tailscale network, SSH
credentials and agent account. Start with Codex and a Git workspace; document
supported host OS and versions only after testing them. Do not invite testers
into the existing personal VM or Tailnet. This is a design recommendation,
not a claim that onboarding is ready or that self-hosting alone proves safety.

A shared hosted service is a separate milestone requiring tenant-scoped
identity, authorization and revocation, isolated execution, credential and
storage boundaries, quotas, auditability and isolation testing.

## Milestone 1: explore the phone experience

- [ ] Review the Shed phone screenshots and the current Relay flow together;
  capture specific preferences for workspace cards, chat, composer, status,
  change review and navigation. Shed screenshots are reference material, not a
  functioning interactive Shed session.
- [ ] Map the core journey and the loading, empty, working, disconnected,
  error and active-writer states. Show only data the backend can supply.
- [ ] Produce a clickable or functional Relay prototype; test opening a
  workspace, finding a chat, sending a message and reviewing a diff on a real
  phone. Check keyboard, long messages, accessibility and small screens.
- [ ] Record which patterns users find useful and revise before committing to
  a full visual redesign. Keep the review prototype clearly distinct from
  the live controller and avoid misleading controls.

## Milestone 2: make conversation and streaming dependable

- [ ] Review and test existing uncommitted UI/streaming changes; determine
  what is already fixed before implementing more.
- [ ] Verify current Codex behavior on browser disconnect and controller or
  app-server restart. Track turns server-side where supported, enforce a
  single writer, and make lifecycle and failure states explicit.
- [ ] Reconnect, reconcile persisted history and preserve partial output and
  drafts. Prevent duplicate sends with a defined idempotency contract; never
  silently resend a prompt.
- [ ] Test actual phone backgrounding, reconnects, server errors, active-writer
  conflicts, long streams and UI scroll behavior. Clearly label outcomes that
  remain unknown after an interruption.

## Milestone 3: protect work and make handoffs repeatable

- [ ] Implement safe repeat pushes with preflight, staged verification and
  conflict detection; preserve both copies when changes diverge.
- [ ] Define durable workspace ownership and checkpoints, reviewable changes,
  transfer history and recovery from an interrupted or failed operation.
- [ ] Test staged, unstaged, binary, untracked, renamed and ignored files,
  divergent commits, concurrent edits and interrupted transfers on supported
  systems. Provide a safe dry-run and a recovery guide.
- [ ] Show the user what will transfer; improve secret detection and document
  that ignored files and environment state are not transferred automatically.

## Milestone 4: self-hosted beta onboarding and operations

- [ ] Create versioned install/update/uninstall and doctor flows for a clean
  machine and fresh VM, including workspace registration, Codex login,
  private access and a tested first handoff. Document OS/version prerequisites,
  likely costs and who pays for the VM and agent usage.
- [ ] Harden controller authentication and authorization around the supported
  single-owner deployment; review trusted proxy headers, loopback binding,
  request validation, SSH host-key verification and service permissions.
- [ ] Address the existing full-VM/no-approval execution model before inviting
  testers: define and validate an explicit permission model or supported
  dedicated-VM trust boundary with informed onboarding. Test revocation,
  minimal credentials and isolation from other testers.
- [ ] Add health and error diagnostics, useful redacted logs, backups/recovery
  guidance, version compatibility checks and a clear feedback/bug-report path.
- [ ] Test clean installation, onboarding, phone chat, disconnect/reconnect,
  repeat handoff, safe conflict, reboot, upgrade and uninstall with at least
  one independent tester and a disposable project.

## Milestone 5: selected beta features

- [ ] Improve changed-file review and safe app preview readiness, with private
  access and clear startup errors.
- [ ] Add image attachments and artifact previews as a complete feature with
  scoped storage, limits, cleanup and validation of installed Codex support.
- [ ] Evaluate notifications, project search and last-seen lists after core
  reliability. Clearly distinguish cached content from live state.
- [ ] Define environment reconstruction, runtime manifests and user-managed
  secret references; do not equate copying source with reproducing a machine.

Multi-agent providers, browser terminal, phone-triggered Mac synchronization,
automated cloud provisioning and a shared hosted beta are separate decisions.
They need not block a narrowly scoped, assisted self-hosted beta unless the
chosen testers or promised experience require them.

## Beta exit gates

- A tester can install, authenticate, hand off a disposable Git project,
  continue a Codex chat from a phone, inspect changes and safely return work.
- A broken connection does not silently report success, duplicate a prompt or
  discard work; conflicts leave both copies recoverable.
- Each tester's data, execution and credentials have a verified boundary; the
  operator can revoke access and explain the current permission model.
- A clean-machine runbook and tested recovery path exist, and critical failures
  have an owner and feedback channel. Performance and reliability targets should
  be set from baseline measurements before claiming a beta SLA.
