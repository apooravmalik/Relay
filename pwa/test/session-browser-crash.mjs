// Opt-in Playwright crash regression. Uses a disposable local controller and an
// injected process fixture; never signals the VM or a real user task.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

if (!process.env.RELAY_PLAYWRIGHT_MODULE) throw new Error('Set RELAY_PLAYWRIGHT_MODULE to an installed Playwright index.mjs.');
const { chromium } = await import(pathToFileURL(process.env.RELAY_PLAYWRIGHT_MODULE));
const directory = await mkdtemp(path.join(tmpdir(), 'relay-browser-crash-'));
const serverModule = new URL('../server.mjs', import.meta.url).href;
const scopesModule = new URL('./fixtures/session-fixtures.mjs', import.meta.url).href;
const writerCode = "const fs=require('node:fs');setInterval(()=>fs.appendFileSync(process.argv[1]+'/heartbeat','x'),100)";
const childCode = `import {createRelayServer} from ${JSON.stringify(serverModule)};
import {FixtureScopes} from ${JSON.stringify(scopesModule)};
import {spawn} from 'node:child_process';import fs from 'node:fs';
const root=process.argv[1],port=Number(process.argv[2]);
const workspace={id:'crash-fixture',name:'Crash fixture',path:root,status:'ready',gitAvailable:false};
const server=createRelayServer({allowLocalDevelopment:true,sessionOptions:{stateDirectory:root+'/controller',scopes:new FixtureScopes()},
 listWorkspaces:async()=>[workspace],findWorkspace:async(id)=>id===workspace.id?workspace:null,listModels:async()=>[],
 listConversations:async()=>[],readConversation:async()=>({conversation:{id:'crash-thread',name:'Crash fixture'},messages:[]}),workspaceChanges:async()=>[],
 streamNewTurn:async({onEvent,spawnOptions})=>{
  const child=spawn(process.execPath,['-e',${JSON.stringify(writerCode)},root],{detached:true,stdio:'ignore'});child.unref();
  const fields=fs.readFileSync('/proc/'+child.pid+'/stat','utf8').split(')').slice(1).join(')').trim().split(/\\s+/);
  fs.writeFileSync(root+'/writer.json',JSON.stringify({pid:child.pid,start:fields[19]}));fs.appendFileSync(root+'/starts','1\\n');
  spawnOptions.onInitialized();onEvent({type:'conversation',conversation:{id:'crash-thread',name:'Crash fixture'}});
  onEvent({type:'turn',threadId:'crash-thread',turnId:'crash-turn'});onEvent({type:'delta',text:'Fixture writing',itemId:'fixture-item'});
  return new Promise(()=>{});
 },interruptTurn:async()=>{}});
await server.sessions.ready;await new Promise(resolve=>server.listen(port,'127.0.0.1',resolve));console.log(JSON.stringify({port:server.address().port}));`;
let controller, browser, context, writer;
const timeout = 30000;
async function until(work, description, limit = timeout) {
  const end = Date.now() + limit;
  while (Date.now() < end) { const value = await work().catch(() => null); if (value) return value; await sleep(100); }
  throw new Error(`Timed out waiting for ${description}`);
}
async function start(port) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', childCode, directory, String(port)], { env: { ...process.env, HOME: directory }, stdio: ['ignore', 'pipe', 'pipe'] });
  const [ready] = await Promise.race([once(child.stdout, 'data'), once(child, 'exit').then(([code]) => { throw new Error(`Fixture controller exited before ready: ${code}`); })]);
  return { child, port: JSON.parse(String(ready).trim()).port };
}
async function identity(pid) {
  try { const fields = (await readFile(`/proc/${pid}/stat`, 'utf8')).split(')').slice(1).join(')').trim().split(/\s+/); return { state: fields[0], start: fields[19] }; }
  catch (error) { if (['ENOENT', 'ESRCH'].includes(error.code)) return null; throw error; }
}
try {
  const first = await start(0); controller = first.child; const base = `http://127.0.0.1:${first.port}`;
  browser = await chromium.launch({ headless: true, ...(process.env.RELAY_E2E_BROWSER_EXECUTABLE ? { executablePath: process.env.RELAY_E2E_BROWSER_EXECUTABLE } : {}), args: ['--no-sandbox'] });
  context = await browser.newContext({ viewport: { width: 390, height: 844 } }); let page = await context.newPage();
  await page.goto(base); await page.getByRole('button', { name: 'Open workspace' }).click(); await page.locator('#new-chat').click();
  await page.locator('#prompt').fill(`start crash fixture ${'long message '.repeat(80)}`); await page.getByRole('button', { name: 'Send message' }).click();
  await page.locator('#chat-status').filter({ hasText: 'Working on VM' }).waitFor({ timeout });
  writer = JSON.parse(await readFile(path.join(directory, 'writer.json'), 'utf8'));
  await until(async () => (await readFile(path.join(directory, 'heartbeat'), 'utf8')).length > 0, 'fixture writer');
  const before = (await readFile(path.join(directory, 'heartbeat'), 'utf8')).length;
  const exited = once(controller, 'exit'); controller.kill('SIGKILL'); await exited; controller = null;
  await until(async () => (await readFile(path.join(directory, 'heartbeat'), 'utf8')).length > before, 'writer to survive controller crash');
  const helper = spawnSync('python3', ['-c', "import sys; from relay_lib.export_workspace import assert_session_idle; assert_session_idle('crash-fixture', sys.argv[1])", directory], {
    cwd: process.cwd(), env: { ...process.env, HOME: directory, RELAY_CONTROLLER_STATE_DIR: path.join(directory, 'controller') }, encoding: 'utf8',
  });
  assert.notEqual(helper.status, 0, 'Durable helper guard must block while the controller is absent');
  assert.match(helper.stderr, /source_busy/);
  let restarted;
  await until(async () => { try { restarted = await start(first.port); return true; } catch { return false; } }, 'fixture controller restart');
  controller = restarted.child;
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('#session-recovery').waitFor({ timeout });
  assert.equal(await page.locator('#prompt').isDisabled(), true, 'Uncertain execution must block new prompts');
  assert.equal(await readFile(path.join(directory, 'starts'), 'utf8'), '1\n', 'Restart must not replay the prompt');
  const selection = await page.evaluate(() => JSON.parse(localStorage.getItem('relay-session-selection')));
  const response = await context.request.post(`${base}/api/workspaces/crash-fixture/sessions`, { data: { text: 'conflicting task', createdAt: Date.now(), idempotencyKey: 'crash-fixture-retry-12345' } });
  assert.equal(response.status(), 409, 'Uncertain execution must block a second task');
  assert.ok(selection.sessionId);
  await page.locator('#recover-recheck').click({ timeout: 5000 });
  await page.locator('#recovery-message').filter({ hasText: 'not proven stopped' }).waitFor({ timeout });
  assert.equal(await page.locator('#prompt').isDisabled(), true, 'Failed recovery must retain the guard');
  await page.screenshot({ path: '/tmp/relay-browser-crash-fixed.png' });
  console.log('PASS: browser reopened to UNCERTAIN after controller SIGKILL; orphan continued, prompt was not repeated and a new task was blocked.');
} finally {
  if (controller && controller.exitCode === null && controller.signalCode === null) { const exit = once(controller, 'exit'); controller.kill('SIGTERM'); await exit; }
  if (writer) { const current = await identity(writer.pid); if (current?.start === writer.start && current.state !== 'Z') { try { process.kill(writer.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } } }
  await context?.close(); await browser?.close(); await rm(directory, { recursive: true, force: true });
}
