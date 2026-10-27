import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile as execFileCallback } from 'node:child_process';

const execFile = promisify(execFileCallback);
const maxPreviewBytes = 512 * 1024;

export function parseWorkspaceRoots(value = '') {
  if (!value) return [];
  return [...new Set(value.split(path.delimiter).map((entry) => entry.trim()).filter(Boolean))]
    .map((entry) => {
      if (!path.isAbsolute(entry)) throw new Error(`Workspace path must be absolute: ${entry}`);
      return entry;
    });
}

export function countPorcelainRecords(output) {
  const records = output.split('\0');
  let count = 0;
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) continue;
    count += 1;
    if (record.length >= 2 && (record[0] === 'R' || record[0] === 'C' || record[1] === 'R' || record[1] === 'C')) index += 1;
  }
  return count;
}

async function git(cwd, args) {
  const { stdout } = await execFile('git', ['--no-optional-locks', '-C', cwd, ...args], {
    encoding: 'utf8',
    maxBuffer: maxPreviewBytes * 2,
  });
  return stdout.trimEnd();
}

async function gitOrNull(cwd, args) {
  try {
    return await git(cwd, args);
  } catch {
    return null;
  }
}

function workspaceId(canonicalPath) {
  return createHash('sha256').update(canonicalPath).digest('hex').slice(0, 16);
}

function displayName(canonicalPath) {
  return path.basename(canonicalPath).replace(/[_-]+/g, ' ');
}

function changedPath(record) {
  return record.length > 3 ? record.slice(3) : '';
}

function isSensitivePath(relativePath) {
  const base = path.basename(relativePath).toLowerCase();
  return base === '.env' || base.startsWith('.env.') || base.endsWith('.pem') || base.endsWith('.key') || base.startsWith('id_');
}

function statusEntries(statusOutput, untrackedOutput) {
  const records = statusOutput.split('\0');
  const changes = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) continue;
    const status = record.slice(0, 2);
    if (status === '??') continue;
    let relativePath = changedPath(record);
    if ((status.includes('R') || status.includes('C')) && records[index + 1]) {
      relativePath = records[index + 1];
      index += 1;
    }
    if (relativePath) changes.push({ path: relativePath, status, previewAllowed: !isSensitivePath(relativePath) });
  }
  for (const relativePath of untrackedOutput.split('\0')) {
    if (relativePath) changes.push({ path: relativePath, status: '??', previewAllowed: !isSensitivePath(relativePath) });
  }
  return changes.sort((left, right) => left.path.localeCompare(right.path));
}

export async function inspectWorkspace(root) {
  const canonicalPath = await realpath(root);
  const metadata = await stat(canonicalPath);
  if (!metadata.isDirectory()) throw new Error(`Workspace is not a directory: ${root}`);
  if (await gitOrNull(canonicalPath, ['rev-parse', '--is-inside-work-tree']) !== 'true') {
    throw new Error(`Workspace is not a Git repository: ${canonicalPath}`);
  }
  const [branch, status, handoffRef, untracked] = await Promise.all([
    gitOrNull(canonicalPath, ['symbolic-ref', '--short', 'HEAD']),
    git(canonicalPath, ['status', '--porcelain=v1', '-z']),
    gitOrNull(canonicalPath, ['rev-parse', '--verify', '--quiet', 'refs/relay/synced']),
    git(canonicalPath, ['ls-files', '--others', '--exclude-standard', '-z']),
  ]);
  return {
    id: workspaceId(canonicalPath),
    name: displayName(canonicalPath),
    branch: branch || 'detached HEAD',
    changedFileCount: statusEntries(status, untracked).length,
    handoffReady: Boolean(handoffRef),
    status: 'ready',
  };
}

export async function listWorkspaces(roots = parseWorkspaceRoots(process.env.RELAY_WORKSPACE_ROOTS)) {
  const results = await Promise.all(roots.map(async (root) => {
    try {
      return await inspectWorkspace(root);
    } catch {
      return {
        id: createHash('sha256').update(root).digest('hex').slice(0, 16),
        name: displayName(root),
        changedFileCount: null,
        handoffReady: false,
        status: 'unavailable',
        error: 'Workspace is unavailable on this VM.',
      };
    }
  }));
  return results.sort((left, right) => left.name.localeCompare(right.name));
}

export async function findWorkspace(id, roots = parseWorkspaceRoots(process.env.RELAY_WORKSPACE_ROOTS)) {
  for (const root of roots) {
    try {
      const canonicalPath = await realpath(root);
      if (workspaceId(canonicalPath) === id) return { ...(await inspectWorkspace(canonicalPath)), path: canonicalPath };
    } catch {
      // Unavailable workspaces are intentionally never addressable through file APIs.
    }
  }
  return null;
}

export async function workspaceChanges(workspacePath) {
  const [status, untracked] = await Promise.all([
    git(workspacePath, ['status', '--porcelain=v1', '-z']),
    git(workspacePath, ['ls-files', '--others', '--exclude-standard', '-z']),
  ]);
  return statusEntries(status, untracked);
}

async function checkedChangedFile(workspacePath, relativePath) {
  if (typeof relativePath !== 'string' || !relativePath || path.isAbsolute(relativePath) || relativePath.split(/[\\/]+/).includes('..')) {
    throw new Error('Invalid file path.');
  }
  if (isSensitivePath(relativePath)) throw new Error('Sensitive files are not available in Relay.');
  const changes = await workspaceChanges(workspacePath);
  if (!changes.some((change) => change.path === relativePath && change.previewAllowed)) throw new Error('File is not available for preview.');
  const canonicalRoot = await realpath(workspacePath);
  const candidate = path.resolve(canonicalRoot, relativePath);
  const canonical = await realpath(candidate);
  if (!canonical.startsWith(`${canonicalRoot}${path.sep}`)) throw new Error('Invalid file path.');
  const metadata = await stat(canonical);
  if (!metadata.isFile() || metadata.size > maxPreviewBytes) throw new Error('File is too large for mobile preview.');
  return canonical;
}

export async function workspaceFile(workspacePath, relativePath) {
  const filePath = await checkedChangedFile(workspacePath, relativePath);
  const content = await readFile(filePath);
  if (content.includes(0)) throw new Error('Binary files cannot be previewed.');
  return { path: relativePath, content: content.toString('utf8') };
}

export async function workspaceDiff(workspacePath, relativePath) {
  await checkedChangedFile(workspacePath, relativePath);
  const output = await gitOrNull(workspacePath, ['diff', '--no-ext-diff', '--unified=3', '--', relativePath]);
  if (output) return { path: relativePath, diff: output };
  const file = await workspaceFile(workspacePath, relativePath);
  return { path: relativePath, diff: `New file: ${relativePath}\n\n${file.content}` };
}
