import { spawn } from 'node:child_process';
import readline from 'node:readline';

const clientInfo = { name: 'relay_pwa', title: 'Relay', version: '0.1.0' };

export class CodexAppServerError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'CodexAppServerError';
    this.code = code;
  }
}

class AppServer {
  constructor() {
    this.child = spawn('codex', ['app-server', '--listen', 'stdio://'], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Set();
    this.stderr = '';
    readline.createInterface({ input: this.child.stdout }).on('line', (line) => this.onMessage(line));
    this.child.stderr.on('data', (chunk) => { this.stderr = `${this.stderr}${chunk}`.slice(-4096); });
    this.child.on('error', (error) => this.failAll(error));
    this.child.on('exit', () => this.failAll(new CodexAppServerError(this.stderr || 'Codex app-server exited.')));
  }

  onMessage(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.method && message.id !== undefined) {
      this.emit({ type: 'approval', method: message.method, params: message.params || {} });
      this.write({ jsonrpc: '2.0', id: message.id, result: { decision: 'decline' } });
      return;
    }
    if (message.method) {
      this.emit({ type: 'notification', method: message.method, params: message.params || {} });
      return;
    }
    const pending = this.pending.get(String(message.id));
    if (!pending) return;
    this.pending.delete(String(message.id));
    if (message.error) pending.reject(new CodexAppServerError(message.error.message || 'Codex request failed.', message.error.code));
    else pending.resolve(message.result);
  }

  emit(event) {
    for (const listener of this.listeners) listener(event);
  }

  write(message) {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method, params) {
    const id = this.nextId++;
    this.write({ jsonrpc: '2.0', id, method, params });
    return new Promise((resolve, reject) => this.pending.set(String(id), { resolve, reject }));
  }

  notify(method, params) {
    this.write({ jsonrpc: '2.0', method, params });
  }

  onEvent(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  failAll(error) {
    for (const { reject } of this.pending.values()) reject(error);
    this.pending.clear();
  }

  close() {
    this.child.kill();
  }
}

async function withServer(work) {
  const server = new AppServer();
  try {
    await server.request('initialize', { clientInfo });
    server.notify('initialized', {});
    return await work(server);
  } finally {
    server.close();
  }
}

function threadSummary(thread) {
  return {
    id: thread.id,
    name: thread.name || thread.preview || 'Untitled conversation',
    preview: thread.preview || '',
    model: thread.model || null,
    updatedAt: thread.updatedAt || null,
    status: thread.status?.type || 'unknown',
  };
}

function itemText(item) {
  if (typeof item.text === 'string') return item.text;
  if (Array.isArray(item.content)) return item.content.filter((part) => part?.type === 'text').map((part) => part.text).join('');
  return '';
}

function conversationHistory(thread) {
  return (thread.turns || []).flatMap((turn) => (turn.items || []).flatMap((item) => {
    const text = itemText(item);
    if (!text) return [];
    if (item.type === 'userMessage') return [{ role: 'user', text }];
    if (item.type === 'agentMessage') return [{ role: 'assistant', text }];
    return [];
  }));
}

function requiresTerminal(error) {
  return /active writer|already has an active|writer/i.test(error.message);
}

export async function listConversations(cwd) {
  return withServer(async (server) => {
    const result = await server.request('thread/list', { cwd, limit: 50 });
    return (result.data || []).map(threadSummary);
  });
}

export async function readConversation(cwd, threadId) {
  return withServer(async (server) => {
    const listed = await server.request('thread/list', { cwd, limit: 50 });
    if (!(listed.data || []).some((thread) => thread.id === threadId)) throw new CodexAppServerError('Conversation is not in this workspace.');
    const result = await server.request('thread/read', { threadId, includeTurns: true });
    return { conversation: threadSummary(result.thread), messages: conversationHistory(result.thread) };
  });
}

async function streamConversation({ cwd, threadId, text, onEvent }) {
  return withServer(async (server) => {
    let complete;
    const completeTurn = new Promise((resolve) => { complete = resolve; });
    const removeListener = server.onEvent((event) => {
      if (event.type === 'approval') onEvent({ type: 'approval' });
      if (event.method === 'item/agentMessage/delta') {
        const delta = event.params.delta || event.params.text || '';
        if (delta) onEvent({ type: 'delta', text: delta });
      }
      if (event.method === 'turn/completed') complete(event.params.turn || event.params);
    });
    try {
      if (threadId) {
        try {
          await server.request('thread/resume', { threadId, cwd, excludeTurns: true, approvalPolicy: 'never', sandbox: 'danger-full-access' });
        } catch (error) {
          if (requiresTerminal(error)) throw new CodexAppServerError('This conversation is active in Termius. Continue it there, or start a new Relay chat.', 'ACTIVE_WRITER');
          throw error;
        }
      } else {
        const started = await server.request('thread/start', {
          cwd,
          approvalPolicy: 'never',
          sandbox: 'danger-full-access',
        });
        threadId = (started.thread || started).id;
        onEvent({ type: 'conversation', conversation: threadSummary(started.thread || started) });
      }
      await server.request('turn/start', {
        threadId,
        cwd,
        approvalPolicy: 'never',
        input: [{ type: 'text', text }],
      });
      const turn = await completeTurn;
      if (turn.status !== 'completed') throw new CodexAppServerError(`Codex turn ended with status: ${turn.status || 'unknown'}.`);
      return { status: turn.status, threadId };
    } finally {
      removeListener();
    }
  });
}

export function streamTurn(options) {
  if (!options.threadId) throw new CodexAppServerError('Conversation ID is required.');
  return streamConversation(options);
}

export function streamNewTurn(options) {
  return streamConversation({ ...options, threadId: null });
}
