// Optional rendered-browser test. Install Playwright outside the repository and set
// RELAY_PLAYWRIGHT_MODULE to its importable absolute module path. No live controller is used.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRelayServer } from '../server.mjs';
import { FixtureScopes, deferred } from './fixtures/session-fixtures.mjs';

if (!process.env.RELAY_PLAYWRIGHT_MODULE) throw new Error('Set RELAY_PLAYWRIGHT_MODULE to an externally installed Playwright module.');
const { chromium } = await import(pathToFileURL(process.env.RELAY_PLAYWRIGHT_MODULE));
const directory = await mkdtemp(path.join(tmpdir(), 'relay-browser-'));
const scopes = new FixtureScopes();
let starts = 0, interrupts = 0, emit, complete, currentText, output = '', turnId;
const workspace = { id: 'browser-workspace', name: 'Session browser fixture', path: directory, status: 'ready', gitAvailable: true, branch: 'main', changedFileCount: 0 };
const run = async ({ text, onEvent }) => {
  starts++; currentText = text; output = 'tick1\n'; turnId = `turn-${starts}`; emit = onEvent; complete = deferred();
  onEvent({ type: 'conversation', conversation: { id: 'browser-thread', name: 'Persistent session fixture' } });
  onEvent({ type: 'turn', threadId: 'browser-thread', turnId });
  onEvent({ type: 'delta', text: output, itemId: `item-${starts}` });
  return complete.promise;
};
const server = createRelayServer({ allowLocalDevelopment: true,
  sessionOptions: { stateDirectory: path.join(directory, 'controller'), scopes },
  findWorkspace: async (id) => id === workspace.id ? workspace : null,
  listWorkspaces: async () => [workspace], listModels: async () => [],
  listConversations: async () => starts ? [{ id: 'browser-thread', name: 'Persistent session fixture', status: 'idle' }] : [],
  readConversation: async () => ({ conversation: { id: 'browser-thread', name: 'Persistent session fixture' }, messages: starts ? [
    { role: 'user', text: currentText, turnId, itemId: `user-${starts}` },
    { role: 'assistant', text: output, turnId, itemId: `item-${starts}` },
  ] : [] }),
  workspaceChanges: async () => [], listWorkspaceFiles: async () => ({ entries: [{ kind: 'file', name: 'README.md', path: 'README.md' }] }),
  workspaceBrowseFile: async () => ({ content: 'fixture file readback' }),
  streamNewTurn: run, streamTurn: run,
  interruptTurn: async () => { interrupts++; complete.resolve({ status: 'interrupted' }); },
});
await server.sessions.ready;
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const port = server.address().port, base = `http://127.0.0.1:${port}`;
assert.ok(execFileSync('ss', ['-ltnH', `sport = :${port}`], { encoding: 'utf8' }).includes(`127.0.0.1:${port}`));
assert.equal((await fetch(base + '/api/health')).status, 200);
let browser;
const contexts = [], errors = [];
async function context() { const value = await browser.newContext({ viewport: { width: 390, height: 844 } }); contexts.push(value); value.on('page', (page) => page.on('pageerror', (error) => errors.push(error.message))); return value; }
async function waitForState(page, label) { await page.locator('#chat-status').filter({ hasText: label }).waitFor({ timeout: 15000 }); }
try {
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const first = await context(); let page = await first.newPage();
  await page.goto(base); await page.getByRole('button', { name: 'Open workspace' }).click(); await page.locator('#new-chat').click();
  await page.locator('#prompt').fill('browser durability prompt'); await page.getByRole('button', { name: 'Send message' }).click();
  await waitForState(page, 'Working on VM');
  await page.locator('#message-list').filter({ hasText: 'tick1' }).waitFor();
  await page.locator('#files-tab').click(); await page.getByRole('treeitem', { name: 'README.md' }).click();
  assert.ok((await page.locator('#file-content').innerText()).includes('fixture file readback')); await page.locator('#close-file').click();
  await page.close();
  output += 'missed output\n'; emit({ type: 'delta', text: 'missed output\n', itemId: 'item-1' });
  assert.equal(interrupts, 0); assert.equal(starts, 1);
  page = await first.newPage(); await page.goto(base);
  await page.locator('#message-list').filter({ hasText: 'missed output' }).waitFor();
  assert.equal((await page.locator('.message.user .message-content').allTextContents()).filter((text) => text === 'browser durability prompt').length, 1);
  assert.equal(((await page.locator('#message-list').innerText()).match(/tick1/g) || []).length, 1);
  const second = await context(), other = await second.newPage(); await other.goto(base);
  await other.getByRole('button', { name: 'Open workspace' }).click(); await other.locator('.session-row').first().click();
  await other.locator('#message-list').filter({ hasText: 'missed output' }).waitFor(); assert.equal(starts, 1);
  await other.locator('#stop-turn').click(); await waitForState(other, 'Stopped'); await waitForState(page, 'Stopped');
  assert.equal(interrupts, 1);
  await page.reload(); await waitForState(page, 'Stopped');
  assert.equal(((await page.locator('#message-list').innerText()).match(/tick1/g) || []).length, 1);
  await page.locator('#prompt').fill('recovery fixture'); await page.getByRole('button', { name: 'Send message' }).click(); await waitForState(page, 'Working on VM');
  scopes.failStop = true; complete.resolve({ status: 'completed' });
  await page.locator('#session-recovery').waitFor(); assert.equal(await page.locator('#prompt').isDisabled(), true);
  scopes.failStop = false; await page.locator('#recover-terminate').click(); await waitForState(page, 'Stopped');
  assert.deepEqual(errors, []);
  await page.screenshot({ path: '/tmp/relay-v14-browser-session.png', fullPage: true });
  console.log('PASS: rendered mobile PWA, file view during task, page closure, missed replay, duplicate-free history, two browsers, Stop, reload, and uncertainty recovery.');
} finally {
  complete?.resolve({ status: 'completed' }); scopes.failStop = false;
  await Promise.all([...server.sessions.active.values()].map((entry) => entry.work));
  for (const value of contexts) await value.close(); await browser?.close();
  server.closeAllConnections(); await new Promise((done) => server.close(done)); await server.sessions.close();
  await rm(directory, { recursive: true, force: true });
}
