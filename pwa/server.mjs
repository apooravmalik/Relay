import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createDirectory,
  findWorkspace,
  listProjectDirectories,
  listProjectRoots,
  listWorkspaceFiles,
  listWorkspaces,
  openDirectory,
  saveWorkspaceUpload,
  workspaceChanges,
  workspaceBrowseFile,
  workspaceDiff,
  workspaceFile,
} from './lib/workspaces.mjs';
import {
  CodexAppServerError,
  interruptTurn,
  listConversations,
  listModels,
  readConversation,
  streamNewTurn,
  streamTurn,
  validateModelSelection,
} from './lib/codex.mjs';
import { SessionManager } from './lib/sessions.mjs';
import { SessionError, terminalStates } from './lib/session-store.mjs';
import { hiddenThreadIds, hideThread } from './lib/preferences.mjs';
import { openPreview, stopPreview, assertPreviewAvailable } from './lib/previews.mjs';

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const publicDirectory = path.join(currentDirectory, 'public');
const allowedHosts = new Set(['127.0.0.1', '::1']);
const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};
const securityHeaders = {
  'Content-Security-Policy': "default-src 'self'; base-uri 'none'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; manifest-src 'self'; script-src 'self'; style-src 'self'; worker-src 'self'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
};

function writeJson(response, statusCode, body) {
  response.writeHead(statusCode, {
    ...securityHeaders,
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
  });
  response.end(JSON.stringify(body));
}

function writeError(response, statusCode, error) {
  writeJson(response, statusCode, { error });
}

function staticPath(pathname) {
  const requested = pathname === '/' ? '/index.html' : pathname;
  const normalized = path.posix.normalize(requested);
  if (!normalized.startsWith('/') || normalized.includes('..')) return null;
  const target = path.resolve(publicDirectory, `.${normalized}`);
  return target.startsWith(`${publicDirectory}${path.sep}`) ? target : null;
}

async function serveStatic(pathname, response) {
  const target = staticPath(pathname);
  if (!target) return writeError(response, 404, 'Not found.');
  try {
    const body = await readFile(target);
    response.writeHead(200, {
      ...securityHeaders,
      'Cache-Control': 'no-cache',
      'Content-Type': contentTypes[path.extname(target)] || 'application/octet-stream',
    });
    response.end(body);
  } catch {
    writeError(response, 404, 'Not found.');
  }
}

async function requestBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 32 * 1024) throw new Error('Request body is too large.');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('Request body must be JSON.');
  }
}

async function uploadBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 10 * 1024 * 1024) throw new Error('Upload is too large. Files must be 10 MB or smaller.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function uploadName(request) {
  const header = request.headers['x-relay-upload-name'];
  if (typeof header !== 'string') throw new Error('Upload filename is required.');
  try {
    return decodeURIComponent(header);
  } catch {
    throw new Error('Upload filename is invalid.');
  }
}

function pathnameParts(pathname) {
  return pathname.split('/').filter(Boolean).map(decodeURIComponent);
}

function isLocalRequest(request) {
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress);
}

function ownerFor(request, options) {
  const expected = options.ownerLogin?.toLowerCase();
  if (options.allowLocalDevelopment && isLocalRequest(request)) return expected || 'local-development';
  const actual = request.headers['tailscale-user-login'];
  if (!expected || typeof actual !== 'string' || actual.toLowerCase() !== expected) return null;
  return expected;
}

function sseEvent(response, type, data) {
  response.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
}

function appError(error) {
  if (error instanceof SessionError) return [error.status, error.message];
  if (error.code?.includes('SQLITE')) return [503, 'Session storage is unavailable. Workspace execution remains protected.'];
  if (error.code === 'WORKSPACE_BUSY') return [409, error.message];
  if (error instanceof CodexAppServerError && ['ACTIVE_WRITER', 'NO_ACTIVE_TURN'].includes(error.code)) return [409, error.message];
  if (error instanceof CodexAppServerError) return [502, error.message];
  return [400, error.message || 'Request could not be completed.'];
}

async function streamSession(manager, owner, workspaceId, id, after, response, legacy = false) {
  await manager.ensure();
  manager.store.get(id, owner, workspaceId);
  manager.store.events(id, after); // Validate before committing HTTP headers.
  if (manager.listenerCount(id) >= 8 || (manager.subscribers || 0) >= 32) throw new SessionError('Too many session subscribers. Close an unused tab and reconnect.', 429);
  manager.subscribers = (manager.subscribers || 0) + 1;
  response.writeHead(200, { ...securityHeaders, 'Cache-Control': 'no-store', 'Content-Type': 'text/event-stream; charset=utf-8', 'X-Accel-Buffering': 'no' });
  response.flushHeaders();
  let cursor = after, closed = false, blocked = false, stall;
  const finish = () => { if (closed) return; closed = true; manager.subscribers--; clearInterval(poll); clearInterval(heartbeat); clearTimeout(stall); manager.off(id, send); response.end(); };
  const send = () => {
    if (closed || blocked) return;
    try {
      for (const event of manager.store.events(id, cursor)) {
        let type = event.type, data = event;
        if (legacy && type === 'status' && terminalStates.has(event.state)) { type = 'completed'; data = { status: event.state === 'INTERRUPTED' ? 'interrupted' : event.state === 'COMPLETED' ? 'completed' : 'failed' }; }
        const writable = response.write(`id: ${event.id}\nevent: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
        cursor = event.id;
        if (!writable) {
          blocked = true; stall = setTimeout(() => { response.destroy(); finish(); }, 5000);
          response.once('drain', () => { clearTimeout(stall); blocked = false; send(); });
          return;
        }
      }
      const session = manager.store.get(id, owner, workspaceId);
      if ((terminalStates.has(session.state) || session.state === 'UNCERTAIN') && cursor === session.lastEventId) finish();
    } catch { finish(); }
  };
  const poll = setInterval(send, 250);
  const heartbeat = setInterval(() => { if (!closed && !blocked) response.write(': heartbeat\n\n'); }, 15000);
  manager.on(id, send);
  response.once('close', finish);
  send(); // Query persisted IDs after subscribing: no replay/live handoff gap.
}

export function createRelayServer(dependencies = {}) {
  const options = {
    ownerLogin: dependencies.ownerLogin ?? process.env.RELAY_ALLOWED_TAILSCALE_LOGIN,
    allowLocalDevelopment: dependencies.allowLocalDevelopment ?? process.env.RELAY_ALLOW_LOCAL_DEV === '1',
    findWorkspace: dependencies.findWorkspace ?? findWorkspace,
    createDirectory: dependencies.createDirectory ?? createDirectory,
    listProjectDirectories: dependencies.listProjectDirectories ?? listProjectDirectories,
    listProjectRoots: dependencies.listProjectRoots ?? listProjectRoots,
    listWorkspaceFiles: dependencies.listWorkspaceFiles ?? listWorkspaceFiles,
    listWorkspaces: dependencies.listWorkspaces ?? listWorkspaces,
    listModels: dependencies.listModels ?? listModels,
    openDirectory: dependencies.openDirectory ?? openDirectory,
    saveWorkspaceUpload: dependencies.saveWorkspaceUpload ?? saveWorkspaceUpload,
    workspaceChanges: dependencies.workspaceChanges ?? workspaceChanges,
    workspaceBrowseFile: dependencies.workspaceBrowseFile ?? workspaceBrowseFile,
    workspaceDiff: dependencies.workspaceDiff ?? workspaceDiff,
    workspaceFile: dependencies.workspaceFile ?? workspaceFile,
    listConversations: dependencies.listConversations ?? listConversations,
    readConversation: dependencies.readConversation ?? readConversation,
    streamNewTurn: dependencies.streamNewTurn ?? streamNewTurn,
    streamTurn: dependencies.streamTurn ?? streamTurn,
    validateModelSelection: dependencies.validateModelSelection ?? validateModelSelection,
    hiddenThreadIds: dependencies.hiddenThreadIds ?? hiddenThreadIds,
    hideThread: dependencies.hideThread ?? hideThread,
    interruptTurn: dependencies.interruptTurn ?? interruptTurn,
    openPreview: dependencies.openPreview ?? openPreview,
    stopPreview: dependencies.stopPreview ?? stopPreview,
  };
  if (!options.ownerLogin && !options.allowLocalDevelopment) {
    throw new Error('RELAY_ALLOWED_TAILSCALE_LOGIN is required unless RELAY_ALLOW_LOCAL_DEV=1.');
  }

  const sessions = dependencies.sessions ?? new SessionManager({
    ...dependencies.sessionOptions,
    run: (input) => input.threadId ? options.streamTurn(input) : options.streamNewTurn(input),
    interrupt: options.interruptTurn,
    openPreview: options.openPreview,
    stopPreview: options.stopPreview,
    checkPreview: dependencies.assertPreviewAvailable ?? assertPreviewAvailable,
    validateThread: options.readConversation,
    validateInput: async (input) => options.validateModelSelection(await options.listModels(), input),
  });
  const server = createServer(async (request, response) => {
    const login = ownerFor(request, options);
    if (!login) return writeError(response, 401, 'Relay is available only to the configured Tailnet owner.');
    if (!['GET', 'HEAD'].includes(request.method)) {
      const origin = request.headers.origin;
      let crossOrigin = false;
      try { if (origin) crossOrigin = new URL(origin).host !== request.headers.host; } catch { crossOrigin = true; }
      if (crossOrigin || request.headers['sec-fetch-site'] === 'cross-site') return writeError(response, 403, 'Cross-origin mutations are not allowed.');
    }
    const url = new URL(request.url, 'http://relay.local');
    let parts;
    try { parts = pathnameParts(url.pathname); } catch { return writeError(response, 400, 'Invalid request path.'); }
    const isApi = parts[0] === 'api';
    if (!isApi) {
      if (request.method !== 'GET') return writeError(response, 405, 'Method not allowed.');
      return serveStatic(url.pathname, response);
    }

    try {
      if (request.method === 'GET' && url.pathname === '/api/health') {
        return writeJson(response, 200, { status: 'ok', owner: login });
      }
      if (request.method === 'GET' && url.pathname === '/api/workspaces') {
        return writeJson(response, 200, { workspaces: await options.listWorkspaces() });
      }
      if (request.method === 'GET' && url.pathname === '/api/project-roots') {
        return writeJson(response, 200, { roots: await options.listProjectRoots() });
      }
      if (request.method === 'GET' && parts[1] === 'project-roots' && parts[2] && parts[3] === 'directories' && parts.length === 4) {
        return writeJson(response, 200, await options.listProjectDirectories(parts[2], url.searchParams.get('path') || ''));
      }
      if (request.method === 'GET' && url.pathname === '/api/codex/models') {
        return writeJson(response, 200, { models: await options.listModels() });
      }
      if (request.method === 'POST' && url.pathname === '/api/projects') {
        const body = await requestBody(request);
        if (body.action === 'create') {
          return writeJson(response, 201, { workspace: await options.createDirectory({
            rootId: body.rootId,
            parentPath: body.parentPath || '',
            name: body.name,
          }) });
        }
        if (body.action === 'open') {
          return writeJson(response, 201, { workspace: await options.openDirectory({ rootId: body.rootId, path: body.path || '' }) });
        }
        return writeError(response, 400, 'Project action must be create or open.');
      }
      if (parts[1] !== 'workspaces' || !parts[2]) return writeError(response, 404, 'Not found.');

      const workspace = await options.findWorkspace(parts[2]);
      if (!workspace) return writeError(response, 404, 'Workspace not found.');
      const suffix = parts.slice(3);

      if (request.method === 'GET' && suffix.length === 1 && suffix[0] === 'changes') {
        return writeJson(response, 200, { changes: await options.workspaceChanges(workspace.path) });
      }
      if (request.method === 'GET' && suffix.length === 1 && suffix[0] === 'files') {
        return writeJson(response, 200, await options.listWorkspaceFiles(workspace.path, url.searchParams.get('path') || ''));
      }
      if (request.method === 'GET' && suffix.length === 1 && suffix[0] === 'browse-file') {
        return writeJson(response, 200, await options.workspaceBrowseFile(workspace.path, url.searchParams.get('path')));
      }
      if (request.method === 'GET' && suffix.length === 1 && suffix[0] === 'file') {
        return writeJson(response, 200, await options.workspaceFile(workspace.path, url.searchParams.get('path')));
      }
      if (request.method === 'GET' && suffix.length === 1 && suffix[0] === 'diff') {
        return writeJson(response, 200, await options.workspaceDiff(workspace.path, url.searchParams.get('path')));
      }
      if (request.method === 'POST' && suffix.length === 1 && suffix[0] === 'uploads') {
        return writeJson(response, 201, { upload: await options.saveWorkspaceUpload(workspace.path, {
          name: uploadName(request),
          content: await uploadBody(request),
        }) });
      }
      if (request.method === 'POST' && suffix.length === 1 && suffix[0] === 'preview') {
        const { port, sessionId } = await requestBody(request);
        if (!sessionId) throw new SessionError('Select an active session before publishing a task preview.', 400);
        return writeJson(response, 201, { preview: await sessions.preview(login, workspace.id, sessionId, Number(port)) });
      }
      if (request.method === 'DELETE' && suffix.length === 1 && suffix[0] === 'preview') {
        return writeJson(response, 200, { preview: await sessions.removePreview(login, workspace.id, Number(url.searchParams.get('port'))) });
      }
      if (suffix[0] === 'sessions') {
        await sessions.ensure();
        if (suffix.length === 1 && request.method === 'GET') return writeJson(response, 200, { sessions: sessions.store.list(login, workspace.id) });
        if (suffix.length === 1 && request.method === 'POST') return writeJson(response, 202, { session: await sessions.start(login, workspace, await requestBody(request)) });
        const id = suffix[1];
        if (!id) return writeError(response, 404, 'Session not found.');
        const session = sessions.store.get(id, login, workspace.id);
        if (suffix.length === 2 && request.method === 'GET') return writeJson(response, 200, { session });
        if (suffix.length === 3 && suffix[2] === 'events' && request.method === 'GET') {
          const cursor = url.searchParams.get('after') ?? request.headers['last-event-id'] ?? '0';
          if (!/^\d+$/.test(cursor)) throw new SessionError('Invalid event cursor.', 400);
          return await streamSession(sessions, login, workspace.id, id, Number(cursor), response);
        }
        if (suffix.length === 3 && suffix[2] === 'stop' && request.method === 'POST') return writeJson(response, 202, { session: await sessions.stop(login, workspace.id, id) });
        if (suffix.length === 3 && suffix[2] === 'recovery') {
          if (request.method === 'GET') return writeJson(response, 200, await sessions.recovery(login, workspace.id, id));
          if (request.method === 'POST') { const body = await requestBody(request); return writeJson(response, 200, await sessions.recovery(login, workspace.id, id, body.action, body.generation)); }
        }
        return writeError(response, 404, 'Not found.');
      }
      if (suffix[0] !== 'conversations') return writeError(response, 404, 'Not found.');

      if (request.method === 'GET' && suffix.length === 1) {
        const hidden = await options.hiddenThreadIds(login);
        const conversations = (await options.listConversations(workspace.path)).filter((conversation) => !hidden.has(conversation.id));
        return writeJson(response, 200, { conversations });
      }
      if (request.method === 'POST' && suffix.length === 2 && suffix[1] === 'turns') {
        const session = await sessions.start(login, workspace, await requestBody(request));
        return await streamSession(sessions, login, workspace.id, session.id, 0, response, true);
      }

      const threadId = suffix[1];
      if (!threadId) return writeError(response, 404, 'Not found.');
      if (request.method === 'GET' && suffix.length === 2) {
        return writeJson(response, 200, await options.readConversation(workspace.path, threadId));
      }
      if (request.method === 'DELETE' && suffix.length === 2) {
        const conversations = await options.listConversations(workspace.path);
        if (!conversations.some((conversation) => conversation.id === threadId)) return writeError(response, 404, 'Conversation not found.');
        await options.hideThread(login, threadId);
        response.writeHead(204, securityHeaders);
        return response.end();
      }
      if (request.method === 'POST' && suffix.length === 4 && suffix[2] === 'turns' && suffix[3] === 'stop') {
        await sessions.ensure();
        const active = sessions.store.list(login, workspace.id).find((session) => session.threadId === threadId && !terminalStates.has(session.state));
        if (!active) throw new SessionError('No active session is available to stop.');
        await sessions.stop(login, workspace.id, active.id);
        return writeJson(response, 202, { status: 'interrupting' });
      }
      if (request.method === 'POST' && suffix.length === 3 && suffix[2] === 'turns') {
        const session = await sessions.start(login, workspace, { ...await requestBody(request), threadId });
        return await streamSession(sessions, login, workspace.id, session.id, 0, response, true);
      }
      return writeError(response, 404, 'Not found.');
    } catch (error) {
      const [status, message] = appError(error);
      if (response.headersSent) return response.end();
      return writeError(response, status, message);
    }
  });
  server.sessions = sessions;
  return server;
}

export async function startRelayServer() {
  const host = process.env.RELAY_PWA_HOST || '127.0.0.1';
  const port = Number.parseInt(process.env.RELAY_PWA_PORT || '4388', 10);
  if (!allowedHosts.has(host)) throw new Error('RELAY_PWA_HOST must be 127.0.0.1 or ::1. Use Tailscale Serve to publish privately.');
  const server = createRelayServer();
  await server.sessions.ready;
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    server.sessions.draining = true;
    server.close();
    const drain = setInterval(async () => { if (!server.sessions.active.size && !server.sessions.starting.size) { clearInterval(drain); await server.sessions.close(); } }, 250);
  };
  process.once('SIGTERM', shutdown); process.once('SIGINT', shutdown);
  return server.listen(port, host, () => {
    console.log(`Relay PWA controller listening on http://${host}:${port}`);
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) startRelayServer().catch(() => { console.error('Relay controller startup failed. Inspect session storage and deployment prerequisites.'); process.exitCode = 1; });
