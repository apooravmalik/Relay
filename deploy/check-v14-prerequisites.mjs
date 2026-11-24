import { ExecutionScopes } from '../pwa/lib/execution-scope.mjs';
import { randomUUID } from 'node:crypto';
const scopes = new ExecutionScopes();
let scope;
try {
  await scopes.available();
  scope = await scopes.create(randomUUID());
  const proof = await scopes.verify(scope);
  if (!proof.stopped) throw new Error('Fresh task scope was not empty.');
  console.log('PASS: cgroup v2 task directory creation and identity verification.');
  console.log('Run the opt-in VM tests before declaring child cleanup verified.');
} catch {
  console.error('FAIL: run this check as the controller user inside the candidate service with the V1.4 delegation configuration. See RELAY_V1_4_DEPLOYMENT.md.');
  process.exitCode = 1;
} finally { if (scope) await scopes.remove(scope); }
