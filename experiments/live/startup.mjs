// Startup smoke test: a throwaway host on its own port and its own config, so
// it never touches the real one's chats or relay pairing. Catches the kind of
// wiring break that only shows up when the process actually boots — a chat that
// silently fails to reopen, an exception on the way up.
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const repo = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const dir = mkdtempSync(join(tmpdir(), 'remaude-boot-'));
const projectDir = mkdtempSync(join(tmpdir(), 'remaude-bootproj-'));

// a saved session for the host to reopen at startup — the path that broke once
const sessionId = randomUUID();
const sessionsDir = join(homedir(), '.claude', 'projects', projectDir.replace(/[^a-zA-Z0-9-]/g, '-'));
mkdirSync(sessionsDir, { recursive: true });
writeFileSync(
  join(sessionsDir, `${sessionId}.jsonl`),
  JSON.stringify({
    type: 'user',
    message: { role: 'user', content: 'boot test' },
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
  }) + '\n'
);

const config = join(dir, 'host.json');
writeFileSync(
  config,
  JSON.stringify({
    projects: [projectDir],
    openChats: [{ projectPath: projectDir, sessionId, title: 'boot test', permissionMode: 'bypassPermissions' }],
  })
);

const child = spawn(process.execPath, [join(repo, 'src', 'host', 'server.js')], {
  cwd: repo,
  env: { ...process.env, REMAUDE_PORT: '7788', REMAUDE_CONFIG: config },
});

let out = '';
const done = new Promise((resolve) => {
  const onData = (buf) => {
    out += buf.toString();
    if (/remaude host: http/.test(out)) setTimeout(resolve, 1500); // let the reopens run
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  setTimeout(resolve, 20_000);
});

await done;
child.kill();
const lines = out.split('\n');
const failures = lines.filter((l) => /reopen failed|uncaught|Cannot access|listen failed/.test(l));
const reopened = lines.some((l) => /reopened:/.test(l));
console.log(lines.filter((l) => /remaude host|reopened/.test(l)).slice(0, 6).join('\n') || '(no startup line)');
if (failures.length) console.log(`STARTUP PROBLEMS:\n${failures.join('\n')}`);
else if (!reopened) console.log('STARTUP PROBLEM: the saved chat was not reopened');
else console.log('STARTUP OK');
process.exit(failures.length || !reopened ? 1 : 0);
