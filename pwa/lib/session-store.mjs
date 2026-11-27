import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, chmodSync, existsSync, lstatSync, openSync, closeSync, fsyncSync, writeFileSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

export const terminalStates = new Set(['COMPLETED', 'FAILED', 'INTERRUPTED']);
export class SessionError extends Error {
  constructor(message, status = 409, code = 'SESSION_CONFLICT') { super(message); this.status = status; this.code = code; }
}
const day = 86400000;
const transitions = {
  STARTING: ['RUNNING', 'CANCEL_REQUESTED', 'FAILED', 'INTERRUPTED', 'UNCERTAIN'],
  RUNNING: ['CANCEL_REQUESTED', 'COMPLETED', 'FAILED', 'INTERRUPTED', 'UNCERTAIN'],
  CANCEL_REQUESTED: ['COMPLETED', 'FAILED', 'INTERRUPTED', 'UNCERTAIN'],
  UNCERTAIN: ['FAILED', 'INTERRUPTED'],
};
function syncDirectory(directory) { const fd = openSync(directory, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } }
function overlaps(a, b) {
  const within = (parent, child) => {
    const relative = path.relative(parent, child);
    return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  };
  return within(a, b) || within(b, a);
}
function sharesDirectory(a, b) {
  const contains = (ancestor, child) => {
    const root = statSync(ancestor, { bigint: true });
    for (let current = child; ; current = path.dirname(current)) {
      const entry = statSync(current, { bigint: true });
      if (entry.dev === root.dev && entry.ino === root.ino) return true;
      if (path.dirname(current) === current) return false;
    }
  };
  try { return contains(a, b) || contains(b, a); }
  catch { throw new SessionError('Workspace directory identity cannot be verified.'); }
}
export function directoryIdentity(directory) {
  try {
    const entry = statSync(directory, { bigint: true });
    if (entry.isDirectory() && realpathSync(directory) === directory) return [String(entry.dev), String(entry.ino)];
  } catch {}
  throw new SessionError('Workspace directory identity cannot be verified.');
}

export class SessionStore {
  constructor(directory, { now = Date.now, maxSessionBytes = 64 * 1024 ** 2, maxTotalBytes = 1024 ** 3, requiredMarker } = {}) {
    this.now = now; this.maxSessionBytes = maxSessionBytes; this.maxTotalBytes = maxTotalBytes;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (lstatSync(directory).isSymbolicLink()) throw new SessionError('Session storage must be a private directory.', 503);
    chmodSync(directory, 0o700);
    this.file = path.join(directory, 'sessions.sqlite');
    const marker = path.join(directory, 'initialized');
    const existed = existsSync(this.file);
    if (requiredMarker && existsSync(requiredMarker) && (!existed || !existsSync(marker))) throw new SessionError('Required session storage is missing. Restore it before execution.', 503);
    if (existsSync(marker) && !existed) throw new SessionError('Initialized session database is missing. Restore it before starting work.', 503);
    if (existed && (!lstatSync(this.file).isFile() || lstatSync(this.file).isSymbolicLink())) throw new SessionError('Session database is not a regular file.', 503);
    if (!existed) { const fd = openSync(this.file, 'wx', 0o600); closeSync(fd); }
    chmodSync(this.file, 0o600);
    this.db = new DatabaseSync(this.file);
    try {
      if (!existed) this.db.exec('PRAGMA auto_vacuum=INCREMENTAL');
      this.db.exec('PRAGMA busy_timeout=2000; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA journal_size_limit=8388608; PRAGMA wal_autocheckpoint=256;');
      const version = this.db.prepare('PRAGMA user_version').get().user_version;
      if (![0, 1, 2].includes(version)) throw new SessionError('Unsupported session schema. Do not downgrade the controller.', 503);
      if (version === 0 && existed) throw new SessionError('Uninitialized or damaged session database. Recovery is required.', 503);
      if (version === 0) { this.db.exec(`BEGIN IMMEDIATE;
        CREATE TABLE sessions (
          id TEXT PRIMARY KEY, owner TEXT NOT NULL, workspace_id TEXT NOT NULL, workspace_path TEXT NOT NULL,
          request_key TEXT NOT NULL, request_digest TEXT NOT NULL, requested_at INTEGER NOT NULL,
          thread_id TEXT, turn_id TEXT, model TEXT, effort TEXT,
          state TEXT NOT NULL, phase TEXT NOT NULL DEFAULT 'starting', reason TEXT,
          created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, terminal_at INTEGER,
          last_event INTEGER NOT NULL DEFAULT 0, event_bytes INTEGER NOT NULL DEFAULT 0,
          events_expired INTEGER NOT NULL DEFAULT 0, scope TEXT, boot_id TEXT NOT NULL,
          UNIQUE(owner, workspace_id, request_key));
        CREATE TABLE workspace_guards (workspace_id TEXT PRIMARY KEY, session_id TEXT NOT NULL UNIQUE REFERENCES sessions(id));
        CREATE TABLE events (session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          event_id INTEGER NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL, bytes INTEGER NOT NULL,
          PRIMARY KEY(session_id,event_id));
        CREATE TABLE recovery_audit (id INTEGER PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          actor TEXT NOT NULL, action TEXT NOT NULL, evidence TEXT NOT NULL, created_at INTEGER NOT NULL);
        CREATE INDEX session_workspace ON sessions(owner,workspace_id,created_at);
        CREATE TABLE preview_ports (port INTEGER PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, url TEXT);
        PRAGMA user_version=1; COMMIT;`); }
      if (version < 2) this.transaction(() => this.db.exec(`
        ALTER TABLE sessions ADD COLUMN workspace_device TEXT;
        ALTER TABLE sessions ADD COLUMN workspace_inode TEXT;
        CREATE TABLE handoff_guards (
          transfer_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, workspace_path TEXT NOT NULL,
          device TEXT NOT NULL, inode TEXT NOT NULL, kind TEXT NOT NULL, endpoint TEXT NOT NULL, request_digest TEXT NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('ACTIVE','COMPLETED','ABORTED')));
        CREATE INDEX active_handoff_guards ON handoff_guards(state);
        PRAGMA user_version=2;`));
      if (this.db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw new SessionError('Session storage integrity check failed.', 503);
      if (this.db.prepare('PRAGMA foreign_key_check').get()) throw new SessionError('Session storage references are inconsistent.', 503);
      if (this.db.prepare(`SELECT s.id FROM sessions s LEFT JOIN workspace_guards g ON g.session_id=s.id
        WHERE (s.state NOT IN ('COMPLETED','FAILED','INTERRUPTED') AND (g.session_id IS NULL OR s.terminal_at IS NOT NULL))
           OR (s.state IN ('COMPLETED','FAILED','INTERRUPTED') AND (g.session_id IS NOT NULL OR s.terminal_at IS NULL))
           OR (g.session_id IS NOT NULL AND g.workspace_id<>s.workspace_id) LIMIT 1`).get()) throw new SessionError('Session execution guards are inconsistent. Restore or recover storage.', 503);
      if (!existsSync(marker)) { writeFileSync(marker, '1\n', { flag: 'wx', mode: 0o600 }); const fd = openSync(marker, 'r'); fsyncSync(fd); closeSync(fd); syncDirectory(directory); }
      if (readFileSync(marker, 'utf8') !== '1\n') throw new SessionError('Unsupported session initialization marker.', 503);
      if (requiredMarker && !existsSync(requiredMarker)) { writeFileSync(requiredMarker, '1\n', { flag: 'wx', mode: 0o600 }); const fd = openSync(requiredMarker, 'r'); fsyncSync(fd); closeSync(fd); syncDirectory(path.dirname(requiredMarker)); }
      for (const suffix of ['-wal', '-shm']) if (existsSync(this.file + suffix)) chmodSync(this.file + suffix, 0o600);
    } catch (error) { this.db.close(); throw error; }
  }

  transaction(work) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = work(); this.db.exec('COMMIT'); return result; }
    catch (error) { try { this.db.exec('ROLLBACK'); } catch {} throw error; }
  }
  raw(id) { return this.db.prepare('SELECT * FROM sessions WHERE id=?').get(id); }
  view(row) {
    if (!row) throw new SessionError('Session not found.', 404, 'NOT_FOUND');
    return { id: row.id, requestKey: row.request_key, workspaceId: row.workspace_id, threadId: row.thread_id, turnId: row.turn_id,
      model: row.model, effort: row.effort, state: row.state, phase: row.phase, reason: row.reason,
      createdAt: row.created_at, updatedAt: row.updated_at, lastEventId: row.last_event,
      eventsExpired: Boolean(row.events_expired), generation: row.last_event };
  }
  get(id, owner, workspaceId) {
    const row = this.raw(id);
    if (!row || row.owner !== owner || row.workspace_id !== workspaceId) throw new SessionError('Session not found.', 404, 'NOT_FOUND');
    return this.view(row);
  }
  list(owner, workspaceId) { return this.db.prepare('SELECT * FROM sessions WHERE owner=? AND workspace_id=? ORDER BY created_at DESC LIMIT 100').all(owner, workspaceId).map((row) => this.view(row)); }
  pending() { return this.db.prepare('SELECT * FROM sessions WHERE terminal_at IS NULL').all(); }
  prior(owner, workspaceId, key, digest) {
    const row = this.db.prepare('SELECT * FROM sessions WHERE owner=? AND workspace_id=? AND request_key=?').get(owner, workspaceId, key);
    if (row && row.request_digest !== digest) throw new SessionError('This request key was already used for a different prompt or settings.');
    return row ? this.view(row) : null;
  }
  static request(body) {
    if (typeof body.idempotencyKey !== 'string' || !/^[a-zA-Z0-9_-]{16,100}$/.test(body.idempotencyKey)) throw new SessionError('A stable idempotency key is required. Refresh Relay.', 400);
    if (!Number.isSafeInteger(body.createdAt)) throw new SessionError('Original request creation time is required.', 400);
    if (typeof body.text !== 'string' || !body.text.trim() || body.text.length > 8000) throw new SessionError('Prompt must be between 1 and 8000 characters.', 400);
    if (body.threadId != null && (typeof body.threadId !== 'string' || !body.threadId || body.threadId.length > 200)) throw new SessionError('Invalid conversation ID.', 400);
    for (const field of ['model', 'effort']) if (body[field] != null && (typeof body[field] !== 'string' || body[field].length > 200)) throw new SessionError('Invalid model selection.', 400);
    const input = { text: body.text.trim(), threadId: body.threadId || null, model: body.model || null, effort: body.effort || null, createdAt: body.createdAt };
    return { input, digest: createHash('sha256').update(JSON.stringify(input)).digest('hex') };
  }
  assertWorkspaceIdle(workspace, workspaceIdentity) {
    if (this.db.prepare('SELECT 1 FROM workspace_guards WHERE workspace_id=?').get(workspace.id) || this.db.prepare("SELECT 1 FROM sessions WHERE workspace_id=? AND state NOT IN ('COMPLETED','FAILED','INTERRUPTED')").get(workspace.id)) throw new SessionError('Workspace has active or uncertain execution.');
    const guarded = this.db.prepare("SELECT s.workspace_path, s.workspace_device, s.workspace_inode FROM sessions s LEFT JOIN workspace_guards g ON g.session_id=s.id WHERE g.session_id IS NOT NULL OR s.state NOT IN ('COMPLETED','FAILED','INTERRUPTED')").all();
    for (const row of guarded) {
      if (row.workspace_device !== null) {
        const [device, inode] = directoryIdentity(row.workspace_path);
        if (device !== row.workspace_device || inode !== row.workspace_inode) throw new SessionError('An active workspace identity changed. Recover the session before continuing.');
      }
      if (overlaps(row.workspace_path, workspace.path) || (workspaceIdentity && row.workspace_device !== null && sharesDirectory(row.workspace_path, workspace.path))) throw new SessionError('An overlapping workspace has active or uncertain execution.');
    }
    const handoffs = this.db.prepare("SELECT * FROM handoff_guards WHERE state='ACTIVE'").all();
    for (const handoff of handoffs) {
      const [device, inode] = directoryIdentity(handoff.workspace_path);
      if (device !== handoff.device || inode !== handoff.inode) throw new SessionError('A pending handoff workspace identity changed. Recover the handoff before continuing.');
      if (handoff.workspace_id === workspace.id || overlaps(handoff.workspace_path, workspace.path) || sharesDirectory(handoff.workspace_path, workspace.path)) throw new SessionError('Workspace or overlapping workspace has a pending handoff. Resume or recover it before continuing.');
    }
  }
  reserve({ owner, workspace, key, input, digest, bootId, workspaceIdentity }) {
    return this.transaction(() => {
      const prior = this.prior(owner, workspace.id, key, digest);
      if (prior) return { session: prior, created: false };
      if (input.createdAt < this.now() - day || input.createdAt > this.now() + 60000) throw new SessionError('This request is stale. Review the conversation before sending a new prompt.', 410, 'STALE_REQUEST');
      this.assertWorkspaceIdle(workspace, workspaceIdentity);
      if (this.db.prepare('SELECT COUNT(*) AS n FROM workspace_guards').get().n >= 2) throw new SessionError('Two tasks are already active or uncertain. Finish or recover one first.');
      if (this.db.prepare('SELECT COALESCE(SUM(event_bytes),0) AS n FROM sessions').get().n > this.maxTotalBytes - 65536) throw new SessionError('Session storage budget is full. No new task was started.', 507);
      const id = randomUUID(), now = this.now();
      const [device, inode] = workspaceIdentity ?? [null, null];
      this.db.prepare(`INSERT INTO sessions(id,owner,workspace_id,workspace_path,request_key,request_digest,requested_at,thread_id,model,effort,state,created_at,updated_at,boot_id,workspace_device,workspace_inode)
        VALUES(?,?,?,?,?,?,?,?,?,?,'STARTING',?,?,?,?,?)`).run(id, owner, workspace.id, workspace.path, key, digest, input.createdAt, input.threadId, input.model, input.effort, now, now, bootId, device, inode);
      this.db.prepare('INSERT INTO workspace_guards VALUES(?,?)').run(workspace.id, id);
      this.insertEvent(id, 'input', { text: input.text });
      this.insertEvent(id, 'status', { state: 'STARTING', phase: 'starting' });
      return { session: this.view(this.raw(id)), created: true };
    });
  }
  insertEvent(id, type, payload) {
    const data = JSON.stringify(payload), bytes = Buffer.byteLength(data) + 128, row = this.raw(id);
    if (!row) throw new SessionError('Session not found.', 404);
    const control = ['status', 'phase', 'recovery'].includes(type);
    const reserve = Math.min(4 * 1024 ** 2, Math.floor(this.maxSessionBytes / 8));
    if (bytes > 128 * 1024 || row.event_bytes + bytes > this.maxSessionBytes - (control ? 0 : reserve)) throw new SessionError('Session output storage limit reached; stopping safely.', 507, 'STORAGE_LIMIT');
    const total = this.db.prepare('SELECT COALESCE(SUM(event_bytes),0) AS n FROM sessions').get().n;
    if (total + bytes > this.maxTotalBytes - (control ? 0 : 65536)) throw new SessionError('Controller event storage limit reached.', 507, 'STORAGE_LIMIT');
    const seq = row.last_event + 1;
    this.db.prepare('INSERT INTO events VALUES(?,?,?,?,?)').run(id, seq, type, data, bytes);
    this.db.prepare('UPDATE sessions SET last_event=?, event_bytes=event_bytes+?, updated_at=? WHERE id=?').run(seq, bytes, this.now(), id);
    return { id: seq, type, ...payload };
  }
  append(id, type, payload) { return this.transaction(() => {
    if (terminalStates.has(this.raw(id)?.state)) throw new SessionError('Cannot append output to a completed session.');
    return this.insertEvent(id, type, payload);
  }); }
  update(id, fields) {
    const allowed = new Set(['thread_id', 'turn_id', 'scope', 'phase']);
    const entries = Object.entries(fields);
    if (!entries.length || entries.some(([key]) => !allowed.has(key))) throw new Error('Invalid session metadata field.');
    this.db.prepare(`UPDATE sessions SET ${entries.map(([key]) => `${key}=?`).join(',')},updated_at=? WHERE id=?`).run(...entries.map(([, value]) => value), this.now(), id);
  }
  transition(id, state, reason = null, evidence = null) {
    return this.transaction(() => {
      const row = this.raw(id);
      if (row.state === state) return this.view(row);
      if (!transitions[row.state]?.includes(state)) throw new SessionError('Invalid session state transition.');
      if (terminalStates.has(state) && !evidence?.stopped) throw new SessionError('Verified execution-stop evidence is required.');
      const terminal = terminalStates.has(state);
      this.db.prepare('UPDATE sessions SET state=?,phase=?,reason=?,terminal_at=?,updated_at=? WHERE id=?').run(state, terminal ? 'finished' : state === 'CANCEL_REQUESTED' ? 'stopping' : state === 'UNCERTAIN' ? 'recovery' : 'working', reason, terminal ? this.now() : null, this.now(), id);
      this.insertEvent(id, 'status', { state, reason, phase: terminal ? 'finished' : state === 'CANCEL_REQUESTED' ? 'stopping' : state === 'UNCERTAIN' ? 'recovery' : 'working' });
      if (terminal) this.db.prepare('DELETE FROM workspace_guards WHERE session_id=?').run(id);
      if (evidence) this.db.prepare('INSERT INTO recovery_audit(session_id,actor,action,evidence,created_at) VALUES(?,?,?,?,?)').run(id, evidence.actor || 'controller', state, JSON.stringify(evidence), this.now());
      return this.view(this.raw(id));
    });
  }
  events(id, after = 0, limit = 64) {
    const row = this.raw(id);
    if (!Number.isSafeInteger(after) || after < 0 || after > row.last_event) throw new SessionError('Invalid event cursor.', 400, 'INVALID_CURSOR');
    if (row.events_expired) throw new SessionError('Session events expired. Open saved conversation history and inspect session status.', 410, 'EVENTS_EXPIRED');
    return this.db.prepare('SELECT event_id,type,data FROM events WHERE session_id=? AND event_id>? ORDER BY event_id LIMIT ?').all(id, after, Math.min(limit, 64)).map((event) => ({ ...JSON.parse(event.data), type: event.type, id: event.event_id }));
  }
  cleanup() {
    this.transaction(() => {
      this.db.prepare('DELETE FROM events WHERE session_id IN (SELECT id FROM sessions WHERE terminal_at IS NOT NULL AND terminal_at<?)').run(this.now() - 7 * day);
      this.db.prepare('UPDATE sessions SET event_bytes=0,events_expired=1 WHERE terminal_at IS NOT NULL AND terminal_at<?').run(this.now() - 7 * day);
      this.db.prepare('DELETE FROM sessions WHERE terminal_at IS NOT NULL AND terminal_at<?').run(this.now() - 30 * day);
    });
    this.db.exec('PRAGMA wal_checkpoint(PASSIVE)');
    this.db.exec('PRAGMA incremental_vacuum(1024)');
  }
  close() { this.db.close(); }
}
