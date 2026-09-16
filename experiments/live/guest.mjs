// What a guest actually gets: the state for a shared project, the history of a
// chat they did not start, and the right to start one of their own.
//
// A guest exists only behind the relay — the host learns who they are from the
// {t:'open', guest} frame, and a local ws is always the owner. So the probe
// plays the relay itself: a WS server the host dials out to, over the same
// protocol src/host/relay-link.js speaks.
import { startHost, scratchProject } from './host.mjs';
import { WebSocketServer } from 'ws';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const GUEST = 'guest@example.com';
const RELAY_PORT = 7880 + Math.floor(process.pid % 100);

// ---- the relay, as far as the host is concerned ----
const wss = new WebSocketServer({ port: RELAY_PORT });
let hostWs = null;
let dialled = 0; // a restarted host dials again — that is how we know it is back
const inboxes = new Map(); // client id -> [parsed messages]
wss.on('connection', (ws) => {
  hostWs = ws;
  dialled++;
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw);
    // 'msg' goes to one tunnelled client, 'cast' to all of them
    if (msg.t === 'msg') inboxes.get(msg.id)?.push(JSON.parse(msg.data));
    else if (msg.t === 'cast') for (const box of inboxes.values()) box.push(JSON.parse(msg.data));
    else if (msg.t === 'shares') console.log(`[shares] host announces: ${JSON.stringify(msg.emails)}`);
  });
});

async function hostDialledUs(nth, ms = 60_000) {
  const deadline = Date.now() + ms;
  while (dialled < nth) {
    if (Date.now() > deadline) throw new Error(`the host never dialled the relay (${nth})`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

/** Open a tunnelled browser and return its inbox plus a way to talk. */
function openGuest(id) {
  inboxes.set(id, []);
  hostWs.send(JSON.stringify({ t: 'open', id, guest: { email: GUEST } }));
  return {
    inbox: inboxes.get(id),
    send: (obj) => hostWs.send(JSON.stringify({ t: 'msg', id, data: JSON.stringify(obj) })),
  };
}

/** Wait for a message of this type in an inbox (they arrive out of order). */
async function waitFor(inbox, type, ms = 30_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const hit = inbox.find((m) => m.type === type);
    if (hit) return hit;
    const err = inbox.find((m) => m.type === 'error');
    if (err) throw new Error(`host refused: ${err.message}`);
    if (Date.now() > deadline) throw new Error(`no ${type} in ${ms}ms`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

// ---- a host of our own, told to dial our relay ----
const projectDir = scratchProject('guest');
const cfgDir = mkdtempSync(join(tmpdir(), 'remaude-guest-cfg-'));
const cfgPath = join(cfgDir, 'host.json');
writeFileSync(
  cfgPath,
  JSON.stringify({
    projects: [projectDir],
    openChats: [],
    relay: { token: 'probe-token', url: `ws://127.0.0.1:${RELAY_PORT}` },
  })
);

const host = await startHost({ configPath: cfgPath });
await hostDialledUs(1);
console.log(`[relay] host connected on :${RELAY_PORT}`);

// ---- the owner: a chat with something in it, and the project shared ----
const owner = host.connect();
const ownerBox = [];
owner.on('message', (raw) => ownerBox.push(JSON.parse(raw)));
await new Promise((r) => owner.on('open', r));

owner.send(JSON.stringify({ type: 'create_chat', projectPath: projectDir, model: 'haiku' }));
const { chatId } = await waitFor(ownerBox, 'chat_created');
owner.send(JSON.stringify({ type: 'send', chatId, content: 'Ответь одним словом: привет.' }));
const answered = Date.now() + 120_000;
while (!ownerBox.some((m) => m.type === 'chat_message' && m.msg?.type === 'result')) {
  if (Date.now() > answered) throw new Error('the owner never got a result');
  await new Promise((r) => setTimeout(r, 200));
}
console.log(`[owner] chat ${chatId.slice(0, 8)} has an answer`);

owner.send(JSON.stringify({ type: 'share_scope', projectPath: projectDir, email: GUEST }));
const shared = await waitFor(ownerBox, 'share_result');
console.log(`[share] project → ${JSON.stringify(shared.emails)}`);

// ---- the guest ----
const guest = openGuest('guest-1');
const state = await waitFor(guest.inbox, 'state');
const project = state.projects.find((p) => p.path === projectDir);
console.log(`[guest] guest=${state.guest} projects=${state.projects.length} canCreate=${project?.canCreate}`);
console.log(`[guest] chats visible: ${project?.chats.length} (${project?.chats.map((c) => c.id.slice(0, 8)).join(', ')})`);

guest.send({ type: 'history', chatId });
const history = await waitFor(guest.inbox, 'history');
console.log(`[guest] history: ${history.messages.length} messages — ${history.messages.map((m) => m.type).join(', ')}`);

// the feed puts a message on one side or the other by this, so it has to say
// whose it is — and on this machine the guest is not the one who wrote it
const written = history.messages.find((m) => m.type === 'user' && m.author);
console.log(`[guest] the owner's message is signed ${written?.author} / ${written?.authorId}, and we are ${state.me}`);
const signed = state.me === GUEST && written?.authorId === '@owner';

guest.send({ type: 'create_chat', projectPath: projectDir });
const made = await waitFor(guest.inbox, 'chat_created');
console.log(`[guest] started a chat of their own: ${made.chatId.slice(0, 8)}`);

// and the fence still stands: a project nobody shared with them
guest.send({ type: 'create_chat', projectPath: tmpdir() });
const refused = await waitFor(guest.inbox, 'error');
console.log(`[guest] elsewhere: ${refused.message}`);

// ---- and the half of it that only a restart can show ----
// The host signs a live message as it broadcasts it; after a restart there is
// nothing left but the transcript, and a transcript records no author. So a
// guest's message carries its sender written into the text — the test is that
// it comes back theirs, and comes back clean.
const SAID = 'Ответь одним словом: ага.';
guest.send({ type: 'send', chatId, content: SAID });
const spoke = Date.now() + 120_000;
while (!guest.inbox.some((m) => m.type === 'chat_message' && m.msg?.type === 'result')) {
  if (Date.now() > spoke) throw new Error('the guest never got a result');
  await new Promise((r) => setTimeout(r, 200));
}
console.log('[guest] said something into the shared chat');

host.stop();
const again = await startHost({ configPath: cfgPath, port: host.port });
await hostDialledUs(2);
console.log('[relay] the host is back');

const guest2 = openGuest('guest-2');
const state2 = await waitFor(guest2.inbox, 'state');
// a reopened chat is a new chat with an old conversation in it
const reopened = state2.projects.find((p) => p.path === projectDir)?.chats.find((c) => c.title);
guest2.send({ type: 'history', chatId: reopened?.id });
const history2 = await waitFor(guest2.inbox, 'history');
const mine = history2.messages.find((m) => m.type === 'user' && JSON.stringify(m.message.content).includes('ага'));
console.log(`[guest] after the restart their own message reads back as ${mine?.author} / ${mine?.authorId}`);
console.log(`[guest] and its text is ${JSON.stringify(mine?.message?.content)}`);

const survived =
  mine?.authorId === GUEST && mine?.author === 'guest' && !JSON.stringify(mine.message.content).includes('remaude:');

const ok =
  state.guest === true && project?.canCreate === true && history.messages.length > 0 && signed && survived;
console.log(ok ? '\nOK' : '\nFAILED');

again.stop();
wss.close();
process.exit(ok ? 0 : 1);
