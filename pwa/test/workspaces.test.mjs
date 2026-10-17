import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { countPorcelainRecords, inspectWorkspace, parseWorkspaceRoots, workspaceFile } from '../lib/workspaces.mjs';

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
  assert.equal(typeof workspace.id, 'string');
  assert.equal('path' in workspace, false);
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

