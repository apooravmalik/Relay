import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import {
  countPorcelainRecords,
  createDirectory,
  inspectWorkspace,
  listProjectDirectories,
  listProjectRoots,
  listWorkspaceFiles,
  parseWorkspaceRoots,
  openDirectory,
  saveWorkspaceUpload,
  workspaceFile,
  workspaceBrowseFile,
  workspaceChanges,
  workspaceDiff,
} from '../lib/workspaces.mjs';

const run = promisify(execFile);

test('parseWorkspaceRoots accepts only unique absolute paths', () => {
  const separator = path.delimiter;
  assert.deepEqual(parseWorkspaceRoots(`/one${separator}/two${separator}/one`), ['/one', '/two']);
  assert.throws(() => parseWorkspaceRoots('relative/path'), /must be absolute/);
});

test('countPorcelainRecords treats a rename as one changed file', () => {
  assert.equal(countPorcelainRecords(' M readme.md\0?? new.md\0R  old.md\0new.md\0'), 3);
});

test('inspectWorkspace returns only safe Git metadata', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'relay-workspace-test-'));
  await run('git', ['init', root]);
  await run('git', ['-C', root, 'config', 'user.email', 'relay-test@example.invalid']);
  await run('git', ['-C', root, 'config', 'user.name', 'Relay Test']);
  await writeFile(path.join(root, 'tracked.txt'), 'base\n');
  await run('git', ['-C', root, 'add', 'tracked.txt']);
  await run('git', ['-C', root, 'commit', '-m', 'base']);
  await writeFile(path.join(root, 'tracked.txt'), 'changed\n');
  await mkdir(path.join(root, 'nested'));
  await writeFile(path.join(root, 'nested', 'new.txt'), 'new\n');

  const workspace = await inspectWorkspace(root);
  assert.match(workspace.branch, /^(main|master)$/);
  assert.equal(workspace.changedFileCount, 2);
  assert.equal(workspace.status, 'ready');
  assert.equal(workspace.gitAvailable, true);
  assert.equal(typeof workspace.id, 'string');
  assert.equal('path' in workspace, false);
});

test('inspectWorkspace accepts a plain directory for Codex', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'relay-plain-workspace-test-'));
  const workspace = await inspectWorkspace(root);
  assert.equal(workspace.status, 'ready');
  assert.equal(workspace.gitAvailable, false);
  assert.equal(workspace.branch, null);
  assert.equal(workspace.changedFileCount, null);
});

test('workspace file preview cannot read a secret or escape the changed workspace', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'relay-preview-test-'));
  await run('git', ['init', root]);
  await writeFile(path.join(root, 'safe.txt'), 'safe\n');
  await writeFile(path.join(root, '.env'), 'SECRET=not-for-preview\n');

  await assert.doesNotReject(() => workspaceFile(root, 'safe.txt'));
  await assert.rejects(() => workspaceFile(root, '.env'), /Sensitive files/);
  await assert.rejects(() => workspaceFile(root, '../outside.txt'), /Invalid file path/);
});

test('workspace change list expands an untracked directory into files', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'relay-untracked-test-'));
  await run('git', ['init', root]);
  await mkdir(path.join(root, 'new-directory'));
  await writeFile(path.join(root, 'new-directory', 'visible.txt'), 'visible\n');
  const workspace = await inspectWorkspace(root);
  assert.equal(workspace.changedFileCount, 1);
  await assert.doesNotReject(() => workspaceFile(root, 'new-directory/visible.txt'));
});

test('renamed and staged files show their current name and staged diff', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'relay-rename-test-'));
  await run('git', ['init', root]);
  await run('git', ['-C', root, 'config', 'user.email', 'relay-test@example.invalid']);
  await run('git', ['-C', root, 'config', 'user.name', 'Relay Test']);
  await writeFile(path.join(root, 'old.txt'), 'before\n');
  await run('git', ['-C', root, 'add', 'old.txt']);
  await run('git', ['-C', root, 'commit', '-m', 'base']);
  await run('git', ['-C', root, 'mv', 'old.txt', 'new.txt']);
  assert.deepEqual((await workspaceChanges(root)).map((change) => change.path), ['new.txt']);
  assert.equal((await workspaceFile(root, 'new.txt')).content, 'before\n');
  assert.match((await workspaceDiff(root, 'new.txt')).diff, /diff --git/);
});

test('staged and unstaged edits both appear in the diff preview', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'relay-diff-test-'));
  await run('git', ['init', root]);
  await run('git', ['-C', root, 'config', 'user.email', 'relay-test@example.invalid']);
  await run('git', ['-C', root, 'config', 'user.name', 'Relay Test']);
  await writeFile(path.join(root, 'file.txt'), 'original\n');
  await run('git', ['-C', root, 'add', 'file.txt']);
  await run('git', ['-C', root, 'commit', '-m', 'base']);
  await writeFile(path.join(root, 'file.txt'), 'staged\n');
  await run('git', ['-C', root, 'add', 'file.txt']);
  await writeFile(path.join(root, 'file.txt'), 'working\n');
  const { diff } = await workspaceDiff(root, 'file.txt');
  assert.match(diff, /-original/);
  assert.match(diff, /\+working/);
});

test('a deleted tracked file still has a diff preview', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'relay-deleted-test-'));
  await run('git', ['init', root]);
  await run('git', ['-C', root, 'config', 'user.email', 'relay-test@example.invalid']);
  await run('git', ['-C', root, 'config', 'user.name', 'Relay Test']);
  await writeFile(path.join(root, 'file.txt'), 'removed line\n');
  await run('git', ['-C', root, 'add', 'file.txt']);
  await run('git', ['-C', root, 'commit', '-m', 'base']);
  await run('git', ['-C', root, 'rm', 'file.txt']);
  assert.match((await workspaceDiff(root, 'file.txt')).diff, /-removed line/);
});

test('workspace uploads stay in the workspace and avoid overwriting existing files', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'relay-upload-test-'));
  const first = await saveWorkspaceUpload(root, { name: 'brief.txt', content: Buffer.from('first') });
  const second = await saveWorkspaceUpload(root, { name: 'brief.txt', content: Buffer.from('second') });
  assert.equal(first.path, 'uploads/brief.txt');
  assert.equal(second.path, 'uploads/brief-2.txt');
  assert.equal(await readFile(path.join(root, first.path), 'utf8'), 'first');
  await assert.rejects(() => saveWorkspaceUpload(root, { name: '../escape.txt', content: Buffer.from('no') }), /Invalid upload filename/);
});

test('workspace file browser lists safe visible files and cannot escape the workspace', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'relay-file-browser-test-'));
  const outside = await mkdtemp(path.join(tmpdir(), 'relay-file-browser-outside-'));
  await mkdir(path.join(root, 'src'));
  await writeFile(path.join(root, 'src', 'app.js'), 'export default 1;\n');
  await writeFile(path.join(root, 'README.md'), 'hello\n');
  await writeFile(path.join(root, '.env'), 'SECRET=no\n');
  await symlink(outside, path.join(root, 'outside-link'));

  const listing = await listWorkspaceFiles(root);
  assert.deepEqual(listing.entries.map((entry) => [entry.kind, entry.name]), [['directory', 'src'], ['file', 'README.md']]);
  assert.equal((await workspaceBrowseFile(root, 'src/app.js')).content, 'export default 1;\n');
  await assert.rejects(() => workspaceBrowseFile(root, '.env'), /Sensitive files/);
  await assert.rejects(() => workspaceBrowseFile(root, '../outside.txt'), /Invalid directory path/);
});

test('folder creation stays inside the VM root, skips hidden folders, and does not initialize Git', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'relay-project-root-'));
  const outside = await mkdtemp(path.join(tmpdir(), 'relay-outside-root-'));
  const registry = path.join(root, 'registry.json');
  await mkdir(path.join(root, 'existing'));
  await mkdir(path.join(root, '.hidden'));
  await symlink(outside, path.join(root, 'outside-link'));
  const [{ id }] = await listProjectRoots([root]);

  const created = await createDirectory({ rootId: id, parentPath: '', name: 'new-project', roots: [root], registry });
  assert.equal(created.name, 'new project');
  assert.equal(created.gitAvailable, false);
  await assert.rejects(() => run('git', ['-C', path.join(root, 'new-project'), 'rev-parse', '--is-inside-work-tree']));
  await assert.rejects(() => createDirectory({ rootId: id, parentPath: '../', name: 'escape', roots: [root], registry }), /Invalid directory path/);
  await assert.rejects(() => createDirectory({ rootId: id, parentPath: '.hidden', name: 'escape', roots: [root], registry }), /Invalid directory path/);

  const listed = await listProjectDirectories(id, '', [root]);
  assert.deepEqual(listed.directories.map((directory) => directory.name), ['existing', 'new-project']);
  const registered = await openDirectory({ rootId: id, path: 'existing', roots: [root], registry });
  assert.equal(registered.name, 'existing');
});

