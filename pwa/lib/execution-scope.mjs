import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdir, readFile, realpath, rmdir, stat, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { SessionError } from './session-store.mjs';

const wrapper = fileURLToPath(new URL('../../relay_lib/session_scope_exec.py', import.meta.url));
const run = promisify(execFile);
export async function bootId() { return (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim(); }

export async function acquireLock(directory, name, { waitSeconds = 0 } = {}) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const mode = waitSeconds > 0 ? ['-w', String(waitSeconds)] : ['-n'];
  const child = spawn('flock', [...mode, path.join(directory, `${name}.lock`), 'sh', '-c', 'printf ready; cat >/dev/null'], { stdio: ['pipe', 'pipe', 'ignore'] });
  child.stdin.on('error', () => {});
  return new Promise((resolve, reject) => {
    const failed = () => reject(new SessionError('Workspace or controller is busy.', 409, 'WORKSPACE_BUSY'));
    child.once('error', failed); child.once('exit', failed);
    child.stdout.once('data', () => {
      let released = false;
      resolve({
        alive: () => !released && child.exitCode === null && child.signalCode === null,
        release: () => new Promise((done) => {
          released = true;
          if (child.exitCode !== null || child.signalCode !== null) return done();
          child.once('exit', done); child.stdin.end();
        }),
      });
    });
  });
}

export class ExecutionScopes {
  async base() {
    const entry = (await readFile('/proc/self/cgroup', 'utf8')).split('\n').find((line) => line.startsWith('0::'));
    if (!entry) throw new SessionError('Linux cgroup v2 is required for task ownership.', 503);
    return path.join('/sys/fs/cgroup', entry.slice(3));
  }
  async available() {
    try { await access(await this.base(), constants.W_OK); }
    catch { throw new SessionError('Task process tracking is not installed. Apply the documented cgroup delegation prerequisite.', 503, 'SCOPE_UNAVAILABLE'); }
  }
  async create(id) {
    await this.available();
    const directory = path.join(await this.base(), `relay-task-${id}`);
    await mkdir(directory);
    await access(path.join(directory, 'cgroup.kill'), constants.W_OK);
    const identity = await stat(directory);
    return { directory, inode: String(identity.ino), bootId: await bootId() };
  }
  async verify(scope) {
    if (!scope) throw new SessionError('No execution scope was recorded. Stop cannot be proven.');
    if (scope.bootId !== await bootId()) return { stopped: true, proof: 'host-boot-changed' };
    const base = await this.base();
    if (path.dirname(scope.directory) !== base || !/^relay-task-[0-9a-f-]{36}$/.test(path.basename(scope.directory))) throw new SessionError('Unrecognized execution scope. Administrator recovery is required.');
    if (await realpath(scope.directory) !== scope.directory || String((await stat(scope.directory)).ino) !== scope.inode) throw new SessionError('Execution scope identity changed. Administrator recovery is required.');
    const events = await readFile(path.join(scope.directory, 'cgroup.events'), 'utf8');
    return { stopped: /^populated 0$/m.test(events), proof: 'verified-cgroup-membership', scope: path.basename(scope.directory) };
  }
  spawnOptions(scope) { return { command: 'python3', args: [wrapper, scope.directory, scope.inode, 'codex', 'app-server', '--listen', 'stdio://'] }; }
  async ownsPort(scope, port) {
    await this.verify(scope);
    const { stdout } = await run('ss', ['-ltnpH', `sport = :${port}`], { timeout: 3000, maxBuffer: 65536 });
    const lines = stdout.split('\n').filter((line) => line && !line.includes('%tailscale0:'));
    const pids = lines.flatMap((line) => [...line.matchAll(/pid=(\d+)/g)].map((match) => match[1]));
    if (!lines.length || !pids.length || lines.some((line) => !/pid=\d+/.test(line))) return false;
    const relative = scope.directory.slice('/sys/fs/cgroup'.length);
    for (const pid of pids) {
      const group = (await readFile(`/proc/${pid}/cgroup`, 'utf8')).split('\n').find((line) => line.startsWith('0::'))?.slice(3);
      if (group !== relative && !group?.startsWith(`${relative}/`)) return false;
    }
    return true;
  }
  async stop(scope) {
    const initial = await this.verify(scope);
    if (initial.stopped) return initial;
    // cgroup.kill covers descendants, including setsid/double-fork children.
    await writeFile(path.join(scope.directory, 'cgroup.kill'), '1');
    for (let attempt = 0; attempt < 100; attempt++) {
      const evidence = await this.verify(scope);
      if (evidence.stopped) return evidence;
      await sleep(50);
    }
    throw new SessionError('Task descendants have not been confirmed stopped. Workspace remains blocked.');
  }
  async remove(scope) { try { if ((await this.verify(scope)).stopped && scope.bootId === await bootId()) await rmdir(scope.directory); } catch {} }
}
