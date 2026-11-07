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
  assert.match(app, /if \(state\.busy \|\| \(!message && !state\.attachment\) \|\| !state\.conversation\) return/);
  assert.match(app, /Math\.max\(prompt\.scrollHeight, 22\)/);
  assert.match(app, /setBusy\(true\)/);
  assert.match(app, /finally \{\s*setBusy\(false\);\s*\}/s);
});

test('PWA markup versions its UI assets after a controller deployment', () => {
  assert.match(markup, /styles\.css\?v=mobile-reconcile-1/);
  assert.match(markup, /app\.js\?v=mobile-reconcile-1/);
});

test('chat messages render safe Markdown instead of raw HTML text', () => {
  assert.match(app, /renderMarkdown/);
  assert.match(app, /message-content/);
  assert.match(stylesheet, /\.message-content table/);
});

test('workspace files use the same mobile tree treatment as the project picker', () => {
  assert.match(markup, /id="files-tab"/);
  assert.match(markup, /id="workspace-files"/);
  assert.match(app, /api\/workspaces\/\$\{state\.workspace\.id\}\/files/);
  assert.match(app, /browse-file/);
  assert.match(stylesheet, /\.workspace-file-row\s*\{[^}]*cursor:\s*pointer/s);
});

test('PWA exposes a hierarchical plain-folder picker and per-turn chat model controls', () => {
  assert.match(markup, /id="add-workspace"/);
  assert.match(markup, /id="workspace-creator"/);
  assert.match(markup, /id="open-folder"/);
  assert.match(markup, /Create folder/);
  assert.doesNotMatch(markup, /Git repository/);
  assert.match(stylesheet, /\.directory-children\s*\{[^}]*border-left/s);
  assert.match(stylesheet, /\.child-directory\s*\{[^}]*position:\s*relative/s);
  assert.match(markup, /id="chat-model"/);
  assert.match(markup, /id="chat-effort"/);
  assert.match(app, /api\/project-roots/);
  assert.match(app, /api\/codex\/models/);
  assert.match(app, /const selection = \{ model: modelSelect\.value \|\| undefined, effort: effortSelect\.value \|\| undefined \}/);
});

test('chat composer puts uploads and model settings behind a future-ready add menu', () => {
  assert.match(markup, /id="file-upload"/);
  assert.match(markup, /id="add-menu"/);
  assert.match(markup, /id="composer-menu"/);
  assert.match(markup, /id="open-model-settings"/);
  assert.match(markup, /id="model-settings-dialog"/);
  assert.match(markup, /id="git-status"/);
  assert.match(markup, /id="stop-turn"/);
  assert.doesNotMatch(markup, /Codex runs with full VM access/);
  assert.match(app, /api\/workspaces\/\$\{state\.workspace\.id\}\/uploads/);
  assert.match(app, /Uploaded file: \$\{upload\.path\}/);
  assert.match(app, /uploadInput\.click\(\)/);
  assert.match(app, /composerMenu\.showModal\(\)/);
  assert.match(stylesheet, /\.git-status\s*\{[^}]*border-radius:\s*999px/s);
  assert.match(stylesheet, /\.add-button\s*\{[^}]*font-size:\s*1\.65rem/s);
  assert.match(stylesheet, /\.tab\s*\{[^}]*font-size:\s*\.88rem/s);
});

test('chat controls expose working feedback, concise reasoning summaries, and a real stop route', () => {
  assert.match(markup, /id="stop-turn"/);
  assert.match(markup, /id="git-status"/);
  assert.match(app, /Codex is working/);
  assert.match(app, /reasoning/);
  assert.match(app, /turns\/stop/);
  assert.match(app, /Edit & resend/);
  assert.match(stylesheet, /\.working-dots\s*\{[^}]*display:\s*inline-flex/s);
});

test('workspace UI offers a private localhost preview link', () => {
  assert.match(markup, /id="open-preview"/);
  assert.match(markup, /id="preview-port"/);
  assert.match(app, /\/preview/);
  assert.match(app, /previewDialog\.showModal/);
});

test('completed Codex replies turn a live localhost address into a phone preview', () => {
  assert.match(app, /localPreviewPorts/);
  assert.match(app, /publishDetectedPreviews/);
  assert.match(app, /Open on this phone/);
  assert.match(stylesheet, /\.preview-open\s*\{[^}]*background:\s*var\(--accent\)/s);
});

test('chat localhost links are opened through Relay instead of the phone loopback', () => {
  assert.match(app, /async function openChatPreview/);
  assert.match(app, /messageList\.addEventListener\('click', openChatPreview\)/);
  assert.match(app, /api\(`\/api\/workspaces\/\$\{state\.workspace\.id\}\/preview`/);
  assert.match(app, /previewWindow\.location\.replace\(preview\.url\)/);
});
