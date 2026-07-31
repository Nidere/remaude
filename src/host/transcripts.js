// Чтение сохранённых сессий Claude Code из ~/.claude/projects/<slug>/*.jsonl.
// Формат недокументирован и меняется между версиями — всё читаем best-effort:
// незнакомые типы записей молча пропускаем, используем только для ОТОБРАЖЕНИЯ
// истории (контекст при resume восстанавливает сам SDK).
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

/** Первые bytes байт файла — чтобы не читать многомегабайтные транскрипты целиком. */
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

/** @returns [{id, mtime, title, preview}] по убыванию свежести */
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
          continue; // последняя строка головы обычно обрезана
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
 * История сессии в виде псевдо-SDK-сообщений — ровно то, что умеет рендерить
 * веб-клиент (type/message/parent_tool_use_id).
 */
export function loadHistory(cwd, sessionId) {
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
    messages.push({
      type: entry.type,
      message: entry.message,
      parent_tool_use_id: entry.isSidechain ? (entry.parentToolUseId ?? 'past-sidechain') : null,
      timestamp: entry.timestamp ?? null,
    });
  }
  return messages;
}
