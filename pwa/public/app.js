import { localPreviewPorts } from './local-preview.js';
import { renderMarkdown } from './markdown.js';

const homeScreen = document.querySelector('#home-screen');
const workspaceScreen = document.querySelector('#workspace-screen');
const workspaceList = document.querySelector('#workspace-list');
const conversationList = document.querySelector('#conversation-list');
const changesList = document.querySelector('#changes-list');
const workspaceFiles = document.querySelector('#workspace-files');
const conversationPanel = document.querySelector('#conversation-list-panel');
const chatPanel = document.querySelector('#chat-panel');
const changesPanel = document.querySelector('#changes-panel');
const filesPanel = document.querySelector('#files-panel');
const messageList = document.querySelector('#message-list');
const prompt = document.querySelector('#prompt');
const composer = document.querySelector('#composer');
const fileViewer = document.querySelector('#file-viewer');
const workspaceCreator = document.querySelector('#workspace-creator');
const chatSettings = document.querySelector('#new-chat-settings');
const modelSelect = document.querySelector('#chat-model');
const effortSelect = document.querySelector('#chat-effort');
const uploadInput = document.querySelector('#file-upload');
const addMenu = document.querySelector('#add-menu');
const composerMenu = document.querySelector('#composer-menu');
const modelSettingsDialog = document.querySelector('#model-settings-dialog');
const uploadList = document.querySelector('#upload-list');
const stopTurn = document.querySelector('#stop-turn');
const previewDialog = document.querySelector('#preview-dialog');
const previewPort = document.querySelector('#preview-port');
const previewStatus = document.querySelector('#preview-status');
const previewLink = document.querySelector('#preview-link');

const state = { attachment: null, busy: false, changes: [], conversation: null, fileDirectories: new Map(), filesLoaded: false, models: [], preview: null, projectRoot: null, projectPath: '', turnStatus: null, voiceSupported: false, workspace: null };

function element(name, className, text) {
  const node = document.createElement(name);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

async function api(url, options) {
  const response = await fetch(url, { headers: { Accept: 'application/json', ...(options?.headers || {}) }, ...options });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || 'Relay controller is unavailable.');
  }
  return response.status === 204 ? null : response.json();
}

function setTab(tab) {
  const chats = tab === 'chats';
  for (const button of document.querySelectorAll('.tab')) {
    const selected = button.id === `${tab}-tab`;
    button.classList.toggle('selected', selected);
    button.setAttribute('aria-selected', String(selected));
    button.tabIndex = selected ? 0 : -1;
  }
  conversationPanel.hidden = !chats;
  chatPanel.hidden = true;
  changesPanel.hidden = tab !== 'changes';
  filesPanel.hidden = tab !== 'files';
  if (tab === 'files' && !state.filesLoaded) void loadWorkspaceFiles();
}

function workspaceRow(workspace) {
  const row = element('article', `workspace ${workspace.status}`);
  const status = element('p', 'status', workspace.status === 'ready' ? 'VM online' : 'Workspace unavailable');
  const title = element('h2', '', workspace.name);
  const metrics = element('div', 'metrics');
  if (workspace.status === 'ready') {
    const values = workspace.gitAvailable
      ? [['Branch', workspace.branch], ['Changed files', String(workspace.changedFileCount)]]
      : [['Repository', 'Not initialized']];
    for (const [label, value] of values) {
      const metric = element('div', 'metric');
      metric.append(element('span', '', label), element('strong', '', value));
      metrics.append(metric);
    }
  }
  const detail = element('p', 'handoff', workspace.gitAvailable
    ? (workspace.handoffReady ? 'Last handoff: Mac → VM' : 'No completed handoff yet')
    : 'Ask Codex to initialize Git when you are ready.');
  const button = element('button', 'primary', 'Open workspace');
  button.disabled = workspace.status !== 'ready';
  button.addEventListener('click', () => openWorkspace(workspace));
  row.append(status, title, metrics, detail, button);
  return row;
}

async function loadHome() {
  workspaceList.replaceChildren(element('p', 'loading', 'Loading workspaces…'));
  try {
    const { workspaces } = await api('/api/workspaces');
    workspaceList.replaceChildren(...(workspaces.length ? workspaces.map(workspaceRow) : [element('p', 'loading', 'No workspaces are registered on this VM yet.')]));
  } catch (error) {
    workspaceList.replaceChildren(element('p', 'error', error.message));
  }
}

function renderWorkspaceHeader() {
  if (!state.workspace) return;
  document.querySelector('#workspace-name').textContent = state.workspace.name;
  document.querySelector('#workspace-meta').textContent = `${state.workspace.gitAvailable ? state.workspace.branch : 'Git not initialized'} · VM workspace`;
  const gitStatus = document.querySelector('#git-status');
  gitStatus.className = `git-status ${state.workspace.gitAvailable ? 'active' : 'inactive'}`;
  gitStatus.textContent = state.workspace.gitAvailable ? 'Git ✓' : 'Git ×';
  gitStatus.title = state.workspace.gitAvailable ? 'Git is ready in this workspace.' : 'Git is not set up in this workspace.';
  gitStatus.setAttribute('aria-label', gitStatus.title);
}

async function refreshWorkspaceMetadata() {
  if (!state.workspace) return;
  const { workspaces } = await api('/api/workspaces');
  const workspace = workspaces.find((candidate) => candidate.id === state.workspace.id);
  if (!workspace) return;
  state.workspace = workspace;
  renderWorkspaceHeader();
}

function option(value, label, selected = false) {
  const node = document.createElement('option');
  node.value = value;
  node.textContent = label;
  node.selected = selected;
  return node;
}

function selectedModel() {
  return state.models.find((model) => model.id === modelSelect.value);
}

function populateEfforts() {
  const model = selectedModel();
  effortSelect.replaceChildren(...(model?.efforts || []).map((effort) => option(effort.id, effort.id, effort.id === model.defaultEffort)));
  effortSelect.disabled = !model?.efforts?.length;
}

async function loadModels() {
  try {
    const { models } = await api('/api/codex/models');
    state.models = models;
    modelSelect.replaceChildren(...models.map((model) => option(model.id, model.name)));
    modelSelect.disabled = !models.length;
    populateEfforts();
    chatSettings.hidden = !models.length;
  } catch {
    state.models = [];
    chatSettings.hidden = true;
  }
}

function selectConversationModel(conversation) {
  if (!conversation?.model || !state.models.some((model) => model.id === conversation.model)) return;
  modelSelect.value = conversation.model;
  populateEfforts();
}

function projectPathLabel() {
  return state.projectPath ? `Home / ${state.projectPath}` : 'Home';
}

function folderIcon() {
  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  icon.setAttribute('viewBox', '0 0 24 24');
  icon.setAttribute('aria-hidden', 'true');
  const outline = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  outline.setAttribute('d', 'M3 6.5h6l2 2h10v9.5A2 2 0 0 1 19 20H5a2 2 0 0 1-2-2z');
  icon.append(outline);
  return icon;
}

function fileIcon() {
  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  icon.setAttribute('viewBox', '0 0 24 24');
  icon.setAttribute('aria-hidden', 'true');
  const outline = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  outline.setAttribute('d', 'M6 2h8l4 4v16H6zM14 2v5h5');
  icon.append(outline);
  return icon;
}

function workspaceFileRow(entry) {
  const directory = entry.kind === 'directory';
  const row = element('button', `directory-row workspace-file-row child-directory${directory ? '' : ' file-entry'}`);
  row.type = 'button';
  row.setAttribute('role', 'treeitem');
  row.setAttribute('aria-level', String(entry.path.split('/').length + 1));
  row.append(directory ? folderIcon() : fileIcon(), element('span', '', entry.name));
  if (directory) {
    const expanded = state.fileDirectories.get(entry.path)?.expanded === true;
    row.setAttribute('aria-expanded', String(expanded));
    row.append(element('span', 'directory-chevron', expanded ? '⌄' : '›'));
    row.addEventListener('click', () => toggleWorkspaceDirectory(entry.path));
  } else {
    row.addEventListener('click', () => openWorkspaceFile(entry.path));
  }
  return row;
}

function renderWorkspaceFiles() {
  const root = state.fileDirectories.get('');
  document.querySelector('#file-location').textContent = state.workspace?.name ? `${state.workspace.name} / workspace` : '';
  if (!root) return workspaceFiles.replaceChildren(element('p', 'loading', 'Loading workspace files…'));
  const branch = (directory) => {
    const children = element('div', 'directory-children');
    children.setAttribute('role', 'group');
    children.append(...(directory.entries.length ? directory.entries.map((entry) => {
      const row = workspaceFileRow(entry);
      if (entry.kind !== 'directory' || !state.fileDirectories.get(entry.path)?.expanded) return row;
      const wrapper = element('div', 'workspace-file-branch');
      wrapper.append(row, branch(state.fileDirectories.get(entry.path)));
      return wrapper;
    }) : [element('p', 'empty', 'No visible files here.')]));
    return children;
  };
  const current = element('div', 'directory-row current-directory');
  current.setAttribute('role', 'treeitem');
  current.setAttribute('aria-level', '1');
  current.setAttribute('aria-expanded', 'true');
  current.append(folderIcon(), element('span', '', 'Workspace'), element('span', 'directory-chevron', '⌄'));
  workspaceFiles.replaceChildren(current, branch(root));
}

async function loadWorkspaceFiles(directory = '') {
  if (!state.workspace) return;
  if (!state.fileDirectories.has(directory)) state.fileDirectories.set(directory, { entries: [] });
  renderWorkspaceFiles();
  try {
    const result = await api(`/api/workspaces/${state.workspace.id}/files?path=${encodeURIComponent(directory)}`);
    state.fileDirectories.set(directory, { entries: result.entries, expanded: directory ? state.fileDirectories.get(directory)?.expanded : true });
    state.filesLoaded = true;
    renderWorkspaceFiles();
  } catch (error) {
    workspaceFiles.replaceChildren(element('p', 'error', error.message));
  }
}

async function toggleWorkspaceDirectory(directory) {
  const current = state.fileDirectories.get(directory);
  if (current?.expanded) {
    current.expanded = false;
    renderWorkspaceFiles();
    return;
  }
  if (current) {
    current.expanded = true;
    renderWorkspaceFiles();
    return;
  }
  state.fileDirectories.set(directory, { entries: [], expanded: true });
  await loadWorkspaceFiles(directory);
}

function projectDirectoryRow(directory) {
  const row = element('button', 'directory-row child-directory');
  row.type = 'button';
  row.setAttribute('role', 'treeitem');
  row.setAttribute('aria-level', '2');
  row.append(folderIcon(), element('span', '', directory.name), element('span', 'directory-chevron', '›'));
  row.addEventListener('click', () => loadProjectDirectories(directory.path));
  return row;
}

async function loadProjectDirectories(nextPath = '') {
  const location = document.querySelector('#project-location');
  const list = document.querySelector('#project-directories');
  if (!state.projectRoot) return;
  list.replaceChildren(element('p', 'loading', 'Loading folders…'));
  try {
    const result = await api(`/api/project-roots/${state.projectRoot}/directories?path=${encodeURIComponent(nextPath)}`);
    state.projectPath = result.path;
    location.textContent = projectPathLabel();
    document.querySelector('#folder-create-location').textContent = `Create in ${projectPathLabel()}`;
    document.querySelector('#up-folder').disabled = !state.projectPath;
    const current = element('div', 'directory-row current-directory');
    current.setAttribute('role', 'treeitem');
    current.setAttribute('aria-level', '1');
    current.setAttribute('aria-expanded', 'true');
    current.append(folderIcon(), element('span', '', state.projectPath.split('/').at(-1) || 'Home'), element('span', 'directory-chevron', '⌄'));
    const children = element('div', 'directory-children');
    children.setAttribute('role', 'group');
    children.append(...(result.directories.length ? result.directories.map(projectDirectoryRow) : [element('p', 'empty', 'No visible subfolders here.')]));
    list.replaceChildren(current, children);
  } catch (error) {
    list.replaceChildren(element('p', 'error', error.message));
  }
}

async function openWorkspaceCreator() {
  const status = document.querySelector('#project-creator-status');
  status.textContent = '';
  document.querySelector('#folder-browser').hidden = false;
  document.querySelector('#folder-creator').hidden = true;
  document.querySelector('#folder-picker-title').textContent = 'Choose project folder';
  workspaceCreator.showModal();
  try {
    const { roots } = await api('/api/project-roots');
    state.projectRoot = roots[0]?.id || null;
    state.projectPath = '';
    if (state.projectRoot) await loadProjectDirectories();
    else document.querySelector('#project-directories').replaceChildren(element('p', 'empty', 'The VM home folder is not available.'));
  } catch (error) {
    status.textContent = error.message;
  }
}

function showFolderCreator() {
  document.querySelector('#folder-browser').hidden = true;
  document.querySelector('#folder-creator').hidden = false;
  document.querySelector('#folder-picker-title').textContent = 'New folder';
  document.querySelector('#project-creator-status').textContent = '';
  document.querySelector('#project-name').value = '';
  document.querySelector('#project-name').focus();
}

function hideFolderCreator() {
  document.querySelector('#folder-creator').hidden = true;
  document.querySelector('#folder-browser').hidden = false;
  document.querySelector('#folder-picker-title').textContent = 'Choose project folder';
}

async function addProject(action) {
  const status = document.querySelector('#project-creator-status');
  const create = document.querySelector('#create-project');
  const open = document.querySelector('#open-folder');
  if (!state.projectRoot) return;
  create.disabled = true;
  open.disabled = true;
  status.textContent = action === 'create' ? 'Creating folder…' : 'Opening folder…';
  try {
    const body = action === 'create'
      ? { action, rootId: state.projectRoot, parentPath: state.projectPath, name: document.querySelector('#project-name').value.trim() }
      : { action: 'open', rootId: state.projectRoot, path: state.projectPath };
    const { workspace } = await api('/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    workspaceCreator.close();
    await openWorkspace(workspace);
    await createConversation();
  } catch (error) {
    status.textContent = error.message;
  } finally {
    create.disabled = false;
    open.disabled = false;
  }
}

function conversationRow(conversation) {
  const row = element('button', 'conversation-row');
  row.type = 'button';
  const title = element('strong', '', conversation.name);
  const preview = element('span', '', conversation.preview || 'No messages yet');
  const status = element('span', 'conversation-status', conversation.status === 'notLoaded' ? 'Saved' : conversation.status);
  row.append(title, preview, status);
  row.addEventListener('click', () => openConversation(conversation));
  return row;
}

async function loadWorkspaceData() {
  const [conversations, changes] = await Promise.all([
    api(`/api/workspaces/${state.workspace.id}/conversations`),
    api(`/api/workspaces/${state.workspace.id}/changes`),
  ]);
  state.changes = changes.changes;
  document.querySelector('#change-count').textContent = state.changes.length ? String(state.changes.length) : '';
  document.querySelector('#review-count').textContent = `${state.changes.length} file${state.changes.length === 1 ? '' : 's'} changed`;
  document.querySelector('#review-changes').hidden = !state.workspace.gitAvailable;
  conversationList.replaceChildren(...(conversations.conversations.length
    ? conversations.conversations.map(conversationRow)
    : [element('p', 'empty', 'No Relay conversations yet. Start one when you are ready.')]));
  changesList.replaceChildren(...(state.changes.length
    ? state.changes.map(changeRow)
    : [element('p', 'empty', state.workspace.gitAvailable ? 'No changed files on this VM.' : 'Initialize Git in Codex to view Relay changes and handoffs.')]));
}

function changeRow(change) {
  const row = element('button', 'change-row');
  row.type = 'button';
  const status = element('span', `file-status ${change.status.includes('?') ? 'new' : 'edited'}`, change.status.includes('?') ? '+' : '•');
  const path = element('strong', '', change.path);
  const stateText = element('span', '', change.previewAllowed ? (change.status.includes('?') ? 'Untracked' : 'Modified') : 'Protected');
  row.append(status, path, stateText);
  if (change.previewAllowed) row.addEventListener('click', () => openFile(change.path));
  else row.disabled = true;
  return row;
}

async function openWorkspace(workspace) {
  state.workspace = workspace;
  state.attachment = null;
  renderAttachment();
  state.conversation = null;
  state.fileDirectories = new Map();
  state.filesLoaded = false;
  state.preview = null;
  renderWorkspaceHeader();
  homeScreen.hidden = true;
  workspaceScreen.hidden = false;
  setTab('chats');
  conversationList.replaceChildren(element('p', 'loading', 'Loading conversations…'));
  changesList.replaceChildren(element('p', 'loading', 'Loading changes…'));
  workspaceFiles.replaceChildren(element('p', 'loading', 'Open Files to browse this workspace.'));
  try {
    await loadWorkspaceData();
  } catch (error) {
    conversationList.replaceChildren(element('p', 'error', error.message));
  }
}

function showPreview(preview) {
  state.preview = preview;
  previewPort.value = String(preview.port);
  previewStatus.textContent = `Private link ready on port ${preview.port}.`;
  previewLink.href = preview.url;
  previewLink.hidden = false;
  document.querySelector('#stop-preview').disabled = false;
}

async function createPreview(event) {
  event.preventDefault();
  const submit = document.querySelector('#preview-form button[type="submit"]');
  submit.disabled = true;
  previewStatus.textContent = 'Checking the VM port…';
  previewLink.hidden = true;
  try {
    const { preview } = await api(`/api/workspaces/${state.workspace.id}/preview`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ port: previewPort.value }),
    });
    showPreview(preview);
  } catch (error) {
    previewStatus.textContent = error.message;
  } finally {
    submit.disabled = false;
  }
}

async function stopPreview() {
  if (!state.preview) return;
  const button = document.querySelector('#stop-preview');
  button.disabled = true;
  previewStatus.textContent = 'Removing private link…';
  try {
    await api(`/api/workspaces/${state.workspace.id}/preview?port=${state.preview.port}`, { method: 'DELETE' });
    previewStatus.textContent = 'Private link removed. Your local development server is still running.';
    previewLink.hidden = true;
    state.preview = null;
  } catch (error) {
    previewStatus.textContent = error.message;
    button.disabled = false;
  }
}

function appendMessage(role, text) {
  const follow = messageList.scrollHeight - messageList.scrollTop - messageList.clientHeight < 80;
  const message = element('article', `message ${role}`);
  const content = element('div', 'message-content');
  renderMarkdown(content, text);
  if (role !== 'system') message.append(element('span', 'message-author', role === 'user' ? 'You' : 'Codex'));
  message.append(content);
  if (role === 'user') {
    const edit = element('button', 'edit-message', 'Edit & resend');
    edit.type = 'button';
    edit.addEventListener('click', () => {
      prompt.value = text;
      resizePrompt();
      prompt.focus();
    });
    message.append(edit);
  }
  messageList.append(message);
  if (follow) messageList.scrollTop = messageList.scrollHeight;
  return content;
}

function appendPreviewLink(preview) {
  const message = element('article', 'message assistant preview-message');
  const title = element('p', 'preview-title', `Preview ready · port ${preview.port}`);
  const link = element('a', 'preview-open', 'Open on this phone');
  link.href = preview.url;
  link.target = '_blank';
  link.rel = 'noopener';
  message.append(title, link);
  messageList.append(message);
  messageList.scrollTop = messageList.scrollHeight;
}

async function publishDetectedPreviews(text) {
  for (const port of localPreviewPorts(text)) {
    try {
      const { preview } = await api(`/api/workspaces/${state.workspace.id}/preview`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ port }),
      });
      appendPreviewLink(preview);
    } catch (error) {
      appendMessage('system', `Preview for localhost:${port} is unavailable: ${error.message}`);
    }
  }
}

async function openChatPreview(event) {
  const link = event.target.closest('.message-content a');
  const [port] = localPreviewPorts(link?.href || '');
  if (!link || !port || !state.workspace) return;
  event.preventDefault();
  const previewWindow = window.open('', '_blank');
  try {
    const { preview } = await api(`/api/workspaces/${state.workspace.id}/preview`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ port }),
    });
    showPreview(preview);
    if (previewWindow) previewWindow.location.replace(preview.url);
    else previewDialog.showModal();
  } catch (error) {
    previewWindow?.close();
    appendMessage('system', `Preview for localhost:${port} is unavailable: ${error.message}`);
  }
}

function appendWorkingMessage() {
  const message = element('article', 'message assistant');
  message.append(element('span', 'message-author', 'Codex'));
  const content = element('div', 'message-content');
  content.dataset.waiting = 'true';
  content.append(document.createTextNode('Codex is working'));
  const dots = element('span', 'working-dots');
  dots.setAttribute('aria-label', 'Generating');
  dots.append(element('i'), element('i'), element('i'));
  content.append(dots);
  const reasoning = document.createElement('details');
  reasoning.className = 'reasoning-summary';
  reasoning.hidden = true;
  reasoning.append(element('summary', '', 'Working notes'), element('p'));
  message.append(content, reasoning);
  messageList.append(message);
  messageList.scrollTop = messageList.scrollHeight;
  return { content, message, reasoning: reasoning.querySelector('p'), reasoningPanel: reasoning };
}

function appendAssistantDelta(assistant, text) {
  const follow = messageList.scrollHeight - messageList.scrollTop - messageList.clientHeight < 80;
  if (assistant.content.dataset.waiting) {
    assistant.content.replaceChildren();
    delete assistant.content.dataset.waiting;
  }
  assistant.content.dataset.markdown = `${assistant.content.dataset.markdown || ''}${text}`;
  renderMarkdown(assistant.content, assistant.content.dataset.markdown);
  if (follow) messageList.scrollTop = messageList.scrollHeight;
}

function appendReasoningSummary(assistant, text) {
  const follow = messageList.scrollHeight - messageList.scrollTop - messageList.clientHeight < 80;
  assistant.reasoningPanel.hidden = false;
  assistant.reasoningPanel.open = true;
  assistant.reasoning.textContent += text;
  if (follow) messageList.scrollTop = messageList.scrollHeight;
}

function resizePrompt() {
  prompt.style.height = 'auto';
  prompt.style.height = `${Math.min(Math.max(prompt.scrollHeight, 22), 140)}px`;
}

function setBusy(busy) {
  state.busy = busy;
  composer.setAttribute('aria-busy', String(busy));
  prompt.disabled = busy;
  composer.querySelector('[type="submit"]').disabled = busy;
  addMenu.disabled = busy;
  uploadInput.disabled = busy;
  stopTurn.hidden = !busy;
  stopTurn.disabled = false;
  for (const selector of ['#back-home', '#back-to-chats', '#chats-tab', '#changes-tab', '#files-tab', '#review-changes', '#hide-chat']) {
    document.querySelector(selector).disabled = busy;
  }
  if (state.voiceSupported) document.querySelector('#voice-button').disabled = busy;
}

function renderAttachment() {
  if (!state.attachment) return uploadList.replaceChildren();
  const chip = element('span', 'upload-chip');
  chip.append(element('span', '', state.attachment.name));
  const remove = element('button', '', '×');
  remove.type = 'button';
  remove.setAttribute('aria-label', `Remove ${state.attachment.name}`);
  remove.addEventListener('click', () => {
    state.attachment = null;
    uploadInput.value = '';
    renderAttachment();
  });
  chip.append(remove);
  uploadList.replaceChildren(chip);
}

async function uploadAttachment() {
  const file = state.attachment;
  if (!file) return null;
  if (file.size > 10 * 1024 * 1024) throw new Error('Files must be 10 MB or smaller.');
  document.querySelector('#chat-status').textContent = 'Saving file to VM…';
  const response = await fetch(`/api/workspaces/${state.workspace.id}/uploads`, {
    method: 'POST',
    headers: { 'X-Relay-Upload-Name': encodeURIComponent(file.name), 'Content-Type': file.type || 'application/octet-stream' },
    body: file,
  });
  if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || 'Could not upload the file.');
  return (await response.json()).upload;
}

async function openConversation(conversation) {
  state.conversation = conversation;
  conversationPanel.hidden = true;
  chatPanel.hidden = false;
  changesPanel.hidden = true;
  document.querySelector('#chat-title').textContent = conversation.name;
  document.querySelector('#hide-chat').hidden = !conversation.id;
  document.querySelector('#chat-status').textContent = 'Loading saved chat…';
  messageList.replaceChildren();
  chatSettings.hidden = true;
  await loadModels();
  selectConversationModel(conversation);
  if (!conversation.id) {
    appendMessage('system', 'New chat. Tell Codex what you want to work on.');
    document.querySelector('#chat-status').textContent = 'Ready';
    return;
  }
  try {
    const result = await api(`/api/workspaces/${state.workspace.id}/conversations/${conversation.id}`);
    result.messages.forEach((message) => appendMessage(message.role, message.text));
    if (!result.messages.length) appendMessage('system', 'This conversation is ready. Ask Codex what you need.');
    document.querySelector('#chat-status').textContent = 'Saved on VM';
  } catch (error) {
    appendMessage('system', error.message);
    document.querySelector('#chat-status').textContent = 'Unavailable';
  }
}

async function createConversation() {
  const button = document.querySelector('#new-chat');
  button.disabled = true;
  button.textContent = 'Creating…';
  try {
    await openConversation({ id: null, name: 'New chat', preview: '', status: 'draft' });
  } catch (error) {
    conversationList.prepend(element('p', 'error', error.message));
  } finally {
    button.disabled = false;
    button.textContent = 'New chat';
  }
}

function handleSseChunk(chunk, assistant) {
  const event = /event: ([^\n]+)/.exec(chunk)?.[1];
  const data = /data: (.*)/.exec(chunk)?.[1];
  if (!event || !data) return false;
  const payload = JSON.parse(data);
  if (event === 'delta') appendAssistantDelta(assistant, payload.text);
  if (event === 'reasoning') appendReasoningSummary(assistant, payload.text);
  if (event === 'conversation') {
    state.conversation = payload.conversation;
    document.querySelector('#chat-title').textContent = payload.conversation.name;
    document.querySelector('#hide-chat').hidden = false;
  }
  if (event === 'approval') appendMessage('system', 'Relay declined an unexpected interactive approval request. Standard Codex commands run with full VM access.');
  if (event === 'error') throw new Error(payload.message || 'Codex could not complete the turn.');
  if (event === 'completed') state.turnStatus = payload.status || 'completed';
  return event === 'completed';
}

async function sendPrompt(event) {
  event.preventDefault();
  const message = prompt.value.trim();
  if (state.busy || (!message && !state.attachment) || !state.conversation) return;
  let assistant;
  state.turnStatus = null;
  setBusy(true);
  try {
    const upload = await uploadAttachment();
    const text = upload
      ? `${message || 'Please inspect the uploaded file.'}\n\nUploaded file: ${upload.path}`
      : message;
    prompt.value = '';
    resizePrompt();
    state.attachment = null;
    uploadInput.value = '';
    renderAttachment();
    appendMessage('user', text);
    assistant = appendWorkingMessage();
    document.querySelector('#chat-status').textContent = 'Working on VM…';
    const turnPath = state.conversation.id
      ? `/api/workspaces/${state.workspace.id}/conversations/${state.conversation.id}/turns`
      : `/api/workspaces/${state.workspace.id}/conversations/turns`;
    const selection = { model: modelSelect.value || undefined, effort: effortSelect.value || undefined };
    const response = await fetch(turnPath, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({ text, ...selection }),
    });
    if (!response.ok || !response.body) throw new Error((await response.json().catch(() => ({}))).error || 'Could not start Codex.');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let complete = false;
    while (!complete) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) >= 0) complete ||= handleSseChunk(buffer.slice(0, boundary), assistant), buffer = buffer.slice(boundary + 2);
      if (done) break;
    }
    if (!complete) throw new Error('Connection interrupted. Check the saved conversation before sending again.');
    if (!assistant.content.textContent.trim() || assistant.content.dataset.waiting) {
      if (state.turnStatus === 'interrupted') {
        assistant.content.textContent = 'Stopped.';
        delete assistant.content.dataset.waiting;
      } else if (!assistant.reasoning.textContent) assistant.message.remove();
    }
    document.querySelector('#chat-status').textContent = state.turnStatus === 'interrupted' ? 'Stopped' : 'Saved on VM';
    if (state.turnStatus === 'completed') await publishDetectedPreviews(assistant.content.dataset.markdown || assistant.content.textContent);
    await Promise.all([refreshWorkspaceMetadata(), loadWorkspaceData()]).catch(() => {});
  } catch (error) {
    if (assistant?.content.dataset.waiting) {
      if (assistant.reasoning.textContent) assistant.content.textContent = 'Response interrupted.';
      else assistant.message.remove();
    }
    appendMessage('system', error.message);
    document.querySelector('#chat-status').textContent = 'Needs attention';
  } finally {
    setBusy(false);
  }
}

async function openFile(filePath) {
  document.querySelector('#file-title').textContent = filePath;
  fileViewer.dataset.path = filePath;
  fileViewer.dataset.mode = 'change';
  document.querySelector('#file-actions').hidden = false;
  document.querySelector('#file-content').textContent = 'Loading diff…';
  fileViewer.showModal();
  await loadFile('diff');
}

async function openWorkspaceFile(filePath) {
  document.querySelector('#file-title').textContent = filePath;
  fileViewer.dataset.path = filePath;
  fileViewer.dataset.mode = 'workspace';
  document.querySelector('#file-actions').hidden = true;
  document.querySelector('#file-content').textContent = 'Loading file…';
  fileViewer.showModal();
  try {
    const result = await api(`/api/workspaces/${state.workspace.id}/browse-file?path=${encodeURIComponent(filePath)}`);
    document.querySelector('#file-content').textContent = result.content;
  } catch (error) {
    document.querySelector('#file-content').textContent = error.message;
  }
}

async function loadFile(kind) {
  const path = fileViewer.dataset.path;
  document.querySelector('#show-diff').classList.toggle('selected', kind === 'diff');
  document.querySelector('#show-file').classList.toggle('selected', kind === 'file');
  try {
    const result = await api(`/api/workspaces/${state.workspace.id}/${kind}?path=${encodeURIComponent(path)}`);
    document.querySelector('#file-content').textContent = result[kind === 'diff' ? 'diff' : 'content'];
  } catch (error) {
    document.querySelector('#file-content').textContent = error.message;
  }
}

function setupVoice() {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const button = document.querySelector('#voice-button');
  if (!Recognition) {
    button.disabled = true;
    button.title = 'Voice dictation is not supported by this browser.';
    return;
  }
  state.voiceSupported = true;
  const recognition = new Recognition();
  recognition.interimResults = false;
  recognition.onresult = (event) => {
    prompt.value = `${prompt.value}${prompt.value ? ' ' : ''}${event.results[0][0].transcript}`;
    prompt.focus();
  };
  recognition.onend = () => {
    button.classList.remove('listening');
    button.setAttribute('aria-pressed', 'false');
  };
  recognition.onerror = () => {
    button.classList.remove('listening');
    button.setAttribute('aria-pressed', 'false');
    button.title = 'Voice dictation could not start. You can type your message instead.';
  };
  button.addEventListener('click', () => {
    if (state.busy) return;
    button.classList.add('listening');
    button.setAttribute('aria-pressed', 'true');
    try {
      recognition.start();
    } catch {
      button.classList.remove('listening');
      button.setAttribute('aria-pressed', 'false');
    }
  });
}

document.querySelector('#back-home').addEventListener('click', () => {
  workspaceScreen.hidden = true;
  homeScreen.hidden = false;
  loadHome();
});
document.querySelector('#chats-tab').addEventListener('click', () => setTab('chats'));
document.querySelector('#changes-tab').addEventListener('click', () => setTab('changes'));
document.querySelector('#files-tab').addEventListener('click', () => setTab('files'));
for (const [index, button] of [...document.querySelectorAll('.tab')].entries()) {
  button.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const tabs = [...document.querySelectorAll('.tab')];
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    tabs[next].focus();
    setTab(tabs[next].id.replace(/-tab$/, ''));
  });
}
document.querySelector('#review-changes').addEventListener('click', () => setTab('changes'));
document.querySelector('#git-status').addEventListener('click', () => {
  if (!state.workspace?.gitAvailable && state.conversation) appendMessage('system', 'Git is not set up. Ask Codex to initialize Git in this workspace, or initialize it from your own machine.');
});
document.querySelector('#add-workspace').addEventListener('click', openWorkspaceCreator);
document.querySelector('#open-preview').addEventListener('click', () => {
  previewStatus.textContent = state.preview ? `Private link ready on port ${state.preview.port}.` : 'Enter the port used by the development server on this VM.';
  previewLink.hidden = !state.preview;
  document.querySelector('#stop-preview').disabled = !state.preview;
  previewDialog.showModal();
});
document.querySelector('#close-preview').addEventListener('click', () => previewDialog.close());
document.querySelector('#preview-form').addEventListener('submit', createPreview);
document.querySelector('#stop-preview').addEventListener('click', stopPreview);
document.querySelector('#close-workspace-creator').addEventListener('click', () => workspaceCreator.close());
document.querySelector('#up-folder').addEventListener('click', () => {
  if (!state.projectPath) return;
  loadProjectDirectories(state.projectPath.split('/').slice(0, -1).join('/'));
});
document.querySelector('#show-folder-creator').addEventListener('click', showFolderCreator);
document.querySelector('#cancel-folder-creator').addEventListener('click', hideFolderCreator);
document.querySelector('#folder-creator').addEventListener('submit', (event) => {
  event.preventDefault();
  addProject('create');
});
document.querySelector('#open-folder').addEventListener('click', () => addProject('open'));
modelSelect.addEventListener('change', populateEfforts);
addMenu.addEventListener('click', () => {
  addMenu.setAttribute('aria-expanded', 'true');
  composerMenu.showModal();
});
document.querySelector('#close-composer-menu').addEventListener('click', () => composerMenu.close());
composerMenu.addEventListener('close', () => addMenu.setAttribute('aria-expanded', 'false'));
document.querySelector('#choose-file').addEventListener('click', () => {
  composerMenu.close();
  uploadInput.click();
});
document.querySelector('#open-model-settings').addEventListener('click', () => {
  composerMenu.close();
  if (!state.models.length) return;
  modelSettingsDialog.showModal();
});
document.querySelector('#close-model-settings').addEventListener('click', () => modelSettingsDialog.close());
document.querySelector('#new-chat').addEventListener('click', createConversation);
document.querySelector('#back-to-chats').addEventListener('click', () => {
  state.conversation = null;
  chatPanel.hidden = true;
  conversationPanel.hidden = false;
});
document.querySelector('#hide-chat').addEventListener('click', async () => {
  if (!state.conversation || !window.confirm('Hide this conversation from Relay? It will stay saved in Codex and the workspace will not change.')) return;
  try {
    await api(`/api/workspaces/${state.workspace.id}/conversations/${state.conversation.id}`, { method: 'DELETE' });
    state.conversation = null;
    chatPanel.hidden = true;
    conversationPanel.hidden = false;
    await loadWorkspaceData();
  } catch (error) {
    appendMessage('system', error.message);
    document.querySelector('#chat-status').textContent = 'Needs attention';
  }
});
document.querySelector('#close-file').addEventListener('click', () => fileViewer.close());
document.querySelector('#show-diff').addEventListener('click', () => loadFile('diff'));
document.querySelector('#show-file').addEventListener('click', () => loadFile('file'));
messageList.addEventListener('click', openChatPreview);
stopTurn.addEventListener('click', async () => {
  if (!state.busy || !state.workspace || !state.conversation?.id) return;
  stopTurn.disabled = true;
  document.querySelector('#chat-status').textContent = 'Stopping Codex…';
  try {
    await api(`/api/workspaces/${state.workspace.id}/conversations/${state.conversation.id}/turns/stop`, { method: 'POST' });
  } catch (error) {
    stopTurn.disabled = false;
    appendMessage('system', error.message);
  }
});
composer.addEventListener('submit', sendPrompt);
prompt.addEventListener('input', resizePrompt);
uploadInput.addEventListener('change', () => {
  const [file] = uploadInput.files;
  if (!file) return;
  state.attachment = file;
  renderAttachment();
});
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/service-worker.js');
setupVoice();
resizePrompt();
loadHome();
