// A whole conversation as one markdown document — what the browser only ever
// shows the tail of. It is written for a person to read later: what was said,
// by whom, and what was done in between, without the tool traffic that makes a
// transcript unreadable.

const TIME = (ts) => {
  if (!ts) return '';
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' });
};

function textOf(msg) {
  const content = msg.message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
}

/** Service turns talk to the machinery, not to the reader. */
const isServiceTitle = (text) => /^\[remaude: a service request/i.test(text.trimStart());
const stripMarker = (text) => text.replace(/^\[remaude:[^\]]*\]\n?/i, '').trimStart();

/** What a tool call did, in one line — the arguments a reader would recognise. */
function toolLine(block) {
  const input = block.input ?? {};
  const file = (p) => String(p).split(/[\\/]/).pop();
  const say = (s, n = 70) => String(s ?? '').replace(/\s+/g, ' ').slice(0, n);
  switch (block.name) {
    case 'Read':
    case 'Write':
    case 'Edit':
      return `${block.name} · ${file(input.file_path ?? '')}`;
    case 'Bash':
    case 'PowerShell':
      return `${block.name} · ${say(input.description ?? input.command)}`;
    case 'Grep':
    case 'Glob':
      return `${block.name} · ${say(input.pattern, 40)}`;
    case 'Agent':
      return `Agent · ${say(input.description, 50)}`;
    case 'WebFetch':
    case 'WebSearch':
      return `${block.name} · ${say(input.url ?? input.query, 50)}`;
    default:
      return block.name;
  }
}

function hasImages(msg) {
  const content = msg.message?.content;
  return Array.isArray(content) && content.some((b) => b.type === 'image');
}

/**
 * @param messages history entries as the feed knows them (type/message/timestamp/author/chatThread)
 * @returns the document, marked for the inbox
 */
export function chatToMarkdown({ title, project, messages, exportedAt = Date.now(), owner = null }) {
  const out = ['<!-- remaude -->', `# ${title || 'Чат'}`, ''];
  const said = [];

  for (const msg of messages) {
    if (msg.type !== 'user' && msg.type !== 'assistant') continue;
    if (msg.parent_tool_use_id) continue; // a subagent's own chatter is not this conversation
    const text = textOf(msg);
    if (msg.type === 'user' && !text && !hasImages(msg)) continue; // a bare tool result
    if (isServiceTitle(text)) continue;

    const who = msg.type === 'user' ? msg.author || owner || 'Пользователь' : 'Claude';
    const when = TIME(msg.timestamp);
    const thread = msg.chatThread ? ' · в ветке' : '';
    said.push(`## ${who}${when ? ` · ${when}` : ''}${thread}`);

    const body = stripMarker(text);
    if (body) said.push('', body);
    if (hasImages(msg)) said.push('', '*(изображение)*');

    // what was done between the words, so the story is followable
    const blocks = Array.isArray(msg.message?.content) ? msg.message.content : [];
    const tools = blocks.filter((b) => b.type === 'tool_use').map((b) => `- 🔧 ${toolLine(b)}`);
    if (tools.length) said.push('', ...tools);
    said.push('');
  }

  const header = [
    `**Проект:** ${project ?? '—'}`,
    `**Сообщений:** ${said.filter((l) => l.startsWith('## ')).length}`,
    `**Выгружено:** ${TIME(exportedAt)}`,
    '',
    '---',
    '',
  ];
  return [...out, ...header, ...said].join('\n').replace(/\n{3,}/g, '\n\n') + '\n';
}

/** A file name that survives every file system we run on. */
export function exportFileName(title, at = Date.now()) {
  const day = new Date(at).toISOString().slice(0, 10);
  const name = String(title || 'chat')
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
  return `${day} ${name || 'chat'}.md`;
}
