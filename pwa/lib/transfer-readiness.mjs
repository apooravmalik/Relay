import { lstat, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';
import { SessionError } from './session-store.mjs';

export async function assertTransferIdle(workspaceId, workspacePath, checkpointRoot = path.join(homedir(), '.relay-v0/checkpoints')) {
  // Python transfer checkpoints live under HOME independently of the controller DB override.
  if (!path.isAbsolute(workspacePath)) throw new SessionError('Workspace path cannot be verified.');
  let directories;
  try {
    const info = await lstat(checkpointRoot);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new SessionError('Checkpoint directory cannot be verified.');
    directories = await readdir(checkpointRoot, { withFileTypes: true });
  } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  for (const directory of directories) {
    if (directory.isSymbolicLink()) throw new SessionError('Checkpoint directory cannot be verified.');
    if (!directory.isDirectory()) continue;
    const root = path.join(checkpointRoot, directory.name);
    let files;
    try { files = await readdir(root); }
    catch { throw new SessionError('Workspace checkpoint cannot be inspected. Recover the handoff first.'); }
    for (const name of files.filter((file) => file.endsWith('.json'))) {
      let data;
      try {
        const file = path.join(root, name), info = await lstat(file);
        if (!info.isFile() || info.isSymbolicLink()) throw new Error('Invalid checkpoint file.');
        data = JSON.parse(await readFile(file, 'utf8'));
      }
      catch { throw new SessionError('Workspace checkpoint cannot be inspected. Recover the handoff first.'); }
      if (!data.pending) continue;
      const pendingPath = data.pending.source_path;
      if (data.pending.workspace_id !== directory.name || typeof pendingPath !== 'string' || !path.isAbsolute(pendingPath)) throw new SessionError('Pending handoff path cannot be verified. Recover the handoff first.');
      const inside = (parent, child) => { const relative = path.relative(parent, child); return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)); };
      if (directory.name === workspaceId || inside(workspacePath, pendingPath) || inside(pendingPath, workspacePath)) throw new SessionError('Workspace or overlapping workspace has a pending handoff. Resume or recover it before starting a task.');
    }
  }
}
