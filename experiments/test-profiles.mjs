// The sharing between two Claude accounts on one machine, and the one part of it
// that does not hold: the hard link on settings.json. The CLI renames a new file
// over that one, which replaces the directory entry rather than the contents, so
// the two names drift apart with nothing to announce it. This is the probe that
// the drift is noticed and undone.
//
// profiles.js reads os.homedir(), and on every platform Node takes that from the
// environment — so the whole thing runs against a temp home in a child process,
// and never touches the owner's real ~/.claude.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

let failed = 0;
const check = (cond, name) => {
  if (!cond) {
    console.error('FAIL:', name);
    failed++;
  }
};

// a file:// URL, because a Windows path is not one an ESM import will take
const PROFILES = new URL('../src/host/profiles.js', import.meta.url).href;
const home = mkdtempSync(join(tmpdir(), 'remaude-profiles-'));

/** Run a snippet of code with `profiles` imported and `home` as the home directory. */
function inFakeHome(code) {
  return execFileSync(process.execPath, ['--input-type=module', '-e', `import * as profiles from ${JSON.stringify(PROFILES)};\n${code}`], {
    env: { ...process.env, HOME: home, USERPROFILE: home },
    encoding: 'utf8',
  }).trim();
}

try {
  // The default account, as it is when remaude first meets it.
  mkdirSync(join(home, '.claude'), { recursive: true });
  writeFileSync(join(home, '.claude', 'settings.json'), '{"model":"fable"}');

  // A second account is made by borrowing from the first.
  inFakeHome('await profiles.createProfile("work")');
  const base = join(home, '.claude', 'settings.json');
  const mirror = join(home, '.claude-work', 'settings.json');

  check(existsSync(mirror), 'a new profile gets the settings of the default one');
  check(statSync(base).ino === statSync(mirror).ino, 'and gets them as one file under two names');
  check(existsSync(join(home, '.claude-work', 'projects')), 'transcripts are shared, so a chat can change hands');

  // An edit through either name is the same edit — that is the point of the link.
  writeFileSync(base, '{"model":"opus"}');
  check(readFileSync(mirror, 'utf8') === '{"model":"opus"}', 'an edit to settings reaches both accounts');

  // What the CLI actually does: write a new file and rename it over the old one.
  // The link does not survive it, and nothing says so.
  writeFileSync(join(home, '.claude', 'settings.new'), '{"model":"sonnet","effortLevel":"high"}');
  rmSync(base);
  writeFileSync(base, '{"model":"sonnet","effortLevel":"high"}');
  check(statSync(base).ino !== statSync(mirror).ino, 'a replace-by-rename breaks the link (the whole reason for this probe)');
  check(readFileSync(mirror, 'utf8') === '{"model":"opus"}', 'and the second account is left on stale settings');

  // Starting a session under that account puts it back.
  inFakeHome('profiles.profileEnv("work")');
  check(statSync(base).ino === statSync(mirror).ino, 'starting a session re-links the settings');
  check(readFileSync(mirror, 'utf8') === '{"model":"sonnet","effortLevel":"high"}', 'so the account sees the current settings again');

  // Twice in a row must be as good as once — it runs at every session start.
  inFakeHome('profiles.profileEnv("work"); profiles.profileEnv("work")');
  check(statSync(base).ino === statSync(mirror).ino, 'repairing an intact link leaves it intact');

  // A missing junction is restored too — the transcripts are what the accounts
  // share for, and a chat that cannot find them cannot be resumed.
  rmSync(join(home, '.claude-work', 'projects'), { recursive: true });
  inFakeHome('profiles.profileEnv("work")');
  check(existsSync(join(home, '.claude-work', 'projects')), 'a lost junction to the shared transcripts is remade');

  // The default account is left alone: it inherits whatever the host was started
  // with, and there is nothing above it to borrow from.
  const env = JSON.parse(inFakeHome('console.log(JSON.stringify(profiles.profileEnv("personal")))'));
  check(!('CLAUDE_CONFIG_DIR' in env) || env.CLAUDE_CONFIG_DIR === process.env.CLAUDE_CONFIG_DIR, 'the default account is not pointed anywhere by hand');
  const work = JSON.parse(inFakeHome('console.log(JSON.stringify(profiles.profileEnv("work")))'));
  check(work.CLAUDE_CONFIG_DIR === join(home, '.claude-work'), 'a second account is a CLAUDE_CONFIG_DIR');

  // Repairing an account that does not exist is a no-op, not a crash: the owner
  // may have deleted the directory while a project still names it.
  inFakeHome('profiles.repairShared("never-made")');
  check(!existsSync(join(home, '.claude-never-made')), 'an account that is gone is not conjured back into being');

  // Names that would make a mess of the home directory.
  check(inFakeHome('console.log(profiles.nameComplaint("personal") ?? "")') !== '', 'the default name cannot be taken twice');
  check(inFakeHome('console.log(profiles.nameComplaint("../escape") ?? "")') !== '', 'a name cannot climb out of the home directory');
  check(inFakeHome('console.log(profiles.nameComplaint("work") ?? "ok")') === 'ok', 'an ordinary name is fine');
} finally {
  rmSync(home, { recursive: true, force: true });
}

console.log(failed ? `${failed} failed` : 'ok');
process.exit(failed ? 1 : 0);
