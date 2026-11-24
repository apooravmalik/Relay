import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';
import { SessionError } from './session-store.mjs';

export async function assertTransferIdle(workspaceId, checkpointRoot = path.join(homedir(), '.relay-v0/checkpoints')) {
  // Python transfer checkpoints live under HOME independently of the controller DB override.
  const root = path.join(checkpointRoot, workspaceId);
  let files;
  try { files = await readdir(root); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  for (const name of files.filter((file) => file.endsWith('.json'))) {
    let data;
    try { data = JSON.parse(await readFile(path.join(root, name), 'utf8')); }
    catch { throw new SessionError('Workspace checkpoint cannot be inspected. Recover the handoff first.'); }
    if (data.pending) throw new SessionError('Workspace has a pending handoff. Resume or recover it before starting a task.');
  }
}
