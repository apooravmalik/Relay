import assert from 'node:assert/strict';
import test from 'node:test';
import { createRelayServer } from '../server.mjs';

async function withServer(testBody) {
  const hidden = [];
  const workspace = { id: 'workspace-1', name: 'Sample', path: '/safe/workspace', branch: 'main', changedFileCount: 1, handoffReady: true, status: 'ready' };
  const server = createRelayServer({
    ownerLogin: 'owner@example.com',
    listWorkspaces: async () => [workspace],
    findWorkspace: async (id) => id === workspace.id ? workspace : null,
    workspaceChanges: async () => [{ path: 'changed.js', status: ' M', previewAllowed: true }],
    workspaceFile: async () => ({ path: 'changed.js', content: 'console.log("ok")\n' }),
    workspaceDiff: async () => ({ path: 'changed.js', diff: '-old\n+new' }),
    listConversations: async () => [{ id: 'thread-1', name: 'Saved chat', preview: 'hello', status: 'notLoaded' }],
    readConversation: async () => ({ conversation: { id: 'thread-1', name: 'Saved chat' }, messages: [] }),
    streamNewTurn: async ({ text, onEvent }) => {
      onEvent({ type: 'conversation', conversation: { id: 'thread-2', name: 'New chat' } });
      onEvent({ type: 'delta', text: `New: ${text}` });
      return { status: 'completed' };
    },
    hiddenThreadIds: async () => new Set(),
    hideThread: async (login, id) => hidden.push({ login, id }),
    streamTurn: async ({ text, onEvent }) => {
      onEvent({ type: 'delta', text: `Echo: ${text}` });
      return { status: 'completed' };
    },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    await testBody({ base: `http://127.0.0.1:${port}`, hidden });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('server requires the configured Tailnet identity before serving a workspace', async () => {
  await withServer(async ({ base }) => {
    const denied = await fetch(`${base}/api/workspaces`);
    assert.equal(denied.status, 401);

    const allowed = await fetch(`${base}/api/workspaces`, { headers: { 'Tailscale-User-Login': 'owner@example.com' } });
    assert.equal(allowed.status, 200);
    assert.deepEqual((await allowed.json()).workspaces.map((workspace) => workspace.id), ['workspace-1']);
  });
});

test('PWA assets revalidate after a private-controller deployment', async () => {
  await withServer(async ({ base }) => {
    const response = await fetch(`${base}/styles.css`, { headers: { 'Tailscale-User-Login': 'owner@example.com' } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-cache');
  });
});

test('hiding a chat is a Relay preference and a turn streams only workspace-scoped output', async () => {
  await withServer(async ({ base, hidden }) => {
    const headers = { 'Tailscale-User-Login': 'owner@example.com' };
    const hiddenResponse = await fetch(`${base}/api/workspaces/workspace-1/conversations/thread-1`, { method: 'DELETE', headers });
    assert.equal(hiddenResponse.status, 204);
    assert.deepEqual(hidden, [{ login: 'owner@example.com', id: 'thread-1' }]);

    const response = await fetch(`${base}/api/workspaces/workspace-1/conversations/thread-1/turns`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'hello VM' }),
    });
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.match(body, /Echo: hello VM/);
    assert.match(body, /event: completed/);

    const newConversation = await fetch(`${base}/api/workspaces/workspace-1/conversations/turns`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'start here' }),
    });
    assert.match(await newConversation.text(), /New: start here/);
  });
});
