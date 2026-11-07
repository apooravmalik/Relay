import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { createRelayServer, interruptOnDisconnect } from '../server.mjs';

async function withServer(testBody) {
  const hidden = [];
  const interruptions = [];
  const previews = [];
  const turns = [];
  const uploads = [];
  const workspace = { id: 'workspace-1', name: 'Sample', path: '/safe/workspace', branch: 'main', changedFileCount: 1, gitAvailable: true, handoffReady: true, status: 'ready' };
  const server = createRelayServer({
    ownerLogin: 'owner@example.com',
    listWorkspaces: async () => [workspace],
    findWorkspace: async (id) => id === workspace.id ? workspace : null,
    listProjectRoots: async () => [{ id: 'root-1', name: 'Projects' }],
    listProjectDirectories: async (id, directory) => ({ root: { id, name: 'Projects' }, path: directory, directories: [] }),
    listWorkspaceFiles: async (workspacePath, directory) => ({ path: directory, entries: [{ kind: 'file', name: 'README.md', path: 'README.md' }] }),
    createDirectory: async () => workspace,
    openDirectory: async () => workspace,
    saveWorkspaceUpload: async (workspacePath, upload) => {
      uploads.push({ workspacePath, ...upload });
      return { name: upload.name, path: `uploads/${upload.name}`, size: upload.content.length };
    },
    workspaceChanges: async () => [{ path: 'changed.js', status: ' M', previewAllowed: true }],
    workspaceBrowseFile: async () => ({ path: 'README.md', content: 'workspace file\n' }),
    workspaceFile: async () => ({ path: 'changed.js', content: 'console.log("ok")\n' }),
    workspaceDiff: async () => ({ path: 'changed.js', diff: '-old\n+new' }),
    listConversations: async () => [{ id: 'thread-1', name: 'Saved chat', preview: 'hello', status: 'notLoaded' }],
    readConversation: async () => ({ conversation: { id: 'thread-1', name: 'Saved chat' }, messages: [] }),
    listModels: async () => [{ id: 'gpt-test', name: 'GPT Test', defaultEffort: 'medium', efforts: [{ id: 'low' }, { id: 'medium' }] }],
    validateModelSelection: (models, selection) => {
      if (!selection.model && !selection.effort) return {};
      if (selection.model !== 'gpt-test' || selection.effort !== 'medium' || models.length !== 1) throw new Error('Invalid model selection.');
      return selection;
    },
    streamNewTurn: async ({ text, onEvent }) => {
      onEvent({ type: 'conversation', conversation: { id: 'thread-2', name: 'New chat' } });
      onEvent({ type: 'delta', text: `New: ${text}` });
      return { status: 'completed' };
    },
    hiddenThreadIds: async () => new Set(),
    hideThread: async (login, id) => hidden.push({ login, id }),
    interruptTurn: async (details) => interruptions.push(details),
    openPreview: async (port) => {
      previews.push({ action: 'open', port });
      return { port: Number(port), url: `https://relay.example.ts.net:${port}/` };
    },
    stopPreview: async (port) => {
      previews.push({ action: 'stop', port });
      return { port: Number(port), status: 'stopped' };
    },
    streamTurn: async (turn) => {
      turns.push(turn);
      const { text, onEvent } = turn;
      onEvent({ type: 'delta', text: `Echo: ${text}` });
      return { status: 'completed' };
    },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    await testBody({ base: `http://127.0.0.1:${port}`, hidden, interruptions, previews, turns, uploads });
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

test('owner can browse VM folders, open a plain directory, and read available models', async () => {
  await withServer(async ({ base }) => {
    const headers = { 'Tailscale-User-Login': 'owner@example.com', 'Content-Type': 'application/json' };
    const roots = await fetch(`${base}/api/project-roots`, { headers });
    assert.deepEqual((await roots.json()).roots, [{ id: 'root-1', name: 'Projects' }]);

    const directories = await fetch(`${base}/api/project-roots/root-1/directories?path=work`, { headers });
    assert.equal((await directories.json()).path, 'work');

    const models = await fetch(`${base}/api/codex/models`, { headers });
    assert.equal((await models.json()).models[0].id, 'gpt-test');

    const project = await fetch(`${base}/api/projects`, { method: 'POST', headers, body: JSON.stringify({ action: 'open', rootId: 'root-1', path: 'work' }) });
    assert.equal(project.status, 201);
    assert.equal((await project.json()).workspace.id, 'workspace-1');

    const created = await fetch(`${base}/api/projects`, { method: 'POST', headers, body: JSON.stringify({ action: 'create', rootId: 'root-1', parentPath: 'work', name: 'phone-folder' }) });
    assert.equal(created.status, 201);
    assert.equal((await created.json()).workspace.id, 'workspace-1');
  });
});

test('hiding a chat is a Relay preference and a turn streams only workspace-scoped output', async () => {
  await withServer(async ({ base, hidden, turns }) => {
    const headers = { 'Tailscale-User-Login': 'owner@example.com' };
    const hiddenResponse = await fetch(`${base}/api/workspaces/workspace-1/conversations/thread-1`, { method: 'DELETE', headers });
    assert.equal(hiddenResponse.status, 204);
    assert.deepEqual(hidden, [{ login: 'owner@example.com', id: 'thread-1' }]);

    const response = await fetch(`${base}/api/workspaces/workspace-1/conversations/thread-1/turns`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'hello VM', model: 'gpt-test', effort: 'medium' }),
    });
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.match(body, /Echo: hello VM/);
    assert.match(body, /event: completed/);
    assert.deepEqual({ model: turns[0].model, effort: turns[0].effort }, { model: 'gpt-test', effort: 'medium' });

    const newConversation = await fetch(`${base}/api/workspaces/workspace-1/conversations/turns`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'start here', model: 'gpt-test', effort: 'medium' }),
    });
    assert.match(await newConversation.text(), /New: start here/);
  });
});

test('an attached document is saved inside its selected workspace', async () => {
  await withServer(async ({ base, uploads }) => {
    const response = await fetch(`${base}/api/workspaces/workspace-1/uploads`, {
      method: 'POST',
      headers: { 'Tailscale-User-Login': 'owner@example.com', 'X-Relay-Upload-Name': encodeURIComponent('brief.txt') },
      body: Buffer.from('private document'),
    });
    assert.equal(response.status, 201);
    assert.deepEqual((await response.json()).upload, { name: 'brief.txt', path: 'uploads/brief.txt', size: 16 });
    assert.deepEqual(uploads.map(({ workspacePath, name, content }) => [workspacePath, name, content.toString('utf8')]), [['/safe/workspace', 'brief.txt', 'private document']]);
  });
});

test('owner can stop an active Codex turn only within its selected workspace', async () => {
  await withServer(async ({ base, interruptions }) => {
    const response = await fetch(`${base}/api/workspaces/workspace-1/conversations/thread-1/turns/stop`, {
      method: 'POST', headers: { 'Tailscale-User-Login': 'owner@example.com' },
    });
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { status: 'interrupting' });
    assert.deepEqual(interruptions, [{ cwd: '/safe/workspace', threadId: 'thread-1' }]);
  });
});

test('a disconnected phone stream interrupts only the Relay turn it owns', async () => {
  const response = new EventEmitter();
  let interruptions = 0;
  interruptOnDisconnect(response, async () => { interruptions += 1; });
  response.emit('close');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(interruptions, 1);

  const completedResponse = new EventEmitter();
  const completed = interruptOnDisconnect(completedResponse, async () => { interruptions += 1; });
  completed();
  completedResponse.emit('close');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(interruptions, 1);
});

test('owner can create and remove a private preview link for a workspace port', async () => {
  await withServer(async ({ base, previews }) => {
    const headers = { 'Tailscale-User-Login': 'owner@example.com', 'Content-Type': 'application/json' };
    const created = await fetch(`${base}/api/workspaces/workspace-1/preview`, { method: 'POST', headers, body: JSON.stringify({ port: 3000 }) });
    assert.equal(created.status, 201);
    assert.deepEqual(await created.json(), { preview: { port: 3000, url: 'https://relay.example.ts.net:3000/' } });
    const removed = await fetch(`${base}/api/workspaces/workspace-1/preview?port=3000`, { method: 'DELETE', headers });
    assert.deepEqual(await removed.json(), { preview: { port: 3000, status: 'stopped' } });
    assert.deepEqual(previews, [{ action: 'open', port: 3000 }, { action: 'stop', port: '3000' }]);
  });
});

test('owner can browse visible workspace files without using the Git change preview', async () => {
  await withServer(async ({ base }) => {
    const headers = { 'Tailscale-User-Login': 'owner@example.com' };
    const listing = await fetch(`${base}/api/workspaces/workspace-1/files?path=src`, { headers });
    assert.deepEqual(await listing.json(), { path: 'src', entries: [{ kind: 'file', name: 'README.md', path: 'README.md' }] });
    const preview = await fetch(`${base}/api/workspaces/workspace-1/browse-file?path=README.md`, { headers });
    assert.deepEqual(await preview.json(), { path: 'README.md', content: 'workspace file\n' });
  });
});
