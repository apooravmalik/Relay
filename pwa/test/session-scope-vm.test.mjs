import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import test from 'node:test';
import { ExecutionScopes } from '../lib/execution-scope.mjs';

test('delegated cgroup contains a detached server after its parent dies and proves cleanup', { skip: process.env.RELAY_TEST_DELEGATED_CGROUP !== '1' }, async () => {
  const scopes = new ExecutionScopes();
  await scopes.available();
  const directory = await mkdtemp(path.join(tmpdir(), 'relay-scope-vm-'));
  const scope = await scopes.create(randomUUID());
  const record = path.join(directory, 'server.json');
  const serverCode = `const fs=require('node:fs'); const http=require('node:http'); const server=http.createServer((q,r)=>r.end('scope-fixture')); server.listen(0,'127.0.0.1',()=>fs.writeFileSync(process.argv[1],JSON.stringify({pid:process.pid,port:server.address().port})));`;
  const parentCode = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(serverCode)},process.argv[1]],{detached:true,stdio:'ignore'}); setInterval(()=>{},1000);`;
  const wrapper = fileURLToPath(new URL('../../relay_lib/session_scope_exec.py', import.meta.url));
  const child = spawn('python3', [wrapper, scope.directory, scope.inode, process.execPath, '-e', parentCode, record], { stdio: ['ignore', 'ignore', 'pipe'] });
  let info;
  try {
    for (let n = 0; n < 200; n++) { try { info = JSON.parse(await readFile(record, 'utf8')); break; } catch { await sleep(25); } }
    assert.ok(info, 'fixture server must start');
    assert.match(execFileSync('ss', ['-ltnH', `sport = :${info.port}`], { encoding: 'utf8' }), new RegExp(`127\\.0\\.0\\.1:${info.port}`));
    assert.equal(await (await fetch(`http://127.0.0.1:${info.port}`)).text(), 'scope-fixture');
    child.kill('SIGKILL');
    assert.equal((await scopes.verify(scope)).stopped, false);
    assert.equal((await scopes.stop(scope)).stopped, true);
    await assert.rejects(fetch(`http://127.0.0.1:${info.port}`));
  } finally { await scopes.stop(scope); await scopes.remove(scope); if (child.exitCode === null) child.kill(); await rm(directory, { recursive: true, force: true }); }
});
