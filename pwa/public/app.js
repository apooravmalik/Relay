const workspaceList = document.querySelector('#workspace-list');
const workspaceDetail = document.querySelector('#workspace-detail');

function text(value) {
  const node = document.createTextNode(value);
  return node;
}

function metric(label, value) {
  const item = document.createElement('div');
  item.className = 'metric';
  const labelNode = document.createElement('span');
  labelNode.textContent = label;
  const valueNode = document.createElement('strong');
  valueNode.textContent = value;
  item.append(labelNode, valueNode);
  return item;
}

function showWorkspace(workspace) {
  workspaceDetail.hidden = false;
  workspaceDetail.replaceChildren();

  const title = document.createElement('h2');
  title.textContent = workspace.name;
  const summary = document.createElement('p');
  summary.textContent = workspace.handoffReady
    ? 'VM handoff baseline is ready. Changes stay on the VM until you pull them on the Mac.'
    : 'No Relay handoff baseline is recorded yet.';
  const ownership = document.createElement('p');
  ownership.className = 'ownership-note';
  ownership.textContent = 'Chat controls are being added through the approved Codex bridge. Termius remains the fallback for an active terminal-owned chat.';
  workspaceDetail.append(title, summary, ownership);
  workspaceDetail.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function workspaceRow(workspace) {
  const row = document.createElement('article');
  row.className = `workspace ${workspace.status}`;

  const status = document.createElement('p');
  status.className = 'status';
  status.textContent = workspace.status === 'ready' ? 'VM online' : 'Workspace unavailable';
  const title = document.createElement('h2');
  title.textContent = workspace.name;
  const metrics = document.createElement('div');
  metrics.className = 'metrics';
  if (workspace.status === 'ready') {
    metrics.append(metric('Branch', workspace.branch), metric('Changed files', String(workspace.changedFileCount)));
  }
  const detail = document.createElement('p');
  detail.className = 'handoff';
  detail.textContent = workspace.status === 'ready'
    ? workspace.handoffReady ? 'Last handoff: Mac → VM' : 'No completed handoff yet'
    : workspace.error;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'open-workspace';
  button.disabled = workspace.status !== 'ready';
  button.append(text('Open workspace'), document.createElement('span'));
  button.lastChild.textContent = '→';
  button.addEventListener('click', () => showWorkspace(workspace));

  row.append(status, title, metrics, detail, button);
  return row;
}

async function loadWorkspaces() {
  try {
    const response = await fetch('/api/workspaces', { headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error('Relay controller is unavailable.');
    const { workspaces } = await response.json();
    workspaceList.replaceChildren();
    if (!workspaces.length) {
      const empty = document.createElement('p');
      empty.className = 'loading';
      empty.textContent = 'No workspaces are registered on this VM yet.';
      workspaceList.append(empty);
      return;
    }
    workspaces.forEach((workspace) => workspaceList.append(workspaceRow(workspace)));
  } catch (error) {
    workspaceList.replaceChildren();
    const message = document.createElement('p');
    message.className = 'error';
    message.textContent = error.message;
    workspaceList.append(message);
  }
}

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/service-worker.js');
loadWorkspaces();
