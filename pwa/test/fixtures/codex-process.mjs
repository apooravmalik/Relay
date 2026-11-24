import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import readline from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const [directory, mode] = process.argv.slice(2);
const identity = () => { const fields = readFileSync(`/proc/${process.pid}/stat`, 'utf8').split(')').slice(1).join(')').trim().split(/\s+/); return { pid: process.pid, group: Number(fields[2]), start: fields[19] }; };
if (mode === 'server') {
  const server = createServer((request, response) => response.end('relay-task-fixture'));
  server.listen(0, '127.0.0.1', () => writeFileSync(path.join(directory, 'server.json'), JSON.stringify({ ...identity(), port: server.address().port })));
  setInterval(() => appendFileSync(path.join(directory, 'heartbeat'), 'write\n'), 25);
} else {
  writeFileSync(path.join(directory, 'parent.json'), JSON.stringify(identity()));
  let finished = false, timer;
  const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');
  const end = (status) => { if (finished) return; finished = true; clearInterval(timer); send({ method: 'turn/completed', params: { threadId: 'fixture-thread', turn: { id: 'fixture-turn', status } } }); };
  readline.createInterface({ input: process.stdin }).on('line', (line) => {
    const message = JSON.parse(line);
    if (message.id == null) return;
    if (message.method === 'thread/start') return send({ id: message.id, result: { thread: { id: 'fixture-thread', name: 'Process fixture' } } });
    if (message.method === 'turn/start') {
      send({ id: message.id, result: { turn: { id: 'fixture-turn' } } });
      spawn(process.execPath, [fileURLToPath(import.meta.url), directory, 'server'], { stdio: 'ignore' });
      timer = setInterval(() => {
        if (existsSync(path.join(directory, 'finish'))) end('completed');
      }, 25);
      send({ method: 'item/agentMessage/delta', params: { threadId: 'fixture-thread', turnId: 'fixture-turn', itemId: 'item-fixture', delta: 'Running the foreground task.\n' } });
      return;
    }
    send({ id: message.id, result: {} });
    if (message.method === 'turn/interrupt') end('interrupted');
  });
}
