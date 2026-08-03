// Reading saved Claude Code sessions from ~/.claude/projects/<slug>/*.jsonl.
// The format is undocumented and changes between versions — so we read everything
// best-effort: unknown record types are silently skipped, and we use this only to
// DISPLAY history (on resume the SDK itself restores the context).
import { readdirSync, readFileSync, statSync, existsSync, openSync, readSync, closeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const PROJECTS_DIR = join(homedir(), '.claude', 'projects');

function slugCandidates(cwd) {
  const sanitize = (s) => s.replace(/[^a-zA-Z0-9-]/g, '-');
  return [...new Set([cwd, cwd[0].toLowerCase() + cwd.slice(1), cwd[0].toUpperCase() + cwd.slice(1)])].map(sanitize);
}

/** The folder name Claude Code derives from a working directory. */
export function slugFor(cwd) {
  return slugCandidates(cwd)[0];
}

/** Every session file on this machine: [{id, file, slug, mtime}] */
export function listAllSessionFiles() {
  const out = [];
  let slugs = [];
  try {
    slugs = readdirSync(PROJECTS_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return out;
  }
  for (const slug of slugs) {
    const dir = join(PROJECTS_DIR, slug);
    let files = [];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }
    for (const f of files) {
      const file = join(dir, f);
      try {
        out.push({ id: f.slice(0, -6), file, slug, mtime: statSync(file).mtimeMs });
      } catch {
        /* the file may vanish between listing and stat */
      }
    }
  }
  return out;
}

function plainText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join(' ');
}

function snippetAround(text, idx, len) {
  const from = Math.max(0, idx - 60);
  const to = Math.min(text.length, idx + len + 90);
  return (from ? '…' : '') + text.slice(from, to).replace(/\s+/g, ' ').trim() + (to < text.length ? '…' : '');
}

/**
 * Search one transcript for a lowercase needle. Only what a human said or was
 * told counts — tool traffic and sidechains are noise for finding a conversation.
 * @returns {{matches:number, snippet:string, title:string|null, cwd:string|null}|null}
 */
export function searchSessionFile(file, needle) {
  let text;
  try {
    text = readFileSync(file, 'utf-8');
  } catch {
    return null;
  }
  if (!text.toLowerCase().includes(needle)) return null; // cheap reject before parsing
  let matches = 0;
  let snippet = null;
  let title = null;
  let cwd = null;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!cwd && entry.cwd) cwd = entry.cwd;
    if (!title && entry.type === 'ai-title' && typeof entry.title === 'string') title = entry.title;
    if ((entry.type !== 'user' && entry.type !== 'assistant') || entry.isMeta || entry.isSidechain) continue;
    if (entry.type === 'user' && entry.origin?.kind) continue;
    const body = plainText(entry.message?.content);
    if (!body) continue;
    const idx = body.toLowerCase().indexOf(needle);
    if (idx === -1) continue;
    matches++;
    if (!snippet) snippet = snippetAround(body, idx, needle.length);
  }
  return matches ? { matches, snippet, title, cwd } : null;
}

export function sessionDir(cwd) {
  for (const slug of slugCandidates(cwd)) {
    const dir = join(PROJECTS_DIR, slug);
    if (existsSync(dir)) return dir;
  }
  return null;
}

/** The first `bytes` bytes of the file — so we don't read multi-megabyte transcripts in full. */
function readHead(file, bytes = 65536) {
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const n = readSync(fd, buf, 0, bytes, 0);
    return buf.toString('utf-8', 0, n);
  } finally {
    closeSync(fd);
  }
}

function firstUserText(entry) {
  const c = entry.message?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.find((b) => b.type === 'text')?.text ?? null;
  return null;
}

/** @returns [{id, mtime, title, preview}] ordered from most to least recent */
export function listSessions(cwd) {
  const dir = sessionDir(cwd);
  if (!dir) return [];
  const sessions = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.jsonl')) continue;
    const file = join(dir, f);
    let title = null;
    let preview = null;
    try {
      for (const line of readHead(file).split('\n')) {
        if (!line.trim()) continue;
        let entry;
        try {
          entry = JSON.parse(line);
        } catch {
          continue; // the last line of the head chunk is usually truncated
        }
        if (!title && entry.type === 'ai-title' && typeof entry.title === 'string') title = entry.title;
        if (!preview && entry.type === 'user' && !entry.isSidechain && !entry.isMeta) {
          const text = firstUserText(entry);
          if (text) preview = text.slice(0, 100);
        }
        if (title && preview) break;
      }
      sessions.push({ id: f.slice(0, -6), mtime: statSync(file).mtimeMs, title, preview });
    } catch {
      continue;
    }
  }
  return sessions.sort((a, b) => b.mtime - a.mtime);
}

/**
 * Every image in a transcript, newest first: [{mediaType, data, ts, mine}].
 * `mine` marks pictures the user attached, as opposed to screenshots and other
 * images that arrived from tools.
 */
export function collectImages(file, { limit = 500 } = {}) {
  let text;
  try {
    text = readFileSync(file, 'utf-8');
  } catch {
    return [];
  }
  if (!text.includes('"base64"')) return []; // cheap reject: most transcripts have none
  const images = [];
  for (const line of text.split('\n')) {
    if (!line.trim() || !line.includes('"base64"')) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const content = entry.message?.content;
    if (!Array.isArray(content)) continue;
    const mine = entry.type === 'user' && !content.some((b) => b.type === 'tool_result');
    const walk = (blocks) => {
      for (const b of blocks ?? []) {
        if (b.type === 'image' && b.source?.type === 'base64')
          images.push({ mediaType: b.source.media_type, data: b.source.data, ts: entry.timestamp ?? null, mine });
        else if (b.type === 'tool_result' && Array.isArray(b.content)) walk(b.content);
      }
    };
    walk(content);
    if (images.length >= limit) break;
  }
  return images.reverse();
}

/**
 * A session id is a uuid and nothing else. Without this check a crafted id is a
 * path: "../<other project>/<uuid>" would walk out of the project's folder and
 * hand a guest transcripts they were never given.
 */
export function isSessionId(id) {
  return typeof id === 'string' && /^[0-9a-fA-F-]{8,64}$/.test(id) && !id.includes('..');
}

/** Full path to a session's transcript, or null if it does not exist. */
export function sessionFile(cwd, sessionId) {
  if (!isSessionId(sessionId)) return null;
  const dir = sessionDir(cwd);
  if (!dir) return null;
  const file = join(dir, `${sessionId}.jsonl`);
  return existsSync(file) ? file : null;
}

/** The first text of a message, whatever shape the content came in. */
function leadingText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.find((b) => b.type === 'text')?.text ?? '';
}

export function isCliCommandNoise(content) {
  const text = leadingText(content).trimStart();
  return text.startsWith('<command-name>') || text.startsWith('<local-command-stdout>') || text.startsWith('<command-message>');
}

/**
 * One raw transcript entry → a feed message the web client can render
 * (type/message/parent_tool_use_id), or null for entries the feed skips.
 */
export function mapEntry(entry, { defaultAuthor = null } = {}) {
  if ((entry.type !== 'user' && entry.type !== 'assistant') || !entry.message || entry.isMeta) return null;
  // the harness's system injections (task notifications and the like) are written as
  // user messages, but carry origin.kind — real user input has no origin
  if (entry.type === 'user' && entry.origin?.kind) return null;
  // CLI slash commands leave their bookkeeping in the transcript as user
  // messages (<command-name>/model</command-name>, <local-command-stdout>…) —
  // that is the terminal talking to itself, not the conversation
  if (entry.type === 'user' && isCliCommandNoise(entry.message.content)) return null;
  // ...and the assistant's replies to those injections are noise too: the harness
  // convention is the literal "No response requested." for turns with no answer
  if (entry.type === 'assistant' && Array.isArray(entry.message.content)) {
    const text = entry.message.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();
    if (text === 'No response requested.') return null;
  }
  const isPlainUserText =
    entry.type === 'user' &&
    !entry.isSidechain &&
    !(Array.isArray(entry.message.content) && entry.message.content.some((b) => b.type === 'tool_result'));
  return {
    type: entry.type,
    message: entry.message,
    parent_tool_use_id: entry.isSidechain ? (entry.parentToolUseId ?? 'past-sidechain') : null,
    timestamp: entry.timestamp ?? null,
    // the transcript has no author — we sign historical messages with the host owner
    author: isPlainUserText ? defaultAuthor : undefined,
    uuid: entry.uuid ?? null,
  };
}

/**
 * Session history as pseudo-SDK messages — exactly what the web client knows how
 * to render.
 */
export function loadHistory(cwd, sessionId, { defaultAuthor = null } = {}) {
  const file = sessionFile(cwd, sessionId); // validates the id

  if (!file) return [];
  const messages = [];
  for (const line of readFileSync(file, 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const msg = mapEntry(entry, { defaultAuthor });
    if (msg) messages.push(msg);
  }
  return messages;
}
