export const finishedStates = new Set(['COMPLETED', 'FAILED', 'INTERRUPTED']);

export function parseSessionFrame(frame) {
  let id, type = 'message';
  const data = [];
  for (const line of frame.replace(/\r/g, '').split('\n')) {
    if (line.startsWith('id:')) id = Number(line.slice(3).trim());
    if (line.startsWith('event:')) type = line.slice(6).trim();
    if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
  }
  if (!data.length) return null;
  if (!Number.isSafeInteger(id) || id < 1) throw new Error('Invalid session event ID.');
  return { ...JSON.parse(data.join('\n')), id, type };
}

export async function followSession(url, { signal, onEvent, onConnection = () => {}, fetcher = fetch, wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  let cursor = 0, delay = 250, done = false, lastState;
  while (!signal.aborted && !done) {
    try {
      const response = await fetcher(`${url}?after=${cursor}`, { signal, headers: { Accept: 'text/event-stream' } });
      if (!response.ok) {
        const error = new Error((await response.json().catch(() => ({}))).error || 'Session connection unavailable.');
        error.status = response.status; throw error;
      }
      onConnection(true); delay = 250;
      const reader = response.body.getReader(), decoder = new TextDecoder();
      let buffer = '';
      try {
        while (!signal.aborted) {
          const chunk = await reader.read();
          buffer += decoder.decode(chunk.value || new Uint8Array(), { stream: !chunk.done }).replace(/\r/g, '');
          if (buffer.length > 2 * 1024 * 1024) throw new Error('Session response buffer limit exceeded.');
          let boundary;
          while ((boundary = buffer.indexOf('\n\n')) >= 0) {
            const event = parseSessionFrame(buffer.slice(0, boundary)); buffer = buffer.slice(boundary + 2);
            if (!event || event.id <= cursor) continue;
            if (event.id !== cursor + 1) { const error = new Error('Session event gap. Reopen the session to recover its history.'); error.status = 410; throw error; }
            await onEvent(event); cursor = event.id;
            if (event.type === 'status') lastState = event.state;
          }
          if (chunk.done) { done = finishedStates.has(lastState) || lastState === 'UNCERTAIN'; break; }
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      if (!done && !signal.aborted) throw new Error('Connection ended before final status.');
    } catch (error) {
      if (signal.aborted) return;
      if ([400, 401, 403, 404, 410].includes(error.status)) throw error;
      onConnection(false);
      // Abortable wait: navigation never owns the server's execution lifetime.
      await new Promise((resolve) => {
        const end = () => { signal.removeEventListener('abort', end); resolve(); };
        signal.addEventListener('abort', end, { once: true });
        if (signal.aborted) end(); else void wait(delay).then(end);
      });
      delay = Math.min(delay * 2, 10000);
    }
  }
}
