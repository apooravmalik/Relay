import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const defaultFile = path.join(process.env.HOME || '/tmp', '.relay-v0', 'controller', 'preferences.json');

function preferenceFile() {
  return process.env.RELAY_PREFERENCES_FILE || defaultFile;
}

async function readPreferences() {
  try {
    const parsed = JSON.parse(await readFile(preferenceFile(), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

async function savePreferences(preferences) {
  const target = preferenceFile();
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(preferences)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, target);
}

export async function hiddenThreadIds(login) {
  const preferences = await readPreferences();
  return new Set(Array.isArray(preferences[login]?.hiddenThreadIds) ? preferences[login].hiddenThreadIds : []);
}

export async function hideThread(login, threadId) {
  const preferences = await readPreferences();
  const hidden = new Set(Array.isArray(preferences[login]?.hiddenThreadIds) ? preferences[login].hiddenThreadIds : []);
  hidden.add(threadId);
  preferences[login] = { hiddenThreadIds: [...hidden] };
  await savePreferences(preferences);
}
