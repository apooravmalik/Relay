import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile as execFileCallback } from 'node:child_process';

const execFile = promisify(execFileCallback);
const maxPreviewBytes = 512 * 1024;
export const maxUploadBytes = 10 * 1024 * 1024;
const defaultRegistryFile = path.join(process.env.HOME || '/tmp', '.relay-v0', 'controller', 'workspaces.json');

export function parseWorkspaceRoots(value = '') {
  if (!value) return [];
  return [...new Set(value.split(path.delimiter).map((entry) => entry.trim()).filter(Boolean))]
    .map((entry) => {
      if (!path.isAbsolute(entry)) throw new Error(`Workspace path must be absolute: ${entry}`);
      return entry;
    });
}

export function parseProjectRoots(value = '') {
  return parseWorkspaceRoots(value);
}

function registryFile() {
  return process.env.RELAY_WORKSPACE_REGISTRY_FILE || defaultRegistryFile;
}

async function registeredWorkspaceRoots(file = registryFile()) {
  try {
    const value = JSON.parse(await readFile(file, 'utf8'));
    return Array.isArray(value?.roots) ? value.roots.filter((root) => typeof root === 'string' && path.isAbsolute(root)) : [];
  } catch {
    return [];
  }
}

async function saveRegisteredWorkspaceRoots(roots, file = registryFile()) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ roots })}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, file);
}

export async function configuredWorkspaceRoots({ roots, registry } = {}) {
  const configured = roots ?? parseWorkspaceRoots(process.env.RELAY_WORKSPACE_ROOTS);
  const registered = await registeredWorkspaceRoots(registry);
  return [...new Set([...configured, ...registered])];
}

function safeRelativePath(value = '') {
  const parts = typeof value === 'string' ? value.split(/[\\/]+/).filter(Boolean) : [];
  if (typeof value !== 'string' || value.includes('\0') || path.isAbsolute(value) || parts.some((part) => part === '..' || part.startsWith('.'))) {
    throw new Error('Invalid directory path.');
  }
  return value === '.' ? '' : value;
}

function isWithin(root, candidate) {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

async function canonicalProjectRoot(root) {
  const canonical = await realpath(root);
  if (!(await stat(canonical)).isDirectory()) throw new Error('Project root is not a directory.');
  return canonical;
}

async function configuredProjectRoots(roots = parseProjectRoots(process.env.RELAY_PROJECT_ROOTS)) {
  const results = [];
  for (const root of roots) {
    try {
      const canonical = await canonicalProjectRoot(root);
      results.push({ id: workspaceId(canonical), name: displayName(canonical), path: canonical });
    } catch {
      // A misconfigured or unavailable root is never exposed to the client.
    }
  }
  return results;
}

async function projectDirectory(rootId, relativePath = '', roots) {
  const root = (await configuredProjectRoots(roots)).find((entry) => entry.id === rootId);
  if (!root) throw new Error('Project folder is not available.');
  const candidate = await realpath(path.resolve(root.path, safeRelativePath(relativePath)));
  if (!isWithin(root.path, candidate)) throw new Error('Directory is outside the selected project root.');
  if (!(await stat(candidate)).isDirectory()) throw new Error('Selected path is not a directory.');
  return { ...root, directory: candidate };
}

export async function listProjectRoots(roots) {
  return (await configuredProjectRoots(roots)).map(({ id, name }) => ({ id, name }));
}

export async function listProjectDirectories(rootId, relativePath = '', roots) {
  const selected = await projectDirectory(rootId, relativePath, roots);
  const directories = [];
  for (const entry of await readdir(selected.directory, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    try {
      const target = await realpath(path.join(selected.directory, entry.name));
      if (isWithin(selected.path, target) && (await stat(target)).isDirectory()) {
        directories.push({ name: entry.name, path: path.relative(selected.path, target) });
      }
    } catch {
      // Skip entries that disappear or cannot be safely resolved.
    }
  }
  return {
    root: { id: selected.id, name: selected.name, path: selected.path },
    path: path.relative(selected.path, selected.directory),
    directories: directories.sort((left, right) => left.name.localeCompare(right.name)),
  };
}

function projectName(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(value) || value === '.' || value === '..') {
    throw new Error('Project name must use letters, numbers, dots, dashes, or underscores.');
  }
  return value;
}

async function registerWorkspacePath(directory, registry) {
  const workspace = await inspectWorkspace(directory);
  const roots = await registeredWorkspaceRoots(registry);
  if (!roots.includes(directory)) await saveRegisteredWorkspaceRoots([...roots, directory], registry);
  return workspace;
}

export async function openDirectory({ rootId, path: relativePath = '', roots, registry } = {}) {
  const selected = await projectDirectory(rootId, relativePath, roots);
  return registerWorkspacePath(selected.directory, registry);
}

export async function createDirectory({ rootId, parentPath = '', name, roots, registry } = {}) {
  const parent = await projectDirectory(rootId, parentPath, roots);
  const directory = path.join(parent.directory, projectName(name));
  if (!isWithin(parent.path, directory)) throw new Error('Directory is outside the selected project root.');
  await mkdir(directory, { mode: 0o700 });
  return registerWorkspacePath(await realpath(directory), registry);
}

function uploadFileName(value) {
  const name = typeof value === 'string' ? value.normalize('NFC').trim() : '';
  if (!name || name.length > 120 || name !== path.basename(name) || name.startsWith('.') || /[\0-\x1f]/.test(name)) {
    throw new Error('Invalid upload filename.');
  }
  return name;
}

export async function saveWorkspaceUpload(workspacePath, { name, content } = {}) {
  if (!Buffer.isBuffer(content) || !content.length) throw new Error('Upload is empty.');
  if (content.length > maxUploadBytes) throw new Error('Upload is too large. Files must be 10 MB or smaller.');
  const root = await realpath(workspacePath);
  const uploadDirectory = path.join(root, 'uploads');
  await mkdir(uploadDirectory, { recursive: true, mode: 0o700 });
  const canonicalUploadDirectory = await realpath(uploadDirectory);
  if (!isWithin(root, canonicalUploadDirectory) || !(await stat(canonicalUploadDirectory)).isDirectory()) {
    throw new Error('Upload directory is not available.');
  }
  const fileName = uploadFileName(name);
  const extension = path.extname(fileName);
  const stem = extension ? fileName.slice(0, -extension.length) : fileName;
  for (let index = 0; index < 100; index += 1) {
    const candidateName = index ? `${stem}-${index + 1}${extension}` : fileName;
    const candidate = path.join(canonicalUploadDirectory, candidateName);
    try {
      await writeFile(candidate, content, { mode: 0o600, flag: 'wx' });
      return { name: candidateName, path: path.relative(root, candidate), size: content.length };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
  throw new Error('Too many files with this name already exist. Rename the file and try again.');
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

async function workspaceDirectory(workspacePath, relativePath = '') {
  const root = await realpath(workspacePath);
  const directory = await realpath(path.resolve(root, safeRelativePath(relativePath)));
  if (!isWithin(root, directory) || !(await stat(directory)).isDirectory()) throw new Error('Directory is not available in this workspace.');
  return { root, directory };
}

export async function listWorkspaceFiles(workspacePath, relativePath = '') {
  const selected = await workspaceDirectory(workspacePath, relativePath);
  const entries = [];
  for (const entry of await readdir(selected.directory, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || isSensitivePath(entry.name)) continue;
    try {
      const target = await realpath(path.join(selected.directory, entry.name));
      const metadata = await stat(target);
      if (!isWithin(selected.root, target) || (!metadata.isDirectory() && !metadata.isFile())) continue;
      entries.push({ kind: metadata.isDirectory() ? 'directory' : 'file', name: entry.name, path: path.relative(selected.root, target) });
    } catch {
      // Entries that disappear or resolve outside the workspace are never exposed.
    }
  }
  return {
    path: path.relative(selected.root, selected.directory),
    entries: entries.sort((left, right) => left.kind === right.kind ? left.name.localeCompare(right.name) : left.kind === 'directory' ? -1 : 1),
  };
}

export async function workspaceBrowseFile(workspacePath, relativePath) {
  if (isSensitivePath(relativePath || '')) throw new Error('Sensitive files are not available in Relay.');
  const root = await realpath(workspacePath);
  const candidate = await realpath(path.resolve(root, safeRelativePath(relativePath)));
  if (!isWithin(root, candidate)) throw new Error('Invalid file path.');
  const metadata = await stat(candidate);
  if (!metadata.isFile() || metadata.size > maxPreviewBytes) throw new Error('File is too large for mobile preview.');
  const content = await readFile(candidate);
  if (content.includes(0)) throw new Error('Binary files cannot be previewed.');
  return { path: path.relative(root, candidate), content: content.toString('utf8') };
}

function statusEntries(statusOutput, untrackedOutput) {
  const records = statusOutput.split('\0');
  const changes = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) continue;
    const status = record.slice(0, 2);
    if (status === '??') continue;
    const relativePath = changedPath(record);
    if ((status.includes('R') || status.includes('C')) && records[index + 1]) {
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
  const gitAvailable = await gitOrNull(canonicalPath, ['rev-parse', '--is-inside-work-tree']) === 'true';
  if (!gitAvailable) {
    return {
      id: workspaceId(canonicalPath),
      name: displayName(canonicalPath),
      branch: null,
      changedFileCount: null,
      gitAvailable: false,
      handoffReady: false,
      status: 'ready',
    };
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
    gitAvailable: true,
    handoffReady: Boolean(handoffRef),
    status: 'ready',
  };
}

export async function listWorkspaces(roots) {
  const workspaceRoots = roots ?? await configuredWorkspaceRoots();
  const results = await Promise.all(workspaceRoots.map(async (root) => {
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

export async function findWorkspace(id, roots) {
  const workspaceRoots = roots ?? await configuredWorkspaceRoots();
  for (const root of workspaceRoots) {
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
  if (await gitOrNull(workspacePath, ['rev-parse', '--is-inside-work-tree']) !== 'true') return [];
  const [status, untracked] = await Promise.all([
    git(workspacePath, ['status', '--porcelain=v1', '-z']),
    git(workspacePath, ['ls-files', '--others', '--exclude-standard', '-z']),
  ]);
  return statusEntries(status, untracked);
}

async function checkedChangedPath(workspacePath, relativePath) {
  if (typeof relativePath !== 'string' || !relativePath || path.isAbsolute(relativePath) || relativePath.split(/[\\/]+/).includes('..')) {
    throw new Error('Invalid file path.');
  }
  if (isSensitivePath(relativePath)) throw new Error('Sensitive files are not available in Relay.');
  const changes = await workspaceChanges(workspacePath);
  if (!changes.some((change) => change.path === relativePath && change.previewAllowed)) throw new Error('File is not available for preview.');
  return realpath(workspacePath);
}

async function checkedChangedFile(workspacePath, relativePath) {
  const canonicalRoot = await checkedChangedPath(workspacePath, relativePath);
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
  await checkedChangedPath(workspacePath, relativePath);
  const [staged, unstaged] = await Promise.all([
    gitOrNull(workspacePath, ['diff', '--cached', '--no-ext-diff', '--no-textconv', '--unified=3', '--', relativePath]),
    gitOrNull(workspacePath, ['diff', '--no-ext-diff', '--no-textconv', '--unified=3', '--', relativePath]),
  ]);
  if (staged || unstaged) {
    const diff = [staged && `Staged changes:\n${staged}`, unstaged && `Unstaged changes:\n${unstaged}`].filter(Boolean).join('\n\n');
    return { path: relativePath, diff };
  }
  const file = await workspaceFile(workspacePath, relativePath);
  return { path: relativePath, diff: `New file: ${relativePath}\n\n${file.content}` };
}
