# Relay — Product Requirements Document

## 1. Product Summary

Relay is a developer infrastructure tool for moving an active local development workspace to remote compute and continuing work from another device.

The primary command is:

```bash
relay push
```

Relay captures the relevant state of the current local workspace, provisions or resumes a cloud development environment, reconstructs the project, transfers the local working delta and selected persistent state, and exposes remote terminal access.

The reverse operation is:

```bash
relay pull
```

which synchronizes resulting remote development changes back to the local environment.

Relay is not an AI coding assistant. It is the infrastructure layer beneath tools such as Codex, Claude Code, shell processes, local development servers, test runners, and other developer tooling.

---

## 2. Product Goals

### 2.1 Primary Goal

Enable a developer to move from:

```text
active local development
```

to:

```text
active cloud development
```

without requiring them to first:

- commit unfinished work
- push temporary changes to GitHub
- manually recreate dependencies
- manually transfer temporary files
- rebuild local service state
- leave the original laptop powered on

### 2.2 Secondary Goals

Relay should teach and demonstrate:

- VM provisioning
- cloud APIs
- Docker
- Linux process management
- remote terminals
- PTYs
- WebSockets
- SSH
- filesystem synchronization
- persistent volumes
- snapshots
- secure secret handling
- networking
- environment reproducibility
- development-agent orchestration

### 2.3 Non-Goals for the Initial Product

Do not build:

- a source-code editor
- a full browser IDE
- an AI model
- an AI code-review product
- a replacement for GitHub
- collaborative multiplayer editing
- Kubernetes-based infrastructure
- Firecracker/microVM orchestration in V0
- CRDT-based real-time bidirectional editing
- automatic multi-agent orchestration
- complex team/enterprise administration

---

## 3. Primary User Flow

### Local → Cloud

```text
Developer
   │
   │ relay push
   ▼
Workspace Capture
   │
   ├── detect Git state
   ├── identify environment
   ├── detect runtime/services
   ├── capture selected data
   └── produce Workspace Manifest
   │
   ▼
Relay Control Plane
   │
   ├── select compute provider
   ├── create/resume VM
   ├── attach storage
   └── establish secure connection
   │
   ▼
Remote Relay Agent
   │
   ├── clone base repository
   ├── apply workspace delta
   ├── restore environment
   ├── restore persistent data
   └── launch services
   │
   ▼
Remote Workspace Ready
```

The developer then connects using:

```bash
relay connect
```

or:

```bash
relay ssh
```

### Cloud → Local

```text
Remote Workspace
      │
      │ relay pull
      ▼
Calculate remote delta
      │
      ▼
Transfer changed state
      │
      ▼
Apply safely to local workspace
```

---

## 4. Core Product Concepts

## 4.1 Workspace

A Workspace represents the portable development state of one project.

It is independent of the physical VM.

A Workspace contains:

```text
Workspace
│
├── Repository State
├── Environment Definition
├── Runtime Metadata
├── Selected Persistent Data
├── Agent Configuration
├── Networking Metadata
└── Workspace Ownership State
```

---

## 4.2 Workspace Manifest

Every captured workspace must produce a machine-readable Workspace Manifest.

The manifest should describe, at minimum:

### Repository

- repository remote
- base commit SHA
- current branch
- staged changes
- unstaged changes
- deleted files
- non-ignored untracked files

### Runtime

- operating-system metadata
- source architecture
- required runtime versions
- Node version
- Python version where applicable
- package manager
- package manager version

### Environment

Relay should detect available environment definitions such as:

- `Dockerfile`
- `docker-compose.yml`
- `compose.yaml`
- `.devcontainer/devcontainer.json`
- `package.json`
- lockfiles
- `.nvmrc`
- `.node-version`
- `.python-version`
- Python lockfiles
- other runtime version files

The first version does not need perfect detection of every ecosystem.

### Services

Examples:

```text
postgres
redis
elasticsearch
minio
application server
worker
```

Relay should store enough metadata to reconstruct the service topology.

### Ports

Example:

```text
3000 → application
5432 → postgres
6379 → redis
```

### Agent Metadata

Relay may capture configuration relevant to developer agents, including:

- `AGENTS.md`
- `CLAUDE.md`
- Codex configuration
- MCP configuration
- workspace-specific agent instructions

Credential files must not be copied automatically.

---

## 5. State Transfer Model

Relay must not blindly copy the entire local development directory.

The state should be split into three categories.

```text
Source State
+
Environment Definition
+
Persistent Runtime Data
```

### 5.1 Source State

Git should provide the base.

Example:

```text
GitHub repository
       │
       │ clone base SHA
       ▼
Remote Workspace
       ▲
       │ local delta
       │
Local Machine
```

Relay should transfer only:

- modified files
- staged modifications
- deletions
- non-ignored untracked files

This prevents unnecessary transfer of the complete repository on every push.

---

## 5.2 Dependency State

Relay should **not copy dependency directories by default**.

Examples that should normally not be transferred directly:

- `node_modules`
- Python virtual environments
- compiled Rust targets
- platform-specific binaries
- local package caches

Reasons:

- macOS and Linux may use different binaries
- ARM and x86_64 may differ
- native modules may be platform-specific
- dependency directories can be extremely large

Dependencies should instead be recreated from deterministic definitions such as:

- lockfiles
- Dockerfiles
- devcontainers
- package manifests

---

## 5.3 Environment Caching

Relay should calculate an environment fingerprint.

Example inputs:

```text
Dockerfile
package.json
pnpm-lock.yaml
runtime version
system dependency definition
```

Conceptually:

```text
environment fingerprint
        ↓
env:f8a7d921
```

If the environment fingerprint has not changed:

```text
CACHE HIT
```

Relay can reuse an existing environment image.

If it changes:

```text
CACHE MISS
```

Relay rebuilds the environment.

This avoids reinstalling dependencies during every workspace transfer.

---

## 6. Persistent Data

Some development workloads depend on data that is not represented in Git.

Examples:

- PostgreSQL development databases
- Redis state
- SQLite files
- MinIO objects
- local application uploads
- selected Docker volumes

Relay should support explicitly selected persistent data.

The initial product should avoid automatically snapshotting every directory.

Developers should be able to configure what is persistent.

Example conceptual configuration:

```text
Persistent:
- postgres-data
- redis-data
- ./local-uploads

Excluded:
- node_modules
- build/
- caches
```

---

## 7. Compute Model

Compute should be treated as disposable.

The product should avoid tying a Workspace permanently to one VM.

Conceptually:

```text
Persistent Workspace State
          │
          ▼
     Disposable VM
```

When work begins:

```text
Workspace
   ↓
Provision VM
   ↓
Restore environment
   ↓
Attach/restore state
```

When work ends:

```text
Save state
   ↓
Destroy VM
```

This keeps infrastructure costs lower.

---

## 8. Compute Provider Abstraction

Relay should not be architecturally coupled to one provider.

The product should define a provider abstraction capable of:

- create machine
- delete machine
- retrieve machine status
- provision network access
- create storage
- attach storage
- create snapshot
- retrieve snapshot
- expose instance metadata

Conceptually:

```text
                    Relay
                      │
               Compute Provider
                      │
        ┌─────────────┼─────────────┐
        ▼             ▼             ▼
 DigitalOcean      Hetzner         AWS
        │             │             │
     Droplet        Server         EC2
```

The first provider can be simple.

Additional providers should not require redesigning the Workspace model.

---

## 9. Recommended VM Providers

## 9.1 DigitalOcean

Recommended for the first implementation.

Reasons:

- relatively simple API
- easy VM lifecycle
- straightforward documentation
- cloud-init support
- block storage
- snapshots
- object storage
- Terraform support
- Bangalore region
- good developer experience

Likely initial VM class:

```text
2 vCPU
4 GB RAM
Linux
Ubuntu 24.04
```

This is enough for an early workspace containing:

- Node.js
- Docker
- Codex
- tmux
- PostgreSQL
- Redis
- a small application

### What is required

At minimum:

- DigitalOcean account
- API token
- one Droplet while testing
- optionally a persistent block volume
- optionally Spaces/Object Storage later
- domain name for the control plane if remote access is exposed publicly

---

## 9.2 Hetzner

Useful as the second provider.

Advantages:

- inexpensive compute
- strong price/performance
- good API
- good choice for autonomous/background workloads

Tradeoff:

European regions may introduce noticeable interactive terminal latency for users in India.

Hetzner is valuable as a second provider primarily to validate the provider abstraction.

### What is required

- Hetzner Cloud account
- API token
- Cloud Server
- optional volume
- optional snapshots/backups

---

## 9.3 Vultr

Reasonable alternative.

Advantages:

- Mumbai presence
- VM API
- snapshots
- block storage
- Terraform support

Could be used instead of DigitalOcean if the desired instance economics or regional availability are better.

---

## 9.4 AWS EC2

AWS should not be mandatory for V0.

Use AWS later when learning or requiring:

- EC2
- EBS
- IAM
- VPC
- security groups
- S3
- KMS
- enterprise networking

AWS is useful but introduces substantially more infrastructure concepts than needed for the first proof of concept.

---

## 9.5 Oracle Cloud

Potentially useful for cheap experiments.

ARM compute may be attractive for development but can introduce architecture compatibility problems.

Relay should not initially depend on Oracle's free-tier economics.

---

## 10. Initial Infrastructure Purchases / Accounts

The initial project does **not** require a large infrastructure budget.

### Required

1. **GitHub account/repository**
   - stores the repository base state

2. **Cloud VM provider account**
   - recommended: DigitalOcean
   - alternative: Hetzner or Vultr

3. **Domain name**
   - useful for the Relay control plane and secure remote endpoints
   - example conceptual domains:
     - `api.relay.dev`
     - `ws.relay.dev`
     - `workspace.relay.dev`

4. **TLS**
   - should use HTTPS/WSS
   - can be obtained without paid certificates

### Likely Required Later

5. **Object storage**
   - workspace metadata
   - deltas
   - manifests
   - logs
   - snapshot artifacts

Possible providers:

- DigitalOcean Spaces
- Cloudflare R2
- AWS S3
- Backblaze B2

6. **Persistent block storage**
   - databases
   - selected development state
   - persistent workspace data

7. **Database for Relay control-plane metadata**
   - workspace records
   - machine records
   - provider information
   - snapshot metadata
   - ownership state

8. **Secret-management solution**
   - initially encrypted application storage may be acceptable for development
   - later:
     - AWS KMS
     - HashiCorp Vault
     - managed secrets products

---

## 11. Remote Connectivity

Relay should not require every VM to expose port 22 directly to the public internet.

Preferred architecture:

```text
Remote VM
   │
   │ outbound secure WebSocket
   ▼
Relay Control Plane
   ▲
   │
CLI / Browser / Phone
```

The VM runs a Relay Agent that opens an outbound connection to the Relay control plane.

Advantages:

- no mandatory inbound SSH port
- easier NAT/firewall compatibility
- centralized authentication
- session multiplexing
- terminal transport
- log transport
- future file transfer
- future port forwarding

SSH may still be supported as a debugging or advanced-user feature.

---

## 12. Relay Agent

Every remote machine should run a lightweight Relay Agent.

Responsibilities:

- register itself with the control plane
- authenticate itself
- maintain an outbound secure connection
- report health
- receive commands
- launch workspace processes
- attach to terminal sessions
- transfer filesystem deltas
- report service status
- expose ports through the Relay tunnel
- perform graceful shutdown/snapshot operations

The Relay Agent should not contain business-specific logic.

It exists to operate the remote development workspace.

---

## 13. Terminal and Process Persistence

For the initial implementation, `tmux` is acceptable.

Example:

```text
Remote VM
│
└── tmux
    ├── codex
    ├── application server
    └── shell
```

Benefits:

- simple
- battle-tested
- reconnectable
- easy to inspect during development

However, tmux should be considered an implementation aid rather than Relay's long-term agent harness.

The eventual harness may manage:

- PTYs
- stdin/stdout streams
- process lifecycle
- reconnects
- agent state
- process supervision
- terminal sessions
- approvals

---

## 14. Agent Support

Relay should be agent-neutral.

The workspace must be capable of running:

- Codex
- Claude Code
- shell
- other CLI agents

The initial product may optimize for Codex because it is the primary build workflow, but the Workspace model must not depend on Codex.

Relay owns the environment.

The agent is simply a process inside the environment.

---

## 15. Authentication for Coding Agents

Relay should avoid copying raw local credential files whenever possible.

### Codex

Prefer supported sign-in/authentication mechanisms.

Do not make the core design depend on copying local Codex authentication files between computers.

### Claude Code

The MVP may allow the user to authenticate interactively inside their own remote machine.

Relay should not assume permission to transfer subscription credentials automatically.

### General Principle

Authentication should be separated from workspace state.

```text
Workspace Snapshot
≠
Credential Snapshot
```

---

## 16. Secrets

Relay must not automatically copy `.env` or other sensitive files as ordinary workspace content.

Secrets should eventually use a dedicated mechanism.

Concept:

```bash
relay secret set DATABASE_URL
relay secret set STRIPE_KEY
```

Secrets are:

- encrypted
- stored separately
- injected at runtime
- excluded from workspace snapshots
- excluded from logs

Initial development may use simpler mechanisms, but the architecture should preserve this separation.

---

## 17. Networking

Remote development often requires internet access.

The first version may provide standard outbound internet access.

Later versions should support an explicit network policy.

Example:

```text
Allowed:
- github.com
- registry.npmjs.org
- api.openai.com
- api.anthropic.com

Blocked:
- everything else
```

Future reasons:

- prevent credential exfiltration
- limit compromised dependencies
- reduce prompt-injection impact
- support enterprise environments

---

## 18. Port Forwarding and Preview URLs

Relay should eventually expose local development ports remotely.

Example:

```text
Remote workspace

localhost:3000
      ↓
Relay Tunnel
      ↓
https://3000.workspace-id.relay.example
```

Potential uses:

- web applications
- API endpoints
- internal dev tools

Access should require authentication by default.

---

## 19. Workspace Ownership

The MVP should avoid simultaneous bidirectional editing.

At any point, workspace ownership is one of:

```text
LOCAL
```

or:

```text
CLOUD
```

### Push

```text
LOCAL
  ↓
relay push
  ↓
CLOUD
```

Cloud becomes authoritative.

### Pull

```text
CLOUD
  ↓
relay pull
  ↓
LOCAL
```

Local becomes authoritative.

This avoids the complexity of:

- simultaneous editing
- merge conflicts
- CRDT synchronization
- distributed filesystem races

Real-time sync is explicitly deferred.

---

## 20. Proposed CLI Experience

The exact names may change, but the product should support a small command surface.

### Create / Transfer

```bash
relay push
```

Capture local state and transfer ownership to cloud.

### Connect

```bash
relay connect
```

Attach to the remote development terminal.

Optional:

```bash
relay ssh
```

### Inspect

```bash
relay status
```

Example:

```text
Workspace: payments-refactor
Owner: CLOUD
Provider: DigitalOcean
Region: BLR1
Machine: Running

Services:
✓ postgres
✓ redis
✓ web

Ports:
3000 → available
```

### Return

```bash
relay pull
```

Apply remote source changes to the local workspace and return ownership to local.

### Suspend

```bash
relay sleep
```

Persist required state and destroy/stop compute where appropriate.

### Delete

```bash
relay destroy
```

Delete the remote workspace and associated compute resources after confirmation.

---

## 21. MVP Scope

The first useful version should intentionally support a narrow environment.

### Supported Development Scenario

- Git-based project
- Node.js application
- Linux remote VM
- Docker
- PostgreSQL
- Redis
- local uncommitted changes
- non-ignored untracked files
- Codex or shell
- tmux terminal session

### MVP Flow

```text
Local Node project
   ↓
relay push
   ↓
DigitalOcean VM
   ↓
Git clone base
   ↓
apply local delta
   ↓
start Docker services
   ↓
connect terminal
   ↓
continue development
   ↓
relay pull
   ↓
local workspace updated
```

---

## 22. MVP Technical Decisions

### Decision 1 — Use a Normal VM First

Use a normal cloud VM.

Do not start with:

- Firecracker
- Kubernetes
- custom hypervisors
- microVM orchestration

Reason:

The project's first goal is to validate development-state portability.

---

### Decision 2 — DigitalOcean First

Use DigitalOcean for the first provider unless practical testing shows a better provider for cost or region.

Reason:

- simple API
- straightforward VM lifecycle
- Bangalore region
- good learning curve

Provider abstraction should still exist from the start.

---

### Decision 3 — Ubuntu Linux Remote Environment

Use Ubuntu Linux as the standard initial remote runtime.

The source machine may be macOS or Linux.

Relay reconstructs the environment instead of copying platform-specific dependencies.

---

### Decision 4 — Docker for Service Reproduction

Docker should be the preferred mechanism for:

- databases
- Redis
- supporting services
- consistent local/cloud execution

Relay may later support non-containerized services more deeply.

---

### Decision 5 — Git Base + Delta Transfer

Do not upload the entire source repository on every push.

Use:

```text
base Git commit
+
workspace delta
```

---

### Decision 6 — Explicit Persistent Data

Persistent runtime data must be opt-in/explicit during the MVP.

Avoid attempting to detect every meaningful local data directory automatically.

---

### Decision 7 — tmux Initially

Use tmux for terminal continuity and agent/session persistence.

Replace or augment it later with a native PTY/session supervisor if required.

---

### Decision 8 — Outbound Agent Connection

Prefer:

```text
Remote VM → Relay Control Plane
```

using secure outbound WebSocket connectivity.

Avoid requiring publicly exposed inbound SSH for normal operation.

---

### Decision 9 — Cloud/Local Ownership Model

Only one side is authoritative at a time.

No real-time synchronization in the MVP.

---

## 23. State Persistence Evolution

### Phase 1

VM local disk.

Useful for initial proof of concept.

### Phase 2

Persistent block volume.

```text
VM
 │
 └── /workspace
       ↓
 persistent volume
```

VM can be destroyed while the volume remains.

### Phase 3

Object-storage-backed manifests and deltas.

```text
Object Storage
├── manifests
├── file deltas
├── logs
└── metadata
```

### Phase 4

Provider snapshots.

Use snapshots for faster environment restoration.

### Phase 5

Advanced VM/microVM checkpointing.

Potential exploration:

- Firecracker
- CRIU
- filesystem snapshots
- memory snapshots

This is intentionally outside the MVP.

---

## 24. Cost Model

The system should minimize always-on compute.

Preferred lifecycle:

```text
relay push
     ↓
create VM
     ↓
work
     ↓
relay sleep
     ↓
persist state
     ↓
destroy compute
```

This means developers primarily pay for:

- active compute hours
- persistent storage
- snapshot/object-storage usage
- network transfer

rather than a 24/7 VM.

The MVP does not need to implement billing to end users.

---

## 25. Reliability Requirements

Relay should prioritize correctness over speed.

Before transitioning ownership, it must know whether the workspace is safely captured.

A failed push must not leave the user believing the remote copy is authoritative when it is incomplete.

Important operations should be transactional where practical.

Examples:

### Push

```text
capture
→ upload
→ restore
→ verify
→ switch ownership
```

Only after successful verification should ownership move to CLOUD.

### Pull

```text
calculate delta
→ download
→ validate local preconditions
→ apply changes
→ verify
→ switch ownership
```

---

## 26. Security Requirements

At minimum:

- TLS for control-plane communication
- authenticated Relay Agents
- authenticated clients
- no plaintext credential storage
- secrets excluded from ordinary snapshots
- minimal public ports
- isolated workspaces
- no automatic copying of SSH private keys
- no automatic copying of cloud credential directories
- workspace deletion must delete associated sensitive data where possible

Future versions should include:

- short-lived tokens
- KMS-backed encryption
- egress policies
- audit logs
- device authorization
- workspace access controls

---

## 27. Observability

Relay should expose enough operational information to debug failed workspace transitions.

Record:

- workspace ID
- snapshot ID
- machine ID
- provider
- environment fingerprint
- transfer size
- provisioning state
- restore status
- service status
- agent connection status

Logs should not capture secrets.

---

## 28. Failure Scenarios

The MVP should account for:

### VM provisioning failure

Do not transfer ownership.

### File upload failure

Retry safely.

### Environment build failure

Surface the underlying command/output.

### Remote service failure

Show which service failed.

### Lost WebSocket

Agent should reconnect automatically.

### Local workspace changed after push

`relay pull` must detect divergence before applying remote changes.

### Provider outage

Workspace metadata should remain independent of the provider where possible.

---

## 29. Key Technical Challenges

The project should deliberately solve these challenges.

### 29.1 Workspace Representation

Determine exactly what constitutes portable development state.

### 29.2 Cross-Platform Reconstruction

Example:

```text
Source:
macOS ARM

Destination:
Linux x86_64
```

Avoid copying platform-specific runtime artifacts.

### 29.3 Fast Incremental Transfer

Avoid uploading entire projects repeatedly.

Potential future approaches:

- rsync-style delta
- content-addressed storage
- file hashing
- Merkle trees
- compression

### 29.4 Persistent Service Data

Safely transfer or preserve local development database state.

### 29.5 Terminal Reconnection

Allow sessions to survive client disconnects.

### 29.6 Secure Remote Networking

Expose development services without creating unsafe public VMs.

---

## 30. Future Product Opportunities

Once the core workspace portability works, possible extensions include:

### Multiple Cloud Providers

```bash
relay run --provider digitalocean
relay run --provider hetzner
relay run --provider aws
```

### Provider Selection

Choose based on:

- price
- latency
- available CPU
- GPU
- geographic region

### Remote Preview

Automatically expose development servers.

### Background Agents

Allow Codex/Claude to continue working while the developer is offline.

### Snapshot History

```text
10:14 before migration
11:03 after refactor
12:28 before agent run
```

### Fork Workspace

```bash
relay fork experiment-a
```

Useful for agents and parallel experiments.

### Team Handoff

```text
Developer A
     ↓
Workspace
     ↓
Developer B
```

### Agent Handoff

```text
Local Codex
    ↓
cloud workspace
    ↓
Claude Code
```

### Full Runtime Checkpointing

Potential future goal:

```text
filesystem
+
processes
+
memory
```

This would require substantially deeper infrastructure and should not be part of the first build.

---

## 31. Competitive Positioning

Relay should not attempt to outperform Claude Cloud or Codex Cloud at their own agent experiences.

Instead it should operate one layer below them.

### Claude/Codex Cloud

```text
Repository
+
Prepared Environment
+
Agent
```

### Relay

```text
Development State
+
Portable Runtime
+
Any Agent / Shell / Tool
```

Relay's central thesis:

> The development workspace should be portable independently of the agent and independently of the cloud provider.

---

## 32. MVP Acceptance Criteria

The initial project is considered successful when all of the following work reliably:

1. A developer starts with a Git repository locally.
2. The repository contains uncommitted source changes.
3. At least one non-ignored untracked file is present.
4. The project requires PostgreSQL and Redis.
5. The developer runs `relay push`.
6. A remote Linux VM is provisioned.
7. The base repository is restored from Git.
8. Local source deltas are applied.
9. Dependencies are reconstructed remotely.
10. PostgreSQL and Redis are available remotely.
11. Selected persistent data is present.
12. The developer can connect remotely.
13. The project can run and its tests can execute.
14. The developer modifies code remotely.
15. The developer runs `relay pull`.
16. The resulting remote changes are safely applied locally.
17. No Git commit was required purely for the transfer.
18. The VM can be removed without losing the persistent workspace state required for another resume.

---

## 33. Recommended Build Sequence

### Milestone 1 — Compute Lifecycle

- create a remote VM
- bootstrap Ubuntu
- install Relay Agent
- establish agent connection
- destroy VM

### Milestone 2 — Workspace Capture

- detect Git repository
- capture branch/base SHA
- capture dirty state
- capture non-ignored untracked files
- generate Workspace Manifest

### Milestone 3 — Workspace Restore

- clone repository
- checkout base SHA
- apply delta
- verify filesystem

### Milestone 4 — Environment

- Docker support
- runtime detection
- dependency reconstruction
- environment fingerprinting

### Milestone 5 — Terminal

- tmux
- remote command execution
- reconnectable terminal
- `relay connect`

### Milestone 6 — Persistent Services

- PostgreSQL
- Redis
- Docker volumes
- selected persistent paths

### Milestone 7 — Reverse Handoff

- calculate remote delta
- detect local divergence
- `relay pull`

### Milestone 8 — Cost Optimization

- persistent workspace volume
- disposable compute
- `relay sleep`

### Milestone 9 — Security

- proper authentication
- secret separation
- stronger network controls

### Milestone 10 — Second Provider

Implement Hetzner or Vultr to verify the provider abstraction.

---

## 34. Guiding Principle

Every design decision should be evaluated against one question:

> Can a developer leave one machine and continue the same development work elsewhere without first cleaning up, committing, or manually rebuilding the environment?

If the answer becomes reliably yes, Relay has solved its core problem.
