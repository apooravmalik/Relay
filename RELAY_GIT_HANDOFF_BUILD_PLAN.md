# Relay Git handoff implementation plan

Build one repeatable workflow for a Git workspace on the cloud VM and its paired copy on the PC. Start or resume Codex from the phone. Use the desktop CLI to move work in either direction. Preserve committed history, staged changes and working files, including eligible files outside Git. Move uncommitted work over SSH by default and let the user explicitly choose to commit through Git.

The current code already imports a Git workspace into a new desktop folder and can repeat handoffs for plain folders. The full-permission notice is in the local phone UI. This plan adds repeat Git handoffs, transfer rules, merge review, and end-to-end verification of the deployed workflow. The [test runbook](RELAY_E2E_TEST_PLAN.md) remains the acceptance checklist.

## 1. Define the shared checkpoint and transfer policy

- Extend the existing destination pairing and checkpoint in `relay_lib/update_workspace.py` and `relay_lib/export_workspace.py`. Record the repository identity and object format, branch or detached state, `HEAD`, index entries, working file manifest, policy digest and checkpoint generation. Keep the prior file and index versions needed for three-way comparison in private Relay storage. Store copies by hash so repeat handoffs can reuse unchanged data.
- Preserve the three Git states separately. If Git has `base` at `HEAD`, `staged` in the index and `working` on disk, a file handoff must produce the same three states on the receiving side. Tests should verify each directly, including a staged deletion with a recreated working file. Extend the existing import fixture and reuse its Git metadata validation.
- Version the checkpoint format before changing it. For an old pairing, verify its receipt and retained export before upgrading. If the baseline cannot be reconstructed, offer a fresh import into a new folder. Retain the existing local and VM copies.
- Define one root `.relayignore` file with two rule types. Use the same parser on both endpoints. Preview the rule and transfer disposition for each affected path. Pin the policy digest to the transfer and recheck it on resume. If endpoint rules differ, preview the differences and resolve them before applying a transfer.

  ```text
  protect .env
  protect .env.*
  protect credentials/**
  exclude scratch/**
  exclude local-only.db
  ```

  `protect` allows SSH transfer and keeps contents out of Relay previews and AI merge requests. `exclude` keeps a path local to its endpoint and takes precedence. Define how basename rules and root-relative globs match, reject malformed rules, and reserve `.relayignore` itself as policy metadata. Keep the current built-in dependency and cache exclusions. Recognize common secret files as protected by default, and handle database snapshots and binary files as whole files. Codex retains its normal full VM-user permissions during chat.

- Apply the policy to initial import, both repeat directions, previews, candidate staging, and recovery. Verify that excluding a path preserves any existing destination copy. Reject exclusions that conflict with transferring a tracked path through the index or `HEAD`. Committed Git history may contain older copies of a path, so the Git transfer mode must detect and block excluded history when it can verify that condition, and fail closed when it cannot. Document that `.relayignore` does not rewrite Git history.

**Done when** tests demonstrate matching staged and working states after import, byte-for-byte transfer of a protected dummy `.env`, preservation of an excluded destination file, and refusal on a policy mismatch or a stale resume.

## 2. Implement repeat Git push and pull

- Extend `relay push --workspace ID --project PATH` and `relay pull --workspace ID --into PATH --update` for paired Git repositories. Start with the supported repository states from first import, with explicit checks for linked worktrees, special index flags, unsupported file types and in-progress Git operations. Preserve the existing plain-folder behavior and its commands.
- Compare both endpoints to their checkpoint. When only the sending side changed, stage and verify its eligible file changes over SSH. Transfer staged blobs separately and use Git plumbing to write the receiving index without modifying the source or creating a commit. Preserve the receiving repository's remotes, hooks, configuration, unrelated refs and worktree registration. For any repository state Relay cannot update safely, show the blocker in the preview before writing.
- Preview path changes, expected transfer bytes and direction. Reuse the batch transfer's bounded-memory staging, hashes and resumable rsync. Use a journal for the workspace files, index and any Git ref update. Retain previous copies, verify both endpoints against the planned state, then advance the shared checkpoint. A retry after lost acknowledgment must recognize a completed operation without applying it again.
- Coordinate Relay transfers and Relay-started Codex turns so a handoff can refuse an active writer. Tell users to pause independent editors, watchers and database writers during a handoff. Copy database files only from a stopped database or an application-consistent backup. Block publication if the source, destination or Git state changed after preview.
- Add explicit Git commit transfer after the uncommitted path works. Show the files and staged changes before creating any commit. Use the user's approved commit or an existing commit, transfer the required Git objects over SSH, and verify the receiving ref before advancing the checkpoint. Fast-forward when possible. If histories diverge, prepare the merge for review. Preserve unrelated branches and any work outside the transfer.

**Done when** a Git workspace completes two round trips into the same directory without creating a project commit, and a separate explicit commit test advances both copies to the approved commit. An interrupted upload, download, or acknowledgment must leave a recoverable state.

## 3. Build merge planning and conflict review

- Compare the PC and VM versions against the last shared checkpoint. Use Git's three-way merge tools on eligible text in private staging. Compare the committed history, index and working files separately. Keep an already staged change staged and an unstaged change unstaged. If a merged result would make that distinction ambiguous, present the conflict for review.
- Represent additions, deletions, path collisions, rename cases, permissions, and file type changes in the plan. Merge independent changes when the result is unambiguous. Preserve both versions for overlapping edits, modify/delete conflicts, unsupported renames, and conflicts involving binaries, protected files and databases. Provide explicit actions to keep the PC version, keep the VM version, or supply a reviewed result. Protected conflicts can be resolved by choosing a whole file without displaying its contents in Relay.
- Add a conflict review flow to the desktop CLI first. Report the conflict paths, available actions and the pending checkpoint. Keep both originals accessible until the proposed resolution is approved. Optionally surface status and safe conflict metadata in the phone UI so the user knows when the VM workspace is ready to use again.
- Add optional AI assistance through a provider call scoped to the selected conflict. Show which non-protected files and versions would be sent and obtain approval for that request. Build the payload from the approved files only, including checks on previous paths in renames. Use a stub provider in tests to verify that dummy secrets never enter the payload. Return a proposal for review and apply it only after approval. This feature uses a scoped conflict request. The regular full-permission Codex window is separate.
- Publish an approved merge to both copies using the transfer journal. Revalidate both inputs immediately before publication. If either side changes while the user reviews the merge, retain the proposal and generate a new plan. Advance the checkpoint only once both endpoints verify the same approved result.

**Done when** two independent edits merge into the same result on both copies, overlapping edits remain intact until approval, declining AI assistance leaves both copies unchanged, and a protected conflict never reaches the merge provider.

## 4. Deploy and verify with a phone and desktop

- Keep the existing full-permission notice visible in new and saved chats. Check on a phone-sized screen that it explains `.env` access before sending a message. Deploy a verified build to the private VM with a rollback path. Record the candidate and deployed revisions.
- Run the PWA and transfer suites, then execute the Git acceptance tests over real SSH against a disposable registered VM workspace. Check two repeat cycles, the Git index, `HEAD`, hashes, `.relayignore`, a file larger than 10 MiB, conflict approval, recovery after interruption and a closed database snapshot restore. Keep the existing plain-folder SSH smoke test as a regression check.
- On the actual phone, open Relay over the Tailnet, create a fresh Git workspace, use Codex to make the first edit, and pull it onto the PC. Work on the PC, push, and verify the new files in **Files** before resuming the phone chat. Make another phone edit, pull into the same directory, and repeat once more. Then test a conflict with disposable files. Keep the receipts and compare checkpoint IDs to prove both endpoints agree.
- Run Linux first. Run the same scenarios on macOS and the Windows environment Relay intends to support. Record native Windows and WSL outcomes separately. A platform can be listed as supported after its own run succeeds.

The phone and desktop workflow is complete when the deployed VM and the paired PC finish two Git cycles with matching files, Git state and checkpoint receipts, and the conflict and recovery cases pass. Record the builds and platforms actually exercised in the [test runbook](RELAY_E2E_TEST_PLAN.md).

## Execution checklist

Complete these in order. Keep receipts and test evidence in the acceptance runbook.

- [x] **Policy and checkpoint.** Apply the same parser on both endpoints, record the policy digest in versioned snapshots, retain baseline data by hash, and verify old imports before adopting them. Refuse excluded tracked paths and excluded paths reachable in transferred history. Test protected bytes, excluded destinations, mismatches, and stale resumes.
- [x] **Repeat Git file transfer.** Reuse bounded staging and the file publication journal. Add a separate index operation, preserve repository metadata, and validate the receiving and sending states before advancing the checkpoint. Test two round trips, index-only changes, staged deletion with a recreated file, and upload, download, and acknowledgment interruption. Keep the plain-folder regression.
- [x] **Explicit commit transfer.** Require an explicitly selected commit, verify ancestry and objects, journal the ref update, and send divergent histories to review.
- [x] **Merge review.** Compare working files and the index separately against the shared baseline. Test independent edits, overlapping edits, deletes, and protected or binary conflicts. Keep both originals until approval and verify that the approved result reaches both endpoints.
- [x] **Optional scoped AI review.** Preview the exact inputs before approval, prove protected versions cannot reach the provider, and keep proposal approval separate from request approval.
- [x] **Candidate and deployment.** Run local suites and disposable Linux SSH acceptance. Record the candidate revision, deployed revision, and rollback path. Verify the chat notice and workspace file readback on the deployed build.
- [ ] **Phone and platform acceptance.** Automated Linux SSH checks passed. The physical phone run and the other desktop environments are pending. Follow the commands and prompts in the E2E runbook using one workspace ID and one desktop path. Record two matching checkpoints, the conflict and recovery outcomes, and each device and desktop environment exercised. Keep platforms without a successful run marked unverified.
