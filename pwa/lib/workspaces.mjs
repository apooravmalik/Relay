import { createHash } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile as execFileCallback } from 'node:child_process';

const execFile = promisify(execFileCallback);

export function parseWorkspaceRoots(value = '') {
  if (!value) return [];

  return [...new Set(value.split(path.delimiter).map((entry) => entry.trim()).filter(Boolean))]
    .map((entry) => {
      if (!path.isAbsolute(entry)) {
        throw new Error(`Workspace path must be absolute: ${entry}`);
      }
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
    if (record.length >= 2 && (record[0] === 'R' || record[0] === 'C' || record[1] === 'R' || record[1] === 'C')) {
      index += 1;
    }
  }

  return count;
}

async function git(cwd, args) {
  const { stdout } = await execFile('git', ['--no-optional-locks', '-C', cwd, ...args], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
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

export async function inspectWorkspace(root) {
  const canonicalPath = await realpath(root);
  const metadata = await stat(canonicalPath);
  if (!metadata.isDirectory()) throw new Error(`Workspace is not a directory: ${root}`);

  const isGitRepository = await gitOrNull(canonicalPath, ['rev-parse', '--is-inside-work-tree']);
  if (isGitRepository !== 'true') throw new Error(`Workspace is not a Git repository: ${canonicalPath}`);

  const [branch, status, handoffRef] = await Promise.all([
    gitOrNull(canonicalPath, ['symbolic-ref', '--short', 'HEAD']),
    git(canonicalPath, ['status', '--porcelain=v1', '-z']),
    gitOrNull(canonicalPath, ['rev-parse', '--verify', '--quiet', 'refs/relay/synced']),
  ]);

  return {
    id: workspaceId(canonicalPath),
    name: displayName(canonicalPath),
    branch: branch || 'detached HEAD',
    changedFileCount: countPorcelainRecords(status),
    handoffReady: Boolean(handoffRef),
    status: 'ready',
  };
}

export async function listWorkspaces(roots = parseWorkspaceRoots(process.env.RELAY_WORKSPACE_ROOTS)) {
  const results = await Promise.all(roots.map(async (root) => {
    try {
      return await inspectWorkspace(root);
    } catch (error) {
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
