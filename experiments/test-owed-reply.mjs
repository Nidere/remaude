// A message folded into a running turn is owed a reply in words: tool calls are
// refused until the model says something visible, and never for long.
import { OwedReply, OWED_REPLY_REASON, CONTINUE_NUDGE, isContinueNudge } from '../src/host/owed-reply.js';
import { mapEntry } from '../src/host/transcripts.js';

let failed = 0;
const eq = (got, want, name) => {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  if (a !== b) {
    console.error(`FAIL ${name}: got ${a}, want ${b}`);
    failed++;
  }
};

const started = { type: 'command_lifecycle', state: 'started', command_uuid: 'u' };
const result = { type: 'result', subtype: 'success' };
const said = (text, parent = null) => ({
  type: 'assistant',
  parent_tool_use_id: parent,
  message: { content: [{ type: 'text', text }] },
});
const thought = { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'thinking', thinking: 'noted' }] } };
const toolUse = { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', name: 'Bash' }] } };

let o = new OwedReply();
o.observe(started);
eq(o.refusal(), null, 'the message that starts a turn is answered the ordinary way');

o.observe(toolUse);
o.observe(started);
eq(o.owed, true, 'a second message taken into the running turn is owed a reply');
o.observe(thought);
eq(o.refusal(), OWED_REPLY_REASON, 'thinking about it does not count');
o.observe(said('   '));
eq(o.owed, true, 'nor does an empty text block');
o.observe(said('a reply', 'toolu_sub'));
eq(o.owed, true, 'nor does a subagent speaking');
o.observe(said('Answering: yes.'));
eq(o.refusal(), null, 'visible text settles it');

o.observe(started);
eq(o.owed, true, 'owed again for the next one');
o.observe(result);
eq(o.owed, false, 'the end of the turn clears it');
o.observe(started);
eq(o.owed, false, 'and the next turn starts clean');

// a model that will not answer is let go rather than held forever
o = new OwedReply();
o.observe(started);
o.observe(started);
eq([o.refusal(), o.refusal(), o.refusal()].every(Boolean), true, 'refused three times');
eq(o.refusal(), null, 'then let through');
eq(o.refusal(), null, 'and not refused again');

o = new OwedReply();
o.observe(started);
o.observe(started);
o.reset();
eq(o.refusal(), null, 'an interrupt clears it');

// a reply the refusals pulled out, and then the turn simply ends: the host nudges
o = new OwedReply();
o.observe(started);
o.observe(toolUse);
o.observe(started);
o.refusal();
o.observe(said('Answering: yes.'));
o.observe(result);
eq(o.takeStalled(), true, 'a turn ending on a forced reply wants a nudge');
eq(o.takeStalled(), false, 'and only once');

o = new OwedReply();
o.observe(started);
o.observe(started);
o.refusal();
o.observe(said('Answering: yes.'));
o.observe(toolUse);
o.observe(result);
eq(o.takeStalled(), false, 'a model that went back to work on its own is left alone');

o = new OwedReply();
o.observe(started);
o.observe(started);
o.observe(said('Answering: yes.'));
o.observe(result);
eq(o.takeStalled(), false, 'nor is one that answered without being refused');

o = new OwedReply();
o.observe(started);
o.observe(started);
o.refusal();
o.observe(said('Answering: yes.'));
o.reset();
o.observe({ type: 'result', subtype: 'error_during_execution' });
eq(o.takeStalled(), false, 'nor an interrupted one');

eq(isContinueNudge(CONTINUE_NUDGE), true, 'the nudge knows itself');
eq(isContinueNudge([{ type: 'text', text: CONTINUE_NUDGE }]), true, 'in blocks too');
eq(isContinueNudge('carry on'), false, 'and nothing else');
eq(mapEntry({ type: 'user', message: { role: 'user', content: CONTINUE_NUDGE } }), null, 'the feed never shows it');

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log('ok');
