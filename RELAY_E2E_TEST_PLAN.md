# Relay end to end test plan

Use sections 1–5 for the plain-folder regression. Use section 6 for the repeat Git handoff on a Tailnet phone and a desktop with the matching Relay checkout. Complete the phone run with a disposable workspace and dummy data.

## 1. Set up the test

- Connect the phone to your Tailnet and open your existing private Relay URL. Record the phone OS and browser, desktop OS, local Relay revision, and deployed PWA build if known. Confirm the workspace list loads and you can start a Codex chat.
- Run the commands below from the Relay checkout on the desktop. Replace `relay-do-v0` if you use a different SSH alias. Check that Git, Python 3 and rsync are available on both machines. The `doctor` command reports the versions.
- Use a new disposable workspace with dummy data. Codex runs with full permissions for its VM account and can read files that account can access. Keep real credentials and production databases out of the fixture.
- Wait for each transfer to finish before editing on the other device. Stop active Codex turns, preview services, watchers or other processes that might write to the fixture before each transfer.

```bash
set -o pipefail
RELAY_TEST_VM=relay-do-v0
./relay doctor --vm "$RELAY_TEST_VM"
```

Run the automated preflight from the desktop before the manual phone test. The SSH test uses a disposable workspace under `/tmp` on the selected VM and simulates the phone's file edits there. It checks discovery, first import, two multi-file push and pull cycles, a large file, and refusal on divergence. The phone steps exercise the actual PWA, Codex chat, and private preview.

```bash
npm test
RELAY_DISPOSABLE_TEST_VM="$RELAY_TEST_VM" python3 -m unittest -v relay_lib.test_vm_plain_push
```

## 2. Start the project on the phone

1. Tap **Add workspace**, choose a VM parent, tap **New folder**, then **Create folder**. Use a unique name such as `relay-e2e-plain-01`. Keep the workspace as a plain folder. Open **Chats** and start or open a chat. On a build with the access notice, confirm it says Codex can read files such as `.env` before you send a message.
2. Send this prompt and wait for the turn to finish.

   > In this workspace only, create `index.html` displaying `PHONE_V1` as its heading and `notes.txt` containing `seed-v1`. Use plain HTML and do not initialize Git, install anything, or open a public port.

3. Open **Files**, tap `index.html`, and confirm it contains `PHONE_V1`. Return to the conversation and confirm the original turn appears in history.
4. For the private preview check, ask Codex to serve this workspace using Python's built-in HTTP server on an available loopback port such as 8765 and report the URL and how to stop it. Tap **Preview**, enter the reported port, tap **Create link**, then **Open preview**. Confirm the page displays `PHONE_V1`. Tap **Stop preview** in Relay to remove the link and stop the test HTTP server separately. Confirm the chat is idle before pulling.

## 3. Pull the project onto the desktop

List workspaces and copy the ID for the phone-created folder. Replace `PASTE_ID_HERE` before running the pull. `mktemp` makes a fresh parent so the destination does not already exist.

```bash
./relay workspaces --vm "$RELAY_TEST_VM" --json
RELAY_TEST_ID=PASTE_ID_HERE
RELAY_TEST_PARENT=$(mktemp -d "$HOME/relay-e2e.XXXXXX")
RELAY_TEST_PROJECT="$RELAY_TEST_PARENT/phone-project"
./relay pull --workspace "$RELAY_TEST_ID" --into "$RELAY_TEST_PARENT" --name phone-project --vm "$RELAY_TEST_VM" --dry-run --json
```

Confirm the dry run reports a plain workspace and the expected destination, then run the import.

```bash
./relay pull --workspace "$RELAY_TEST_ID" --into "$RELAY_TEST_PARENT" --name phone-project --vm "$RELAY_TEST_VM" --json
grep -F 'PHONE_V1' "$RELAY_TEST_PROJECT/index.html"
grep -Fx 'seed-v1' "$RELAY_TEST_PROJECT/notes.txt"
```

**Pass** if the import returns a receipt and both content checks succeed. Keep the receipt. Run the same import dry run again and confirm it reports `destination_exists`.

## 4. Work on the desktop, push, and resume on the phone

In the same terminal, define the commands for repeated handoffs and make two desktop edits.

```bash
relay_test_push() {
  ./relay push --workspace "$RELAY_TEST_ID" --project "$RELAY_TEST_PROJECT" --vm "$RELAY_TEST_VM" --json "$@"
}
relay_test_pull() {
  ./relay pull --workspace "$RELAY_TEST_ID" --into "$RELAY_TEST_PROJECT" --update --vm "$RELAY_TEST_VM" --json "$@"
}
printf '<h1>DESKTOP_V2</h1>\n' > "$RELAY_TEST_PROJECT/index.html"
printf 'desktop-v2\n' > "$RELAY_TEST_PROJECT/desktop.txt"
relay_test_push --dry-run
```

1. Confirm the preview shows `index.html` modified, `desktop.txt` added, and no cloud changes. Run `relay_test_push` after reviewing the preview. Keep the success receipt and checkpoint or transfer ID.
2. On the phone, reopen the same workspace. In **Files**, refresh or reopen `index.html` and `desktop.txt`. Confirm they contain `DESKTOP_V2` and `desktop-v2` respectively. This checks the VM copy before Codex makes another change.
3. Continue the original chat and send this prompt.

   > Change the heading in `index.html` to `PHONE_V3` and create `phone.txt` containing `phone-v3`. Leave `desktop.txt` unchanged. Stop after those edits.

4. Wait for the turn to finish, then run `relay_test_pull --dry-run` on the desktop. Confirm it reports cloud changes and no local changes, then run the update and check the files.

```bash
relay_test_pull
grep -F 'PHONE_V3' "$RELAY_TEST_PROJECT/index.html"
grep -Fx 'phone-v3' "$RELAY_TEST_PROJECT/phone.txt"
grep -Fx 'desktop-v2' "$RELAY_TEST_PROJECT/desktop.txt"
```

5. Repeat with `DESKTOP_V4` and `PHONE_V5`. This time edit the existing `desktop.txt` to contain `desktop-v4` and have the phone turn update `phone.txt` to `phone-v5`. Push and pull with the same commands and verify both files and the final heading. Keep using the same workspace ID and local folder.

**Pass** if both cycles finish and the phone sees the desktop edits before making its next edit. The desktop must then see the phone edits in the same local folder, with the untouched files preserved. Run a final dry run and confirm there are no pending changes in either copy.

## 5. Exercise failures on disposable fixtures

| Case | Action and expected result |
| --- | --- |
| Both copies edited | After the successful cycles, put different markers into `notes.txt` on each side. The plain folder workflow reports divergence and refuses the transfer. Verify each copy still has its own marker. Use a fresh fixture for later tests. |
| Interrupted transfer | Use a separate fixture with a synthetic file larger than 10 MiB. Interrupt while rsync is transferring, restore connectivity, then resume. For first import use `./relay pull --resume TRANSFER_ID --vm "$RELAY_TEST_VM"`. For batch push use `relay_test_push --resume`. For repeat pull use `./relay pull --inspect-update "$RELAY_TEST_PROJECT" --vm "$RELAY_TEST_VM"` and then `./relay pull --resume-update "$RELAY_TEST_PROJECT" --vm "$RELAY_TEST_VM"`. Use the variables for that fixture. Compare the final SHA-256 on both ends and check the recorded recovery paths. |
| Phone disconnect | In a separate chat, disconnect the phone during a harmless test turn and reconnect. Reopen the workspace and history, inspect any partial changes, and start a fresh turn. The current PWA interrupts a Relay-owned turn when its stream disconnects. Record the behavior you observe. |
| Phone Stop button | During a harmless read-only turn, tap **Stop**. Verify the chat returns to an actionable state and a follow-up turn can run. |

## 6. Run the Git phone acceptance test

Start with Linux. Keep both endpoints idle during each handoff, including Codex turns, watchers and database writers. Use a stopped database or a consistent backup. Keep the same workspace ID and desktop project path throughout.

### Preflight and first pull

Run from the Relay checkout on the desktop. The VM suite creates disposable fixtures under `/tmp`.

```bash
set -o pipefail
RELAY_TEST_VM=relay-do-v0
./relay doctor --vm "$RELAY_TEST_VM"
npm test
RELAY_DISPOSABLE_TEST_VM="$RELAY_TEST_VM" python3 -m unittest -v   relay_lib.test_vm_git_handoff relay_lib.test_vm_plain_push
```

1. On the phone, connect to your Tailnet and open your existing private Relay URL. Use **Add workspace → New folder** to register a disposable folder named `relay-e2e-git-01`. Open **Chats** and check the notice about full VM-user permissions and `.env` access before sending.
2. Send this prompt and wait for the turn to finish.

   > In this disposable workspace only, initialize Git and create one commit. Put `BASE` in `version.txt`, `DELETE_BASE` in `delete.txt`, and a TOP line, twelve numbered separator lines, and a BOTTOM line in `sections.txt`. Commit exactly those three files. Use an inline Git author identity like Relay Fixture <fixture@example.invalid> if needed. Create an untracked `.relayignore` with the lines `protect .env` and `exclude local-only.db`. Create dummy `.env` bytes `TOKEN=synthetic-vm`, and put `VM_ONLY` in `local-only.db`. Stage a new `PHONE_INDEX_1` version of `version.txt`, then write `PHONE_WORKTREE_1` to it without staging again. Stop and report the absolute workspace path and current commit ID. Use no real credentials or public ports.

3. Open **Files**, confirm `version.txt` shows `PHONE_WORKTREE_1`, and confirm the two policy-controlled files are absent there. Reopen the saved chat and check that the notice still appears. On the desktop, copy the workspace ID from the listing. Use a fresh project parent and keep the JSON preview and receipt.

```bash
./relay workspaces --vm "$RELAY_TEST_VM" --json
RELAY_TEST_ID=PASTE_WORKSPACE_ID
RELAY_TEST_PARENT=$(mktemp -d "$HOME/relay-git-e2e.XXXXXX")
RELAY_TEST_PROJECT="$RELAY_TEST_PARENT/phone-git"
./relay pull --workspace "$RELAY_TEST_ID" --into "$RELAY_TEST_PARENT" --name phone-git   --vm "$RELAY_TEST_VM" --dry-run --json | tee "$RELAY_TEST_PARENT/import-preview.json"
./relay pull --workspace "$RELAY_TEST_ID" --into "$RELAY_TEST_PARENT" --name phone-git   --vm "$RELAY_TEST_VM" --json | tee "$RELAY_TEST_PARENT/import.json"
RELAY_TEST_HEAD=$(git -C "$RELAY_TEST_PROJECT" rev-parse HEAD)
git -C "$RELAY_TEST_PROJECT" show HEAD:version.txt
git -C "$RELAY_TEST_PROJECT" show :version.txt
cat "$RELAY_TEST_PROJECT/version.txt"
test "$(cat "$RELAY_TEST_PROJECT/.env")" = TOKEN=synthetic-vm
test ! -e "$RELAY_TEST_PROJECT/local-only.db"
printf 'PC_ONLY
' > "$RELAY_TEST_PROJECT/local-only.db"
```

Expect `BASE`, `PHONE_INDEX_1` and `PHONE_WORKTREE_1` from the three checks. Compare the recorded commit ID with the phone result. The preview should report the `.env` and exclusion path dispositions without file contents.

### Two round trips in the same folder

```bash
git_push() {
  ./relay push --workspace "$RELAY_TEST_ID" --project "$RELAY_TEST_PROJECT" --vm "$RELAY_TEST_VM" --json "$@"
}
git_pull() {
  ./relay pull --workspace "$RELAY_TEST_ID" --into "$RELAY_TEST_PROJECT" --update --vm "$RELAY_TEST_VM" --json "$@"
}
git_review() {
  ./relay merge --workspace "$RELAY_TEST_ID" --project "$RELAY_TEST_PROJECT" --vm "$RELAY_TEST_VM" --json "$@"
}
printf 'PC_INDEX_2
' > "$RELAY_TEST_PROJECT/version.txt"
git -C "$RELAY_TEST_PROJECT" add version.txt
printf 'PC_WORKTREE_2
' > "$RELAY_TEST_PROJECT/version.txt"
git -C "$RELAY_TEST_PROJECT" rm delete.txt
printf 'RECREATED_UNTRACKED
' > "$RELAY_TEST_PROJECT/delete.txt"
dd if=/dev/zero of="$RELAY_TEST_PROJECT/large.bin" bs=1048576 count=11
git_push --dry-run | tee "$RELAY_TEST_PARENT/push-preview-1.json"
RELAY_PLAN_ID=$(python3 -c 'import json,sys; print(json.load(sys.stdin)["plan_id"])' < "$RELAY_TEST_PARENT/push-preview-1.json")
git_push --expect "$RELAY_PLAN_ID" | tee "$RELAY_TEST_PARENT/push-1.json"
```

1. On the phone, reopen **Files** before sending a prompt. Confirm `version.txt` shows `PC_WORKTREE_2` and `delete.txt` shows `RECREATED_UNTRACKED`. Resume the original chat and send:

   > Check that HEAD remains the fixture commit, the index contains PC_INDEX_2 for version.txt, delete.txt is absent from the index but exists on disk, and local-only.db still contains VM_ONLY. Report pass or fail without reading .env. Then stage PHONE_INDEX_3 in version.txt and write PHONE_WORKTREE_3 to it without staging it again. Create phone.txt containing PHONE_3 without staging it. Stop without committing.

2. After the turn ends, run the pull and validate the three Git states. Keep the same folder.

```bash
git_pull --dry-run | tee "$RELAY_TEST_PARENT/pull-preview-1.json"
RELAY_PLAN_ID=$(python3 -c 'import json,sys; print(json.load(sys.stdin)["plan_id"])' < "$RELAY_TEST_PARENT/pull-preview-1.json")
git_pull --expect "$RELAY_PLAN_ID" | tee "$RELAY_TEST_PARENT/pull-1.json"
git -C "$RELAY_TEST_PROJECT" show :version.txt
git -C "$RELAY_TEST_PROJECT" status --short
git -C "$RELAY_TEST_PROJECT" diff
git -C "$RELAY_TEST_PROJECT" diff --cached
test "$(git -C "$RELAY_TEST_PROJECT" rev-parse HEAD)" = "$RELAY_TEST_HEAD"
test "$(cat "$RELAY_TEST_PROJECT/version.txt")" = PHONE_WORKTREE_3
test "$(cat "$RELAY_TEST_PROJECT/phone.txt")" = PHONE_3
test "$(cat "$RELAY_TEST_PROJECT/local-only.db")" = PC_ONLY
```

3. For round two, stage `PC_INDEX_4` in `version.txt`, then write `PC_WORKTREE_4` without staging again. Run `git_push --dry-run` and `git_push | tee "$RELAY_TEST_PARENT/push-2.json"`. Verify `PC_WORKTREE_4` in **Files**, then have the phone stage `PHONE_INDEX_5`, write `PHONE_WORKTREE_5` without staging, and change `phone.txt` to `PHONE_5`. Run `git_pull --dry-run` and `git_pull | tee "$RELAY_TEST_PARENT/pull-2.json"`. Repeat the Git checks. Verify each receipt's `parent_id` equals the preceding receipt's `transfer_id`. A final dry run should show no pending changes.

### Merge, commit and recovery

1. From the shared checkpoint, edit TOP on the PC and BOTTOM via the phone without staging those edits. Run `git_review`, read the plan, then run `git_review --approve PLAN_ID`. Check both endpoints contain both changes.
2. Make conflicting edits to TOP and different dummy values in `.env` on each side. Run `git_review` again. Verify both originals survive the preview. Resolve via `git_review --approve PLAN_ID --resolve worktree:sections.txt=pc --resolve worktree:.env=vm`. Compare dummy `.env` hashes privately. If testing a provider, use the scoped review commands in the README and a stub executable.
3. Check separate explicit commit transfer. Inspect `git diff --cached`, commit the intended staged fixture on the PC, capture its full ID with `git rev-parse HEAD`, and run `git_push --dry-run`. It should show the commit approval blocker. Run `git_push --commit FULL_OID` and verify that both endpoints reach that commit.
4. On a fresh disposable fixture, interrupt rsync in each direction and resume with `git_push --resume` or `./relay pull --resume-update "$RELAY_TEST_PROJECT" --vm "$RELAY_TEST_VM" --json`. For pull, inspect with `--inspect-update` before resuming. Verify the large file hash on both endpoints, the original copies where publication was incomplete, and a single checkpoint advance after retry. Stop any database writer before copying the test snapshot, then restore and query the received snapshot.

| Test | Pass criteria |
| --- | --- |
| Phone warning | The chat UI clearly says Codex has full VM-user access and can read `.env` and other files that user can access. Open both a new and a saved chat. The wording matches the actual access model. |
| Git import and two repeat cycles | Repeat the phone and desktop steps with Git. Include a staged version plus a different unstaged version of the same file, an untracked addition and a deletion. Verify the working files, `git status --short`, `git diff`, `git diff --cached`, and `git rev-parse HEAD` after each handoff. In file-transfer mode the staged and unstaged states match the source and `HEAD` stays unchanged. Test explicit commit mode separately and verify the chosen commit reaches both copies. |
| Transfer rules | Add `.relayignore` fixtures for a private-but-transferable file and an excluded file, according to the candidate's documented syntax. Check first import, push, pull and resume. The private dummy file arrives byte-for-byte if included. The excluded file never arrives through Relay and an existing excluded destination copy stays unchanged. Git-ignored files follow Relay's transfer rules. |
| Private content | Use recognizable dummy values in `.env` and other protected fixtures. Verify Relay keeps their contents out of transfer previews and automatic AI conflict requests, including when both versions change. Check by inspecting the test output or captured requests using a stub provider. Full-permission Codex can still open data it can read during a normal chat. |
| Two independent edits | Edit separate sections of the same text file from a shared checkpoint. Relay uses the common version to merge the edits. Verify both sides receive the same file containing both changes. |
| Overlapping edits and approval | Edit the same line differently on each side. Relay preserves both versions and reports the conflict. Decline assistance first and verify neither copy is overwritten. Then approve assistance on a non-private fixture and verify the proposal is reviewed before publication. For a protected file or database, choose or restore a complete version manually and verify its hash. |
| Recovery and content checks | Repeat divergence, interrupted upload and download, and lost acknowledgment tests on disposable fixtures. Confirm the shared checkpoint advances once after verification and both copies match. Include an offline database snapshot and verify a restore on the receiving side. |

Use Linux first. Repeat the acceptance run on macOS and on the Windows environment Relay intends to support, recording native Windows and WSL results separately. Record Android and iPhone browser results independently when both devices are available.

Record pass, fail, or blocked for each row, along with the exact error, last completed step, build, device and affected transfer ID. Keep receipts and any screenshots free of credential values. The plain folder smoke test passes after two verified cycles. The Git workflow passes only after its acceptance cases and the claimed platform runs succeed.

## 7. Candidate and deployment record

Candidate tested on 22 November 2026 from checkout base
`ca381f34ac1ef3709f6c4ada843e22b8d3a1bfa2` with the working-tree changes for Git
handoff. The desktop CLI archive SHA-256 is
`1cfa5125a9e78402308451fb8df84c77749bcbcf997807c0b685c4d036b06bc8`.
The PWA candidate and deployed archive SHA-256 match
`9690f91d46fd08036a80fbaf19f0af08cfa55a4ed2f7475af9e94f8b1617e8f3`.

The `relay-pwa` service is active on `relay-do-v0`. The deployed service returned
401 without an owner identity, and its health, workspace listing and chat
notice returned 200 with the configured owner. The desktop also reached
`/api/health` over the Tailnet. The deployment kept the existing private Serve
configuration. The VM records the deployed digest in `/opt/relay/.pwa-build`.

If a rollback is needed, the previous PWA and helper are preserved on the VM.
Run the saved restore script on the VM, then check health again.

```bash
ssh relay-do-v0 sudo -n /opt/relay/rollback-9690f91d46fd08036a80fbaf19f0af08cfa55a4ed2f7475af9e94f8b1617e8f3/restore.sh
```

| Check | Result |
| --- | --- |
| PWA suite | Pass, 46 tests, including transfer-rule preview refusal and the shared chat notice. |
| Linux plain-folder over real SSH | Pass, including repeat cycles and divergence refusal. |
| Linux Git over real SSH | Pass for import, two repeat cycles, separate index and worktree, protected and excluded files, 11 MiB hash, SQLite restore, independent merge and explicit commit. Rate-limited upload and download were interrupted and resumed. A dropped acknowledgment advanced the checkpoint exactly once. |
| Git recovery and scoped review fixtures | Pass for interrupted upload and download, stale policy, protected conflict and stub payload, and reviewed divergent commit histories. |
| Actual Android phone and Linux PC | Pending. Record browser, PWA build and final checkpoint IDs here. |
| Actual iPhone and Linux PC | Pending. Record browser, PWA build and final checkpoint IDs here. |
| macOS desktop | Unverified. |
| Windows native desktop | Unverified. |
| Windows via WSL | Unverified. |

The live phone and Linux desktop fixture `relay-e2e-git-01`
(`cea325d9068771ea`) passed the initial import and two repeat cycles.
The receipts link through generation 4 at
`03361af7f4bd4a8d80d412ea76b69879`. The independent merge passed at
generation 5, `16b056f795c146d782abe8c6cc434540`. The desktop file
and the deployed Files endpoint returned identical bytes containing
`PC_TOP` and the phone's lowercase `vm_bottom` edit. Git verification
confirmed the merge remained unstaged and preserved the fixture commit.
The phone OS and browser were not recorded.

Live acceptance to date covers untracked and unstaged file transfer, distinct
staged and working versions, protected `.env` import, exclusion of the local
database file, and an independent worktree merge. Overlapping edits and
protected-file conflict resolution passed in automated fixtures. A manual phone
run of those conflicts, explicit commit transfer and recovery remains pending.
The runbook is not fully accepted until the remaining phone and platform cases
are recorded.
