const homeScreen = document.querySelector('#home-screen');
const workspaceScreen = document.querySelector('#workspace-screen');
const workspaceList = document.querySelector('#workspace-list');
const conversationList = document.querySelector('#conversation-list');
const changesList = document.querySelector('#changes-list');
const conversationPanel = document.querySelector('#conversation-list-panel');
const chatPanel = document.querySelector('#chat-panel');
const changesPanel = document.querySelector('#changes-panel');
const messageList = document.querySelector('#message-list');
const prompt = document.querySelector('#prompt');
const composer = document.querySelector('#composer');
const fileViewer = document.querySelector('#file-viewer');

const state = { busy: false, changes: [], conversation: null, voiceSupported: false, workspace: null };

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
  changesPanel.hidden = chats;
}

function workspaceRow(workspace) {
  const row = element('article', `workspace ${workspace.status}`);
  const status = element('p', 'status', workspace.status === 'ready' ? 'VM online' : 'Workspace unavailable');
  const title = element('h2', '', workspace.name);
  const metrics = element('div', 'metrics');
  if (workspace.status === 'ready') {
    for (const [label, value] of [['Branch', workspace.branch], ['Changed files', String(workspace.changedFileCount)]]) {
      const metric = element('div', 'metric');
      metric.append(element('span', '', label), element('strong', '', value));
      metrics.append(metric);
    }
  }
  const detail = element('p', 'handoff', workspace.handoffReady ? 'Last handoff: Mac → VM' : 'No completed handoff yet');
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
  conversationList.replaceChildren(...(conversations.conversations.length
    ? conversations.conversations.map(conversationRow)
    : [element('p', 'empty', 'No Relay conversations yet. Start one when you are ready.')]));
  changesList.replaceChildren(...(state.changes.length ? state.changes.map(changeRow) : [element('p', 'empty', 'No changed files on this VM.')]));
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
  state.conversation = null;
  document.querySelector('#workspace-name').textContent = workspace.name;
  document.querySelector('#workspace-meta').textContent = `${workspace.branch} · VM workspace`;
  homeScreen.hidden = true;
  workspaceScreen.hidden = false;
  setTab('chats');
  conversationList.replaceChildren(element('p', 'loading', 'Loading conversations…'));
  changesList.replaceChildren(element('p', 'loading', 'Loading changes…'));
  try {
    await loadWorkspaceData();
  } catch (error) {
    conversationList.replaceChildren(element('p', 'error', error.message));
  }
}

function appendMessage(role, text) {
  const message = element('article', `message ${role}`);
  message.append(element('p', '', text));
  messageList.append(message);
  messageList.scrollTop = messageList.scrollHeight;
  return message.querySelector('p');
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
  if (state.voiceSupported) document.querySelector('#voice-button').disabled = busy;
}

async function openConversation(conversation) {
  state.conversation = conversation;
  conversationPanel.hidden = true;
  chatPanel.hidden = false;
  changesPanel.hidden = true;
  document.querySelector('#chat-title').textContent = conversation.name;
  document.querySelector('#chat-status').textContent = 'Loading saved chat…';
  messageList.replaceChildren();
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
  if (event === 'delta') assistant.textContent += payload.text;
  if (event === 'conversation') {
    state.conversation = payload.conversation;
    document.querySelector('#chat-title').textContent = payload.conversation.name;
  }
  if (event === 'approval') appendMessage('system', 'Relay declined an unexpected interactive approval request. Standard Codex commands run with full VM access.');
  if (event === 'error') appendMessage('system', payload.message);
  return event === 'completed' || event === 'error';
}

async function sendPrompt(event) {
  event.preventDefault();
  const text = prompt.value.trim();
  if (state.busy || !text || !state.conversation) return;
  prompt.value = '';
  resizePrompt();
  appendMessage('user', text);
  const assistant = appendMessage('assistant', '');
  document.querySelector('#chat-status').textContent = 'Working on VM…';
  setBusy(true);
  try {
    const turnPath = state.conversation.id
      ? `/api/workspaces/${state.workspace.id}/conversations/${state.conversation.id}/turns`
      : `/api/workspaces/${state.workspace.id}/conversations/turns`;
    const response = await fetch(turnPath, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({ text }),
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
    if (!assistant.textContent) assistant.remove();
    document.querySelector('#chat-status').textContent = 'Saved on VM';
    await loadWorkspaceData();
  } catch (error) {
    assistant.remove();
    appendMessage('system', error.message);
    document.querySelector('#chat-status').textContent = 'Needs attention';
  } finally {
    setBusy(false);
  }
}

async function openFile(filePath) {
  document.querySelector('#file-title').textContent = filePath;
  fileViewer.dataset.path = filePath;
  document.querySelector('#file-content').textContent = 'Loading diff…';
  fileViewer.showModal();
  await loadFile('diff');
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
for (const [index, button] of [...document.querySelectorAll('.tab')].entries()) {
  button.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const tabs = [...document.querySelectorAll('.tab')];
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    tabs[next].focus();
    setTab(next === 0 ? 'chats' : 'changes');
  });
}
document.querySelector('#review-changes').addEventListener('click', () => setTab('changes'));
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
composer.addEventListener('submit', sendPrompt);
prompt.addEventListener('input', resizePrompt);
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/service-worker.js');
setupVoice();
resizePrompt();
loadHome();
