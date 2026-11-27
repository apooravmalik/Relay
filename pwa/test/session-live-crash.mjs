// Opt-in real-VM crash test. Creates and kills only its own transient service.
// Never run against the live or shared candidate service.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';

const { RELAY_PLAYWRIGHT_MODULE: modulePath, RELAY_E2E_VM: vm, RELAY_E2E_REMOTE_TEST_ROOT: testRoot,
  RELAY_E2E_REMOTE_CHECKOUT: checkout, RELAY_E2E_BROWSER_EXECUTABLE: executablePath } = process.env;
if (!modulePath || !vm || !testRoot?.startsWith('/') || !checkout?.startsWith('/') || process.env.RELAY_E2E_DISPOSABLE !== '1' || process.env.RELAY_E2E_CRASH_SERVICE !== '1') {
  throw new Error('Set Playwright module, SSH alias, absolute remote test root and checkout, RELAY_E2E_DISPOSABLE=1, and RELAY_E2E_CRASH_SERVICE=1.');
}
const exec = promisify(execFile), quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
const ssh = async (...args) => (await exec('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', vm, args.map(quote).join(' ')], { timeout: 30000 })).stdout.trim();
const until = async (work, label, ms = 60000) => { const end = Date.now() + ms; while (Date.now() < end) { try { const value = await work(); if (value) return value; } catch {} await sleep(500); } throw new Error(`Timed out waiting for ${label}`); };
const { chromium } = await import(pathToFileURL(modulePath));
const token = randomUUID().replaceAll('-', ''), unit = `relay-e2e-crash-${token}`;
let remote, tunnel, browser, context, page, session, workspace, started = false;
try {
  remote = await ssh('python3', '-c', "import tempfile,sys; from pathlib import Path; p=Path(sys.argv[1]); assert p.is_dir(); root=Path(tempfile.mkdtemp(prefix='crash-e2e-',dir=p)); (root/'workspace').mkdir(); print(root)", testRoot);
  const helperSettings = [
    `RELAY_CONTROLLER_STATE_DIR=${quote(`${remote}/controller`)}`,
    `RELAY_WORKSPACE_REGISTRY_FILE=${quote(`${remote}/registry.json`)}`,
    `RELAY_WORKSPACE_ROOTS=${quote(`${remote}/workspace`)}`,
  ].join('\n') + '\n';
  await ssh('python3', '-c', "import sys; from pathlib import Path; p=Path(sys.argv[1]); (p/'relay-handoff').symlink_to(sys.argv[2]); (p/'relay-handoff.env').write_text(sys.argv[3])", remote, `${checkout}/deploy/relay-handoff`, helperSettings);
  const remotePort = await ssh('python3', '-c', "import socket; s=socket.socket(); s.bind(('127.0.0.1',0)); print(s.getsockname()[1]); s.close()");
  const localPort = await new Promise((resolve, reject) => { const server = createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); }); });
  const user = await ssh('id', '-un');
  const service = ['sudo', '-n', 'systemd-run', `--unit=${unit}`, `--property=User=${user}`, `--property=Group=${user}`, '--property=Delegate=yes', '--property=Restart=no', `--working-directory=${checkout}`,
    `--setenv=RELAY_ALLOW_LOCAL_DEV=1`, `--setenv=RELAY_PWA_HOST=127.0.0.1`, `--setenv=RELAY_PWA_PORT=${remotePort}`,
    `--setenv=RELAY_CONTROLLER_STATE_DIR=${remote}/controller`, `--setenv=RELAY_WORKSPACE_ROOTS=${remote}/workspace`,
    `--setenv=RELAY_WORKSPACE_REGISTRY_FILE=${remote}/registry.json`, `--setenv=RELAY_PREFERENCES_FILE=${remote}/preferences.json`,
    '/usr/local/bin/node', `${checkout}/pwa/server.mjs`];
  started = true; await ssh(...service);
  tunnel = spawn('ssh', ['-N', '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes', '-o', 'ConnectTimeout=8', '-L', `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`, vm], { stdio: ['ignore', 'ignore', 'pipe'] });
  const base = `http://127.0.0.1:${localPort}`;
  await until(async () => (await fetch(`${base}/api/health`)).ok, 'isolated controller');
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}), args: ['--no-sandbox'] });
  context = await browser.newContext({ viewport: { width: 390, height: 844 } }); page = await context.newPage();
  await page.goto(base); const listing = await (await context.request.get(`${base}/api/workspaces`)).json();
  assert.equal(listing.workspaces.length, 1, 'Only the isolated workspace may be visible'); workspace = listing.workspaces[0];
  await page.getByRole('button', { name: 'Open workspace' }).click(); await page.locator('#new-chat').click();
  const marker = `crash-${token}.txt`;
  await page.locator('#prompt').fill(`In this disposable workspace run a foreground Python task for at least four minutes. Append the next integer to ${marker} every three seconds and flush each write. Do not modify other files or start background processes.`);
  const accepted = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === `/api/workspaces/${workspace.id}/sessions`, { timeout: 120000 });
  await page.getByRole('button', { name: 'Send message' }).click(); const response = await accepted;
  assert.equal(response.status(), 202); session = (await response.json()).session;
  const heartbeat = async () => { const result = await context.request.get(`${base}/api/workspaces/${workspace.id}/browse-file?path=${encodeURIComponent(marker)}`); return result.ok() ? ((await result.json()).content || '').length : 0; };
  await until(async () => (await heartbeat()) > 0, 'real Codex heartbeat', 120000);
  await until(async () => (await page.evaluate(() => JSON.parse(localStorage.getItem('relay-session-selection') || 'null')))?.sessionId === session.id, 'persisted session selection');
  const scopeProof = "import json,sqlite3,sys; from pathlib import Path; c=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True); r=c.execute('select scope,turn_id from sessions where id=?',(sys.argv[2],)).fetchone(); s=json.loads(r[0]); p=Path(s['directory']); assert s.get('armed') and r[1] and p.parent.name==sys.argv[3] and str(p.stat().st_ino)==s['inode'] and 'populated 1' in (p/'cgroup.events').read_text(); print('scope verified')";
  assert.equal(await ssh('python3', '-c', scopeProof, `${remote}/controller/sessions/sessions.sqlite`, session.id, `${unit}.service`), 'scope verified');
  await ssh('sudo', '-n', 'systemctl', 'kill', '--kill-who=main', '--signal=SIGKILL', `${unit}.service`);
  await until(async () => (await ssh('systemctl', 'is-active', `${unit}.service`).catch(() => 'inactive')) !== 'active', 'controller crash');
  const destination = await mkdtemp(path.join(tmpdir(), 'relay-crash-import-'));
  const env = { ...process.env, RELAY_REMOTE_HELPER: `${remote}/relay-handoff` };
  delete env.RELAY_REMOTE_CONTROLLER_STATE_DIR;
  delete env.RELAY_REMOTE_WORKSPACE_REGISTRY_FILE;
  delete env.RELAY_REMOTE_WORKSPACE_ROOTS;
  let transfer; try { transfer = await exec('./relay', ['pull', '--workspace', workspace.id, '--into', destination, '--vm', vm, '--json'], { cwd: process.cwd(), env, timeout: 120000 }); }
  catch (error) { transfer = { code: error.code, stdout: error.stdout || '', stderr: error.stderr || '' }; }
  assert.ok(transfer.code, 'SSH import must fail while the controller is absent');
  assert.match((transfer.stdout || '') + (transfer.stderr || ''), /source_busy/i);
  await ssh('sudo', '-n', 'systemctl', 'restart', `${unit}.service`);
  await until(async () => (await fetch(`${base}/api/health`)).ok, 'controller restart');
  await page.reload({ waitUntil: 'domcontentloaded' });
  const state = await until(async () => { const r = await context.request.get(`${base}/api/workspaces/${workspace.id}/sessions/${session.id}`); return r.ok() ? (await r.json()).session.state : null; }, 'persisted session');
  assert.ok(['UNCERTAIN', 'INTERRUPTED', 'FAILED'].includes(state), `Unexpected state after crash: ${state}`);
  if (state === 'UNCERTAIN') {
    await page.locator('#session-recovery').waitFor({ timeout: 60000 });
    assert.equal(await page.locator('#prompt').isDisabled(), true);
    const blocked = await context.request.post(`${base}/api/workspaces/${workspace.id}/sessions`, { data: { text: 'Must be blocked', createdAt: Date.now(), idempotencyKey: randomUUID() } });
    assert.equal(blocked.status(), 409);
    const [result] = await Promise.all([
      page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname.endsWith(`/sessions/${session.id}/recovery`), { timeout: 20000 }),
      page.locator('#recover-recheck').click({ timeout: 10000 }),
    ]);
    const recoveryData = await result.json();
    if (result.status() === 409) {
      assert.match(recoveryData.error, /not proven stopped/i, 'A refused recheck must explain the missing stop proof');
      await page.locator('#recovery-message').filter({ hasText: 'not proven stopped' }).waitFor({ timeout: 30000 });
      assert.equal(await page.locator('#prompt').isDisabled(), true);
      let stillBlocked;
      try { stillBlocked = await exec('./relay', ['pull', '--workspace', workspace.id, '--into', destination, '--vm', vm, '--json'], { cwd: process.cwd(), env, timeout: 120000 }); }
      catch (error) { stillBlocked = { code: error.code, stdout: error.stdout || '', stderr: error.stderr || '' }; }
      assert.ok(stillBlocked.code, 'SSH import must remain blocked after an unsuccessful recheck');
      assert.match((stillBlocked.stdout || '') + (stillBlocked.stderr || ''), /source_busy/i);
    } else {
      assert.equal(result.status(), 200);
      assert.equal(recoveryData.evidence.stopped, true, 'Recovery may succeed only with verified stop evidence');
      assert.equal(recoveryData.session.state, 'INTERRUPTED');
      await page.locator('#chat-status').filter({ hasText: 'Stopped' }).waitFor({ timeout: 30000 });
    }
  } else await page.locator('#chat-status').filter({ hasText: /Stopped|Failed/ }).waitFor({ timeout: 60000 });
  const sessions = (await (await context.request.get(`${base}/api/workspaces/${workspace.id}/sessions`)).json()).sessions;
  assert.equal(sessions.length, 1, 'The prompt must not be repeated on restart');
  await page.screenshot({ path: '/tmp/relay-live-crash-pass.png' });
  console.log(`PASS: isolated real VM crash blocked SSH while down and reopened the same session as ${state} without replay.`);
} catch (error) {
  if (page && !page.isClosed()) {
    try {
      await page.screenshot({ path: '/tmp/relay-live-crash-failure.png' });
      console.error('Crash-test browser status:', await page.locator('#chat-status').innerText());
      console.error('Recovery message:', await page.locator('#recovery-message').innerText());
      console.error('Screenshot: /tmp/relay-live-crash-failure.png');
    } catch { /* Preserve the original failure. */ }
  }
  throw error;
} finally {
  if (started) { try { await ssh('sudo', '-n', 'systemctl', 'stop', `${unit}.service`); } catch (error) { console.error(`Could not stop test unit ${unit}.service: ${error.message}`); process.exitCode = 1; } }
  await context?.close(); await browser?.close();
  if (tunnel && tunnel.exitCode === null && tunnel.signalCode === null) tunnel.kill('SIGTERM');
  if (remote) console.log(`Retained isolated crash fixture ${remote}; unit ${unit}.service; session ${session?.id || 'not started'}.`);
}
