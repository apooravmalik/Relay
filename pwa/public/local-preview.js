export function localPreviewPorts(text) {
  const ports = new Set();
  const pattern = /\b(?:https?:\/\/)?(?:localhost|127\.0\.0\.1|\[::1\]):(\d{2,5})(?=[/?#)\],\s]|$)/gi;
  for (const match of String(text || '').matchAll(pattern)) {
    const port = Number(match[1]);
    if (port >= 1024 && port <= 65535) ports.add(port);
  }
  return [...ports];
}
