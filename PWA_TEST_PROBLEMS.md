# PWA test problems

Problems and environment blockers reported during testing. These are recorded for later work; they have not been fixed.

## 1. Tables in Codex chat are cramped

**Status:** Open  
**Area:** PWA chat rendering

Tables in Codex responses do not display correctly on the phone: columns become cramped. Make tables horizontally scrollable so their contents remain readable on narrow screens.

## 2. Docker Compose and Buildx are missing on the VM

**Status:** Open  
**Area:** VM tooling

The Docker CLI and daemon are both version 29.1.3. Docker Compose and the Buildx component are not installed, blocking the planned Compose-based container test until they are available.

## 3. PWA Codex cannot use sudo even though SSH can

**Status:** Open / needs a product decision  
**Area:** PWA service and VM administration

The `relay` user can run `sudo -n` over SSH, but the PWA service and its Codex subprocesses inherit `NoNewPrivileges=yes`; sudo cannot elevate within that service. This blocks system package installation from the PWA chat. Docker is usable by the `relay` user through membership in the `docker` group, which itself grants substantial host privileges. Decide how system-level setup should be performed and communicated without assuming the service setting confines Docker access.

## 4. RAG app initially failed to start due to file permissions

**Status:** Observed; current container recovered  
**Area:** RAG test container

During the first build, the app container restarted with `PermissionError` reading `/app/app/__init__.py`. The active Codex chat subsequently rebuilt/restarted it; the app then became healthy and its local `/health` endpoint returned `status: ok`. Verify the correction persists on a clean rebuild during the end-to-end test.

## Monitor: qdrant — 2026-11-07 21:53:56 UTC

**Status:** Observed  
**Area:** Automated one-minute health check

The Qdrant container or its local readiness endpoint is unavailable (it may have been stopped intentionally). The check failed twice consecutively.

## Monitor: rag_app — 2026-11-07 21:53:56 UTC

**Status:** Observed  
**Area:** Automated one-minute health check

The RAG application container or its local health endpoint is unavailable (it may have been stopped intentionally). The check failed twice consecutively.

**Follow-up:** Both containers were stopped after phone testing. These alerts establish that the services were stopped; they do not establish an application failure. The monitor was stopped at the user's request before the PC import.

## 5. Qdrant snapshot is included in the Docker build context

**Status:** Open  
**Area:** RAG test application / container build

The RAG workspace has a `.backups/` directory containing a roughly 164 MiB Qdrant snapshot, but its `.dockerignore` excludes `backups` and not `.backups`. Docker or Podman builds can therefore send that database snapshot in the build context, increasing build time and potentially exposing its contents to a remote builder. Exclude `.backups/` from the build context and verify a rebuild; the snapshot should remain included in Relay workspace transfers.

## 6. RAG app notifications cover controls on a narrow screen

**Status:** Open  
**Area:** RAG test application / mobile UI

At a 390 × 844 viewport, the ingestion and answer notifications can stack over the question button and part of the results. They are dismissible and success notifications expire, but important controls are temporarily obscured. Check notification placement and stacking on small screens.

## 7. RAG app requests a missing favicon

**Status:** Open  
**Area:** RAG test application / browser console

The app returns HTTP 404 for `/favicon.ico`. The main UI and retrieval flow still work, but the browser can report a failed-resource console message and the app has no favicon.

## 8. RAG Compose bind mounts fail under rootless Podman with SELinux

**Status:** Open  
**Area:** RAG test application / PC portability

On the Fedora PC with SELinux enforcing and rootless `podman-compose`, the imported Compose configuration started the app but Qdrant repeatedly failed with `Permission denied` on its bind-mounted storage, and `/health` returned HTTP 503. In a separate scratch copy, adding private `:Z` labels to both data bind mounts and `userns_mode: keep-id` to the app service allowed both containers to start; the ingestion, retrieval and browser checks then passed. This test does not establish behavior under Docker Compose or on the VM. Keep the imported project unchanged until the portability fix is reviewed.

## 9. Podman OCI builds discard the RAG image health check

**Status:** Open / environment-specific  
**Area:** RAG test application / PC portability

The PC's default Podman build used OCI format and reported that the Dockerfile `HEALTHCHECK` was ignored. Building the same image with `podman build --format docker` retained the instruction without that warning. The VM's Docker behavior is a separate test.

## 10. RAG README hard-codes the VM workspace path

**Status:** Open  
**Area:** RAG test application / PC portability

The imported project's README says to run every command from `/home/relay/rag-lab` and repeats that path in examples. On the PC the imported workspace is elsewhere, so those instructions cannot be followed verbatim. Make examples relative to the current project directory and document the destination runtime prerequisites.
