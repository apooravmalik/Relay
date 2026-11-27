// Rendered PWA and installed handoff helper against the same disposable SQLite store.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRelayServer } from '../server.mjs';
import { deferred, FixtureScopes } from './fixtures/session-fixtures.mjs';

const modulePath = process.env.RELAY_PLAYWRIGHT_MODULE;
if (!modulePath) throw new Error('Set RELAY_PLAYWRIGHT_MODULE to an installed Playwright module.');
const { chromium } = await import(pathToFileURL(modulePath));
const directory = await mkdtemp(path.join(tmpdir(), 'relay-handoff-browser-'));
const stateDirectory = path.join(directory, 'controller');
const registry = path.join(directory, 'registry.json');
const hash = (value) => createHash('sha256').update(value).digest('hex');
const workspaces = ['parent', 'parent/child', 'sibling'].map((name) => {
  const root = path.join(directory, name);
  return { id: hash(root).slice(0, 16), name, path: root, status: 'ready', gitAvailable: false };
});
const [parent, child, sibling] = workspaces;
for (const workspace of workspaces) await mkdir(workspace.path, { recursive: true });
const file = path.join(child.path, 'file');
await writeFile(file, 'original', { mode: 0o600 });
await writeFile(registry, JSON.stringify({ roots: workspaces.map((workspace) => workspace.path) }));
const env = { ...process.env, HOME: directory, RELAY_CONTROLLER_STATE_DIR: stateDirectory, RELAY_WORKSPACE_REGISTRY_FILE: registry };
const helperPath = fileURLToPath(new URL('../../deploy/relay-handoff', import.meta.url));
function helper(workspace, action, request, crashAt) {
  // Stop the real helper after durable writes, before its caller gets a reply.
  const crash = `
from relay_lib import export_workspace as e
import json, os, signal, sys
write = e._push_write_json
def write_and_crash(path, data):
    write(path, data)
    if path.name == 'journal.json':
        os.kill(os.getpid(), signal.SIGKILL)
e._push_write_json = write_and_crash
checkpoint = e.checkpoint
def checkpoint_and_crash(root, workspace, request):
    result = checkpoint(root, workspace, request)
    if request['action'] == 'commit':
        os.kill(os.getpid(), signal.SIGKILL)
    return result
if sys.argv[3] == 'checkpoint':
    e._push_write_json = write
    e.checkpoint = checkpoint_and_crash
e.dispatch_handoff(e.resolve_workspace(sys.argv[1]), sys.argv[1], sys.argv[2], json.load(sys.stdin))
`;
  const childProcess = crashAt
    ? spawn('python3', ['-c', crash, workspace.id, action, crashAt], { env })
    : spawn(helperPath, [workspace.id, action], { env });
  let output = '', errors = '';
  childProcess.stdout.setEncoding('utf8').on('data', (data) => { output += data; });
  childProcess.stderr.setEncoding('utf8').on('data', (data) => { errors += data; });
  childProcess.stdin.end(request ? JSON.stringify(request) : undefined);
  return once(childProcess, 'close').then(([code, signal]) => {
    if (signal) return { signal };
    assert.ok(output, errors);
    return { code, result: JSON.parse(output) };
  });
}

const workers = new Map();
let startCount = 0;
async function run({ cwd, onEvent }) {
  const work = deferred();
  workers.set(cwd, work);
  const number = ++startCount;
  onEvent({ type: 'conversation', conversation: { id: `thread-${number}`, name: 'Handoff browser fixture' } });
  onEvent({ type: 'turn', threadId: `thread-${number}`, turnId: `turn-${number}` });
  return work.promise;
}
const server = createRelayServer({ allowLocalDevelopment: true,
  sessionOptions: { stateDirectory, scopes: new FixtureScopes() },
  listWorkspaces: async () => workspaces, findWorkspace: async (id) => workspaces.find((workspace) => workspace.id === id),
  listModels: async () => [], validateModelSelection: async () => {}, listConversations: async () => [],
  readConversation: async (_cwd, id) => ({ conversation: { id, name: 'Handoff browser fixture' }, messages: [] }),
  streamNewTurn: run, streamTurn: run,
});
let browser;
const pageErrors = [];
const unexpectedConsole = [];
try {
  await server.sessions.ready;
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const capture = await helper(child, 'capture');
  assert.equal(capture.code, 0, JSON.stringify(capture.result));
  const { entries, git, transfer_id, source_path, workspace_id } = capture.result.manifest;
  const endpoint = 'a'.repeat(64);
  const base = { entries, git, transfer_id, source_path, workspace_id, endpoint, generation: 0, parent_id: null, schema_version: 1 };
  const initial = await helper(child, 'checkpoint', { action: 'init', endpoint, checkpoint: base });
  assert.equal(initial.code, 0, JSON.stringify(initial.result));
  const content = 'acknowledged push';
  const transfer = randomUUID().replaceAll('-', '');
  const proposed = { ...base, transfer_id: transfer, parent_id: transfer_id, generation: 1,
    entries: [{ ...entries[0], sha256: hash(content), size: Buffer.byteLength(content) }] };
  const request = { transfer_id: transfer, endpoint, base, proposed };

  browser = await chromium.launch({ args: ['--no-sandbox'], executablePath: process.env.RELAY_E2E_BROWSER_EXECUTABLE });
  async function open(workspace) {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error' && !message.text().includes('409 (Conflict)')) unexpectedConsole.push(message.text());
    });
    await page.goto(url);
    assert.equal(new URL(page.url()).origin, url);
    assert.match(await page.title(), /Relay/);
    await page.locator('article.workspace').filter({ has: page.getByRole('heading', { name: workspace.name, exact: true }) })
      .getByRole('button', { name: 'Open workspace' }).click();
    await page.locator('#new-chat').click();
    return page;
  }
  async function send(page, text) {
    await page.locator('#prompt').fill(text);
    const response = page.waitForResponse((res) => res.request().method() === 'POST' && /\/sessions$/.test(res.url()));
    await page.getByRole('button', { name: 'Send message' }).click();
    return response;
  }
  const working = (page) => page.locator('#chat-status').filter({ hasText: 'Working on VM' }).waitFor();
  const finish = async (page, workspace) => {
    workers.get(workspace.path).resolve({ status: 'completed' });
    await page.locator('#chat-status').filter({ hasText: 'Completed' }).waitFor();
  };

  const parentPage = await open(parent);
  const first = await send(parentPage, 'parent task before push');
  assert.equal(first.status(), 202);
  await working(parentPage);
  const blockedPush = await helper(child, 'batch_begin', request);
  assert.equal(blockedPush.result.error, 'source_busy');
  assert.match(blockedPush.result.message, /overlapping/);
  assert.equal(await readFile(file, 'utf8'), 'original');
  await finish(parentPage, parent);

  const deadHelper = await helper(child, 'batch_begin', request, 'journal');
  assert.equal(deadHelper.signal, 'SIGKILL');
  const blocked = await send(parentPage, 'parent task while child transfer is pending');
  assert.equal(blocked.status(), 409);
  assert.match((await blocked.json()).error, /overlapping workspace has a pending handoff/);
  await parentPage.locator('#chat-status').filter({ hasText: 'Send needs attention' }).waitFor();
  assert.equal(startCount, 1);
  if (process.env.RELAY_HANDOFF_SCREENSHOT) await parentPage.screenshot({ path: process.env.RELAY_HANDOFF_SCREENSHOT });
  const upload = await parentPage.request.post(`${url}/api/workspaces/${parent.id}/uploads`, {
    data: Buffer.from('pending attachment'), headers: { 'x-relay-upload-name': 'attachment.txt' },
  });
  assert.equal(upload.status(), 409);
  await assert.rejects(access(path.join(parent.path, 'uploads')), { code: 'ENOENT' });

  const moved = child.path + '-moved';
  await rename(child.path, moved);
  await mkdir(child.path);
  const changed = await send(parentPage, 'do not accept a replaced workspace');
  assert.equal(changed.status(), 409);
  assert.match((await changed.json()).error, /workspace identity changed/);
  await parentPage.locator('#chat-status').filter({ hasText: 'Send needs attention' }).waitFor();
  await rm(child.path, { recursive: true });
  await rename(moved, child.path);

  const siblingPage = await open(sibling);
  assert.equal((await send(siblingPage, 'unrelated sibling task')).status(), 202);
  await working(siblingPage);
  await finish(siblingPage, sibling);

  const resumed = await helper(child, 'batch_begin', request);
  assert.equal(resumed.code, 0, JSON.stringify(resumed.result));
  await writeFile(path.join(resumed.result.upload_path, 'file'), content, { mode: 0o600 });
  assert.equal((await helper(child, 'batch_apply', request, 'checkpoint')).signal, 'SIGKILL');
  assert.equal(await readFile(file, 'utf8'), content);
  assert.equal((await send(parentPage, 'parent task before recovery acknowledgment')).status(), 409);
  await parentPage.locator('#chat-status').filter({ hasText: 'Send needs attention' }).waitFor();
  const ack = await helper(child, 'batch_apply', request);
  assert.deepEqual(ack.result.checkpoint, proposed, JSON.stringify(ack.result));
  assert.equal(await readFile(file, 'utf8'), content);
  assert.equal(await readFile(path.join(resumed.result.upload_path, 'file'), 'utf8'), 'original');

  assert.equal((await send(parentPage, 'parent task after acknowledgment')).status(), 202);
  await working(parentPage);
  const replay = await helper(child, 'batch_apply', request);
  assert.deepEqual(replay.result, ack.result);
  await finish(parentPage, parent);
  assert.equal(startCount, 3);
  const raceContent = 'concurrent start winner';
  const raceTransfer = randomUUID().replaceAll('-', '');
  const raceProposed = { ...proposed, transfer_id: raceTransfer, parent_id: transfer, generation: 2,
    entries: [{ ...entries[0], sha256: hash(raceContent), size: Buffer.byteLength(raceContent) }] };
  const raceRequest = { transfer_id: raceTransfer, endpoint, base: proposed, proposed: raceProposed };
  await parentPage.locator('#prompt').fill('race the nested handoff');
  const raceResponse = parentPage.waitForResponse((res) => res.request().method() === 'POST' && /\/sessions$/.test(res.url()));
  const [raceHandoff, raceSession] = await Promise.all([
    helper(child, 'batch_begin', raceRequest), raceResponse, parentPage.getByRole('button', { name: 'Send message' }).click(),
  ]);
  assert.equal(Number(raceHandoff.code === 0) + Number(raceSession.status() === 202), 1, 'Exactly one overlapping start should win');
  assert.equal(await readFile(file, 'utf8'), content, 'The losing operation must not modify the workspace');
  if (raceHandoff.code === 0) {
    assert.equal(raceSession.status(), 409);
    await writeFile(path.join(raceHandoff.result.upload_path, 'file'), raceContent, { mode: 0o600 });
    assert.equal((await helper(child, 'batch_apply', raceRequest)).code, 0);
  } else {
    assert.equal(raceHandoff.result.error, 'source_busy');
    await working(parentPage);
    await finish(parentPage, parent);
  }
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(unexpectedConsole, []);
  console.log(`PASS ${url} (390 × 844): exclusive starts; unrelated sibling; changed directory rejected; recovery after SIGKILL during upload and after checkpoint commit; read-only acknowledgment retry.`);
} finally {
  for (const work of workers.values()) work.resolve({ status: 'completed' });
  await browser?.close();
  await Promise.allSettled([...server.sessions.active.values()].map((execution) => execution.work));
  await server.sessions.close();
  await new Promise((resolve) => server.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
