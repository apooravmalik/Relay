import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const stylesheet = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');
const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const markup = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');

test('mobile layout keeps hidden panels hidden and shrinks long chat content', () => {
  assert.match(stylesheet, /\[hidden\]\s*\{\s*display:\s*none\s*!important;\s*\}/);
  assert.match(stylesheet, /\.message\s*\{[^}]*overflow-wrap:\s*anywhere/s);
  assert.match(stylesheet, /grid-template-columns:\s*46px minmax\(0, 1fr\) 46px/);
  assert.match(stylesheet, /\.composer textarea\s*\{[^}]*min-height:\s*22px/s);
});

test('chat UI bounds scrolling and prevents concurrent sends', () => {
  assert.match(stylesheet, /\.message-list\s*\{[^}]*overflow-y:\s*auto/s);
  assert.match(app, /if \(state\.busy \|\| !text \|\| !state\.conversation\) return/);
  assert.match(app, /Math\.max\(prompt\.scrollHeight, 22\)/);
  assert.match(app, /setBusy\(true\)/);
  assert.match(app, /finally \{\s*setBusy\(false\);\s*\}/s);
});

test('PWA markup versions its UI assets after a controller deployment', () => {
  assert.match(markup, /styles\.css\?v=mobile-ui-2/);
  assert.match(markup, /app\.js\?v=mobile-ui-2/);
});
