import { execFile } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function portNumber(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Preview port must be between 1024 and 65535.');
  return port;
}

function loopbackTarget(output, port) {
  const listeners = output.trim().split('\n').filter(Boolean).map((line) => line.trim().split(/\s+/)[3]);
  if (!listeners.length) return null;
  const isLoopback = (listener) => listener === `127.0.0.1:${port}` || listener === `[::1]:${port}`;
  const isTailnetServe = (listener) => listener.endsWith(`%tailscale0:${port}`);
  const loopback = listeners.filter(isLoopback);
  if (!loopback.length) {
    if (listeners.every(isTailnetServe)) return null;
    throw new Error(`localhost:${port} is not private. Bind the development server to 127.0.0.1 or ::1.`);
  }
  if (!listeners.every((listener) => isLoopback(listener) || isTailnetServe(listener))) {
    throw new Error(`localhost:${port} is not private. Bind the development server to 127.0.0.1 or ::1.`);
  }
  return loopback.includes(`127.0.0.1:${port}`) ? `http://127.0.0.1:${port}` : `http://[::1]:${port}`;
}

export function createPreviewManager({ run = execFileAsync, wait = sleep, attempts = 30 } = {}) {
  async function tailnetHost() {
    const { stdout } = await run('tailscale', ['status', '--json']);
    const hostname = JSON.parse(stdout).Self?.DNSName?.replace(/\.$/, '');
    if (!hostname) throw new Error('Relay could not determine this VM\'s Tailnet hostname.');
    return hostname;
  }

  return {
    async open(portValue) {
      const port = portNumber(portValue);
      let target;
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        const { stdout } = await run('ss', ['-ltnH', `sport = :${port}`]);
        target = loopbackTarget(stdout, port);
        if (target) break;
        if (attempt + 1 < attempts) await wait(1000);
      }
      if (!target) throw new Error(`Nothing is listening privately on localhost:${port}. Start the development server on the VM first.`);
      await run('tailscale', ['serve', `--https=${port}`, '--bg', '--yes', target]);
      return { port, url: `https://${await tailnetHost()}:${port}/` };
    },
    async stop(portValue) {
      const port = portNumber(portValue);
      await run('tailscale', ['serve', `--https=${port}`, '--yes', 'off']);
      return { port, status: 'stopped' };
    },
  };
}

const previews = createPreviewManager();
export const openPreview = (port) => previews.open(port);
export const stopPreview = (port) => previews.stop(port);
