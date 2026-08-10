// Which thread the running turn belongs to. The rule that matters: the turn is
// tagged when the session takes a message into work, so nothing has to be
// counted — the previous version counted turns and lost its place whenever one
// ended without reporting back.
import { TurnTags } from '../src/host/turn-tags.js';
import { readFileSync } from 'node:fs';

let failed = 0;
const eq = (got, want, name) => {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  if (a !== b) {
    console.error(`FAIL ${name}: got ${a}, want ${b}`);
    failed++;
  }
};

let t = new TurnTags();
eq(t.active('c'), null, 'nothing is tagged to begin with');

// an ordinary message: the turn belongs to no thread
t.begin('c', null);
eq(t.active('c'), null, 'an ordinary turn carries no tag');
t.end('c');

// a message written in a thread: everything the turn says belongs there
t.begin('c', 'T1');
eq(t.active('c'), 'T1', 'a thread message tags its own turn');
t.end('c');
eq(t.active('c'), null, 'and the tag goes when the turn reports back');

// the case that used to break it: a turn that never reported back (an
// interrupt). The next message still tags its own turn, because nothing is
// being counted.
t = new TurnTags();
t.begin('c', null); // a turn the user interrupts — no end() ever comes
t.begin('c', 'T2'); // the next message is written in a thread
eq(t.active('c'), 'T2', 'an interrupted turn does not shift the next one');

// two threads in a row, and an ordinary message between them
t = new TurnTags();
t.begin('c', 'A');
eq(t.active('c'), 'A', 'first thread');
t.end('c');
t.begin('c', null);
eq(t.active('c'), null, 'an ordinary message in between is not in a thread');
t.end('c');
t.begin('c', 'B');
eq(t.active('c'), 'B', 'second thread');

// chats do not leak into each other
t = new TurnTags();
t.begin('c1', 'A');
t.begin('c2', 'B');
eq([t.active('c1'), t.active('c2')], ['A', 'B'], 'tags are per chat');
t.end('c1');
eq([t.active('c1'), t.active('c2')], [null, 'B'], 'ending one turn leaves the other alone');

// ending a turn nobody started is harmless
t = new TurnTags();
t.end('fresh');
eq(t.active('fresh'), null, 'ending an unknown turn is harmless');

// Wiring: the tag has to be set from the message the session replays back, and
// tool results must not be mistaken for the start of a turn.
const server = readFileSync(new URL('../src/host/server.js', import.meta.url), 'utf-8');
const wiring = server.slice(server.indexOf("agent.on('chat_message'"), server.indexOf('const lastReplies'));
eq(
  /if \(msg\.type === 'user' && msg\.parent_tool_use_id === null && !hasToolResult\(msg\)\)\s*\n\s*turnTags\.begin\(chatId, threadIdInText\(plainTextOf\(msg\)\)\)/.test(wiring),
  true,
  'a turn is tagged from the message that starts it, tool results excluded'
);
eq(/turnTags\.end\(chatId\)/.test(wiring), true, 'and untagged when the turn reports back');

console.log(failed ? `TURN TAGS: ${failed} failed` : 'TURN TAGS OK');
process.exit(failed ? 1 : 0);
