// Opt-in real Codex preview lifecycle test. Creates a private route and test workspace.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';

const { RELAY_PLAYWRIGHT_MODULE: modulePath, RELAY_E2E_URL: base, RELAY_E2E_ROOT_ID: rootId,
  RELAY_E2E_VM: vm, RELAY_E2E_BROWSER_EXECUTABLE: executablePath } = process.env;
if (!modulePath || !base || !rootId || !vm || process.env.RELAY_E2E_DISPOSABLE !== '1') throw new Error('Set the Playwright module, candidate URL, disposable root ID, SSH alias and RELAY_E2E_DISPOSABLE=1.');
const exec = promisify(execFile), quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
const remote = async (...args) => (await exec('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', vm, args.map(quote).join(' ')], { timeout: 30000 })).stdout.trim();
const until = async (work, label, ms = 120000) => { const end = Date.now() + ms; while (Date.now() < end) { try { const value = await work(); if (value) return value; } catch {} await sleep(1000); } throw new Error(`Timed out waiting for ${label}`); };
const { chromium } = await import(pathToFileURL(modulePath));
const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}), args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
let page = await context.newPage(), workspace, session, port, stopped = false;
try {
  port = Number(await remote('python3', '-c', "import socket; s=socket.socket(); s.bind(('127.0.0.1',0)); print(s.getsockname()[1]); s.close()"));
  assert.ok(port >= 1024 && port <= 65535);
  const before = JSON.parse(await remote('tailscale', 'serve', 'status', '--json'));
  assert.ok(!before.TCP?.[String(port)] && !Object.keys(before.Web || {}).some((host) => host.endsWith(`:${port}`)), 'Test port already has a Tailnet route');
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  const created = await context.request.post(new URL('/api/projects', base).href, { data: { action: 'create', rootId, name: `relay-preview-${randomUUID()}` } });
  assert.equal(created.status(), 201); workspace = (await created.json()).workspace;
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('article.workspace').filter({ has: page.getByRole('heading', { name: workspace.name, exact: true }) }).getByRole('button', { name: 'Open workspace' }).click({ timeout: 120000 });
  await page.locator('#new-chat').click({ timeout: 120000 });
  await page.locator('#prompt').fill(`In this disposable workspace, start a foreground Python HTTP server bound only to 127.0.0.1 on port ${port}. Keep it running for at least three minutes until stopped. Do not create or modify any files, and do not background or detach it.`);
  const accepted = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === `/api/workspaces/${workspace.id}/sessions`, { timeout: 120000 });
  await page.getByRole('button', { name: 'Send message' }).click();
  const response = await accepted; assert.equal(response.status(), 202); session = (await response.json()).session;
  const listening = async () => (await remote('python3', '-c', "import socket,sys; s=socket.socket(); s.settimeout(.5); r=s.connect_ex(('127.0.0.1',int(sys.argv[1]))); s.close(); print('yes' if r==0 else 'no')", port)) === 'yes';
  await until(listening, 'task-owned loopback server');
  await page.locator('#open-preview').click(); await page.locator('#preview-port').fill(String(port));
  await page.locator('#preview-form button[type=submit]').click();
  const link = page.locator('#preview-link'); await link.waitFor({ timeout: 60000 });
  const previewUrl = await link.getAttribute('href'); assert.ok(previewUrl);
  const preview = await context.request.get(previewUrl, { timeout: 30000 }); assert.equal(preview.status(), 200);
  await page.locator('#close-preview').click();
  await until(async () => (await page.evaluate(() => JSON.parse(localStorage.getItem('relay-session-selection') || 'null')))?.sessionId === session.id, 'session selection');
  await page.close();
  assert.equal((await context.request.get(previewUrl, { timeout: 30000 })).status(), 200, 'Preview remains available while browser is closed');
  page = await context.newPage(); await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.locator('#stop-turn').click({ timeout: 120000 });
  await until(async () => { const r = await context.request.get(new URL(`/api/workspaces/${workspace.id}/sessions/${session.id}`, base).href); const value = (await r.json()).session.state; if (['COMPLETED', 'FAILED', 'UNCERTAIN'].includes(value)) throw new Error(`Unexpected state: ${value}`); return value === 'INTERRUPTED'; }, 'confirmed Stop');
  stopped = true;
  assert.equal(await listening(), false, 'Task-owned server must stop before terminal status');
  const after = JSON.parse(await remote('tailscale', 'serve', 'status', '--json'));
  assert.ok(!after.TCP?.[String(port)] && !Object.keys(after.Web || {}).some((host) => host.endsWith(`:${port}`)), 'Session-owned preview must be removed');
  for (const [key, value] of Object.entries(before.TCP || {})) assert.deepEqual(after.TCP?.[key], value, `Existing Tailnet port ${key} changed`);
  for (const [key, value] of Object.entries(before.Web || {})) assert.deepEqual(after.Web?.[key], value, `Existing Tailnet route ${key} changed`);
  console.log(`PASS: private preview on ${port} survived browser closure and was removed with the server before confirmed Stop.`);
} finally {
  if (session && !stopped) {
    try {
      const url = new URL(`/api/workspaces/${workspace.id}/sessions/${session.id}`, base).href;
      await context.request.post(`${url}/stop`);
      const state = await until(async () => { const r = await context.request.get(url); if (!r.ok()) return null; const value = (await r.json()).session.state; return ['COMPLETED','FAILED','INTERRUPTED','UNCERTAIN'].includes(value) ? value : null; }, 'test task cleanup', 45000);
      if (state === 'UNCERTAIN') console.error('Preview test session needs recovery; do not remove its route manually.');
    } catch { console.error(`Could not verify cleanup for preview test session ${session.id}; inspect it before retrying.`); }
  }
  await context.close(); await browser.close();
  if (workspace) console.log(`Disposable workspace ${workspace.id}; session ${session?.id || 'not started'}; port ${port}.`);
}
