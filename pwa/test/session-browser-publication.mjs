// Local Playwright acceptance for RLY-015. All workspaces and controller state are disposable.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { createRelayServer } from '../server.mjs';
import { FixtureScopes } from './fixtures/session-fixtures.mjs';

const playwright = process.env.RELAY_PLAYWRIGHT_MODULE;
if (!playwright) throw new Error('Set RELAY_PLAYWRIGHT_MODULE to an installed Playwright index.mjs.');
const { chromium } = await import(pathToFileURL(playwright));
const directory = await mkdtemp(path.join(tmpdir(), 'relay-atomic-browser-'));
const repo = fileURLToPath(new URL('../../', import.meta.url));
const stateDirectory = path.join(directory, 'controller');
const registry = path.join(directory, 'registry.json');
const helper = path.join(directory, 'handoff.sh');
const bin = path.join(directory, 'bin');
const exec = promisify(execFile);
const hash = (value) => createHash('sha256').update(value).digest('hex');
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
const side = (file) => path.join(directory, file);
const workspaces = ['before', 'after', 'rollback', 'git-after'].map((name) => {
  const root = side(name);
  return { id: hash(root).slice(0, 16), name, path: root, status: 'ready', gitAvailable: name === 'git-after', branch: name === 'git-after' ? 'main' : null };
});
const env = { ...process.env, HOME: directory, PATH: bin + ':' + process.env.PATH,
  RELAY_CONTROLLER_STATE_DIR: stateDirectory, RELAY_WORKSPACE_REGISTRY_FILE: registry, RELAY_REMOTE_HELPER: helper };
const run = async (args, extra = {}, expected = 0) => {
  let result;
  try { result = { code: 0, ...await exec(path.join(repo, 'relay'), args, { cwd: repo, env: { ...env, ...extra }, timeout: 30000 }) }; }
  catch (error) { result = error; }
  assert.equal(result.code, expected, result.stdout + result.stderr);
  return JSON.parse(result.stdout);
};
const git = async (cwd, ...args) => (await exec('git', ['-C', cwd, ...args], { env })).stdout.trim();
const commit = (cwd, message) => git(cwd, '-c', 'user.name=Relay Test', '-c', 'user.email=test@example.com', 'commit', '-qm', message);
const gitState = async (cwd) => [await git(cwd, 'rev-parse', 'HEAD'), await git(cwd, 'ls-files', '--stage')];
const checkpoint = async (workspace, endpoint) => {
  const result = await exec('python3', ['-c',
    "import json,sys; from relay_lib import export_workspace as e; w,k=sys.argv[1:]; print(json.dumps(e.checkpoint(e.resolve_workspace(w), w, {'action':'get','endpoint':k})))",
    workspace.id, endpoint], { cwd: repo, env });
  return JSON.parse(result.stdout);
};
async function signature(root, prefix = '') {
  const values = {};
  for (const entry of await readdir(path.join(root, prefix), { withFileTypes: true })) {
    const name = path.join(prefix, entry.name);
    if (entry.isDirectory()) Object.assign(values, await signature(root, name));
    else values[name] = hash(await readFile(path.join(root, name)));
  }
  return values;
}
const server = createRelayServer({
  allowLocalDevelopment: true,
  sessionOptions: { stateDirectory, scopes: new FixtureScopes() },
  listWorkspaces: async () => workspaces,
  findWorkspace: async (id) => workspaces.find((workspace) => workspace.id === id),
  listModels: async () => [],
  listConversations: async () => [],
  readConversation: async () => ({ conversation: { id: 'atomic-publication-test', name: 'Atomic publication' }, messages: [] }),
  streamNewTurn: async ({ onEvent }) => {
    onEvent({ type: 'conversation', conversation: { id: 'atomic-publication-test', name: 'Atomic publication' } });
    onEvent({ type: 'turn', threadId: 'atomic-publication-test', turnId: 't1' });
    return { status: 'completed' };
  },
});
let browser;
try {
  await mkdir(bin);
  await mkdir(side('client'));
  await writeFile(path.join(bin, 'ssh'), '#!/bin/sh\nshift\nexec /bin/sh -c "$*"\n', { mode: 0o700 });
  await writeFile(helper, [
    '#!/bin/sh',
    'if { [ "$2" = batch_apply ] || [ "$2" = git_apply ]; } && [ -n "${RELAY_ATOMIC_CRASH:-}" ]; then',
    'exec python3 ' + quote(side('crash.py')) + ' "$@"',
    'fi',
    'exec ' + quote(path.join(repo, 'deploy/relay-handoff')) + ' "$@"',
    '',
  ].join('\n'), { mode: 0o700 });
  await writeFile(side('crash.py'), [
    'import os, signal, sys',
    'sys.path.insert(0, ' + JSON.stringify(repo) + ')',
    'from relay_lib import export_workspace as e',
    'original = e._workspace_exchange',
    'def crash(candidate, root):',
    "    if os.environ['RELAY_ATOMIC_CRASH'] == 'after':",
    '        original(candidate, root)',
    '    os.kill(os.getpid(), signal.SIGKILL)',
    'e._workspace_exchange = crash',
    'e.main()',
    '',
  ].join('\n'));
  await writeFile(registry, JSON.stringify({ roots: workspaces.map((workspace) => workspace.path) }));
  for (const workspace of workspaces) {
    await mkdir(path.join(workspace.path, 'node_modules'), { recursive: true });
    await writeFile(path.join(workspace.path, 'one.txt'), 'old one');
    await writeFile(path.join(workspace.path, 'two.txt'), 'old two');
    await writeFile(path.join(workspace.path, 'delete.txt'), 'old deleted file');
    await writeFile(path.join(workspace.path, 'node_modules', 'runtime.txt'), 'VM-only runtime');
    if (workspace.gitAvailable) {
      await git(workspace.path, 'init', '-qb', 'main');
      await git(workspace.path, 'add', 'one.txt', 'two.txt', 'delete.txt');
      await commit(workspace.path, 'Original');
    }
  }
  await server.sessions.ready;
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + server.address().port;
  browser = await chromium.launch({ args: ['--no-sandbox'], executablePath: process.env.RELAY_E2E_BROWSER_EXECUTABLE });
  const pageErrors = [];
  for (const workspace of workspaces) {
    const original = await signature(workspace.path);
    const originalGit = workspace.gitAvailable ? await gitState(workspace.path) : null;
    const imported = await run(['pull', '--workspace', workspace.id, '--into', side('client'), '--json']);
    const initial = imported.transfer_id;
    const project = imported.destination;
    const pairing = JSON.parse(await readFile(side('.relay-v0/pairings/' + hash(project) + '.json'), 'utf8'));
    const endpoint = hash(pairing.installation_id + '\0' + project);
    const args = ['push', '--workspace', workspace.id, '--project', project, '--json'];
    await writeFile(path.join(project, 'one.txt'), 'new one');
    await writeFile(path.join(project, 'two.txt'), 'new two');
    await rm(path.join(project, 'delete.txt'));
    let push = args;
    let proposedGit;
    if (workspace.gitAvailable) {
      await git(project, 'add', '-A');
      await commit(project, 'Proposed');
      await writeFile(path.join(project, 'two.txt'), 'new staged two');
      await git(project, 'add', 'two.txt');
      await writeFile(path.join(project, 'two.txt'), 'new two');
      proposedGit = await gitState(project);
      push = [...args, '--commit', proposedGit[0]];
    }
    const after = workspace.name !== 'before';
    await run(push, { RELAY_ATOMIC_CRASH: after ? 'after' : 'before' }, 1);

    const observed = await run([...args, '--inspect']);
    assert.equal(observed.status, after ? 'published' : 'prepared');
    assert.equal(observed.rollback_available, true);
    assert.ok(observed.checkpoint_pending);
    const beforeAck = await checkpoint(workspace, endpoint);
    assert.equal(beforeAck.checkpoint.transfer_id, initial);
    assert.equal(beforeAck.pending.transfer_id, observed.transfer_id);
    const retained = side('.relay-v0/batch-pushes/' + observed.transfer_id + '/previous');
    if (after) assert.deepEqual(await signature(retained), original);
    else assert.deepEqual(await signature(workspace.path), original);
    if (workspace.gitAvailable) {
      assert.deepEqual(await gitState(workspace.path), proposedGit);
      assert.deepEqual(await gitState(retained), originalGit);
    }

    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error' && !message.text().includes('409 (Conflict)')) pageErrors.push(message.text());
    });
    await page.goto(url);
    assert.match(await page.title(), /Relay/);
    await page.locator('article.workspace').filter({ has: page.getByRole('heading', { name: workspace.name, exact: true }) })
      .getByRole('button', { name: 'Open workspace' }).click();
    await page.locator('#files-tab').click();
    async function readInBrowser(file, expected, screenshot) {
      await page.getByRole('treeitem', { name: file }).click();
      await page.locator('#file-content').getByText(expected, { exact: true }).waitFor({ timeout: 8000 });
      if (screenshot) await page.screenshot({ path: screenshot });
      await page.locator('#close-file').click();
    }
    await readInBrowser('one.txt', after ? 'new one' : 'old one');
    await readInBrowser('two.txt', after ? 'new two' : 'old two',
      process.env.RELAY_ATOMIC_SCREENSHOTS ? path.join(process.env.RELAY_ATOMIC_SCREENSHOTS, workspace.name + '.png') : undefined);

    const blocked = await page.request.post(url + '/api/workspaces/' + workspace.id + '/sessions', {
      data: { text: 'must wait for acknowledgment', createdAt: Date.now(), idempotencyKey: 'pending-' + observed.transfer_id },
    });
    assert.equal(blocked.status(), 409);

    if (workspace.name === 'rollback') {
      const rollback = await run([...args, '--rollback']);
      assert.equal(rollback.status, 'ABORTED');
      assert.deepEqual(await signature(workspace.path), original);
      assert.equal(await readFile(path.join(retained, 'two.txt'), 'utf8'), 'new two');
      await assert.rejects(access(path.join(retained, 'delete.txt')), { code: 'ENOENT' });
      assert.deepEqual(await checkpoint(workspace, endpoint), { checkpoint: beforeAck.checkpoint, pending: null });
      await readInBrowser('one.txt', 'old one');
      await readInBrowser('two.txt', 'old two');
    } else {
      const receipt = await run([...args, '--resume']);
      assert.equal(receipt.transfer_id, observed.transfer_id);
      assert.equal(receipt.remote_recovery_path, path.dirname(retained));
      assert.deepEqual(await signature(retained), original);
      await readInBrowser('one.txt', 'new one');
      await readInBrowser('two.txt', 'new two');
      const acknowledged = await checkpoint(workspace, endpoint);
      assert.equal(acknowledged.checkpoint.transfer_id, observed.transfer_id);
      assert.equal(acknowledged.checkpoint.generation, beforeAck.checkpoint.generation + 1);
      assert.equal(acknowledged.pending, null);
      await run([...args, '--resume']);
      assert.deepEqual(await checkpoint(workspace, endpoint), acknowledged);
      await writeFile(path.join(workspace.path, 'one.txt'), 'live edit after acknowledgment');
      assert.deepEqual(await signature(retained), original);
    }

    await page.locator('#chats-tab').click();
    await page.locator('#new-chat').click();
    await page.locator('#prompt').fill('Confirm the workspace can start a task');
    const accepted = page.waitForResponse((response) => response.request().method() === 'POST' && /\/sessions$/.test(response.url()));
    await page.getByRole('button', { name: 'Send message' }).click();
    assert.equal((await accepted).status(), 202);
    await page.locator('#chat-status').getByText('Completed').waitFor();
    await page.close();
    console.log('PASS ' + workspace.name + ': rendered file views, original and proposal, checkpoint, and renewed PWA task');
  }
  assert.deepEqual(pageErrors, []);
  console.log('PASS ' + url + ' (390 x 844) with real CLI, rsync, VM helper, and PWA file views');
} finally {
  await browser?.close();
  await Promise.allSettled([...server.sessions.active.values()].map((execution) => execution.work));
  if (server.sessions.store) await server.sessions.close();
  await new Promise((resolve) => server.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
