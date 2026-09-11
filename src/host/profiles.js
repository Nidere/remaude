// Several Claude Code accounts on one machine.
//
// A profile is a CLAUDE_CONFIG_DIR. The CLI keeps its login in
// `<dir>/.credentials.json`, so a second directory is a second account, and a
// session started with that variable set bills the account that lives there.
//
// But the directory holds far more than the login: the transcripts of every
// chat, the per-project memory, the settings, the plugin cache. A second profile
// that took a fresh copy of all that would hide the owner's own chats from them
// the moment a project changed hands. So a new profile borrows: everything it
// shares points back at the first directory, and only the credentials are its
// own. That is what makes a chat account-agnostic — it stays in one place on
// disk, and either account can resume it.

import { existsSync, linkSync, statSync, symlinkSync, unlinkSync } from 'node:fs';
import { mkdir, symlink, link } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** The account that was here before any of this existed: plain ~/.claude. */
export const DEFAULT_PROFILE = 'personal';

// Junctions, because Windows makes them without administrator rights (a plain
// symlink needs them). `projects` is the transcripts and the memory, `plugins`
// is a cache worth several megabytes and no download.
const SHARED_DIRS = ['projects', 'plugins'];
// A hard link: one file under two names, so an edit through either is the same
// edit. It survives writes but not a replace-by-rename, and the CLI does rename
// over this file — so the link is not expected to last. `repairShared` below
// re-makes it at every session start.
const SHARED_FILES = ['settings.json'];

export function profileDir(name) {
  return !name || name === DEFAULT_PROFILE ? join(homedir(), '.claude') : join(homedir(), `.claude-${name}`);
}

/** @returns the complaint about this name, or null if it is a good one */
export function nameComplaint(name) {
  const value = String(name ?? '').trim();
  if (!value) return 'a profile needs a name';
  if (value === DEFAULT_PROFILE) return `“${DEFAULT_PROFILE}” is the account that is already here`;
  if (!/^[a-z0-9][a-z0-9-]{0,30}$/i.test(value))
    return 'letters, digits and dashes only, starting with a letter or a digit';
  return null;
}

/**
 * Make the directory and its links back to the default profile. The account
 * itself is not signed in here — that is `claude auth login` under this env,
 * which the UI drives so the person can see the code.
 */
export async function createProfile(name) {
  const complaint = nameComplaint(name);
  if (complaint) throw new Error(complaint);
  const dir = profileDir(name);
  if (existsSync(dir)) throw new Error(`${dir} already exists`);
  const base = profileDir(DEFAULT_PROFILE);

  await mkdir(dir, { recursive: true });
  for (const shared of SHARED_DIRS) {
    const target = join(base, shared);
    if (!existsSync(target)) await mkdir(target, { recursive: true });
    await symlink(target, join(dir, shared), process.platform === 'win32' ? 'junction' : 'dir');
  }
  for (const shared of SHARED_FILES) {
    const target = join(base, shared);
    if (existsSync(target)) await link(target, join(dir, shared));
  }
  return dir;
}

/**
 * Put back what the sharing above has lost. The hard link on `settings.json` is
 * the fragile one: the CLI rewrites that file by renaming a new one over it,
 * which replaces the directory entry instead of the contents, and the two names
 * quietly become two files. The profiles then disagree about settings for as
 * long as nobody notices — which is months, because nothing announces it.
 *
 * So the link is checked rather than trusted, at every session start: same inode
 * means it held, anything else means re-link from the profile that owns the file.
 * Junctions do not break the same way, but a missing one is cheap to spot here too.
 *
 * Repair is best-effort by design. A session must start even if this cannot be
 * done — a locked file or a profile the owner has been editing by hand is worth
 * a wrong `settings.json`, not a chat that refuses to open.
 */
export function repairShared(name) {
  if (!name || name === DEFAULT_PROFILE) return;
  const dir = profileDir(name);
  if (!existsSync(dir)) return;
  const base = profileDir(DEFAULT_PROFILE);

  for (const shared of SHARED_FILES) {
    const target = join(base, shared);
    const mirror = join(dir, shared);
    try {
      if (!existsSync(target)) continue;
      if (existsSync(mirror) && statSync(mirror).ino === statSync(target).ino) continue;
      if (existsSync(mirror)) unlinkSync(mirror);
      linkSync(target, mirror);
    } catch {
      // see above: the account's settings are not worth failing a session over
    }
  }
  for (const shared of SHARED_DIRS) {
    const target = join(base, shared);
    const mirror = join(dir, shared);
    try {
      if (existsSync(mirror) || !existsSync(target)) continue;
      symlinkSync(target, mirror, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      /* likewise */
    }
  }
}

/** The environment a session runs in to be that account. */
export function profileEnv(name) {
  repairShared(name);
  // The default profile inherits whatever the host was started with: setting the
  // variable to ~/.claude by hand would override an owner who had set it on purpose.
  if (!name || name === DEFAULT_PROFILE) return { ...process.env };
  return { ...process.env, CLAUDE_CONFIG_DIR: profileDir(name) };
}
