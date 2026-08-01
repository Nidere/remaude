// Inline comments on inbox documents: Confluence-style threads anchored to a
// quoted fragment of the text. Threads live in a sidecar JSON next to the
// document itself — they are part of the work, so they belong in the repo and
// travel with it. Read marks are personal, not part of the work, so they stay
// on this machine in ~/.remaude and never touch the repo.
import { readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

export const SIDECAR_SUFFIX = '.comments.json';
export const sidecarPath = (docPath) => docPath + SIDECAR_SUFFIX;
export const isSidecarPath = (p) => p.toLowerCase().endsWith(SIDECAR_SUFFIX);
export const docPathOfSidecar = (p) => p.slice(0, -SIDECAR_SUFFIX.length);

export function loadThreads(docPath) {
  try {
    const data = JSON.parse(readFileSync(sidecarPath(docPath), 'utf-8'));
    return Array.isArray(data.threads) ? data.threads : [];
  } catch {
    return []; // no sidecar (or a broken one) simply means no comments
  }
}

/** An emptied sidecar is deleted, not left behind as clutter in the repo. */
export function saveThreads(docPath, threads) {
  if (!threads.length) {
    try {
      unlinkSync(sidecarPath(docPath));
    } catch {
      /* already gone */
    }
    return;
  }
  writeFileSync(sidecarPath(docPath), JSON.stringify({ version: 1, threads }, null, 2) + '\n');
}

export function makeReply({ author, authorId, role = 'user', text }) {
  return { id: randomUUID(), author, authorId, role, text: String(text).slice(0, 20000), createdAt: Date.now() };
}

// ---------- per-person read marks ----------
// { identity: { docPathLower: { threadId: lastSeenTs } } }. Identity is the
// guest's email, or '@owner' for every device of the host owner — which is what
// makes a thread opened on the phone lose its red dot on the desktop too.

const SEEN_PATH = join(homedir(), '.remaude', 'comments-seen.json');

let seen = (() => {
  try {
    return JSON.parse(readFileSync(SEEN_PATH, 'utf-8'));
  } catch {
    return {};
  }
})();

function saveSeen() {
  mkdirSync(dirname(SEEN_PATH), { recursive: true });
  writeFile(SEEN_PATH, JSON.stringify(seen, null, 2)).catch(() => {});
}

export function seenFor(identity, docPath) {
  return seen[identity]?.[docPath.toLowerCase()] ?? {};
}

export function markThreadSeen(identity, docPath, threadId) {
  ((seen[identity] ??= {})[docPath.toLowerCase()] ??= {})[threadId] = Date.now();
  saveSeen();
}

/** Threads with someone else's replies newer than this person's last look. */
export function unseenThreadIds(identity, docPath, threads) {
  const marks = seenFor(identity, docPath);
  return threads
    .filter((t) => (t.replies ?? []).some((r) => r.authorId !== identity && r.createdAt > (marks[t.id] ?? 0)))
    .map((t) => t.id);
}
