import assert from 'node:assert/strict';
import test from 'node:test';
import { createPreviewManager } from '../lib/previews.mjs';

test('a preview only proxies a private loopback listener through Tailnet Serve', async () => {
  const calls = [];
  const previews = createPreviewManager({ run: async (file, args) => {
    calls.push([file, args]);
    if (file === 'ss') return { stdout: 'LISTEN 0 511 127.0.0.1:3000 0.0.0.0:*\n' };
    if (args[0] === 'status') return { stdout: JSON.stringify({ Self: { DNSName: 'relay.example.ts.net.' } }) };
    return { stdout: '' };
  } });
  assert.deepEqual(await previews.open(3000), { port: 3000, url: 'https://relay.example.ts.net:3000/' });
  assert.deepEqual(calls[1], ['tailscale', ['serve', '--https=3000', '--bg', '--yes', 'http://127.0.0.1:3000']]);
  assert.deepEqual(await previews.stop(3000), { port: 3000, status: 'stopped' });
  assert.deepEqual(calls.at(-1), ['tailscale', ['serve', '--https=3000', '--yes', 'off']]);
});

test('a preview rejects listeners that are not private loopback services', async () => {
  const previews = createPreviewManager({ run: async () => ({ stdout: 'LISTEN 0 511 0.0.0.0:3000 0.0.0.0:*\n' }) });
  await assert.rejects(() => previews.open(3000), /not private/);
});

test('a preview accepts its existing Tailnet Serve listener beside loopback', async () => {
  const calls = [];
  const previews = createPreviewManager({ run: async (file, args) => {
    calls.push([file, args]);
    if (file === 'ss') return { stdout: 'LISTEN 0 511 127.0.0.1:3000 0.0.0.0:*\nLISTEN 0 4096 100.69.173.93%tailscale0:3000 0.0.0.0:*\n' };
    if (args[0] === 'status') return { stdout: JSON.stringify({ Self: { DNSName: 'relay.example.ts.net.' } }) };
    return { stdout: '' };
  } });
  await previews.open(3000);
  assert.deepEqual(calls[1], ['tailscale', ['serve', '--https=3000', '--bg', '--yes', 'http://127.0.0.1:3000']]);
});

test('a preview waits briefly for a reported loopback server to become ready', async () => {
  let checks = 0;
  const previews = createPreviewManager({
    attempts: 2,
    wait: async () => {},
    run: async (file, args) => {
      if (file === 'ss') return { stdout: ++checks === 1 ? '' : 'LISTEN 0 511 127.0.0.1:3000 0.0.0.0:*\n' };
      if (args[0] === 'status') return { stdout: JSON.stringify({ Self: { DNSName: 'relay.example.ts.net.' } }) };
      return { stdout: '' };
    },
  });
  assert.deepEqual(await previews.open(3000), { port: 3000, url: 'https://relay.example.ts.net:3000/' });
  assert.equal(checks, 2);
});

test('an IPv6 localhost listener uses an IPv6 loopback proxy target', async () => {
  const calls = [];
  const previews = createPreviewManager({ run: async (file, args) => {
    calls.push([file, args]);
    if (file === 'ss') return { stdout: 'LISTEN 0 511 [::1]:3000 [::]:*\n' };
    if (args[0] === 'status') return { stdout: JSON.stringify({ Self: { DNSName: 'relay.example.ts.net.' } }) };
    return { stdout: '' };
  } });
  await previews.open(3000);
  assert.deepEqual(calls[1], ['tailscale', ['serve', '--https=3000', '--bg', '--yes', 'http://[::1]:3000']]);
});
