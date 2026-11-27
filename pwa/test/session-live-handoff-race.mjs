// Opt-in regression: an SSH handoff gate must prevent a browser task from starting.
// Uses only a newly created candidate workspace; leaves it registered for inspection.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const { RELAY_PLAYWRIGHT_MODULE: modulePath, RELAY_E2E_URL: base, RELAY_E2E_ROOT_ID: rootId,
  RELAY_E2E_VM: vm, RELAY_E2E_BROWSER_EXECUTABLE: executablePath, RELAY_E2E_REMOTE_CONTROLLER_STATE_DIR: state } = process.env;
if (!modulePath || !base || !rootId || !vm || !state || !state.startsWith('/') || process.env.RELAY_E2E_DISPOSABLE !== '1') {
  throw new Error('Set the Playwright module, candidate URL, disposable root ID, SSH alias, remote controller state, and RELAY_E2E_DISPOSABLE=1.');
}
// The configured path is shell-quoted because it is interpreted by SSH's remote shell.
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const gateFile = `${state}/handoff-locks/workspace-hierarchy.lock`;
const { chromium } = await import(pathToFileURL(modulePath));
const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}), args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await context.newPage();
let workspace, session, gate;
try {
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  const created = await context.request.post(new URL('/api/projects', base).href, { data: { action: 'create', rootId, name: `relay-race-${randomUUID()}` } });
  assert.equal(created.status(), 201); workspace = (await created.json()).workspace;
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('article.workspace').filter({ has: page.getByRole('heading', { name: workspace.name, exact: true }) }).getByRole('button', { name: 'Open workspace' }).click({ timeout: 120000 });
  await page.locator('#new-chat').click({ timeout: 120000 });
  gate = spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', vm, `flock -x ${quote(gateFile)} sh -c 'printf "ready\\n"; cat >/dev/null'`], { stdio: ['pipe', 'pipe', 'pipe'] });
  const [ready] = await Promise.race([once(gate.stdout, 'data'), once(gate, 'exit').then(() => { throw new Error('SSH handoff gate exited before becoming ready.'); })]);
  assert.equal(String(ready).trim(), 'ready');
  await page.locator('#prompt').fill('Reply exactly: handoff gate test. Do not modify files.');
  const responsePromise = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === `/api/workspaces/${workspace.id}/sessions`, { timeout: 30000 });
  await page.getByRole('button', { name: 'Send message' }).click();
  const response = await responsePromise;
  const data = await response.json(); session = data.session;
  assert.equal(response.status(), 409, 'A task must not start while an SSH handoff holds the workspace coordination gate.');
  await page.locator('#chat-status').filter({ hasText: 'attention' }).waitFor({ timeout: 30000 });
  console.log('PASS: the PWA refused a task while the handoff gate was held.');
} finally {
  if (gate) { gate.stdin.end(); if (gate.exitCode === null && gate.signalCode === null) await once(gate, 'exit'); }
  if (session) {
    try {
      const url = new URL(`/api/workspaces/${workspace.id}/sessions/${session.id}`, base).href;
      await context.request.post(`${url}/stop`);
      const deadline = Date.now() + 45000;
      let state;
      while (Date.now() < deadline) {
        const response = await context.request.get(url);
        if (response.ok()) state = (await response.json()).session.state;
        if (['COMPLETED', 'FAILED', 'INTERRUPTED', 'UNCERTAIN'].includes(state)) break;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      console.log(`Unexpectedly accepted session ${session.id}; final observed state: ${state || 'unknown'}.`);
      if (!['COMPLETED', 'FAILED', 'INTERRUPTED'].includes(state)) console.error('Inspect the test session before retrying.');
    } catch { console.error(`Could not verify cleanup of test session ${session.id}; inspect it before retrying.`); }
  }
  await context.close(); await browser.close();
  if (workspace) console.log(`Disposable workspace: ${workspace.id}`);
}
