// Opt-in real SSH + PWA test; only for an isolated candidate and disposable workspace.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const { RELAY_PLAYWRIGHT_MODULE: modulePath, RELAY_E2E_URL: base, RELAY_E2E_ROOT_ID: rootId,
  RELAY_E2E_VM: vm, RELAY_E2E_BROWSER_EXECUTABLE: executablePath, RELAY_REMOTE_HELPER: installedHelper,
  RELAY_E2E_REMOTE_WORKSPACE_ROOT: fixtureRoot } = process.env;
if (!modulePath || !base || !rootId || !vm || process.env.RELAY_E2E_DISPOSABLE !== '1' ||
    !installedHelper?.startsWith('/')) {
  throw new Error('Set the candidate URL, root ID, SSH alias, Playwright module, absolute RELAY_REMOTE_HELPER, and RELAY_E2E_DISPOSABLE=1.');
}
const exec = promisify(execFile), { chromium } = await import(pathToFileURL(modulePath));
const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}), args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await context.newPage();
const timeout = 120000, marker = `relay-guard-${randomUUID()}`, filename = `${marker}.txt`;
const parent = await mkdtemp(path.join(tmpdir(), 'relay-live-guard-'));
const gitMode = process.env.RELAY_E2E_GIT === '1';
let session, workspace, childWorkspace, stopped = false;
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
async function sshPython(code, ...args) {
  const command = ['python3', '-c', code, ...args].map(quote).join(' ');
  return (await exec('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', vm, command], { timeout: 30000 })).stdout.trim();
}
async function waitFor(check, description, limit = timeout) {
  const end = Date.now() + limit;
  while (Date.now() < end) { const value = await check(); if (value) return value; await new Promise((r) => setTimeout(r, 1000)); }
  throw new Error(`Timed out waiting for ${description}`);
}
async function api(url) { const response = await context.request.get(new URL(url, base).href); assert.equal(response.status(), 200); return response.json(); }
async function heartbeat() {
  const response = await context.request.get(new URL(`/api/workspaces/${workspace.id}/browse-file?path=${encodeURIComponent(filename)}`, base).href);
  if (!response.ok()) return 0;
  return ((await response.json()).content || '').split(/\\n|\r?\n/).filter((line) => /^\d+$/.test(line.trim())).length;
}
async function transfer(id = workspace.id) {
  try { const value = await exec('./relay', ['pull', '--workspace', id, '--into', parent, '--vm', vm, '--json'], { cwd: process.cwd(), timeout: 120000 }); return { code: 0, output: value.stdout }; }
  catch (error) { return { code: error.code, output: error.stdout || '', error: error.stderr || '' }; }
}
try {
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  const roots = (await api('/api/project-roots')).roots;
  assert.ok(roots.some((item) => item.id === rootId), 'Candidate project root unavailable');
  const created = await context.request.post(new URL('/api/projects', base).href, { data: { action: 'create', rootId, name: marker } });
  assert.equal(created.status(), 201); workspace = (await created.json()).workspace;
  if (gitMode) {
    assert.ok(fixtureRoot?.startsWith('/'), 'Set RELAY_E2E_REMOTE_WORKSPACE_ROOT to the absolute Git fixture root.');
    const remotePath = `${fixtureRoot}/${marker}`;
    await sshPython("from pathlib import Path; import subprocess,sys; p=Path(sys.argv[1]); (p/'base.txt').write_text('fixture\\n'); subprocess.run(['git','-C',str(p),'init','-q'],check=True); subprocess.run(['git','-C',str(p),'add','base.txt'],check=True); subprocess.run(['git','-C',str(p),'-c','user.name=Relay Fixture','-c','user.email=fixture@example.invalid','commit','-qm','fixture'],check=True)", remotePath);
  }
  const childCreated = await context.request.post(new URL('/api/projects', base).href, { data: { action: 'create', rootId, parentPath: marker, name: 'nested' } });
  assert.equal(childCreated.status(), 201); childWorkspace = (await childCreated.json()).workspace;
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('article.workspace').filter({ has: page.getByRole('heading', { name: workspace.name, exact: true }) }).getByRole('button', { name: 'Open workspace' }).click({ timeout });
  await page.locator('#new-chat').click({ timeout });
  await page.locator('#prompt').fill(`In this disposable workspace run a foreground Python process that writes the numbers 1 through 90 one at a time to ${filename}, flushing each write and sleeping 3 seconds between writes. Wait for it to finish. Do not modify any other files or launch a background process.`);
  const accepted = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === `/api/workspaces/${workspace.id}/sessions`, { timeout });
  await page.getByRole('button', { name: 'Send message' }).click();
  const start = await accepted; assert.equal(start.status(), 202); session = (await start.json()).session;
  await waitFor(async () => (await heartbeat()) >= 1, 'real Codex heartbeat');
  const overlapping = await context.request.post(new URL(`/api/workspaces/${childWorkspace.id}/sessions`, base).href, {
    data: { text: 'This task must be refused.', createdAt: Date.now(), idempotencyKey: randomUUID() },
  });
  assert.equal(overlapping.status(), 409, 'Nested task must be refused while its parent is active');
  assert.match((await overlapping.json()).error, /overlapping workspace/i);
  console.log('PASS: candidate refused a nested task while its parent task was active');
  const denied = await transfer();
  assert.notEqual(denied.code, 0, 'Handoff must fail while session is active');
  assert.match(denied.output + denied.error, /source_busy/i, 'Refusal must come from session guard');
  console.log('PASS: SSH capture refused by candidate session guard while task was writing');
  const nestedDenied = await transfer(childWorkspace.id);
  assert.notEqual(nestedDenied.code, 0, 'Nested handoff must fail while parent session is active');
  assert.match(nestedDenied.output + nestedDenied.error, gitMode ? /unsupported_git_state/i : /source_busy/i,
    gitMode ? 'Git subdirectory imports must be refused' : 'Nested refusal must come from session guard');
  console.log(gitMode ? 'PASS: nested Git subdirectory import was refused' : 'PASS: SSH capture of the nested workspace refused while its parent task was active');
  await page.locator('#stop-turn').click({ timeout });
  await page.close();
  await waitFor(async () => {
    const state = (await api(`/api/workspaces/${workspace.id}/sessions/${session.id}`)).session.state;
    if (['FAILED', 'COMPLETED', 'UNCERTAIN'].includes(state)) throw new Error(`Unexpected terminal state ${state}`);
    return state === 'INTERRUPTED';
  }, 'confirmed stop');
  stopped = true;
  const count = await heartbeat(); await new Promise((r) => setTimeout(r, 5000));
  assert.equal(await heartbeat(), count, 'File must stop changing after confirmed Stop');
  const reopened = await context.newPage();
  await reopened.goto(base, { waitUntil: 'domcontentloaded' });
  await reopened.locator('#chat-status').filter({ hasText: 'Stopped' }).waitFor({ timeout });
  assert.equal((await reopened.evaluate(() => JSON.parse(localStorage.getItem('relay-session-selection')))).sessionId, session.id);
  const imported = await transfer();
  assert.equal(imported.code, 0, imported.output + imported.error);
  if (gitMode) {
    const destination = JSON.parse(imported.output).destination;
    const remoteHead = await sshPython("import subprocess,sys; print(subprocess.check_output(['git','-C',sys.argv[1],'rev-parse','HEAD'],text=True).strip())", `${fixtureRoot}/${marker}`);
    const localHead = (await exec('git', ['-C', destination, 'rev-parse', 'HEAD'])).stdout.trim();
    assert.equal(localHead, remoteHead, 'Imported Git HEAD must match the VM');
    assert.equal((await exec('git', ['-C', destination, 'show', ':base.txt'])).stdout, 'fixture\n');
    console.log('PASS: Git import preserved the VM commit and index after Stop');
  }
  console.log(`PASS: task stopped after browser closure, reopened with the same status, and SSH import succeeded; retained local fixture ${parent}`);
} finally {
  if (session && !stopped) {
    try {
      await context.request.post(new URL(`/api/workspaces/${workspace.id}/sessions/${session.id}/stop`, base).href);
      const state = await waitFor(async () => {
        const value = (await api(`/api/workspaces/${workspace.id}/sessions/${session.id}`)).session.state;
        return ['COMPLETED', 'FAILED', 'INTERRUPTED', 'UNCERTAIN'].includes(value) ? value : null;
      }, 'test task cleanup', 45000);
      if (state === 'UNCERTAIN') console.error(`Test session ${session.id} needs recovery before retrying.`);
    } catch { console.error(`Could not verify cleanup of test session ${session.id}; inspect it before retrying.`); }
  }
  await context.close(); await browser.close();
  if (workspace) console.log(`Fixture workspace ${workspace.id}; session ${session?.id || 'not started'}.`);
}
