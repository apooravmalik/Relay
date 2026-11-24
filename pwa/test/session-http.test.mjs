import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createRelayServer } from '../server.mjs';
import { FixtureScopes, deferred } from './fixtures/session-fixtures.mjs';
import { followSession } from '../public/session-client.js';

async function fixture(work) {
  const directory = await mkdtemp(path.join(tmpdir(), 'relay-session-http-'));
  const complete = deferred(), started = deferred();
  let events, executions = 0, interrupts = 0;
  const server = createRelayServer({ ownerLogin: 'owner',
    sessionOptions: { stateDirectory: path.join(directory, 'controller'), scopes: new FixtureScopes() },
    findWorkspace: async (id) => ['w1', 'w2'].includes(id) ? { id, path: directory } : null,
    listModels: async () => [], readConversation: async () => ({ conversation: { id: 'thread1' }, messages: [] }),
    streamNewTurn: async ({ onEvent }) => { executions++; events = onEvent; onEvent({ type: 'turn', threadId: 'thread1', turnId: 'turn1' }); onEvent({ type: 'delta', text: 'first', itemId: 'i1' }); started.resolve(); return complete.promise; },
    interruptTurn: async () => { interrupts++; },
  });
  await server.sessions.ready;
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { 'Tailscale-User-Login': 'owner', 'Content-Type': 'application/json' };
  const body = { text: 'run once', idempotencyKey: randomUUID(), createdAt: Date.now() };
  const post = (url, data = body, extra = {}) => fetch(base + url, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(data) });
  try { await work({ server, base, headers, body, post, started, complete, emit: (event) => events(event), executions: () => executions, interrupts: () => interrupts }); }
  finally {
    complete.resolve({ status: 'completed' });
    await Promise.all([...server.sessions.active.values()].map((entry) => entry.work));
    server.closeAllConnections(); await new Promise((done) => server.close(done)); await server.sessions.close();
    await rm(directory, { recursive: true, force: true });
  }
}
test('HTTP disconnect, two subscribers, ordered catch-up and repeated starts execute exactly once', async () => fixture(async ({ server, base, headers, post, started, complete, emit, executions, interrupts }) => {
  const [first, second] = await Promise.all([post('/api/workspaces/w1/sessions'), post('/api/workspaces/w1/sessions')]);
  assert.equal(first.status, 202); assert.equal(second.status, 202);
  const accepted = first;
  const { session } = await accepted.json(); await started.promise;
  const retried = await post('/api/workspaces/w1/sessions'); assert.equal((await retried.json()).session.id, session.id);
  assert.equal(executions(), 1);
  const prefix = `/api/workspaces/w1/sessions/${session.id}`;
  const firstStream = await fetch(base + prefix + '/events?after=0', { headers });
  const firstReader = firstStream.body.getReader();
  const firstChunk = new TextDecoder().decode((await firstReader.read()).value);
  assert.match(firstChunk, /first/); await firstReader.cancel();
  assert.equal(interrupts(), 0);
  const cursor = server.sessions.store.raw(session.id).last_event;
  const streamA = await fetch(base + prefix + `/events?after=${cursor}`, { headers });
  const streamB = await fetch(base + prefix + `/events?after=${cursor}`, { headers });
  emit({ type: 'delta', text: 'missed while offline', itemId: 'i1' });
  complete.resolve({ status: 'completed' });
  const [a, b] = await Promise.all([streamA.text(), streamB.text()]);
  assert.equal(a, b); assert.match(a, /missed while offline/); assert.match(a, /COMPLETED/);
  const replay = await fetch(base + prefix + '/events?after=0', { headers });
  const replayText = await replay.text();
  const ids = [...replayText.matchAll(/^id: (\d+)/gm)].map((match) => Number(match[1]));
  assert.deepEqual(ids, ids.map((_, index) => index + 1));
  assert.equal((await fetch(base + prefix + '/events?after=999999', { headers })).status, 400);
  assert.equal((await fetch(base + prefix + '/events?after=-1', { headers })).status, 400);
  assert.equal((await fetch(base + prefix, { headers: { ...headers, 'Tailscale-User-Login': 'other' } })).status, 401);
  assert.equal((await fetch(base + prefix.replace('/w1/', '/w2/'), { headers })).status, 404);
  assert.equal(interrupts(), 0);
}));
test('Stop persists intent across disconnect and CSRF/changed retries cannot start work', async () => fixture(async ({ server, headers, base, post, started, complete, body, interrupts }) => {
  assert.equal((await post('/api/workspaces/w1/sessions', body, { Origin: 'https://attacker.invalid' })).status, 403);
  const { session } = await (await post('/api/workspaces/w1/sessions')).json(); await started.promise;
  assert.equal((await post('/api/workspaces/w1/sessions', { ...body, text: 'changed' })).status, 409);
  const stopped = await post(`/api/workspaces/w1/sessions/${session.id}/stop`, {});
  assert.equal(stopped.status, 202); assert.equal((await stopped.json()).session.state, 'CANCEL_REQUESTED');
  assert.equal(interrupts(), 1);
  const response = await fetch(`${base}/api/workspaces/w1/sessions/${session.id}/events?after=0`, { headers });
  await response.body.cancel();
  assert.equal(server.sessions.store.raw(session.id).state, 'CANCEL_REQUESTED');
  const work = server.sessions.active.get(session.id).work;
  complete.resolve({ status: 'interrupted' }); await work;
  assert.equal(server.sessions.store.raw(session.id).state, 'INTERRUPTED');
}));
test('browser feed reconnects with a cursor and ignores duplicate delivery', async () => {
  const encoder = new TextEncoder(), calls = [], received = [];
  const frame = (id, type, data) => `id: ${id}\nevent: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  const fakeFetch = async (url) => {
    calls.push(url);
    const text = calls.length === 1 ? frame(1, 'input', { text: 'hello' }) : frame(1, 'input', { text: 'hello' }) + frame(2, 'status', { state: 'COMPLETED' });
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(encoder.encode(text)); controller.close(); } }));
  };
  await followSession('/events', { signal: new AbortController().signal, fetcher: fakeFetch, wait: async () => {}, onEvent: (event) => received.push(event.id) });
  assert.deepEqual(received, [1, 2]); assert.deepEqual(calls, ['/events?after=0', '/events?after=1']);
});

test('browser feed finishes after reconnect when final status arrived before connection loss', async () => {
  let calls = 0, pulls = 0;
  const received = [];
  await followSession('/events', {
    signal: new AbortController().signal, wait: async () => {},
    fetcher: async () => {
      calls++;
      assert.ok(calls <= 2, 'terminal cursor must not reconnect indefinitely');
      return new Response(new ReadableStream({ pull(controller) {
        if (calls === 2) return controller.close();
        if (pulls++ === 0) controller.enqueue(new TextEncoder().encode('id: 1\nevent: status\ndata: {"state":"COMPLETED"}\n\n'));
        else controller.error(new Error('network lost after terminal frame'));
      } }));
    },
    onEvent: (event) => received.push(event.id),
  });
  assert.equal(calls, 2); assert.deepEqual(received, [1]);
});
