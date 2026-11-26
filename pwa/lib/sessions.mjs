import { EventEmitter } from 'node:events';
import { homedir } from 'node:os';
import path from 'node:path';
import { realpath } from 'node:fs/promises';
import { SessionError, SessionStore, terminalStates } from './session-store.mjs';
import { acquireLock, bootId, ExecutionScopes } from './execution-scope.mjs';

export class SessionManager extends EventEmitter {
  constructor({ stateDirectory = process.env.RELAY_CONTROLLER_STATE_DIR || path.join(homedir(), '.relay-v0/controller'), scopes = new ExecutionScopes(), run, interrupt, openPreview, stopPreview, checkPreview = async () => {}, validateThread = async () => {}, validateInput = async () => {}, now, storeOptions } = {}) {
    super();
    this.directory = stateDirectory; this.scopes = scopes; this.run = run; this.interrupt = interrupt;
    this.validateThread = validateThread; this.validateInput = validateInput; this.active = new Map(); this.starting = new Map(); this.fatal = false;
    this.openPreview = openPreview; this.stopPreview = stopPreview; this.checkPreview = checkPreview;
    this.ready = this.initialize(now, storeOptions);
    // The HTTP layer can return a sanitized 503 if initialization fails.
    this.ready.catch(() => {});
  }
  async initialize(now, storeOptions) {
    this.singleton = await acquireLock(this.directory, 'session-controller');
    try {
      this.boot = await bootId();
      this.store = new SessionStore(path.join(this.directory, 'sessions'), { now, ...storeOptions, requiredMarker: path.join(this.directory, 'sessions-required') });
      for (const row of this.store.pending()) {
        let evidence;
        try {
          const scope = JSON.parse(row.scope || 'null');
          evidence = row.boot_id !== this.boot ? { stopped: true, proof: 'host-boot-changed' }
            : (scope?.armed || row.turn_id) ? await this.scopes.verify(scope) : null;
        } catch {}
        if (evidence?.stopped && !this.store.db.prepare('SELECT 1 FROM preview_ports WHERE session_id=?').get(row.id)) this.store.transition(row.id, 'INTERRUPTED', 'Controller restarted; previous task stopped. The prompt was not repeated.', evidence);
        else if (row.state !== 'UNCERTAIN') this.store.transition(row.id, 'UNCERTAIN', 'Controller restarted without verified task termination. Inspect recovery before continuing.');
      }
      this.store.cleanup();
      this.cleanupTimer = setInterval(() => { try { this.store.cleanup(); } catch { this.fatal = true; } }, 3600000);
      this.cleanupTimer.unref();
    } catch (error) { this.store?.close(); await this.singleton.release(); throw error; }
  }
  async ensure() { await this.ready.catch(() => { throw new SessionError('Session storage initialization failed. Restore storage before execution.', 503); }); if (this.fatal || !this.singleton.alive()) throw new SessionError('Session storage or controller ownership needs recovery.', 503); }
  async start(owner, workspace, body) {
    await this.ensure();
    const { digest } = SessionStore.request(body);
    const key = JSON.stringify([owner, workspace.id, body.idempotencyKey]);
    if (this.starting.has(key)) {
      await this.starting.get(key);
      return this.store.prior(owner, workspace.id, body.idempotencyKey, digest);
    }
    const work = this.startOnce(owner, workspace, body);
    this.starting.set(key, work);
    try { return await work; } finally { this.starting.delete(key); }
  }
  async startOnce(owner, workspace, body) {
    await this.ensure();
    if (this.draining) throw new SessionError('Controller is draining for shutdown. No new task was started.', 503);
    const { input, digest } = SessionStore.request(body);
    const existing = this.store.prior(owner, workspace.id, body.idempotencyKey, digest);
    if (existing) return existing;
    if (await realpath(workspace.path) !== workspace.path) throw new SessionError('Workspace identity changed.', 409);
    if (input.threadId) await this.validateThread(workspace.path, input.threadId);
    await this.validateInput(input);
    await this.scopes.available();
    const lockDirectory = path.join(this.directory, 'handoff-locks');
    // Serialize reservation with compatible SSH helpers until the durable guard
    // has been committed. Tasks in unrelated workspaces can then run together.
    const gate = await acquireLock(lockDirectory, 'workspace-hierarchy', { waitSeconds: 1 });
    let lock;
    let reservation;
    try {
      lock = await acquireLock(lockDirectory, workspace.id);
      // A pending transfer journal/checkpoint must be settled before another writer starts.
      const { assertTransferIdle } = await import('./transfer-readiness.mjs');
      await assertTransferIdle(workspace.id, workspace.path);
      if (this.draining) throw new SessionError('Controller is draining. No new task was started.', 503);
      if (!gate.alive()) throw new SessionError('Workspace coordination lock was lost.');
      reservation = this.store.reserve({ owner, workspace, key: body.idempotencyKey, input, digest, bootId: this.boot });
      if (!reservation.created) { await lock.release(); return reservation.session; }
    } catch (error) { await lock?.release(); throw error; }
    finally { await gate.release(); }
    const active = { lock, scope: null, threadId: input.threadId, turnId: null, cancelTimer: null };
    this.active.set(reservation.session.id, active);
    active.watchdog = setInterval(async () => {
      if (active.finishing || active.checkingLock || (active.lock.alive() && this.singleton.alive())) return;
      active.checkingLock = true;
      try {
        this.store.transition(reservation.session.id, 'UNCERTAIN', 'Execution lock ownership was lost. Inspect recovery.');
        this.signal(reservation.session.id);
        if (active.scope) await this.scopes.stop(active.scope);
      } catch { this.fatal = true; }
    }, 500);
    active.watchdog.unref();
    const work = this.execute(reservation.session.id, workspace, input, active);
    active.work = work; work.catch(() => {});
    return reservation.session;
  }
  signal(id) { this.emit(id); }
  event(id, event) {
    const execution = this.active.get(id);
    if (!execution?.lock.alive() || !this.singleton.alive()) throw new SessionError('Execution lock ownership was lost.');
    const { type, ...data } = event;
    if (type === 'conversation') this.store.update(id, { thread_id: event.conversation.id });
    if (type === 'turn') {
      this.store.update(id, { thread_id: event.threadId, turn_id: event.turnId });
      const active = this.active.get(id); active.threadId = event.threadId; active.turnId = event.turnId;
      if (this.store.raw(id).state === 'STARTING') this.store.transition(id, 'RUNNING');
      if (this.store.raw(id).state === 'CANCEL_REQUESTED') void this.sendInterrupt(id);
    }
    this.store.append(id, type, data); this.signal(id);
  }
  async execute(id, workspace, input, active) {
    let outcome = 'FAILED', reason = null, evidence;
    try {
      if (this.store.raw(id).state === 'CANCEL_REQUESTED') {
        evidence = { stopped: true, proof: 'cancelled-before-spawn' }; outcome = 'INTERRUPTED';
      } else {
        active.scope = await this.scopes.create(id);
        this.store.update(id, { scope: JSON.stringify(active.scope) });
        if (!active.lock.alive()) throw new SessionError('Execution lock was lost before start.');
        if (this.store.raw(id).state === 'CANCEL_REQUESTED') { outcome = 'INTERRUPTED'; }
        else {
          const result = await this.run({ cwd: workspace.path, ...input, spawnOptions: {
            ...this.scopes.spawnOptions(active.scope),
            onInitialized: () => { active.scope.armed = true; this.store.update(id, { scope: JSON.stringify(active.scope) }); },
          }, onEvent: (event) => this.event(id, event) });
          outcome = result.status === 'completed' ? 'COMPLETED' : result.status === 'interrupted' ? 'INTERRUPTED' : 'FAILED';
        }
      }
    } catch (error) {
      active.unconfirmedChild = Boolean(error.executionUncertain);
      if (this.store.raw(id)?.state === 'CANCEL_REQUESTED') outcome = 'INTERRUPTED';
      reason = error instanceof SessionError ? error.message : 'Codex execution failed. Inspect the saved conversation and session status.';
    }
    try {
      active.finishing = true;
      this.store.update(id, { phase: 'finishing' });
      this.store.append(id, 'phase', { phase: 'finishing' }); this.signal(id);
    } catch { this.fatal = true; }
    try {
      // This is independent of HTTP, RPC acknowledgment, and app-server exit.
      if (active.scope) evidence = await this.scopes.stop(active.scope);
      else if (!evidence) evidence = { stopped: true, proof: 'scope-creation-failed-before-spawn' };
      if (!evidence.stopped) throw new SessionError('Task stop could not be verified.');
      if (active.unconfirmedChild) throw new SessionError('Direct child exit was not confirmed.');
      await active.previewWork?.catch(() => {});
      await this.cleanPreviews(id);
      this.store.transition(id, outcome, reason, evidence);
      if (active.scope) await this.scopes.remove(active.scope);
    } catch {
      try { if (!terminalStates.has(this.store.raw(id).state)) this.store.transition(id, 'UNCERTAIN', 'Task cleanup or durable finalization could not be verified. Workspace handoffs remain blocked.'); }
      catch { this.fatal = true; }
    } finally {
      clearTimeout(active.cancelTimer);
      clearInterval(active.watchdog);
      await active.lock.release(); this.active.delete(id); this.signal(id);
    }
  }
  async sendInterrupt(id) {
    const active = this.active.get(id);
    if (!active?.turnId || active.interruptSent) return;
    active.interruptSent = true;
    try { await this.interrupt({ cwd: this.store.raw(id).workspace_path, threadId: active.threadId }); }
    catch { active.interruptSent = false; }
  }
  async preview(owner, workspaceId, id, port) {
    await this.ensure();
    this.store.get(id, owner, workspaceId);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new SessionError('Invalid preview port.', 400);
    const active = this.active.get(id);
    if (!active || active.finishing) throw new SessionError('Previews are available only while this task is active.');
    const work = (active.previewWork || Promise.resolve()).catch(() => {}).then(async () => {
      if (active.finishing || !await this.scopes.ownsPort(active.scope, port)) throw new SessionError('This listener is not owned by the active task.');
      const existing = this.store.db.prepare('SELECT * FROM preview_ports WHERE port=?').get(port);
      if (existing && existing.session_id !== id) throw new SessionError('Preview port belongs to another session.');
      if (existing?.url) return { port, url: existing.url };
      if (!existing) await this.checkPreview(port);
      if (active.finishing) throw new SessionError('Task is finishing; its preview cannot be published.');
      this.store.db.prepare('INSERT OR IGNORE INTO preview_ports(port,session_id) VALUES(?,?)').run(port, id);
      const preview = await this.openPreview(port);
      this.store.db.prepare('UPDATE preview_ports SET url=? WHERE port=? AND session_id=?').run(preview.url, port, id);
      this.event(id, { type: 'preview', ...preview });
      return preview;
    });
    active.previewWork = work; return work;
  }
  async cleanPreviews(id) {
    for (const { port } of this.store.db.prepare('SELECT port FROM preview_ports WHERE session_id=?').all(id)) {
      await this.stopPreview(port);
      this.store.db.prepare('DELETE FROM preview_ports WHERE port=? AND session_id=?').run(port, id);
    }
  }
  async removePreview(owner, workspaceId, port) {
    await this.ensure();
    const row = this.store.db.prepare('SELECT * FROM preview_ports WHERE port=?').get(port);
    if (!row) throw new SessionError('Session preview not found.', 404);
    this.store.get(row.session_id, owner, workspaceId);
    await this.stopPreview(port);
    this.store.db.prepare('DELETE FROM preview_ports WHERE port=? AND session_id=?').run(port, row.session_id);
    return { port, status: 'stopped' };
  }
  async stop(owner, workspaceId, id) {
    await this.ensure();
    const session = this.store.get(id, owner, workspaceId);
    if (terminalStates.has(session.state)) return session;
    if (session.state === 'UNCERTAIN') throw new SessionError('Use recovery to inspect and stop uncertain execution.');
    this.store.transition(id, 'CANCEL_REQUESTED'); this.signal(id);
    const active = this.active.get(id);
    if (!active) throw new SessionError('No live execution handle. Inspect recovery.');
    void this.sendInterrupt(id);
    if (!active.cancelTimer) {
      active.cancelTimer = setTimeout(async () => {
        try {
          // A bounded Stop escalates only inside the positively identified task scope.
          if (active.scope) await this.scopes.stop(active.scope);
        } catch {
          try { this.store.transition(id, 'UNCERTAIN', 'Stop deadline elapsed without verified termination.'); this.signal(id); } catch { this.fatal = true; }
        }
      }, 30000);
      active.cancelTimer.unref();
    }
    return this.store.get(id, owner, workspaceId);
  }
  async recovery(owner, workspaceId, id, action, generation) {
    await this.ensure();
    const session = this.store.get(id, owner, workspaceId), row = this.store.raw(id);
    if (session.state !== 'UNCERTAIN') throw new SessionError('Session does not need recovery.');
    if (this.active.has(id)) throw new SessionError('Execution finalization is still active. Wait before recovery.');
    const lock = await acquireLock(path.join(this.directory, 'handoff-locks'), workspaceId);
    try {
      const scope = JSON.parse(row.scope || 'null');
      if (action && generation !== this.store.raw(id).last_event) throw new SessionError('Recovery evidence changed. Inspect again.');
      if (action && !['recheck', 'terminate'].includes(action)) throw new SessionError('Unsupported recovery action.', 400);
      if (action) this.store.db.prepare('INSERT INTO recovery_audit(session_id,actor,action,evidence,created_at) VALUES(?,?,?,?,?)').run(id, owner, `requested:${action}`, JSON.stringify({ generation }), Date.now());
      let evidence;
      try {
        if (row.boot_id !== this.boot) evidence = { stopped: true, proof: 'host-boot-changed' };
        else {
          if (!scope?.armed && !row.turn_id) throw new SessionError('Startup was not fenced; an empty scope alone cannot prove stop.');
          evidence = action === 'terminate' ? await this.scopes.stop(scope) : await this.scopes.verify(scope);
        }
      }
      catch { evidence = { stopped: false, proof: 'unavailable', message: 'Administrator recovery is required. Do not clear the guard manually. See the deployment runbook.' }; }
      if (!action) return { session, evidence, actions: ['recheck', 'terminate'] };
      this.store.db.prepare('INSERT INTO recovery_audit(session_id,actor,action,evidence,created_at) VALUES(?,?,?,?,?)').run(id, owner, `checked:${action}`, JSON.stringify(evidence), Date.now());
      if (!evidence.stopped) throw new SessionError('Execution is not proven stopped. The workspace remains blocked.');
      await this.cleanPreviews(id);
      const result = this.store.transition(id, 'INTERRUPTED', 'Recovered after verified termination. Interrupted edits were preserved.', { ...evidence, actor: owner });
      if (scope) await this.scopes.remove(scope);
      this.signal(id); return { session: result, evidence };
    } finally { await lock.release(); }
  }
  async close() {
    await this.ready.catch(() => {});
    if (this.active.size) throw new SessionError('Controller has active sessions. Drain or explicitly stop them before closing.');
    clearInterval(this.cleanupTimer); this.store?.close(); await this.singleton?.release();
  }
}
