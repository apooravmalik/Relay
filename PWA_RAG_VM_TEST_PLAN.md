# Relay PWA: agentic RAG, Docker, database and workspace pull test plan

## Goal and current environment

Build and exercise a small agentic retrieval application from the phone, run its services on the VM, verify persisted documents and vector data, and import the workspace onto the PC. Record pass/fail and exact errors at each gate; a working service, retrieved answer and PC restore are separate outcomes.

Observed on the configured `relay-do-v0` VM on 8 Nov 2026: PWA service active; 2 CPUs, approximately 3.8 GiB RAM, about 66 GiB free disk; Docker Engine 29.1.3 works for the `relay` user; a minimal Docker image build succeeded through the legacy builder. Docker Compose and Buildx were unavailable. The checked deployed PWA UI and server files matched this workspace. This was a KVM VM, not an identified Firecracker VM. Checks reflect that point in time.

The reviewed rename and diff preview fixes in `pwa/lib/workspaces.mjs` have been deployed to `relay-do-v0` and checked on the VM with a temporary Git workspace.

Prerequisites: the phone and VM are on the private Tailnet; the PWA opens and Codex is signed in; this PC has access to the Relay checkout and `ssh relay-do-v0`; both hosts have Git, Python 3 and rsync. Use synthetic documents, dummy credentials and a fresh test folder. Do not put real secrets in chat or screenshots. The PWA can upload one supported file up to 10 MB through the chat attachment control.

## 1. Create the workspace on the phone

1. Open the PWA. Tap **Add workspace**, choose the desired VM parent, tap **New folder**, name it `relay-rag-lab`, then tap **Create folder**. If that name exists, choose a unique one. A plain workspace opens and a new chat is created.
2. Confirm the workspace says Git is not initialized. Tap **Files**, confirm the folder is empty, then return to **Chats**. If no parent appears, record the configuration error; do not assume the folder was created.
3. In the chat, send:

> Check this workspace and report the working directory, available disk/RAM, `docker version`, `docker compose version`, `docker buildx version`, and whether the Docker daemon can be accessed as the current user. Do not install packages or modify system configuration. Do not print secrets.

**Pass:** The status is reported clearly. Docker Engine can be reachable even when Compose is absent. If Compose is absent, install its plugin through an approved VM administration workflow, then repeat `docker compose version`. Docker documents installation at https://docs.docker.com/compose/install/linux/; the correct package depends on configured repositories. Buildx is separately needed for modern BuildKit builds. Do not substitute `docker compose` commands until the plugin works.

## 2. Build a small RAG pipeline from the PWA

1. In the same chat, send this implementation request:

> In this workspace build a small, runnable agentic RAG demo sized for a 2 CPU / 4 GB VM. Use Docker Compose with an app container and a pinned Qdrant container; bind Qdrant's persistent storage under `./data/qdrant` inside this workspace, and store uploaded documents under `./data/documents`. Keep services private: bind any host-published app port to `127.0.0.1:3000`, and do not expose Qdrant publicly. Provide a simple phone-friendly UI to ingest text and ask a question. Implement observable retrieval and answer steps that report source citations and allow a no-evidence response. If an LLM provider is configured, use its tool calls for retrieval; otherwise label a deterministic local routing mode clearly rather than claiming it is an LLM agent. Include a small deterministic embedding option for an offline smoke test, fixed sample documents, a health endpoint, tests, `Dockerfile`, `compose.yaml`, `.env.example`, and a README with exact build, start, stop and restore commands. Do not initialize Git or commit. Do not read or print existing secrets, expose public ports, or install machine-wide software. Tell me before any task that requires a paid API or missing system prerequisite.

2. Let the Codex turn finish. Record its implementation and test output. Check **Files** for the Compose file, Dockerfile, app code, sample documents and README. Open a text file and verify it is readable. Hidden files, sensitive files and binary files are intentionally not normally shown in the PWA file browser; verify those from the PC after pull instead.
3. Use the **+** attachment control to add a small `.txt` file, then ask Codex to ingest the file saved under `uploads/`. Record whether upload and ingestion succeed. Avoid PDFs or binary databases for the first test.

**Pass:** The code and tests exist, and the application reports how it chooses retrieval and what source it used. A deterministic fallback proves orchestration, not LLM reasoning; test configured model-based tool calls separately if credentials are available.

## 3. Run Docker Compose and test the app on the phone

1. After Compose is installed, ask Codex: “Build and start this workspace using its documented Compose commands. Report container status, private host port bindings and health checks. Do not expose any public ports.” Do not use `docker compose down -v` or remove volumes.
2. Check the output: both app and Qdrant should be healthy and the app host port should be `127.0.0.1:3000`. If the VM has network or registry access failures, record them rather than treating Docker as unavailable.
3. In Relay, tap **Preview**, enter `3000`, tap **Create link**, and open the private Tailnet link. If the port is already in use, ask Codex to select another private port and use that port in Preview. Relay rejects listeners exposed on all interfaces.
4. Ingest a short test document with a distinctive fact, e.g. `The relay lab launch code is BLUE-HERON-42.` Ask for the launch code. Verify the response and the document citation. Ask an unrelated question; verify it reports insufficient evidence rather than inventing an answer. Try an uploaded document too.
5. Test the agent routing/tool view. Record which step queried Qdrant and which source was returned. If a configured model is unavailable or costs money, record that as a separate blocked test; the fallback does not establish model quality.
6. Restart the services using the project README, without deleting data, then repeat the query. **Pass:** the previously ingested fact and source are still present, and the app did not have to re-ingest it.

## 4. Make a vector database backup and test PC import

Qdrant stores persistent data in its configured storage directory; a bind mount under the workspace makes those files visible to Relay. Do not copy an active database and assume it is a consistent backup. Qdrant supports collection snapshots: https://qdrant.tech/documentation/snapshots/.

1. Ask Codex to report the actual Qdrant version, collection name, point count, document count and mount path. Ask it to create a **Qdrant collection snapshot using Qdrant's supported API**, copy the completed `.snapshot` into `./backups/` in the workspace, and show the path and SHA-256 digest. Ensure `backups` is not inside a dependency/cache directory. Verify it does not print data or credentials. This is distinct from raw database files.
2. Ask Codex to stop the application and Qdrant cleanly, close any SQLite connections, and confirm no application/database writers remain active. Do not restart them until the VM capture finishes. Record the exact captured collection count and test query answer.
3. On this PC, in the Relay checkout, run:

```bash
./relay workspaces --vm relay-do-v0
./relay pull --workspace WORKSPACE_ID --into "$PWD" --vm relay-do-v0 --dry-run
./relay pull --workspace WORKSPACE_ID --into "$PWD" --vm relay-do-v0
```

Replace `WORKSPACE_ID` with the listed ID. If the folder already exists, use `--name relay-rag-lab-import-2`. This is a PC CLI step: the phone PWA does not write arbitrary folders to the PC. The preview lists excluded dependency/cache directories; it includes `.env`, keys, databases, backup files and Git-ignored files. Relay may refuse unsupported symlinks or Git states; record the exact error. VM exports currently retain sensitive content until manually managed.
4. Confirm the imported snapshot file exists and compare its SHA-256 with the recorded VM digest. Confirm source documents and project files are present; check any synthetic `.env`, private key and SQLite file separately without revealing contents. Plain workspace must still have no `.git`. Ensure `node_modules` and `.venv` were not imported if they existed.
5. With a compatible Docker/Compose setup on the PC, follow the generated README to start a **fresh, separate Qdrant instance**, restore the transferred snapshot using the supported Qdrant recovery workflow, and run the same query. Use the same Qdrant version as the VM and separate PC ports/storage. Compare collection name, point count, answer and citation. Qdrant documents snapshot version compatibility at https://qdrant.tech/documentation/snapshots/.

**Pass:** The transferred snapshot checksum matches and the restored PC database returns the known fact without re-ingestion. A matching checksum alone does not prove a restore works. If the PC cannot run Docker, mark restore untested rather than passed.

For SQLite, test a separately created consistent backup or a database closed before capture; after pull, open it on the PC and query an expected row. For SQL Server, transfer an actual completed `.bak` from inside the workspace and restore it with a compatible SQL Server instance; a dummy `.bak` tests byte copying only, not database restore. Relay does not automatically back up or restore SQL Server or external Docker volumes. Microsoft: https://learn.microsoft.com/en-us/sql/relational-databases/backup-restore/quickstart-backup-restore-database?view=sql-server-ver16.

## 5. Git and conflict cases

1. Repeat in a **separate** fresh workspace that Codex initializes as Git. Commit an initial file; change a line and stage it; change the same line again without staging; create a new untracked file and a Git-ignored synthetic `.env` and database backup. Ask Codex to report `git status --short` and the current commit without printing secrets.
2. Stop writers, use `relay workspaces` and import to a new PC directory. On the PC compare `git rev-parse HEAD`, `git status --short`, the staged diff (`git diff --cached`) and the unstaged diff (`git diff`) with the VM. Check the untracked and ignored test files exist.
3. Rerun the import to the same destination. **Pass:** Relay rejects the destination and leaves its existing files unchanged. Use `--name` for a separate copy.
4. Optional: repeat with `git init` but no commit and verify the branch is unborn and staged/untracked differences remain. Unsupported symlinks, nested repositories, LFS, `.gitattributes`, shallow/sparse repos and conflicts should yield clear errors, not partial projects.

## 6. PWA usability and error handling

- Add/open workspace; verify folder labels, navigation back and duplicate-name feedback.
- Open a chat, send, watch streaming and status, stop a deliberately long turn, then reopen the chat. Hiding a conversation should hide it from Relay without deleting underlying history.
- Browse visible text files; verify a large/binary file is not shown as text and sensitive/hidden files are not displayed by the browser. This visibility restriction does not imply those files are excluded from the CLI import.
- For a Git workspace, inspect **Changes**, open a changed text file and its diff. A plain directory has no Git change list.
- Open and stop a private preview, confirm a missing listener gives a useful error, and check the page works on a narrow phone screen. Confirm no server port is reachable publicly by design.
- Disconnect/reconnect the phone and record whether status, chat history and preview behave as expected. Do not assume a phone disconnect leaves an active turn running; this PWA interrupts the Relay-owned turn on disconnect.

## 7. Firecracker qualification

The observed DigitalOcean VM reports KVM, not Firecracker; the successful image build is evidence only for that VM. To test Firecracker, use a separately identified Firecracker guest, record its provider/guest kernel, resources, Docker daemon access, Compose and Buildx versions, network access and storage path, then repeat sections 1–5 on that guest. Firecracker guest kernel configuration can determine whether Docker runs; do not infer support from the hypervisor name ([Firecracker project discussion](https://github.com/firecracker-microvm/firecracker/discussions/4038)). Record the outcome separately.

## Results

For each gate record: date, VM and kernel, workspace ID (not credentials), app and Qdrant versions, Compose/build output, document/point counts, snapshot digest, PC restore query, PWA/browser/device, pass/fail, and exact error. Stop and report failed prerequisites; do not mark later steps as passed merely because earlier commands completed.
