import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listWorkspaces } from './lib/workspaces.mjs';

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

function writeJson(response, statusCode, body) {
  response.writeHead(statusCode, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Security-Policy': "default-src 'self'; connect-src 'self'; style-src 'self'; script-src 'self'; manifest-src 'self'; worker-src 'self'",
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
  });
  response.end(JSON.stringify(body));
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
  if (!target) return writeJson(response, 404, { error: 'Not found.' });

  try {
    const body = await readFile(target);
    response.writeHead(200, {
      'Cache-Control': pathname === '/service-worker.js' ? 'no-cache' : 'public, max-age=300',
      'Content-Security-Policy': "default-src 'self'; connect-src 'self'; style-src 'self'; script-src 'self'; manifest-src 'self'; worker-src 'self'",
      'Content-Type': contentTypes[path.extname(target)] || 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
    });
    response.end(body);
  } catch {
    writeJson(response, 404, { error: 'Not found.' });
  }
}

export function createRelayServer() {
  return createServer(async (request, response) => {
    const url = new URL(request.url, 'http://relay.local');

    if (request.method !== 'GET') return writeJson(response, 405, { error: 'Method not allowed.' });
    if (url.pathname === '/api/health') return writeJson(response, 200, { status: 'ok' });
    if (url.pathname === '/api/workspaces') {
      return writeJson(response, 200, { workspaces: await listWorkspaces() });
    }

    return serveStatic(url.pathname, response);
  });
}

const host = process.env.RELAY_PWA_HOST || '127.0.0.1';
const port = Number.parseInt(process.env.RELAY_PWA_PORT || '4388', 10);
if (!allowedHosts.has(host)) throw new Error('RELAY_PWA_HOST must be 127.0.0.1 or ::1. Use Tailscale Serve to publish privately.');

createRelayServer().listen(port, host, () => {
  console.log(`Relay PWA controller listening on http://${host}:${port}`);
});
