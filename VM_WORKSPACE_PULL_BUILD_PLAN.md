# Workspace pull build plan

Goal: import a VM-created registered workspace into a new local project directory, including uncommitted work, without changing the VM repository or an existing local project.

The current file and database selection policy is described in
[VM_WORKSPACE_DATA_POLICY.md](VM_WORKSPACE_DATA_POLICY.md); it supersedes the
original design's exclusion of secrets and runtime data.

1. Resolve PWA workspace IDs on the VM; keep the legacy patch pull intact and reject mixed options.
2. Capture selected files in private export storage, detect changes across capture, and disclose exclusions and unsupported states. Users must pause independent writers during capture.
3. For Git workspaces, export the checked-out commit ancestry and preserve the exact index and working files separately, including unborn branches; reject Git states that cannot be faithfully reconstructed.
4. Transfer the sealed export over SSH into private local staging, validate its manifest, reconstruct Git with safe settings, and publish with an atomic no-replace rename.
5. Record a local receipt, support recovery of interrupted transfers, and exercise plain and Git imports, conflicts, corruption and legacy behavior in integration tests.

The protocol must fail closed where a guarantee is unavailable; no import should replace an existing path or publish a partially verified project. The detailed design and additional release criteria remain in VM_WORKSPACE_PULL_IMPLEMENTATION.md.
