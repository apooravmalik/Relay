import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import { SessionStore } from '../lib/session-store.mjs';

async function fixture(work, options) {
  const directory = await mkdtemp(path.join(tmpdir(), 'relay-session-store-'));
  let store = new SessionStore(directory, options);
  try { await work(store, directory); } finally { try { store.close(); } catch {} await rm(directory, { recursive: true, force: true }); }
}
function reserve(store, overrides = {}) {
  const body = { text: 'private prompt', createdAt: Date.now(), idempotencyKey: randomUUID(), ...overrides };
  const { input, digest } = SessionStore.request(body);
  const id = overrides.workspaceId || 'w1';
  return { ...store.reserve({ owner: 'owner', workspace: { id, path: overrides.workspacePath || (id === 'w1' ? '/workspace' : `/workspace-${id}`) }, key: body.idempotencyKey, input, digest, bootId: 'boot' }), body, input, digest };
}
test('atomic start deduplicates retries, rejects changed bodies and enforces workspace/controller limits', async () => fixture(async (store) => {
  const first = reserve(store);
  const retry = store.reserve({ owner: 'owner', workspace: { id: 'w1', path: '/workspace' }, key: first.body.idempotencyKey, input: first.input, digest: first.digest, bootId: 'boot' });
  assert.equal(retry.session.id, first.session.id); assert.equal(retry.created, false);
  assert.throws(() => store.prior('owner', 'w1', first.body.idempotencyKey, 'changed'), /different/);
  assert.throws(() => reserve(store), /active or uncertain/);
  reserve(store, { workspaceId: 'w2' });
  assert.throws(() => reserve(store, { workspaceId: 'w3' }), /Two tasks/);
  assert.throws(() => store.get(first.session.id, 'other', 'w1'), /not found/);
  assert.throws(() => store.get(first.session.id, 'owner', 'other-workspace'), /not found/);
}));
test('parent and child tasks conflict while sibling workspaces remain independent', async () => fixture(async (store) => {
  const parent = reserve(store, { workspaceId: 'parent', workspacePath: '/workspace/project' });
  assert.throws(() => reserve(store, { workspaceId: 'child', workspacePath: '/workspace/project/nested' }), /overlapping workspace/);
  const sibling = reserve(store, { workspaceId: 'sibling', workspacePath: '/workspace/project-other' });
  store.transition(parent.session.id, 'UNCERTAIN');
  assert.throws(() => reserve(store, { workspaceId: 'ancestor', workspacePath: '/workspace' }), /overlapping workspace/);
  store.transition(parent.session.id, 'INTERRUPTED', null, { stopped: true });
  store.transition(sibling.session.id, 'INTERRUPTED', null, { stopped: true });
  const child = reserve(store, { workspaceId: 'child', workspacePath: '/workspace/project/nested' });
  assert.throws(() => reserve(store, { workspaceId: 'parent-again', workspacePath: '/workspace/project' }), /overlapping workspace/);
  store.transition(child.session.id, 'INTERRUPTED', null, { stopped: true });
}));
test('migrating an initialized v1 store keeps its active session guarded', async () => fixture(async (store, directory) => {
  const { session } = reserve(store);
  store.db.exec(`DROP TABLE handoff_guards;
    ALTER TABLE sessions DROP COLUMN workspace_device;
    ALTER TABLE sessions DROP COLUMN workspace_inode;
    PRAGMA user_version=1;`);
  store.close();
  const migrated = new SessionStore(directory);
  try {
    assert.equal(migrated.raw(session.id).state, 'STARTING');
    assert.throws(() => reserve(migrated, { workspaceId: 'child', workspacePath: '/workspace/child' }), /overlapping workspace/);
    migrated.transition(session.id, 'INTERRUPTED', null, { stopped: true });
    assert.equal(reserve(migrated, { workspaceId: 'child', workspacePath: '/workspace/child' }).created, true);
  } finally { migrated.close(); }
}));
test('events, state and guard changes are transactional and only verified finalization unlocks', async () => fixture(async (store) => {
  const { session } = reserve(store);
  store.transition(session.id, 'RUNNING');
  store.append(session.id, 'delta', { text: 'one', itemId: 'item1' });
  store.transition(session.id, 'CANCEL_REQUESTED');
  assert.throws(() => store.transition(session.id, 'INTERRUPTED'), /evidence/);
  const before = store.raw(session.id).last_event;
  const original = store.insertEvent;
  store.insertEvent = () => { throw new Error('disk full'); };
  assert.throws(() => store.transition(session.id, 'INTERRUPTED', null, { stopped: true }), /disk full/);
  assert.equal(store.raw(session.id).state, 'CANCEL_REQUESTED');
  assert.equal(store.raw(session.id).last_event, before);
  assert.ok(store.db.prepare('SELECT * FROM workspace_guards').get());
  store.insertEvent = original;
  store.transition(session.id, 'INTERRUPTED', null, { stopped: true });
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM workspace_guards').get().n, 0);
  const ids = store.events(session.id).map((event) => event.id);
  assert.deepEqual(ids, ids.map((_, index) => index + 1));
  assert.deepEqual(store.events(session.id, 2), store.events(session.id).slice(2));
  assert.throws(() => store.events(session.id, 1e20), /cursor/);
  assert.throws(() => store.events(session.id, -1), /cursor/);
}));
test('retention expires terminal events, preserves uncertain evidence and rejects old purged retries', async () => {
  let clock = Date.now();
  await fixture(async (store) => {
    assert.equal(store.db.prepare('PRAGMA auto_vacuum').get().auto_vacuum, 2);
    const first = reserve(store);
    store.transition(first.session.id, 'INTERRUPTED', null, { stopped: true });
    const pending = reserve(store, { workspaceId: 'w2' });
    store.transition(pending.session.id, 'UNCERTAIN');
    clock += 8 * 86400000; store.cleanup();
    assert.throws(() => store.events(first.session.id), /expired/);
    assert.ok(store.events(pending.session.id).length);
    assert.ok(store.prior('owner', 'w1', first.body.idempotencyKey, first.digest));
    clock += 23 * 86400000; store.cleanup();
    assert.equal(store.prior('owner', 'w1', first.body.idempotencyKey, first.digest), null);
    assert.throws(() => reserve(store, first.body), /stale/);
    assert.equal(store.raw(pending.session.id).state, 'UNCERTAIN');
  }, { now: () => clock });
});
test('output limit reserves space for control events and missing/corrupt initialized stores fail closed', async () => fixture(async (store, directory) => {
  const { session } = reserve(store);
  assert.throws(() => store.append(session.id, 'delta', { text: 'x'.repeat(2000) }), /limit/);
  store.transition(session.id, 'UNCERTAIN', 'quota');
  assert.equal((await stat(path.join(directory, 'sessions.sqlite'))).mode & 0o077, 0);
  store.close(); await unlink(path.join(directory, 'sessions.sqlite'));
  assert.throws(() => new SessionStore(directory), /missing/);
  await writeFile(path.join(directory, 'sessions.sqlite'), 'corrupt');
  assert.throws(() => new SessionStore(directory));
}, { maxSessionBytes: 2048 }));
test('Python standalone guard reads Node WAL and blocks execution after the controller lock disappears', async () => fixture(async (store, directory) => {
  const { session } = reserve(store);
  const controller = path.dirname(directory);
  // Helper expects controller/sessions; point its state root at a separate fixture symlink-free layout.
  const snippet = `import importlib.util,sys\ns=importlib.util.spec_from_file_location('helper',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)\nm.assert_session_idle('w1')`;
  const helper = path.resolve('relay_lib/export_workspace.py');
  const root = await mkdtemp(path.join(tmpdir(), 'relay-python-guard-'));
  const { rename, mkdir } = await import('node:fs/promises');
  await mkdir(path.join(root, 'controller'));
  // SQLite online backup via Python sees the live Node WAL without copying only the main file.
  execFileSync('python3', ['-c', 'import sqlite3,sys; a=sqlite3.connect(sys.argv[1]); b=sqlite3.connect(sys.argv[2]); a.backup(b); b.close(); a.close()', store.file, path.join(root, 'controller/sessions.sqlite')]);
  await mkdir(path.join(root, 'controller/sessions'));
  await rename(path.join(root, 'controller/sessions.sqlite'), path.join(root, 'controller/sessions/sessions.sqlite'));
  await writeFile(path.join(root, 'controller/sessions/initialized'), '1\n');
  const env = { ...process.env, RELAY_CONTROLLER_STATE_DIR: path.join(root, 'controller') };
  try {
    assert.throws(() => execFileSync('python3', ['-c', snippet, helper], { env, stdio: 'pipe' }), /Command failed/);
    store.transition(session.id, 'UNCERTAIN');
    assert.throws(() => execFileSync('python3', ['-c', snippet, helper], { env, stdio: 'pipe' }));
  } finally { await rm(root, { recursive: true, force: true }); }
}));

test('SQLite full errors retain the durable workspace guard and roll back partial output', async () => fixture(async (store) => {
  const { session } = reserve(store);
  store.transition(session.id, 'RUNNING');
  const pageCount = store.db.prepare('PRAGMA page_count').get().page_count;
  store.db.exec(`PRAGMA max_page_count=${pageCount}`);
  const before = store.raw(session.id).last_event;
  assert.throws(() => store.append(session.id, 'delta', { text: 'x'.repeat(64000) }), /full/);
  assert.equal(store.raw(session.id).last_event, before);
  assert.equal(store.raw(session.id).state, 'RUNNING');
  assert.ok(store.db.prepare('SELECT 1 FROM workspace_guards').get());
  store.db.exec(`PRAGMA max_page_count=${pageCount + 100}`);
  store.transition(session.id, 'INTERRUPTED', null, { stopped: true });
}));

test('SIGKILL during an event/state transaction leaves no partial committed execution state', async () => fixture(async (store, directory) => {
  const { session } = reserve(store);
  const childCode = `import { SessionStore } from ${JSON.stringify(new URL('../lib/session-store.mjs', import.meta.url).href)};
    const store=new SessionStore(process.argv[1]);
    store.db.exec('BEGIN IMMEDIATE');
    store.db.prepare("UPDATE sessions SET state='RUNNING' WHERE id=?").run(process.argv[2]);
    store.insertEvent(process.argv[2],'delta',{text:'uncommitted'});
    console.log('ready'); setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', childCode, directory, session.id], { stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    await once(child.stdout, 'data');
    assert.equal(store.raw(session.id).state, 'STARTING');
    child.kill('SIGKILL'); await once(child, 'exit');
    assert.equal(store.raw(session.id).state, 'STARTING');
    assert.equal(store.events(session.id).length, 2);
    assert.ok(store.db.prepare('SELECT 1 FROM workspace_guards').get());
    assert.equal(store.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
}));
