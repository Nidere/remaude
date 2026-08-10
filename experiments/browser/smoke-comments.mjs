// Smoke test of the comments WS protocol against an isolated server instance.
// Run from the project root: node <this file> <scratchDir>
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { WebSocket } from '../../node_modules/ws/wrapper.mjs';

// somewhere disposable: these start a whole host with its own home
const scratch = process.argv[2] ?? join(tmpdir(), 'remaude-smoke-' + basename(fileURLToPath(import.meta.url), '.mjs'));
const PORT = 7799;
const home = join(scratch, 'fakehome');
const proj = join(scratch, 'proj');
rmSync(home, { recursive: true, force: true });
rmSync(proj, { recursive: true, force: true });
mkdirSync(join(proj, '.remaude'), { recursive: true });
const doc = join(proj, '.remaude', 'test.md');
writeFileSync(doc, '# Test doc\n\nhello world of comments\n\nsecond line here\n');

const server = spawn(process.execPath, [fileURLToPath(new URL('../../src/host/server.js', import.meta.url))], {
  env: {
    ...process.env,
    REMAUDE_PORT: String(PORT),
    REMAUDE_CONFIG: join(home, '.remaude', 'host.json'),
    USERPROFILE: home,
    HOME: home,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (d) => (serverLog += d));
server.stderr.on('data', (d) => (serverLog += d));

const fail = (why) => {
  console.error('FAIL:', why);
  console.error('--- server log ---\n' + serverLog);
  server.kill();
  process.exit(1);
};
const ok = (name) => console.log('ok:', name);

await new Promise((r) => setTimeout(r, 1500));

const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
const inbox = [];
const waiters = [];
ws.on('message', (raw) => {
  const msg = JSON.parse(raw);
  inbox.push(msg);
  for (let i = waiters.length - 1; i >= 0; i--) {
    if (waiters[i].test(msg)) {
      const w = waiters.splice(i, 1)[0];
      clearTimeout(w.timer);
      w.resolve(msg);
    }
  }
});
const expect = (name, test, from = 0) =>
  new Promise((resolve) => {
    const hit = inbox.slice(from).find(test);
    if (hit) return resolve(hit);
    const timer = setTimeout(() => fail(`timeout waiting for: ${name}`), 5000);
    waiters.push({ test, resolve, timer });
  });
const req = (obj) => ws.send(JSON.stringify(obj));

await new Promise((r) => ws.on('open', r));
await expect('state snapshot', (m) => m.type === 'state');
await expect('initial badge', (m) => m.type === 'comments_badge' && m.total === 0);
ok('connect + empty badge');

req({ type: 'add_artifact', path: doc, chatId: null });
await expect('artifact_added', (m) => m.type === 'artifact_added');
ok('add_artifact');

// the inbox keeps itself out of the repository, without touching the project's
// own .gitignore and without anyone having to remember
const ignore = join(proj, '.remaude', '.gitignore');
if (!existsSync(ignore)) fail('the inbox did not make itself invisible to git');
if (!readFileSync(ignore, 'utf-8').includes('*')) fail(`the ignore file ignores nothing: ${readFileSync(ignore, 'utf-8')}`);
ok('the inbox ignores itself');

req({ type: 'read_artifact', path: doc });
const art = await expect('artifact', (m) => m.type === 'artifact');
if (!art.text.includes('hello world')) fail('artifact text wrong');
ok('read_artifact');

req({ type: 'list_comments', path: doc });
const empty = await expect('comments empty', (m) => m.type === 'comments');
if (empty.threads.length !== 0 || empty.me !== '@owner') fail('expected empty threads for @owner');
ok('list_comments (empty)');

req({
  type: 'add_comment',
  path: doc,
  anchor: { quote: 'hello world', prefix: '# Test doc', suffix: ' of comments' },
  text: 'первый коммент',
});
const withThread = await expect('comments with thread', (m) => m.type === 'comments' && m.threads.length === 1);
const thread = withThread.threads[0];
if (thread.replies[0].text !== 'первый коммент') fail('reply text mismatch');
if (thread.replies[0].authorId !== '@owner') fail('authorId mismatch');
if (!existsSync(doc + '.comments.json')) fail('sidecar not written');
ok('add_comment + sidecar on disk');

const badge1 = await expect('badge after own comment', (m) => m.type === 'comments_badge');
if (badge1.total !== 0) fail('own comment must not be unread for its author');
ok('own comment not unread');

req({ type: 'reply_comment', path: doc, threadId: thread.id, text: 'ответ **жирный**' });
const withReply = await expect('comments with reply', (m) => m.type === 'comments' && m.threads[0]?.replies.length === 2);
const replyId = withReply.threads[0].replies[1].id;
ok('reply_comment');

req({ type: 'edit_comment', path: doc, threadId: thread.id, replyId, text: 'исправленный ответ' });
const edited = await expect(
  'edited reply',
  (m) => m.type === 'comments' && m.threads[0]?.replies[1]?.text === 'исправленный ответ'
);
if (!edited.threads[0].replies[1].editedAt) fail('editedAt not set');
ok('edit_comment');

req({ type: 'resolve_comment', path: doc, threadId: thread.id, resolved: true });
await expect('resolved', (m) => m.type === 'comments' && m.threads[0]?.resolved === true);
ok('resolve_comment');

req({ type: 'mark_thread_seen', path: doc, threadId: thread.id });
await expect('seen sync', (m) => m.type === 'comments' && m.seen?.[thread.id]);
ok('mark_thread_seen');

req({ type: 'delete_comment', path: doc, threadId: thread.id, replyId });
await expect('reply deleted', (m) => m.type === 'comments' && m.threads[0]?.replies.length === 1);
ok('delete_comment (reply)');

const beforeThreadDelete = inbox.length;
req({ type: 'delete_comment', path: doc, threadId: thread.id, replyId: thread.replies[0].id });
await expect('thread deleted', (m) => m.type === 'comments' && m.threads.length === 0, beforeThreadDelete);
if (existsSync(doc + '.comments.json')) fail('empty sidecar should be deleted');
ok('delete_comment (thread) + sidecar removed');

// errors surface with inResponseTo
req({ type: 'add_comment', path: doc, anchor: { quote: 'x' }, text: '' });
await expect('empty comment rejected', (m) => m.type === 'error' && m.inResponseTo === 'add_comment');
ok('error path');

// ---------- project file explorer ----------

mkdirSync(join(proj, 'docs', 'deep'), { recursive: true });
mkdirSync(join(proj, 'node_modules'), { recursive: true });
writeFileSync(join(proj, 'node_modules', 'junk.js'), '// noise');
const projDoc = join(proj, 'docs', 'spec.md');
writeFileSync(projDoc, '# Spec\n\nthe design lives here, next to the code\n');
writeFileSync(join(proj, 'docs', 'logo.png'), 'not really a png');

req({ type: 'add_project', path: proj });
await expect('project added', (m) => m.type === 'state' && m.projects.some((p) => p.path === proj));
ok('project added');

let from = inbox.length;
req({ type: 'list_dir', projectPath: proj });
const root = await expect('root listing', (m) => m.type === 'dir_listing', from);
const names = root.entries.map((e) => e.name);
if (names.includes('node_modules')) fail('node_modules must be hidden');
if (!names.includes('docs') || !names.includes('.remaude')) fail(`unexpected root listing: ${names}`);
if (root.parent !== null) fail('root must have no parent');
if (root.entries[0].dir !== true) fail('folders must sort first');
ok('list_dir: folders first, junk hidden');

from = inbox.length;
req({ type: 'list_dir', projectPath: proj, path: join(proj, 'docs') });
const docs = await expect('docs listing', (m) => m.type === 'dir_listing', from);
if (!docs.entries.some((e) => e.name === 'spec.md' && e.size > 0)) fail('spec.md missing from the listing');
if (docs.parent !== proj) fail('parent should point back to the project root');
ok('list_dir: navigating into a folder');

req({ type: 'list_dir', projectPath: proj, path: join(proj, '..') });
await expect('escape rejected', (m) => m.type === 'error' && m.inResponseTo === 'list_dir');
ok('list_dir refuses to climb out of the project');

// a markdown file that was never in the inbox: readable, and commentable
from = inbox.length;
req({ type: 'read_artifact', path: projDoc });
const projArt = await expect('project doc read', (m) => m.type === 'artifact', from);
if (!projArt.text.includes('next to the code')) fail('wrong content for the project doc');
ok('read_artifact works for a project file outside the inbox');

from = inbox.length;
req({ type: 'add_comment', path: projDoc, anchor: { quote: 'design' }, text: 'коммент к файлу проекта' });
const projThreads = await expect('project doc comments', (m) => m.type === 'comments' && m.threads.length === 1, from);
if (projThreads.path !== projDoc) fail('comments came back for the wrong path');
if (!existsSync(projDoc + '.comments.json')) fail('sidecar not written next to the project file');
ok('comments on a project file (sidecar next to it)');

// the sidecar must not show up in the explorer
from = inbox.length;
req({ type: 'list_dir', projectPath: proj, path: join(proj, 'docs') });
const docs2 = await expect('docs listing again', (m) => m.type === 'dir_listing', from);
if (docs2.entries.some((e) => e.name.endsWith('.comments.json'))) fail('the sidecar must be hidden from the listing');
ok('sidecar hidden from the explorer');

// a file outside any project stays unreachable
req({ type: 'read_artifact', path: join(scratch, 'outside.md') });
await expect('outside rejected', (m) => m.type === 'error' && m.inResponseTo === 'read_artifact');
ok('files outside every project are refused');

// ---------- a file handed over in pieces ----------

req({ type: 'add_project', path: proj });
await expect('project there', (m) => m.type === 'state' && m.projects.some((p) => p.path === proj));
// a chat is needed to hand a file to, and there is none without the SDK — so the
// pieces are checked against the rules the handler enforces before it needs one
req({ type: 'upload_file', chatId: 'nope', uploadId: 'u1', name: 'big.bin', seq: 0, data: Buffer.alloc(8).toString('base64'), last: false });
await expect('upload without a chat refused', (m) => m.type === 'error' && m.inResponseTo === 'upload_file');
ok('a file needs a chat to be handed to');

req({ type: 'upload_file', chatId: 'nope', uploadId: 'u1', name: 'big.bin', seq: 3, data: 'AAAA', last: true });
await expect('a piece of nothing refused', (m) => m.type === 'error' && m.inResponseTo === 'upload_file');
ok('a piece of an upload that never started is refused');

// ---------- links between documents ----------

writeFileSync(join(proj, 'docs', 'heroes.md'), '# Герои\n\n## Действия героя\n\nтекст про действия\n');

from = inbox.length;
req({ type: 'open_doc_link', from: projDoc, href: './heroes.md' });
const linked = await expect('sibling doc opened', (m) => m.type === 'artifact', from);
if (!linked.text.includes('Герои')) fail('the link opened the wrong file');
ok('a link to a sibling document opens it');

from = inbox.length;
req({ type: 'open_doc_link', from: projDoc, href: 'heroes.md#действия-героя' });
const withAnchor = await expect('doc with anchor', (m) => m.type === 'artifact', from);
if (withAnchor.anchor !== 'действия-героя') fail(`the anchor was lost: ${withAnchor.anchor}`);
ok('a link carries its section anchor along');

from = inbox.length;
req({ type: 'open_doc_link', from: projDoc, href: '/README.md' });
writeFileSync(join(proj, 'README.md'), '# Readme\n');
req({ type: 'open_doc_link', from: projDoc, href: '/README.md' });
const rootLink = await expect('root-relative link', (m) => m.type === 'artifact' && m.name === 'README.md', from);
if (!rootLink.path.startsWith(proj)) fail('a root-relative link must stay in the project');
ok('a link from the project root resolves inside the project');

req({ type: 'open_doc_link', from: projDoc, href: '../../../../windows/system.ini' });
await expect('escape refused', (m) => m.type === 'error' && m.inResponseTo === 'open_doc_link');
ok('a link climbing out of the project is refused');

// ---------- the name of a chat reaches its past-chats entry ----------

const slug = proj.replace(/[^a-zA-Z0-9-]/g, '-');
const sessionsDir = join(home, '.claude', 'projects', slug);
mkdirSync(sessionsDir, { recursive: true });
const sid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
writeFileSync(
  join(sessionsDir, `${sid}.jsonl`),
  JSON.stringify({ type: 'user', uuid: 'u1', timestamp: new Date().toISOString(), cwd: proj, message: { role: 'user', content: 'первое сообщение этого чата' } }) + '\n'
);

from = inbox.length;
req({ type: 'list_sessions', projectPath: proj });
const plain = await expect('sessions listed', (m) => m.type === 'sessions', from);
const entry = plain.sessions.find((s) => s.id === sid);
if (!entry) fail('the saved session was not listed at all');
if (entry.title) fail(`an unnamed chat should not pretend to have a name: ${entry.title}`);
ok('past chats list what is on disk');

// a chat that was given a name keeps it here — that is what renaming is for,
// and closing the chat must not take the name with it
const cfgPath = join(home, '.remaude', 'host.json');
const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8'));
cfg.chatNames = { [sid]: 'Как я назвал этот чат' };
writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

server.kill();
await new Promise((r) => setTimeout(r, 500));
const second = spawn(process.execPath, [fileURLToPath(new URL('../../src/host/server.js', import.meta.url))], {
  env: { ...process.env, REMAUDE_PORT: '7796', REMAUDE_CONFIG: cfgPath, USERPROFILE: home, HOME: home },
  stdio: ['ignore', 'pipe', 'pipe'],
});
second.stdout.on('data', (d) => (serverLog += d));
second.stderr.on('data', (d) => (serverLog += d));
await new Promise((r) => setTimeout(r, 1500));

const ws2 = new WebSocket('ws://127.0.0.1:7796/ws');
const seen2 = [];
ws2.on('message', (raw) => seen2.push(JSON.parse(raw)));
await new Promise((r) => ws2.on('open', r));
ws2.send(JSON.stringify({ type: 'list_sessions', projectPath: proj }));
await new Promise((r) => setTimeout(r, 800));
const listed = seen2.find((m) => m.type === 'sessions')?.sessions?.find((s) => s.id === sid);
if (listed?.title !== 'Как я назвал этот чат') {
  second.kill();
  fail(`the chat's name never reached the past-chats list: ${JSON.stringify(listed)}`);
}
ok('a named chat is listed under its name in past chats');
second.kill();

server.kill();
console.log('ALL OK');
process.exit(0);
