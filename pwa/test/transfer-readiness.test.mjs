import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { assertTransferIdle } from '../lib/transfer-readiness.mjs';

test('pending parent or child transfer blocks a task but sibling transfer does not', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'relay-pending-checkpoint-'));
  const folder = path.join(root, 'other-workspace');
  await mkdir(folder);
  const file = path.join(folder, 'endpoint.json');
  try {
    await writeFile(file, JSON.stringify({ pending: { workspace_id: 'other-workspace', source_path: '/projects/app/child' } }));
    await assert.rejects(assertTransferIdle('w', '/projects/app', root), /pending handoff/);
    await assert.rejects(assertTransferIdle('w', '/projects/app/child/inside', root), /pending handoff/);
    await assertTransferIdle('w', '/projects/app-other', root);
    await writeFile(file, JSON.stringify({ pending: { workspace_id: 'other-workspace', source_path: 'invalid' } }));
    await assert.rejects(assertTransferIdle('w', '/projects/app-other', root), /cannot be verified/);
    await writeFile(file, '{broken');
    await assert.rejects(assertTransferIdle('w', '/projects/app-other', root), /cannot be inspected/);
    await rm(file);
    await symlink('/dev/null', file);
    await assert.rejects(assertTransferIdle('w', '/projects/app-other', root), /cannot be inspected/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
