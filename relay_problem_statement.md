# Relay — Problem Statement

## 1. Problem

Modern software development is increasingly split across local machines, cloud environments, remote terminals, and AI coding agents such as Codex and Claude Code.

Git solves one part of this workflow well: synchronizing committed source code. Cloud development environments solve another part: creating a clean remote development machine from a repository.

What is still poorly solved is the transfer of the **live development state** of a developer's current workspace.

A developer may be several hours into a task with:

- uncommitted and staged changes
- untracked files
- a specific branch and base commit
- locally running services
- Docker containers and volumes
- PostgreSQL, Redis, Elasticsearch, MinIO, or other local state
- runtime versions and project dependencies
- open ports
- agent instructions such as `AGENTS.md` or `CLAUDE.md`
- Codex, Claude Code, or other CLI tooling
- local development configuration
- temporary scripts and debugging artifacts

If the developer leaves their primary machine, existing tools usually require one of the following:

1. commit and push the work to Git
2. recreate the development environment elsewhere
3. manually copy files
4. rebuild local databases/services
5. restart the agent session from incomplete context
6. leave the original laptop powered on and remotely connect to it

This creates friction exactly when developers increasingly expect work to move seamlessly between local and cloud execution.

## 2. Existing Solutions and Their Limitation

Products such as Claude Code Cloud, Codex Cloud, GitHub Codespaces, Coder, DevPod, Daytona, E2B, and other remote-development platforms solve substantial portions of remote execution.

Most of them are primarily optimized around one of these models:

```text
Git Repository
      ↓
Create Cloud Environment
      ↓
Install/Recreate Dependencies
      ↓
Run Developer or Agent
```

or:

```text
Prepared Environment Template
      ↓
Fresh Cloud Workspace
      ↓
Run Task
```

The missing primitive is:

```text
LIVE LOCAL DEVELOPMENT STATE
          ↓
      CAPTURE
          ↓
      TRANSFER
          ↓
LIVE REMOTE DEVELOPMENT STATE
```

The remote workspace should not merely contain the same repository. It should represent the developer's **current working state** closely enough that development can continue without reconstructing the task manually.

## 3. Core Problem Statement

> Developers can synchronize committed code with Git and recreate environments with Docker or devcontainers, but there is no simple, vendor-neutral way to transfer an active development workspace — including dirty source state, selected local service data, environment metadata, and agent configuration — from a local machine to disposable cloud compute and continue working from another device.

The problem becomes especially relevant with coding agents.

A developer may start a Codex or Claude Code task locally, need to leave their machine, and want that work to continue on cloud compute while still retaining control from a phone, laptop, browser terminal, or SSH client.

The goal is not to create another coding agent.

The goal is to make the **development workspace portable**.

## 4. Proposed Solution

Relay is a portable development-state runtime.

A developer runs:

```bash
relay push
```

Relay captures the current workspace state, provisions or resumes a remote development machine, reconstructs the environment, transfers only the required local delta and persistent state, and provides remote terminal access.

Conceptually:

```text
Developer Laptop
│
├── Git repository
├── uncommitted changes
├── untracked files
├── environment definition
├── selected local service state
├── agent configuration
└── runtime metadata
        │
        │ relay push
        ▼
Relay Control Plane
        │
        ▼
Remote Compute
│
├── reconstructed workspace
├── persistent data
├── Docker/services
├── Codex / Claude / shell
└── remote PTY
        │
        ├── phone
        ├── browser
        ├── laptop
        └── SSH/CLI
```

When the developer returns to the original machine:

```bash
relay pull
```

Relay synchronizes the remote changes back.

## 5. Product Principle

Relay should treat **compute as disposable** and **workspace state as persistent**.

The VM is not the product.

The persistent development state is the product.

A workspace can therefore move between:

- local machine
- DigitalOcean
- Hetzner
- AWS
- Vultr
- another supported provider
- eventually self-hosted infrastructure

without the workspace being conceptually tied to a particular VM.

## 6. Primary Use Case

A developer is working locally with:

- modified files
- an untracked debugging script
- PostgreSQL
- Redis
- a running application
- Codex or Claude Code

They need to leave their computer.

They run:

```bash
relay push
```

Relay:

1. identifies the base Git commit
2. captures staged, unstaged, and selected untracked changes
3. identifies the environment definition
4. captures selected persistent service data
5. provisions or resumes remote compute
6. reconstructs the environment
7. restores the workspace
8. launches required services
9. exposes a remote terminal
10. allows the coding agent to continue

The developer can then connect from another device.

Later:

```bash
relay pull
```

returns the resulting code changes to the local workspace.

## 7. What Relay Is Not

Relay is not intended to be:

- another AI coding model
- an AI code reviewer
- a replacement for Git
- a Git hosting platform
- another full IDE
- a replacement for Docker
- an ERP-like developer platform
- a generic CI/CD system
- a Claude-only or Codex-only product

Relay should complement these tools.

Git stores durable source history.

Docker/devcontainers describe reproducible environments.

Relay transfers the **active working development state**.

## 8. Core Differentiation

The main differentiator is deeper state continuity.

Relay should eventually support:

```text
Source State
+
Environment Definition
+
Selected Persistent Data
+
Service Topology
+
Agent Configuration
+
Runtime Metadata
```

instead of only:

```text
Repository
+
Setup Script
```

The project should remain vendor-neutral so the same workspace may run:

- Codex
- Claude Code
- shell tools
- test processes
- development servers
- other CLI agents

## 9. MVP Success Definition

The first successful version should prove one narrow workflow:

> A developer with a dirty local Node.js project using PostgreSQL and Redis can run `relay push`, move the workspace to a fresh Linux VM without committing the code, SSH/connect to the remote workspace, run the project successfully with the transferred development state, make further changes remotely, and later run `relay pull` to continue locally.

If this workflow is reliable, the project has demonstrated the core technical idea.

## 10. Long-Term Vision

Relay could evolve into a general development-state portability layer.

Potential future capabilities include:

- provider-independent execution
- content-addressed workspace storage
- instant environment restoration
- volume snapshotting
- browser-based terminal access
- remote preview URLs
- managed secrets
- network egress policy
- multiple concurrent workspaces
- VM/microVM checkpointing
- full process-state restoration
- self-hosted execution
- team collaboration
- workspace handoffs between humans and coding agents
- multiple AI agents operating in the same portable environment

The long-term concept can be summarized as:

> Git moves code. Relay moves the development workspace.
