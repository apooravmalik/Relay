import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import test from 'node:test';
import { createRelayServer } from '../server.mjs';

// An explicitly injected test process group exercises real sockets/writes and RPC.
// This does not replace the separately gated production cgroup test.
class ProcessFixtureScopes {
  constructor(directory) { this.directory = directory; }
  async available() {}
  async create(id) { const directory = path.join(this.directory, id); await mkdir(directory); return { directory }; }
  spawnOptions(scope) { return { command: 'setsid', args: [process.execPath, fileURLToPath(new URL('./fixtures/codex-process.mjs', import.meta.url)), scope.directory] }; }
  async verify(scope) {
    if (!scope) throw new Error('Missing scope');
    let alive = false;
    for (const name of ['parent.json', 'server.json']) {
      let saved; try { saved = JSON.parse(await readFile(path.join(scope.directory, name), 'utf8')); } catch { continue; }
      try {
        const fields = (await readFile(`/proc/${saved.pid}/stat`, 'utf8')).split(')').slice(1).join(')').trim().split(/\s+/);
        if (fields[19] !== saved.start || Number(fields[2]) !== saved.group) throw new Error('Fixture identity changed');
        if (fields[0] !== 'Z') alive = true;
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return { stopped: !alive, proof: 'test-only-process-identities' };
  }
  async stop(scope) {
    const parent = JSON.parse(await readFile(path.join(scope.directory, 'parent.json'), 'utf8'));
    if (!(await this.verify(scope)).stopped) { try { process.kill(-parent.group, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
    for (let n = 0; n < 200; n++) { const evidence = await this.verify(scope); if (evidence.stopped) return evidence; await sleep(10); }
    throw new Error('Fixture termination timed out');
  }
  async remove() {}
}
async function until(work) { for (let n = 0; n < 200; n++) { const result = await work().catch(() => null); if (result) return result; await sleep(25); } throw new Error('Fixture barrier timed out'); }

for (const outcome of ['complete', 'stop']) test(`real process task survives HTTP disconnect and ${outcome} closes its server before unlock`, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'relay-process-e2e-'));
  const stateDirectory = path.join(directory, 'controller');
  const server = createRelayServer({ allowLocalDevelopment: true,
    sessionOptions: { stateDirectory, scopes: new ProcessFixtureScopes(directory) },
    findWorkspace: async (id) => id === 'w1' ? { id, path: directory } : null,
    listModels: async () => [],
  });
  await server.sessions.ready;
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${server.address().port}`;
  let session;
  try {
    const response = await fetch(`${base}/api/workspaces/w1/sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'fixture', createdAt: Date.now(), idempotencyKey: randomUUID() }) });
    assert.equal(response.status, 202); ({ session } = await response.json());
    const scope = path.join(directory, session.id);
    const info = await until(async () => JSON.parse(await readFile(path.join(scope, 'server.json'), 'utf8')));
    const listener = execFileSync('ss', ['-ltnH', `sport = :${info.port}`], { encoding: 'utf8' });
    assert.ok(listener.includes(`127.0.0.1:${info.port}`));
    assert.equal(await (await fetch(`http://127.0.0.1:${info.port}`)).text(), 'relay-task-fixture');
    const stream = await fetch(`${base}/api/workspaces/w1/sessions/${session.id}/events?after=0`); await stream.body.cancel();
    const before = (await readFile(path.join(scope, 'heartbeat'), 'utf8')).length;
    await until(async () => (await readFile(path.join(scope, 'heartbeat'), 'utf8')).length > before);
    assert.equal(server.sessions.store.raw(session.id).state, 'RUNNING');
    const work = server.sessions.active.get(session.id).work;
    if (outcome === 'stop') assert.equal((await fetch(`${base}/api/workspaces/w1/sessions/${session.id}/stop`, { method: 'POST' })).status, 202);
    else await writeFile(path.join(scope, 'finish'), 'finish');
    await work;
    assert.equal(server.sessions.store.raw(session.id).state, outcome === 'stop' ? 'INTERRUPTED' : 'COMPLETED');
    await assert.rejects(fetch(`http://127.0.0.1:${info.port}`));
    assert.equal(server.sessions.store.db.prepare('SELECT COUNT(*) AS n FROM workspace_guards').get().n, 0);
  } finally {
    if (session && server.sessions.active.has(session.id)) { await writeFile(path.join(directory, session.id, 'finish'), 'finish'); await server.sessions.active.get(session.id).work; }
    server.closeAllConnections(); await new Promise((done) => server.close(done)); await server.sessions.close(); await rm(directory, { recursive: true, force: true });
  }
});
