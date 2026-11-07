# Relay PWA: next-step checklist

Updated 6 November 2026. This checklist starts with the existing private VM
controller and uses [the Shed analysis](SHED_DESIGN_ANALYSIS.md) as a design
reference. Shed's visuals were reviewed from demo screenshots, not a live phone
session. Unchecked items are proposed work, not completed features.

## 1. Reliable streaming and conversation recovery — first priority

- [ ] Establish a baseline on a real phone: start a harmless turn, observe the
  stream, background and reopen the PWA, and record what happens to the turn.
- [ ] Make turn state independent of an individual browser connection. Verify
  the installed Codex app-server's behavior on disconnect and process exit;
  design server-side tracking around observed behavior rather than assuming a
  turn survives. Maintain one writer per conversation.
- [ ] Reconnect and reconcile with authoritative conversation history and turn
  state on network return and page visibility. Avoid duplicate messages and
  never resubmit a prompt automatically without an idempotency guarantee.
- [ ] Treat a stream ending without a completion event as interrupted or
  unknown, not successful. Preserve partial output and show actionable errors.
- [ ] Show truthful connecting, working, completed, disconnected and failed
  states; indicate when displayed data is stale. Test app-server failure,
  active-writer conflicts and controller restart.
- [ ] Preserve a reader's scroll position while new text arrives; offer a jump
  to latest. Keep the composer and draft usable across errors and keyboard
  changes, and prevent accidental concurrent sends.
- [ ] Test chunk boundaries, interrupted streams, repeat connections, long
  conversations and mobile background/foreground behavior. Check that the
  phone can recover without creating a second turn.

**Done when:** a real phone can start a turn, lose and regain connectivity,
and see an accurate final or recoverable state without duplicated prompts or
lost partial output. If a turn cannot survive a particular failure, the UI
must say so and offer a safe recovery path.

## 2. Phone UI and UX — alongside streaming work

- [ ] Use Shed's clear hierarchy as a reference: identify each workspace,
  current conversation and meaningful status at a glance. Use real state;
  don't imply a workspace or VM is live merely because cached data exists.
- [ ] Improve the conversation view with clear sender labels, readable message
  spacing, an anchored composer and accessible navigation to changed files.
  Show timestamps only when reliably available.
- [ ] Make the primary continuation action easy to reach; improve loading,
  empty, unavailable, active-writer and error states.
- [ ] Check small screens, landscape, safe areas, virtual keyboard, long code
  blocks, touch targets, contrast and screen-reader labels on actual devices.
- [ ] Consider a session overview, search and an optional last-seen view once
  the controller can provide trustworthy status; mark cached content stale.
- [ ] Compare the implementation against Shed's checked-in phone references,
  then test the real Relay workflow on the user's phone before deployment.

**Done when:** the user can find a workspace, open a chat, understand its
state, send a message and inspect a changed file without using a terminal.

## 3. Images and files — separate end-to-end feature

- [ ] Design and implement scoped image uploads to the VM, including limits,
  safe filenames, explicit retention/cleanup and worktree-safe Git exclusion.
- [ ] Show attachment previews and send the actual supported image or file
  input to Codex only after checking the installed app-server's capabilities.
- [ ] Add scoped artifact previews/downloads with path containment and private
  cache behavior. Test symlinks, hidden files, large files and cleanup.

Shed stores uploads on its host filesystem; Relay does not yet implement image
uploads or a general artifact browser. Do not add a nonfunctional attachment
button as a placeholder.

## 4. Later product work

- [ ] Evaluate private Web Push notifications for completed turns or action
  needed, including mobile browser and installed-PWA support.
- [ ] Add repeat handoffs, conflict preflight and durable writable ownership.
- [ ] Design phone-requested Mac sync with an outbound Mac agent and explicit
  offline handling; reconstruct dependencies and manage secrets separately.
- [ ] Keep terminal access, multi-agent support and multi-user access as
  separate decisions with their own security and interaction designs.

## What Relay has today

Workspace and conversation lists, Codex delta streaming, a bottom composer,
speech input where available, changed-file text/diff previews, and private
access through Tailscale Serve already exist. Relay does not yet have Shed's
event-driven list refresh and fallback polling, reconnect reconciliation,
last-seen lists, push notifications, image attachments or general files view.
Shed's terminal tab and its public tunnel are not prerequisites for Relay's
phone experience. Verify actual behavior before relying on either product's
status indicators.
