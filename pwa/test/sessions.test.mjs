import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import { SessionManager } from '../lib/sessions.mjs';
import { FixtureScopes, deferred } from './fixtures/session-fixtures.mjs';

async function fixture(work) {
  const directory = await mkdtemp(path.join(tmpdir(), 'relay-manager-'));
  const scopes = new FixtureScopes(), complete = deferred(), started = deferred();
  let starts = 0, interrupts = 0;
  const manager = new SessionManager({ stateDirectory: path.join(directory, 'controller'), scopes,
    run: async ({ onEvent }) => { starts++; onEvent({ type: 'turn', threadId: 'thread1', turnId: 'turn1' }); onEvent({ type: 'delta', text: 'before disconnect', itemId: 'item1' }); started.resolve(); return complete.promise; },
    interrupt: async () => { interrupts++; }, openPreview: async (port) => ({ port, url: 'https://private.example/' }), stopPreview: async () => {},
  });
  const workspace = { id: 'w1', path: await realpath(directory) };
  const body = { text: 'work', createdAt: Date.now(), idempotencyKey: randomUUID() };
  await manager.ready;
  try { await work({ manager, scopes, complete, started, workspace, body, starts: () => starts, interrupts: () => interrupts }); }
  finally { complete.resolve({ status: 'completed' }); await Promise.all([...manager.active.values()].map((value) => value.work)); await manager.close(); await rm(directory, { recursive: true, force: true }); }
}
test('server-owned execution survives zero subscribers, deduplicates retry and confirms cancellation separately', async () => fixture(async ({ manager, started, complete, workspace, body, starts, interrupts }) => {
  const session = await manager.start('owner', workspace, body);
  await started.promise;
  assert.equal((await manager.start('owner', workspace, body)).id, session.id);
  assert.equal(starts(), 1);
  assert.equal(manager.listenerCount(session.id), 0);
  assert.equal(manager.store.raw(session.id).state, 'RUNNING');
  await manager.stop('owner', workspace.id, session.id);
  assert.equal(interrupts(), 1);
  assert.equal(manager.store.raw(session.id).state, 'CANCEL_REQUESTED');
  assert.ok(manager.store.db.prepare('SELECT 1 FROM workspace_guards').get());
  await manager.stop('owner', workspace.id, session.id); assert.equal(interrupts(), 1);
  const work = manager.active.get(session.id).work;
  complete.resolve({ status: 'interrupted' }); await work;
  assert.equal(manager.store.raw(session.id).state, 'INTERRUPTED');
  assert.equal(manager.store.db.prepare('SELECT COUNT(*) AS n FROM workspace_guards').get().n, 0);
}));
test('a running handoff gate prevents a task reservation until the handoff releases it', async () => fixture(async ({ manager, started, complete, workspace, body, starts }) => {
  const code = "import sys\nfrom relay_lib.export_workspace import turn_lock\nwith turn_lock('other-workspace', sys.argv[1]):\n print('ready', flush=True)\n sys.stdin.read()";
  const helper = spawn('python3', ['-c', code, workspace.path], { env: { ...process.env, RELAY_CONTROLLER_STATE_DIR: manager.directory, HOME: workspace.path }, stdio: ['pipe', 'pipe', 'pipe'] });
  try {
    const [ready] = await Promise.race([once(helper.stdout, 'data'), once(helper, 'exit').then(() => { throw new Error('Python handoff fixture exited before acquiring the gate.'); })]);
    assert.equal(String(ready).trim(), 'ready');
    await assert.rejects(manager.start('owner', workspace, body), /busy/);
    assert.equal(starts(), 0);
    assert.equal(manager.store.db.prepare('SELECT COUNT(*) AS n FROM workspace_guards').get().n, 0);
  } finally { helper.stdin.end(); if (helper.exitCode === null && helper.signalCode === null) await once(helper, 'exit'); }
  const session = await manager.start('owner', workspace, body);
  await started.promise;
  const work = manager.active.get(session.id).work;
  complete.resolve({ status: 'completed' }); await work;
  assert.equal(manager.store.raw(session.id).state, 'COMPLETED');
}));
test('simultaneous starts in sibling workspaces both reserve successfully', async () => fixture(async ({ manager, complete, workspace, body }) => {
  const firstPath = path.join(workspace.path, 'first'), secondPath = path.join(workspace.path, 'second');
  await mkdir(firstPath); await mkdir(secondPath);
  const [first, second] = await Promise.all([
    manager.start('owner', { id: 'first', path: firstPath }, body),
    manager.start('owner', { id: 'second', path: secondPath }, { ...body, idempotencyKey: randomUUID() }),
  ]);
  assert.notEqual(first.id, second.id);
  assert.equal(manager.store.db.prepare('SELECT COUNT(*) AS n FROM workspace_guards').get().n, 2);
  complete.resolve({ status: 'completed' });
  await Promise.all([...manager.active.values()].map((entry) => entry.work));
}));
test('server cleanup precedes terminal state and failed cleanup quarantines the workspace', async () => fixture(async ({ manager, scopes, started, complete, workspace, body }) => {
  const session = await manager.start('owner', workspace, body); await started.promise;
  scopes.failStop = true;
  const work = manager.active.get(session.id).work;
  complete.resolve({ status: 'completed' }); await work;
  assert.equal(manager.store.raw(session.id).state, 'UNCERTAIN');
  await assert.rejects(manager.start('owner', workspace, { ...body, idempotencyKey: randomUUID() }), /active or uncertain/);
  const inspection = await manager.recovery('owner', workspace.id, session.id);
  await assert.rejects(manager.recovery('owner', workspace.id, session.id, 'terminate', inspection.session.generation - 1), /changed/);
  scopes.failStop = false;
  const recovered = await manager.recovery('owner', workspace.id, session.id, 'terminate', inspection.session.generation);
  assert.equal(recovered.session.state, 'INTERRUPTED');
  assert.ok(manager.store.db.prepare('SELECT * FROM recovery_audit WHERE actor=?').get('owner'));
}));
test('preview is owned while active and removed before successful finalization', async () => fixture(async ({ manager, started, complete, workspace, body }) => {
  const session = await manager.start('owner', workspace, body); await started.promise;
  let removed = false;
  manager.stopPreview = async () => { assert.equal(manager.store.raw(session.id).state, 'RUNNING'); removed = true; };
  await manager.preview('owner', workspace.id, session.id, 8765);
  assert.equal((await manager.preview('owner', workspace.id, session.id, 8765)).port, 8765);
  const work = manager.active.get(session.id).work;
  complete.resolve({ status: 'completed' }); await work;
  assert.ok(removed); assert.equal(manager.store.raw(session.id).state, 'COMPLETED');
  await assert.rejects(manager.preview('owner', workspace.id, session.id, 8765), /only while/);
}));
