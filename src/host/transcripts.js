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
 * Session history as pseudo-SDK messages — exactly what the web client knows how
 * to render (type/message/parent_tool_use_id).
 */
export function loadHistory(cwd, sessionId, { defaultAuthor = null } = {}) {
  const dir = sessionDir(cwd);
  if (!dir) return [];
  const file = join(dir, `${sessionId}.jsonl`);
  if (!existsSync(file)) return [];
  const messages = [];
  for (const line of readFileSync(file, 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if ((entry.type !== 'user' && entry.type !== 'assistant') || !entry.message || entry.isMeta) continue;
    // the harness's system injections (task notifications and the like) are written as
    // user messages, but carry origin.kind — real user input has no origin
    if (entry.type === 'user' && entry.origin?.kind) continue;
    const isPlainUserText =
      entry.type === 'user' &&
      !entry.isSidechain &&
      !(Array.isArray(entry.message.content) && entry.message.content.some((b) => b.type === 'tool_result'));
    messages.push({
      type: entry.type,
      message: entry.message,
      parent_tool_use_id: entry.isSidechain ? (entry.parentToolUseId ?? 'past-sidechain') : null,
      timestamp: entry.timestamp ?? null,
      // the transcript has no author — we sign historical messages with the host owner
      author: isPlainUserText ? defaultAuthor : undefined,
    });
  }
  return messages;
}
