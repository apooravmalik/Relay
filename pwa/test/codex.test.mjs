import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { interruptTurn, relayVmDeveloperInstructions, streamNewTurn, streamTurn, validateModelSelection } from '../lib/codex.mjs';

const models = [{ id: 'gpt-test', name: 'GPT Test', defaultEffort: 'medium', efforts: [{ id: 'low' }, { id: 'medium' }] }];

test('model selection accepts only a catalog-supported model and effort pair', () => {
  assert.deepEqual(validateModelSelection(models, { model: 'gpt-test', effort: 'medium' }), { model: 'gpt-test', effort: 'medium' });
  assert.throws(() => validateModelSelection(models, { model: 'gpt-test', effort: 'xhigh' }), /not supported/);
  assert.throws(() => validateModelSelection(models, { model: 'gone', effort: 'low' }), /no longer available/);
});

test('a new turn forwards its chosen model and effort to Codex', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'relay-codex-test-'));
  const executable = path.join(directory, 'codex');
  const output = path.join(directory, 'requests.jsonl');
  const priorPath = process.env.PATH;
  const priorOutput = process.env.RELAY_TEST_OUTPUT;
  await writeFile(executable, `#!/usr/bin/env node
const readline = require('node:readline');
const fs = require('node:fs');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method) fs.appendFileSync(process.env.RELAY_TEST_OUTPUT, JSON.stringify(message) + '\\n');
  if (message.id == null) return;
  if (message.method === 'thread/start') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { thread: { id: 'thread-1', name: 'New chat' } } }) + '\\n');
    return;
  }
  if (message.method === 'turn/start') {
    const text = message.params.input[0].text;
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { turn: { id: 'turn-1' } } }) + '\\n');
    if (text === 'hold') return;
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'item/reasoning/summaryTextDelta', params: { delta: 'Checking the workspace.' } }) + '\\n');
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'turn/completed', params: { turn: { status: 'completed' } } }) + '\\n');
    return;
  }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} }) + '\\n');
  if (message.method === 'turn/interrupt') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'turn/completed', params: { turn: { status: 'interrupted' } } }) + '\\n');
});
`);
  await chmod(executable, 0o755);
  process.env.PATH = `${directory}:${priorPath}`;
  process.env.RELAY_TEST_OUTPUT = output;
  try {
    const events = [];
    await streamNewTurn({ cwd: '/tmp/project', text: 'hello', model: 'gpt-test', effort: 'medium', onEvent: (event) => events.push(event) });
    const requests = (await readFile(output, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(requests.find((request) => request.method === 'initialize').params.capabilities.experimentalApi, true);
    assert.deepEqual(requests.find((request) => request.method === 'thread/start').params.model, 'gpt-test');
    assert.equal(requests.find((request) => request.method === 'thread/start').params.developerInstructions, relayVmDeveloperInstructions);
    assert.match(relayVmDeveloperInstructions, /private Relay VM/);
    assert.match(relayVmDeveloperInstructions, /http:\/\/localhost:<port>/);
    assert.deepEqual(requests.find((request) => request.method === 'thread/settings/update').params.effort, 'medium');
    assert.equal(requests.find((request) => request.method === 'thread/settings/update').params.summary, 'concise');
    assert.deepEqual(events.find((event) => event.type === 'reasoning'), { type: 'reasoning', text: 'Checking the workspace.' });

    await streamTurn({ cwd: '/tmp/project', threadId: 'thread-1', text: 'continue', model: 'gpt-test', effort: 'low', onEvent: () => {} });
    const resumed = (await readFile(output, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.deepEqual(resumed.findLast((request) => request.method === 'thread/settings/update').params, {
      threadId: 'thread-1', summary: 'concise', model: 'gpt-test', effort: 'low',
    });

    let turnStarted;
    const waiting = streamNewTurn({
      cwd: '/tmp/project', text: 'hold', model: 'gpt-test', effort: 'medium',
      onEvent: (event) => { if (event.type === 'turn') turnStarted?.(); },
    });
    await new Promise((resolve) => { turnStarted = resolve; });
    await interruptTurn({ cwd: '/tmp/project', threadId: 'thread-1' });
    assert.equal((await waiting).status, 'interrupted');
    const updated = (await readFile(output, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.deepEqual(updated.findLast((request) => request.method === 'turn/interrupt').params, { threadId: 'thread-1', turnId: 'turn-1' });
  } finally {
    process.env.PATH = priorPath;
    if (priorOutput === undefined) delete process.env.RELAY_TEST_OUTPUT;
    else process.env.RELAY_TEST_OUTPUT = priorOutput;
    await rm(directory, { recursive: true, force: true });
  }
});

