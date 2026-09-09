// A second Claude account on this machine: does the profile get built as
// promised, does a session actually run under it, and — the point of the whole
// design — does the chat still land in the one shared transcript directory, so
// changing a project's account does not hide its history.
//
// The probe signs no one in. It copies the default profile's credentials into
// the new directory, so the "second account" is really the first one wearing a
// different hat: enough to prove the plumbing, and it costs one haiku turn.
import { startHost, scratchProject } from './host.mjs';
import { copyFileSync, existsSync, lstatSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { slugFor } from '../../src/host/transcripts.js';

const NAME = 'probe';
const dir = join(homedir(), `.claude-${NAME}`);
const base = join(homedir(), '.claude');
if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });

const projectDir = scratchProject('profiles');
const host = await startHost();
const ws = host.connect();
let chatId = null;
const say = (obj) => ws.send(JSON.stringify(obj));

function expect(ok, what) {
  console.log(`${ok ? 'ok:' : 'FAILED:'} ${what}`);
  if (!ok) {
    ws.close();
    host.stop();
    process.exit(1);
  }
}

const finished = new Promise((done, fail) => {
  setTimeout(() => fail(new Error('timeout 180s')), 180_000);
  ws.on('open', () => {
    say({ type: 'add_project', path: projectDir });
    say({ type: 'create_profile', name: NAME });
  });

  ws.on('message', (raw) => {
    const msg = JSON.parse(raw);

    if (msg.type === 'profile_created') {
      expect(existsSync(dir), 'the profile directory is made');
      expect(lstatSync(join(dir, 'projects')).isSymbolicLink(), 'projects is a link, not a copy');
      expect(
        realpathSync(join(dir, 'projects')) === realpathSync(join(base, 'projects')),
        'and it leads to the transcripts the owner already has'
      );
      // Windows does not always give a file index through stat; where it does,
      // one index under two names is the whole point of a hard link
      const a = statSync(join(dir, 'settings.json'));
      const b = statSync(join(base, 'settings.json'));
      expect(a.ino ? a.ino === b.ino : a.size === b.size, 'settings.json is one file under two names');
      expect(!existsSync(join(dir, '.credentials.json')), 'the credentials are its own, and it has none yet');

      // lend it the default account's login, so a session can actually start
      copyFileSync(join(base, '.credentials.json'), join(dir, '.credentials.json'));
      say({ type: 'set_project_profile', path: projectDir, profile: NAME });
      say({ type: 'create_chat', projectPath: projectDir, model: 'haiku' });
    }

    if (msg.type === 'chat_created') {
      chatId = msg.chatId;
      say({ type: 'send', chatId, content: 'Reply with the single word READY.' });
    }

    if (msg.type === 'chat_message' && msg.msg.type === 'result') {
      expect(!msg.msg.is_error, 'a session runs under the second profile');
      const sessionId = msg.msg.session_id;
      const shared = join(base, 'projects', slugFor(projectDir), `${sessionId}.jsonl`);
      expect(existsSync(shared), 'and its transcript is in the shared directory, where either account finds it');
      done();
    }

    if (msg.type === 'error') fail(new Error(msg.message));
  });
});

try {
  await finished;
  const saved = JSON.parse(readFileSync(host.config, 'utf-8'));
  expect(saved.profiles?.includes(NAME), 'the profile is remembered across restarts');
  expect(Object.values(saved.projectProfiles ?? {}).includes(NAME), 'so is the project it was given to');
  console.log('\nPROFILES OK');
} finally {
  ws.close();
  host.stop();
  rmSync(dir, { recursive: true, force: true });
}
