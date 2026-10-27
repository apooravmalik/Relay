function linesOf(markdown) {
  return String(markdown || '').replace(/\r\n?/g, '\n').split('\n');
}

function tableCells(line) {
  return line.trim().replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim());
}

function isTableDivider(line) {
  return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
}

function nextBlock(lines, start) {
  const line = lines[start] || '';
  if (!line.trim()) return true;
  if (/^```/.test(line) || /^#{1,3}\s+/.test(line) || /^>\s?/.test(line)) return true;
  if (/^[-*+]\s+/.test(line) || /^\d+[.)]\s+/.test(line) || /^([-*_])(?:\s*\1){2,}\s*$/.test(line)) return true;
  return line.includes('|') && isTableDivider(lines[start + 1] || '');
}

export function parseMarkdown(markdown) {
  const lines = linesOf(markdown);
  const blocks = [];
  for (let index = 0; index < lines.length;) {
    const line = lines[index];
    if (!line.trim()) { index += 1; continue; }
    const fence = /^```\s*([^\s]*)/.exec(line);
    if (fence) {
      const code = [];
      index += 1;
      while (index < lines.length && !/^```/.test(lines[index])) code.push(lines[index++]);
      if (index < lines.length) index += 1;
      blocks.push({ type: 'code', language: fence[1], text: code.join('\n') });
      continue;
    }
    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading) { blocks.push({ type: 'heading', level: heading[1].length, text: heading[2] }); index += 1; continue; }
    if (/^([-*_])(?:\s*\1){2,}\s*$/.test(line)) { blocks.push({ type: 'rule' }); index += 1; continue; }
    if (line.includes('|') && isTableDivider(lines[index + 1] || '')) {
      const headers = tableCells(line);
      index += 2;
      const rows = [];
      while (index < lines.length && lines[index].includes('|') && lines[index].trim()) rows.push(tableCells(lines[index++]));
      blocks.push({ type: 'table', headers, rows });
      continue;
    }
    if (/^>\s?/.test(line)) {
      const quote = [];
      while (index < lines.length && /^>\s?/.test(lines[index])) quote.push(lines[index++].replace(/^>\s?/, ''));
      blocks.push({ type: 'quote', text: quote.join('\n') });
      continue;
    }
    const list = /^([-*+])\s+(.+)$/.exec(line) || /^(\d+)[.)]\s+(.+)$/.exec(line);
    if (list) {
      const ordered = /^\d+[.)]\s+/.test(line);
      const items = [];
      const pattern = ordered ? /^\d+[.)]\s+(.+)$/ : /^[-*+]\s+(.+)$/;
      while (index < lines.length) {
        const item = pattern.exec(lines[index]);
        if (!item) break;
        items.push(item[1]);
        index += 1;
      }
      blocks.push({ type: 'list', ordered, items });
      continue;
    }
    const paragraph = [line];
    index += 1;
    while (index < lines.length && lines[index].trim() && !nextBlock(lines, index)) paragraph.push(lines[index++]);
    blocks.push({ type: 'paragraph', text: paragraph.join('\n') });
  }
  return blocks;
}

function safeUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

function appendInline(parent, text) {
  const pattern = /`([^`\n]+)`|\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|(\*\*|__)(.+?)\4|(\*|_)(.+?)\6/g;
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > cursor) parent.append(document.createTextNode(text.slice(cursor, match.index)));
    if (match[1]) parent.append(Object.assign(document.createElement('code'), { textContent: match[1] }));
    else if (match[2]) {
      const href = safeUrl(match[3]);
      if (href) {
        const link = Object.assign(document.createElement('a'), { href, textContent: match[2], target: '_blank', rel: 'noopener' });
        parent.append(link);
      } else parent.append(document.createTextNode(match[0]));
    } else if (match[5]) parent.append(Object.assign(document.createElement('strong'), { textContent: match[5] }));
    else parent.append(Object.assign(document.createElement('em'), { textContent: match[7] }));
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) parent.append(document.createTextNode(text.slice(cursor)));
}

function inlineElement(name, text) {
  const node = document.createElement(name);
  appendInline(node, text);
  return node;
}

export function renderMarkdown(container, markdown) {
  const nodes = parseMarkdown(markdown).map((block) => {
    if (block.type === 'heading') return inlineElement(`h${block.level}`, block.text);
    if (block.type === 'code') {
      const code = document.createElement('code');
      code.textContent = block.text;
      if (block.language) code.dataset.language = block.language;
      const pre = document.createElement('pre');
      pre.append(code);
      return pre;
    }
    if (block.type === 'rule') return document.createElement('hr');
    if (block.type === 'quote') return inlineElement('blockquote', block.text);
    if (block.type === 'list') {
      const list = document.createElement(block.ordered ? 'ol' : 'ul');
      block.items.forEach((item) => list.append(inlineElement('li', item)));
      return list;
    }
    if (block.type === 'table') {
      const table = document.createElement('table');
      const head = document.createElement('thead');
      const headerRow = document.createElement('tr');
      block.headers.forEach((cell) => headerRow.append(inlineElement('th', cell)));
      head.append(headerRow);
      const body = document.createElement('tbody');
      block.rows.forEach((row) => {
        const rowNode = document.createElement('tr');
        block.headers.forEach((_, index) => rowNode.append(inlineElement('td', row[index] || '')));
        body.append(rowNode);
      });
      table.append(head, body);
      return table;
    }
    return inlineElement('p', block.text);
  });
  container.replaceChildren(...nodes);
}
