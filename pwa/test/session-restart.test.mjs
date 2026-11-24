import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { SessionManager } from '../lib/sessions.mjs';
import { SessionStore } from '../lib/session-store.mjs';
import { bootId } from '../lib/execution-scope.mjs';
import { FixtureScopes } from './fixtures/session-fixtures.mjs';

const managerModule = new URL('../lib/sessions.mjs', import.meta.url).href;
const fixtureModule = new URL('./fixtures/session-fixtures.mjs', import.meta.url).href;
async function until(work) { for (let n = 0; n < 200; n++) { const result = await work().catch(() => null); if (result) return result; await sleep(25); } throw new Error('Restart fixture barrier timed out'); }
async function processIdentity(pid) {
  try { const fields = (await readFile(`/proc/${pid}/stat`, 'utf8')).split(')').slice(1).join(')').trim().split(/\s+/); return { state: fields[0], start: fields[19] }; }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

test('controller SIGKILL leaves an orphan blocked and never repeats its prompt; recovery is audited', { timeout: 15000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'relay-controller-crash-'));
  const orphanCode = `const fs=require('node:fs');setInterval(()=>fs.appendFileSync(process.argv[1]+'/heartbeat','write\\n'),20);`;
  const childCode = `import { SessionManager } from ${JSON.stringify(managerModule)};
    import { FixtureScopes, deferred } from ${JSON.stringify(fixtureModule)};
    import {spawn} from 'node:child_process';import fs from 'node:fs';import {randomUUID} from 'node:crypto';
    const directory=process.argv[1], started=deferred();
    const manager=new SessionManager({stateDirectory:directory+'/controller',scopes:new FixtureScopes(),run:async({onEvent,spawnOptions})=>{
      const orphan=spawn(process.execPath,['-e',${JSON.stringify(orphanCode)},directory],{detached:true,stdio:'ignore'});orphan.unref();
      const fields=fs.readFileSync('/proc/'+orphan.pid+'/stat','utf8').split(')').slice(1).join(')').trim().split(/\\s+/);
      fs.writeFileSync(directory+'/orphan.json',JSON.stringify({pid:orphan.pid,start:fields[19]}));
      fs.appendFileSync(directory+'/executions','once\\n');spawnOptions.onInitialized();
      onEvent({type:'turn',threadId:'orphan-thread',turnId:'orphan-turn'});started.resolve();return new Promise(()=>{});
    },interrupt:async()=>{}});
    await manager.ready; const session=await manager.start('owner',{id:'w1',path:directory},{text:'run once',idempotencyKey:randomUUID(),createdAt:Date.now()});
    await started.promise;console.log(JSON.stringify({id:session.id}));setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', childCode, directory], { stdio: ['ignore', 'pipe', 'ignore'] });
  let manager, orphan;
  try {
    const ready = JSON.parse(String((await once(child.stdout, 'data'))[0]).trim());
    orphan = JSON.parse(await readFile(path.join(directory, 'orphan.json'), 'utf8'));
    await until(async () => (await readFile(path.join(directory, 'heartbeat'), 'utf8')).length > 0);
    const exit = once(child, 'exit'); child.kill('SIGKILL'); await exit;
    const before = (await readFile(path.join(directory, 'heartbeat'), 'utf8')).length;
    await until(async () => (await readFile(path.join(directory, 'heartbeat'), 'utf8')).length > before);
    await until(async () => {
      const candidate = new SessionManager({ stateDirectory: path.join(directory, 'controller'), scopes: new FixtureScopes(), run: async () => { throw new Error('Must not restart'); } });
      try { await candidate.ready; manager = candidate; return true; } catch { await candidate.close(); return false; }
    });
    assert.equal(manager.store.raw(ready.id).state, 'UNCERTAIN');
    assert.equal(await readFile(path.join(directory, 'executions'), 'utf8'), 'once\n');
    await assert.rejects(manager.start('owner', { id: 'w1', path: directory }, { text: 'conflict', idempotencyKey: randomUUID(), createdAt: Date.now() }), /active or uncertain/);
    const inspection = await manager.recovery('owner', 'w1', ready.id);
    assert.equal(inspection.evidence.stopped, false);
    manager.scopes.stop = async () => {
      const current = await processIdentity(orphan.pid);
      if (current && current.start !== orphan.start) throw new Error('Unrelated PID');
      if (current && current.state !== 'Z') process.kill(orphan.pid, 'SIGKILL');
      await until(async () => { const item = await processIdentity(orphan.pid); return !item || item.state === 'Z'; });
      return { stopped: true, proof: 'verified-fixture-orphan-identity' };
    };
    const result = await manager.recovery('owner', 'w1', ready.id, 'terminate', inspection.session.generation);
    assert.equal(result.session.state, 'INTERRUPTED');
    assert.ok(manager.store.db.prepare("SELECT 1 FROM recovery_audit WHERE action='requested:terminate'").get());
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    if (orphan) { const current = await processIdentity(orphan.pid); if (current?.start === orphan.start && current.state !== 'Z') process.kill(orphan.pid, 'SIGKILL'); }
    await manager?.close(); await rm(directory, { recursive: true, force: true });
  }
});

test('empty scope without startup fence remains UNCERTAIN, including explicit recovery attempts', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'relay-start-fence-'));
  let manager;
  try {
    const store = new SessionStore(path.join(directory, 'sessions'));
    const body = { text: 'ambiguous spawn', idempotencyKey: randomUUID(), createdAt: Date.now() };
    const { input, digest } = SessionStore.request(body);
    const { session } = store.reserve({ owner: 'owner', workspace: { id: 'w1', path: directory }, key: body.idempotencyKey, input, digest, bootId: await bootId() });
    store.update(session.id, { scope: JSON.stringify({ id: session.id }) }); store.close();
    const scopes = new FixtureScopes(); scopes.entries.set(session.id, true);
    manager = new SessionManager({ stateDirectory: directory, scopes }); await manager.ready;
    assert.equal(manager.store.raw(session.id).state, 'UNCERTAIN');
    const inspection = await manager.recovery('owner', 'w1', session.id);
    assert.equal(inspection.evidence.stopped, false);
    await assert.rejects(manager.recovery('owner', 'w1', session.id, 'terminate', inspection.session.generation), /not proven stopped/);
  } finally { await manager?.close(); await rm(directory, { recursive: true, force: true }); }
});
