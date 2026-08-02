// The rule that cannot be eyeballed: a thread tag must ride on the turn its own
// message starts, not on whatever the model happens to be doing right now.
import { TurnTags } from '../src/host/turn-tags.js';

let failed = 0;
const eq = (got, want, name) => {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  if (a !== b) {
    console.error(`FAIL ${name}: got ${a}, want ${b}`);
    failed++;
  }
};

// idle chat: the message starts a turn right away, so its tag is active at once
let t = new TurnTags();
t.onSend('c', { busy: false, threadId: 'T1' });
eq(t.active('c'), 'T1', 'idle send tags the turn it starts');

// the classic case: the model is working, a thread reply is written meanwhile.
// The running turn must stay untagged; the reply owns the NEXT one.
t = new TurnTags();
t.onSend('c', { busy: false }); // the main question
eq(t.active('c'), null, 'a plain turn carries no tag');
t.onSend('c', { busy: true, threadId: 'T1' }); // typed while it thinks
eq(t.active('c'), null, 'the running turn is not stolen by the thread');
eq(t.queued('c'), ['T1'], 'the tag waits in the queue');
t.onTurnEnd('c');
eq(t.active('c'), 'T1', 'the thread owns the next turn');
t.onTurnEnd('c');
eq(t.active('c'), null, 'and lets go afterwards');

// several messages queued behind one turn keep their order — untagged included,
// or every tag after the first would land on the wrong turn
t = new TurnTags();
t.onSend('c', { busy: false, threadId: 'A' });
t.onSend('c', { busy: true, threadId: null });
t.onSend('c', { busy: true, threadId: 'B' });
eq(t.active('c'), 'A', 'first turn keeps its own tag');
t.onTurnEnd('c');
eq(t.active('c'), null, 'the plain message keeps its place in the queue');
t.onTurnEnd('c');
eq(t.active('c'), 'B', 'the second thread reply lands on its own turn');

// two messages typed in a row while idle: the second still queues behind the
// first (the first one is already starting a turn)
t = new TurnTags();
t.onSend('c', { busy: false, threadId: 'A' });
t.onSend('c', { busy: false, threadId: 'B' });
eq(t.active('c'), 'A', 'a burst does not overwrite the running tag');
eq(t.queued('c'), ['B'], 'the second waits');
t.onTurnEnd('c');
eq(t.active('c'), 'B', 'and gets its turn next');

// chats do not leak into each other
t = new TurnTags();
t.onSend('c1', { busy: false, threadId: 'A' });
t.onSend('c2', { busy: false, threadId: 'B' });
eq([t.active('c1'), t.active('c2')], ['A', 'B'], 'tags are per chat');
t.onTurnEnd('c1');
eq([t.active('c1'), t.active('c2')], [null, 'B'], 'ending one turn leaves the other alone');

// an end with nothing queued (a turn nobody tagged) is not an error
t = new TurnTags();
t.onTurnEnd('fresh');
eq(t.active('fresh'), null, 'ending an unknown turn is harmless');

console.log(failed ? `TURN TAGS: ${failed} failed` : 'TURN TAGS OK');
process.exit(failed ? 1 : 0);
