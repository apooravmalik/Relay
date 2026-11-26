// Opt-in live E2E: requires a disposable workspace and a separately installed Playwright.
// See RELAY_V1_4_SESSION_E2E_TEST_PLAN.md. This starts a real Codex task and writes a test file.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const { RELAY_PLAYWRIGHT_MODULE: modulePath, RELAY_E2E_URL: base, RELAY_E2E_WORKSPACE_ID: workspaceId,
  RELAY_E2E_BROWSER_EXECUTABLE: executablePath } = process.env;
if (!modulePath || !base || !workspaceId || process.env.RELAY_E2E_DISPOSABLE !== '1') {
  throw new Error('Set RELAY_PLAYWRIGHT_MODULE, RELAY_E2E_URL, RELAY_E2E_WORKSPACE_ID and RELAY_E2E_DISPOSABLE=1 for a disposable workspace.');
}
const { chromium } = await import(pathToFileURL(modulePath));
const marker = `relay-e2e-${randomUUID()}`;
const filename = `${marker}.txt`;
const closedMs = Number(process.env.RELAY_E2E_CLOSED_MS || 6000);
const offlineMs = Number(process.env.RELAY_E2E_OFFLINE_MS || 6000);
if (![closedMs, offlineMs].every((value) => Number.isSafeInteger(value) && value >= 0 && value <= 600000)) throw new Error('Browser closure and offline durations must be between 0 and 600000 ms.');
const samples = Math.max(30, Math.ceil((closedMs + offlineMs + 60000) / 2000));
const prompt = `In this disposable workspace run one foreground Python command that writes the numbers 1 through ${samples}, one per line, to ${filename}, flushing each line and sleeping 2 seconds between lines. Wait for the command to finish, then reply exactly ${marker} done. Do not change any other file or start a background process.`;
const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}), args: ['--no-sandbox'] });
const first = await browser.newContext({ viewport: { width: 390, height: 844 } });
const observer = await browser.newContext({ viewport: { width: 390, height: 844 } });
let session, page;
const errors = [];
const timeout = 120000;
async function json(context, url) { const response = await context.request.get(new URL(url, base).href); assert.equal(response.status(), 200, `${url}: HTTP ${response.status()}`); return response.json(); }
async function waitFor(check, description, limit = timeout) {
  const end = Date.now() + limit;
  while (Date.now() < end) { const value = await check(); if (value) return value; await new Promise((resolve) => setTimeout(resolve, 1000)); }
  throw new Error(`Timed out waiting for ${description}`);
}
async function countLines() {
  const response = await observer.request.get(new URL(`/api/workspaces/${workspaceId}/browse-file?path=${encodeURIComponent(filename)}`, base).href);
  if (!response.ok()) return 0;
  const value = await response.json(); return (value.content || '').split(/\\n|\r?\n/).map((line) => line.trim()).filter((line) => /^\d+$/.test(line)).length;
}
async function observeBackend(sessionId) {
  const backendPage = await observer.newPage();
  await backendPage.goto(base, { waitUntil: 'domcontentloaded' });
  await backendPage.evaluate(({ workspaceId, sessionId }) => {
    window.relayEvents = [];
    window.relayStreamError = null;
    void (async () => {
      const res = await fetch(`/api/workspaces/${workspaceId}/sessions/${sessionId}/events?after=0`);
      if (!res.ok) throw new Error(`Event stream HTTP ${res.status}`);
      const reader = res.body.getReader(), decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value || new Uint8Array(), { stream: !done }).replace(/\r/g, '');
        let end;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
          const kind = frame.match(/^event: (.*)$/m)?.[1];
          const data = frame.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
          if (data) window.relayEvents.push({ type: kind, data: JSON.parse(data), at: Date.now() });
        }
        if (done) break;
      }
    })().catch((error) => { window.relayStreamError = error.message; });
  }, { workspaceId, sessionId });
  return backendPage;
}
try {
  page = await first.newPage(); page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  const workspaces = (await json(first, '/api/workspaces')).workspaces;
  const workspace = workspaces.find((item) => item.id === workspaceId);
  assert.ok(workspace, 'Disposable workspace was not listed by the candidate.');
  const existing = (await json(first, `/api/workspaces/${workspaceId}/sessions`)).sessions;
  assert.ok(!existing.some((item) => !['COMPLETED', 'FAILED', 'INTERRUPTED'].includes(item.state)), 'Workspace already has an active or uncertain task.');
  const card = page.locator('article.workspace').filter({ has: page.getByRole('heading', { name: workspace.name, exact: true }) });
  assert.equal(await card.count(), 1, 'Workspace name must uniquely identify a card.');
  await card.getByRole('button', { name: 'Open workspace' }).click({ timeout });
  await page.locator('#new-chat').click({ timeout });
  await page.locator('#prompt').fill(prompt);
  await page.evaluate((text) => {
    window.relayTiming = { clicked: 0, userVisible: 0 };
    new MutationObserver(() => {
      if (!window.relayTiming.userVisible && [...document.querySelectorAll('.message.user .message-content')].some((node) => node.textContent.includes(text))) window.relayTiming.userVisible = Date.now();
    }).observe(document.querySelector('#message-list'), { childList: true, subtree: true, characterData: true });
  }, prompt);
  const accepted = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === `/api/workspaces/${workspaceId}/sessions`, { timeout });
  await page.evaluate(() => { window.relayTiming.clicked = Date.now(); });
  await page.getByRole('button', { name: 'Send message' }).click();
  const response = await accepted; assert.equal(response.status(), 202, 'Session start must be accepted');
  const acceptedAt = Date.now();
  session = (await response.json()).session;
  await page.locator('.message.user .message-content').filter({ hasText: prompt }).waitFor({ timeout });
  const sendTiming = await page.evaluate(() => window.relayTiming);
  assert.ok(sendTiming.userVisible, 'Sent message became visible');
  console.log(`TIMING: Send to accepted ${acceptedAt - sendTiming.clicked} ms; Send to visible user message ${sendTiming.userVisible - sendTiming.clicked} ms`);
  await waitFor(async () => (await countLines()) >= 1, 'the real heartbeat task to write its first line');
  await waitFor(async () => (await page.evaluate(() => JSON.parse(localStorage.getItem('relay-session-selection') || 'null')))?.sessionId === session.id, 'session selection to persist');
  const before = await countLines();
  await page.close();
  const closedAt = Date.now();
  const after = await waitFor(async () => { const n = await countLines(); return Date.now() - closedAt >= closedMs && n >= before + 3 ? n : 0; }, 'heartbeat to advance while the app is closed', closedMs + 45000);
  console.log(`PASS: app closed for ${Date.now() - closedAt} ms while heartbeat advanced from ${before} to ${after}; session ${session.id}`);
  page = await first.newPage(); page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.locator('#message-list').getByText(prompt, { exact: true }).waitFor({ timeout });
  const selection = await page.evaluate(() => JSON.parse(localStorage.getItem('relay-session-selection')));
  assert.equal(selection.sessionId, session.id, 'Reopened the original session');
  const beforeOffline = await countLines();
  await first.setOffline(true);
  const offlineAt = Date.now();
  await page.locator('#chat-status').filter({ hasText: 'Offline' }).waitFor({ timeout: 30000 });
  const duringOffline = await waitFor(async () => { const n = await countLines(); return Date.now() - offlineAt >= offlineMs && n >= beforeOffline + 3 ? n : 0; }, 'heartbeat to advance while the browser is offline', offlineMs + 45000);
  await first.setOffline(false);
  await page.locator('#chat-status').filter({ hasText: /Working|Completed/ }).waitFor({ timeout: 30000 });
  assert.equal((await page.evaluate(() => JSON.parse(localStorage.getItem('relay-session-selection')))).sessionId, session.id);
  console.log(`PASS: browser went offline while heartbeat advanced from ${beforeOffline} to ${duringOffline}, then reconnected to the same session`);
  const other = await observer.newPage(); await other.goto(base, { waitUntil: 'domcontentloaded' });
  await other.evaluate((selection) => localStorage.setItem('relay-session-selection', JSON.stringify(selection)), selection);
  await other.reload({ waitUntil: 'domcontentloaded' });
  await other.locator('#message-list').getByText(prompt, { exact: true }).waitFor({ timeout });
  const backendPage = await observeBackend(session.id);
  for (const tab of [page, other]) await tab.evaluate(() => {
    window.relayRenderTimes = [];
    const record = () => { const text = [...document.querySelectorAll('.message.assistant .message-content')].map((node) => node.dataset.markdown || '').join(''); window.relayRenderTimes.push({ text, at: Date.now() }); };
    new MutationObserver(record).observe(document.querySelector('#message-list'), { childList: true, subtree: true, characterData: true, attributes: true });
    record();
  });
  await waitFor(async () => (await json(observer, `/api/workspaces/${workspaceId}/sessions/${session.id}`)).session.state === 'COMPLETED', 'task completion');
  await page.locator('#chat-status').filter({ hasText: 'Completed' }).waitFor({ timeout });
  await other.locator('#chat-status').filter({ hasText: 'Completed' }).waitFor({ timeout });
  await page.locator('.message.assistant').filter({ hasText: `${marker} done` }).waitFor({ timeout });
  await other.locator('.message.assistant').filter({ hasText: `${marker} done` }).waitFor({ timeout });
  const events = await waitFor(async () => {
    const result = await backendPage.evaluate(() => ({ events: window.relayEvents, error: window.relayStreamError }));
    if (result.error) throw new Error(result.error);
    return result.events.some((event) => event.type === 'status' && event.data.state === 'COMPLETED') ? result.events : null;
  }, 'backend terminal event');
  const deltas = events.filter((event) => event.type === 'delta');
  const backendText = deltas.map((event) => event.data.text).join('');
  assert.ok(backendText.includes(`${marker} done`), 'Backend emitted the final reply');
  for (const [index, tab] of [page, other].entries()) {
    const rendered = await tab.locator('.message.assistant .message-content').evaluateAll((nodes) => nodes.map((node) => node.dataset.markdown || '').join(''));
    assert.equal(rendered, backendText, `Browser ${index + 1} rendered the backend deltas in order`);
    const records = await tab.evaluate(() => window.relayRenderTimes);
    const snapshots = [...new Set(records.map((entry) => entry.text).filter(Boolean))];
    assert.ok(snapshots.length, `Browser ${index + 1} observed streamed output`);
    assert.ok(snapshots.every((text) => backendText.startsWith(text)), `Browser ${index + 1} rendered only ordered backend output`);
    const finalRender = records.find((entry) => entry.text === backendText);
    assert.ok(finalRender, `Browser ${index + 1} recorded the complete backend output`);
    console.log(`PASS: browser ${index + 1} observed ${snapshots.length} ordered streamed text states`);
    console.log(`TIMING: browser ${index + 1} complete output vs last backend delta ${finalRender.at - deltas.at(-1).at} ms (negative means browser received it first)`);
  }
  console.log(`PASS: ${deltas.length} backend text events matched both browser transcripts in order`);
  assert.equal((await countLines()), samples, 'All heartbeat lines were written');
  assert.equal(await page.locator('.message.user .message-content').filter({ hasText: prompt }).count(), 1, 'Prompt is not duplicated after reconnect');
  const sessions = (await json(observer, `/api/workspaces/${workspaceId}/sessions`)).sessions;
  assert.equal(sessions.filter((item) => item.id === session.id).length, 1);
  assert.deepEqual(errors, []);
  console.log(`PASS: same session reopened in two browsers, finished, and displayed its reply; heartbeat file ${filename}`);
} finally {
  if (session) {
    try {
      const url = `/api/workspaces/${workspaceId}/sessions/${session.id}`;
      const state = (await json(observer, url)).session.state;
      if (['STARTING', 'RUNNING', 'CANCEL_REQUESTED'].includes(state)) {
        await observer.request.post(new URL(`${url}/stop`, base).href);
        await waitFor(async () => !['STARTING', 'RUNNING', 'CANCEL_REQUESTED'].includes((await json(observer, url)).session.state), 'test task to stop', 45000);
      }
    } catch { console.error(`Could not verify cleanup of test session ${session.id}; inspect it before retrying.`); }
  }
  await first.close(); await observer.close(); await browser.close();
  if (session) console.log(`Test session ${session.id}; test file ${filename} remains in the disposable workspace.`);
}
