import { SessionError } from '../../lib/session-store.mjs';

// Explicitly injected only into tests. Production has no untracked-process fallback.
export class FixtureScopes {
  constructor() { this.entries = new Map(); this.failStop = false; }
  async available() {}
  async create(id) { const scope = { id }; this.entries.set(id, false); return scope; }
  spawnOptions() { return {}; }
  async verify(scope) { if (!scope || !this.entries.has(scope.id)) throw new SessionError('Missing scope proof.'); return { stopped: this.entries.get(scope.id), proof: 'fixture' }; }
  async stop(scope) { if (this.failStop) throw new Error('Fixture stop failure'); this.entries.set(scope.id, true); return this.verify(scope); }
  async ownsPort() { return true; }
  async remove() {}
}
export function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
