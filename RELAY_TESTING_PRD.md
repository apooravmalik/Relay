# Relay testing PRD: VM-first agentic RAG reference project

**Date:** 8 November 2026 (Asia/Kolkata)  
**Status:** Proposed requirements; implementation and scenario results pending  
**Chosen first journey:** Create on VM → develop from phone/PC → export to new PC folder → rebuild and verify locally.

## 1. Purpose and success

Use one realistic AI engineering project to exercise Relay's project lifecycle,
remote execution, private previews, streaming, Docker, persistent data, external
connectivity and return-to-PC workflow. Establish diagnostic coverage before
running the workload. Every scenario produces reproducible evidence and a
pass, fail, blocked or not-run result; a manual workaround is not a product pass.

The reference application is a small engineering knowledge assistant over
synthetic project documentation. It ingests documents, embeds and retrieves
them, uses bounded retrieval tools, streams cited answers and runs repeatable
quality and adversarial evaluations. Use synthetic data and secret canaries;
real credentials are provisioned separately and are never test fixtures.

Success means a developer can create this project on the VM, work through Relay
on their phone, recover from disconnects, review code and artifacts, and obtain
a verified runnable copy on their PC without losing work or leaking secrets.
For the second main journey, repeat from a PC-originated project and verify
the delta return. Source portability and persistent-data portability are
separate results.

## 2. Observed starting point and limitations

A read-only SSH probe during this planning session returned 2 CPUs, 3,915 MiB
RAM, about 3,405 MiB available RAM, no swap and 66 GiB free on the root disk.
VM-reported time was `2026-11-07 18:51:53 UTC`; verify clock synchronization
before correlating phone/host/VM timestamps. Relay PWA, Tailscale and Docker
services were active. Docker reported 29.1.3 and Codex 0.162.1. The Docker
Compose plugin was unavailable. This probe is a baseline, not telemetry setup.

Current Relay gaps directly affect the test:

- No first-class VM workspace creation/registration flow in the PWA; roots
  are explicitly configured on the controller.
- `relay pull` depends on an earlier handoff snapshot and corresponding local
  Git base. It cannot yet export a newly VM-created project into a fresh PC
  folder. Implement an explicit initial checkout/export path; do not create a
  fake PC-origin push to disguise this limitation.
- Repeat push, durable writer ownership and divergence resolution remain
  incomplete (RLY-002/004/012/014).
- The current workspace directory is owned by the personal `relay` user. It
  is not a tenant partition or isolation boundary. This experiment is on the
  existing owner's dedicated workspace; it does not validate multi-user beta.
- The PWA launches Codex with full VM permissions. Container resource limits
  for the sample app do not isolate that agent or other personal workspaces.

## 3. Scope and proposed workload

Start with a Python API, a small browser test client, a Qdrant vector service,
Docker Compose, a pinned dependency lock and an evaluation CLI. Validate and
pin compatible versions during implementation. Prefer a few explicit modules
over a large orchestration framework for this first diagnostic workload.

| Component | Required behavior | Relay coverage |
|---|---|---|
| Ingestion | Parse Markdown/text and a small PDF fixture; chunk with stable IDs, document hash and source metadata; idempotent re-ingestion and deletion | File handling, dependencies, background jobs |
| Vector storage | Workspace-scoped collection, persistence across container restarts, metadata-filtered retrieval | Docker networking, volumes, resource use |
| Retrieval tools | Search documents, fetch cited passage, optionally fetch an allowlisted public source; validated inputs and bounded tool calls | Agentic execution, egress, tool errors |
| Answer pipeline | Retrieve → optionally reformulate/search again → answer with citations or abstain; cancel and enforce deadlines | Long-running work, streaming, state |
| Provider adapters | Deterministic offline fixture mode plus a configured real embedding/generation mode | Reproducibility versus actual external integration |
| Evals | Versioned questions, expected sources and failure cases; JSON and readable reports | Artifacts, regression tracking, transfer |
| Secrets | Ignored local config, placeholder-only example, redacted diagnostics, separate provisioning on PC | Source transfer exclusions and leakage tests |

Offline fixture mode must be labeled as such; passing it is not proof of real
model quality, semantic embedding behavior or provider connectivity. Do not run
a local large model on this VM in the initial profile. Begin with 20–50 small
documents, one active ingestion job and one active query; measure before
increasing load.

## 4. Milestone zero: telemetry before the application

Telemetry provides declared coverage, not a promise to record everything on
the machine. No keylogging, global file-content capture, packet payload
capture, secret dumping or collection of unrelated conversations.

### Required signals and diagnostic views

| Layer | Signals to collect | Diagnostic question |
|---|---|---|
| Host | CPU/load, RAM/available/swap, disk and inodes, I/O, network byte/error counters, clock sync, boot ID, OOM events | Was the VM saturated, full, restarted or out of sync? |
| Services/processes | State, PID, restart/exit reason, CPU/RSS for Relay, Codex children and workload; systemd errors | Which process failed or consumed resources? |
| Containers | Health, restart/exit/OOM state, CPU/RAM, volume usage and bounded logs | Did the app, store or build fail? |
| Relay | Workspace operation and turn IDs, start/end/outcome, transfer bytes and hash verdict, errors, connection lifecycle and writer conflict | What action was attempted, and what happened? |
| Phone/client | Connection transitions, page visibility, request/stream IDs, time to first response/delta, completion and error codes | Did the client lose connectivity or did execution fail? |
| RAG | Ingest/chunk/vector counts, tool spans, retrieval IDs/scores, provider duration/status, retries, usage if supplied, eval results | Was failure in ingest, retrieval, tools or generation? |

Correlate structured logs and application spans using run ID, workspace ID,
thread/turn ID where available, request ID and trace ID. Use UTC timestamps
and monotonic durations. Keep identifiers in logs/traces, not high-cardinality
metric labels. Shell/agent activity is covered by lifecycle metadata and
opt-in scoped test transcripts, not unlimited system-wide command auditing.

Implement the smallest usable collection first: bounded journal/application
logs, a lightweight host/container sampler and a private status view with a
sanitized diagnostic bundle. Add OpenTelemetry application spans when building
the RAG API. Avoid installing a full monitoring database stack on this 4 GiB VM
until measurements justify it. Capture a coverage inventory listing gaps.

Default telemetry is metadata-only: no raw prompts, document contents,
Authorization headers, cookies, environment dumps or URL query tokens. Raw
synthetic traces may be enabled for an individual test run with explicit
retention. Redact before persistence and before diagnostic export. Test
canaries in logs, trace attributes, errors, evaluation reports and exports.

Proposed initial budgets, to validate and revise from baseline measurements:

- Collect host/service samples every 15 seconds; mark stale after 60 seconds.
- Retain rolling metrics for 7 days and logs/traces for 3 days, capped at 500
  MiB combined; keep sanitized regression evidence separately with a manifest.
- Target telemetry overhead below 150 MiB RAM and 5% of one CPU averaged over
  a 10-minute idle comparison; disclose any functions disabled to meet budget.
- Emit private diagnostic events for failed services, OOM, low free disk and
  repeated stream/egress failures. External alert delivery is a later feature.
- Sampling/export failure must not stop agent work; expose dropped records and
  collector health. Test bounded behavior when storage is unavailable.

**Gate:** reproduce a controlled workload error and identify its process,
operation, time and likely cause from one sanitized bundle. Prove secret
canaries are absent and verify retention/rotation, overhead and access control.
Record remaining blind spots before proceeding.

## 5. VM-first lifecycle requirements

1. Create a new uniquely identified workspace without replacing an existing
   path. Record canonical root, owner identity, origin `vm`, Git branch/base,
   timestamps and a creation checkpoint. Initialize Git for this test project.
2. Register it explicitly with Relay and show it in the phone PWA. Initial
   provisioning via an admin command is acceptable scaffolding but must be
   recorded as such; PWA creation is a separate product capability.
3. Install/verify Compose, then build and run the project with an isolated
   Compose project name and named volumes. Bind published ports to loopback;
   expose only an authenticated, private preview. Verify service readiness
   before presenting a link. Give vector storage no public listener.
4. Work through the PWA: start a conversation, request a change, stream output,
   inspect changed files and run the evals. Preserve the evidence checkpoint.
5. Export source to a new/empty PC destination via a supported transaction:
   stage, transfer manifest and hashes, verify, atomically finalize and report
   success. Never overwrite an existing destination or follow escaping paths.
   Define whether Git history/branch is preserved and verify that contract;
   for this Git reference project preserve its history and selected revision.
6. Exclude real secrets, telemetry, dependency caches and raw database volumes.
   Transfer the fixture corpus, code, lockfiles, placeholder config and chosen
   sanitized eval artifacts. Do not report a partial export as a complete one.
7. Provision local credentials separately, rebuild via Compose, re-ingest the
   fixture corpus and rerun tests. Match manifest hashes for transferred files
   and deterministic eval results; use thresholds for real-model results.
8. Test durable data separately: create a supported logical export or vector
   snapshot, verify compatibility and restore. Do not copy live volume files.
   Missing local Docker, credentials or compatible architecture must produce
   a clear readiness failure without corrupting the exported source.

**Gate:** a runnable PC copy and a verified VM copy both remain available.
Report source, history, data and environment reconstruction independently.

## 6. Guardrails, external connections and secrets

Treat retrieved text as untrusted data. Restrict agent tools to registered
workspace documents and an explicit external-domain allowlist. Validate tool
arguments, enforce call/token/time budgets, and disallow arbitrary shell or
general-purpose URL fetching in the sample RAG agent. These controls apply to
the sample agent, not the developer's VM-level Codex permissions.

Test document injection, attempts to read `.env`, cross-workspace retrieval,
path traversal, redirects to loopback/private/metadata destinations, oversized
input, malformed files, unsupported formats and credential-exfiltration prompts.
Checks must constrain resolved addresses and redirect targets, not only URL
spelling. Use synthetic identifiers and secrets for adversarial fixtures.

Egress probe requirements, from both VM host and application container:

- DNS, verified TLS, bounded unauthenticated HTTPS access to configured public
  fixture host, registry and package indexes.
- Authenticated minimal embedding and generation calls only when a user-owned
  provider credential is configured; enforce a configured spend/call cap and
  never silently substitute fixture mode. Record skipped auth checks as blocked.
- Reproduce DNS/TLS failure, timeout, authentication rejection, rate limit and
  service error with a controlled local stub. Do not flood third-party APIs.
- Record only destination hostname, stage/status, duration and error class;
  distinguish host egress, container egress and phone inbound preview access.

No real secret may appear in Git, patches, exported source, browser errors or
diagnostic artifacts. Test ignored and intentionally unignored synthetic
canaries; `.gitignore` alone is not sufficient. Credentials and provider choice
remain implementation inputs, not grounds to call a stubbed test end-to-end.

## 7. Scenario matrix beyond the two happy paths

All cases start as **not run**. Each needs a disposable workspace or isolated
test instance appropriate to the failure; do not inject host-wide faults into
the shared personal VM.

| ID | Scenario | Expected result |
|---|---|---|
| L01 | VM-first create, build, develop, export, local rebuild | Verified complete copy and equivalent deterministic checks |
| L02 | PC-first dirty Git push, VM edits and pull | Original edits preserved; exact remote delta returned |
| L03 | Clone existing remote repository directly on VM | Origin/history preserved; PC bootstrap works |
| L04 | VM-first non-Git project | Explicit full export or clear unsupported result, never fake delta |
| L05 | Repeat PC→VM→PC handoffs | Safe update or explicit blocked conflict; no folder replacement |
| L06 | Both sides edit same file / diverge commits | Both versions preserved; no silent winner or checkpoint advance |
| L07 | Deleted/renamed/binary/untracked/ignored/Unicode files | Correct manifest and Git semantics; exclusions enforced |
| L08 | Existing target, wrong base, escaping path or symlink | Reject before mutation; no unrelated file reads/writes |
| L09 | Export interrupted, corrupt bytes, disk full | Incomplete staging remains uncommitted; verification fails safely |
| C01 | Phone background, refresh, Wi-Fi→mobile, Tailscale off/on | Accurate unknown/offline state, reconcile history, no duplicate turn |
| C02 | Two browser sessions or active terminal writer | Single-writer rule; visible conflict and recovery |
| C03 | Codex child or controller exits mid-turn | Preserve partial output; truthful outcome and diagnostic evidence |
| C04 | Slow/large stream or no completion event | Bounded memory, usable scroll and no false success |
| D01 | Container restart, volume restore, duplicate ingestion | Persistent data correct, no duplicate document records |
| D02 | OOM/disk pressure/failed dependency | Isolated injection, clear resource diagnosis, existing projects intact |
| N01 | Host/container egress and private phone preview | Each leg measured independently; no public exposure |
| N02 | DNS/TLS/401/429/5xx/timeout | Bounded retries, redacted useful errors, explicit failed/blocked status |
| S01 | Injection, secret canary, traversal, cross-workspace access | Deny protected action and produce redacted evidence |
| O01 | Telemetry unavailable or at retention cap | Core work continues; gap/drop counters visible |
| R01 | Reboot and upgrade/restart recovery | Tested in disposable instance; reconcile runtime/checkpoints correctly |

## 8. Evaluations and release criteria

Version a 40-case set: 20 answerable questions, 5 multi-document/tool questions,
5 unanswerable questions and 10 adversarial cases. Record source relevance
labels and expected decisions. Freeze the corpus and retrieval configuration
per run, and persist code/version/config hashes with results.

Initial acceptance targets (requirements, not measured claims):

- All deterministic tests repeat identically on VM and PC; no duplicate ingest.
- Expected relevant source in top 5 for at least 90% of the 25 answerable cases;
  citation IDs must exist and point to retrieved source passages.
- Real-model answers are manually checked for grounded claims; at least 90%
  of answerable cases meet a defined correctness/citation rubric over repeated
  runs. Record judge/rubric and variability; do not rely solely on model judging.
- All 5 unsupported questions abstain and all 10 adversarial fixtures deny
  protected actions. These finite fixtures do not prove general model safety.
- Zero secret canary leaks, cross-workspace access or silent data loss in the
  release suite; failures block a beta claim.
- Measure p50/p95 API and first-delta latency, memory and CPU. Run a short
  one-user soak first; establish provider-specific targets from that baseline.
  Keep at least 1 GiB host available RAM under the initial workload; throttle
  or stop the test if breached. Record maximum concurrency actually validated.

## 9. Evidence and delivery order

Store sanitized per-run evidence outside source in a run-ID directory: build
and dependency versions, Git revisions, fixture hashes, scenario outcomes,
host/container probes, redacted correlated logs/traces, transfer manifests,
eval reports and phone screenshots where needed. Each failure includes
reproduction, expected/actual behavior, severity, owner and linked Relay issue.
Keep the initial baseline distinct from newly collected telemetry.

1. Establish telemetry and its validation gate; fix missing prerequisites.
2. Implement and verify VM-first creation/registration and transactional PC
   export contracts before claiming journey L01 is supported.
3. Create the reference project on the VM; build deterministic mode and test
   Docker, vector persistence, guardrails and private preview.
4. Configure bounded real-provider calls; verify host and container egress.
5. Develop through the phone PWA and exercise reconnect/writer/error scenarios.
6. Export to PC, rebuild and compare source/data/eval results independently.
7. Run the PC-first journey and remaining destructive cases in disposable
   workspaces/instances, triage failures, and update the beta readiness record.

This document is the first deliverable. No telemetry agent, reference project,
dependency installation or fault injection was deployed while writing it.

## Implementation references

- [Docker: Compose plugin installation](https://docs.docker.com/compose/install/linux/)
- [Qdrant: local quickstart](https://qdrant.tech/documentation/quickstart/)
- [OpenTelemetry: signals](https://opentelemetry.io/docs/concepts/signals/)
- [Relay beta roadmap](BETA_ROADMAP.md)
