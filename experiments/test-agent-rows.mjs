// The sidebar's subagent rows, replayed from the messages a real turn produces.
// The bug this exists for: the announcement of a background agent names its id,
// and the rule "any message naming the id is the completion report" swallowed
// that very announcement — the row vanished the moment the agent started.
import { AgentRows } from '../src/host/agent-rows.js';

let failed = 0;
const eq = (got, want, name) => {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  if (a !== b) {
    console.error(`FAIL ${name}: got ${a}, want ${b}`);
    failed++;
  }
};
const statuses = (rows) => rows.list().map((r) => r.status);

const LAUNCH =
  'Async agent launched successfully. (This tool result is internal metadata.)\nagentId: a7d25199b81d811d6 (internal ID - do not mention)';

// a background agent: launched now, reports back much later
let rows = new AgentRows();
rows.start('tool-1', { label: 'изучить репозиторий', type: 'Explore' });
eq(statuses(rows), ['running'], 'a started agent is running');

// the launch announcement and the id mention arrive in the SAME message
rows.onToolResult('tool-1', { text: LAUNCH, token: 'msg-1' });
rows.onMention(JSON.stringify([{ text: LAUNCH }]), { token: 'msg-1' });
eq(statuses(rows), ['running'], 'its own launch announcement does not end it');

// unrelated traffic mentioning nothing
rows.onMention(JSON.stringify([{ text: 'какой-то другой tool_result' }]), { token: 'msg-2' });
eq(statuses(rows), ['running'], 'unrelated messages leave it alone');

// the turn ends while the background agent keeps working — its row must stay
rows.abortForeground();
eq(statuses(rows), ['running'], 'a background agent outlives the turn');

// and finally the harness announces the completion by agent id
const done = rows.onMention(JSON.stringify([{ text: 'agent a7d25199b81d811d6 finished' }]), { token: 'msg-9' });
eq([done, statuses(rows)], [['tool-1'], ['done']], 'the real report ends it, and names which row');

// the real shape of a completion: a harness notification naming the agent and
// the call that started it. This is what the sidebar waits for, and what used
// to never arrive.
rows = new AgentRows();
rows.start('toolu_01BjSdoxjHC8d6rUJrpH3CLF', { label: 'Audit server code quality', type: 'general-purpose' });
rows.onToolResult('toolu_01BjSdoxjHC8d6rUJrpH3CLF', { text: LAUNCH, token: 'launch' });
const notification = JSON.stringify([
  { type: 'text', text: '<task-notification>\n<task-id>a6ec403195d92dc11</task-id>\n<tool-use-id>toolu_01BjSdoxjHC8d6rUJrpH3CLF</tool-use-id>\n<status>completed</status>' },
]);
eq(rows.onMention(notification, { token: 'later' }).length, 1, 'a completion notification ends the row');
eq(statuses(rows), ['done'], 'and it is marked done');

// …even when the notification names only the call it belongs to
rows = new AgentRows();
rows.start('toolu_XYZ', { label: 'что-то', type: null });
rows.onToolResult('toolu_XYZ', { text: 'Async agent launched successfully.', token: 'launch' });
eq(rows.onMention('… <tool-use-id>toolu_XYZ</tool-use-id> …', { token: 'later' }).length, 1, 'the call id alone is enough');

// a foreground agent: one call, one answer
rows = new AgentRows();
rows.start('tool-2', { label: 'посчитать', type: null });
rows.onToolResult('tool-2', { text: 'вот результат работы', token: 'msg-3' });
eq(statuses(rows), ['done'], 'a foreground agent finishes on its answer');

// a failed one says so
rows = new AgentRows();
rows.start('tool-3', { label: 'упасть', type: null });
rows.onToolResult('tool-3', { text: 'boom', isError: true, token: 'msg-4' });
eq(statuses(rows), ['failed'], 'an error is reported as failed');

// a foreground agent that never answered is gone when the turn ends
rows = new AgentRows();
rows.start('tool-4', { label: 'потеряшка', type: null });
eq([rows.abortForeground(), statuses(rows)], [['tool-4'], ['aborted']], 'a silent foreground agent is aborted');
eq(rows.abortForeground(), [], 'aborting twice changes nothing');

// two agents at once, only the named one ends
rows = new AgentRows();
rows.start('a', { label: 'первый', type: null });
rows.start('b', { label: 'второй', type: null });
rows.onToolResult('a', { text: 'Async agent launched. agentId: aaa111', token: 'm1' });
rows.onToolResult('b', { text: 'Async agent launched. agentId: bbb222', token: 'm1' });
rows.onMention(JSON.stringify(['готово: bbb222']), { token: 'm2' });
eq(statuses(rows), ['running', 'done'], 'only the agent that was named finishes');

// what the sidebar actually gets
rows = new AgentRows();
rows.start('x', { label: 'работа', type: 'Explore', now: 111 });
const [row] = rows.list();
eq([row.id, row.label, row.type, row.status, row.startedAt, row.endedAt], ['x', 'работа', 'Explore', 'running', 111, null], 'the row carries what the sidebar draws');

// the reconnect path asks `size` before re-broadcasting — a fresh client must
// learn about agents that were already running (this being absent hid them)
eq(rows.size, 1, 'size counts the rows for the reconnect broadcast');
rows.drop('x');
eq(rows.size, 0, 'and follows drops');


// The shape the completion actually arrives in. Taken from a transcript where
// four "Judge adverts" rows sat running for ten minutes after the work was
// done: the harness does not send a message, it queues the notification, and
// the transcript records the queueing.
import { agentNoticeText } from '../src/host/agent-notice.js';

const NOTICE = [
  '<task-notification>',
  '<task-id>a4ac256c088173df9</task-id>',
  '<tool-use-id>toolu_014tNFTUAhVRWYhwW819w3ci</tool-use-id>',
  '<status>completed</status>',
  '</task-notification>',
].join('\n');

eq(agentNoticeText({ type: 'queue-operation', operation: 'enqueue', content: NOTICE }), NOTICE, 'a queued notification is heard');
eq(agentNoticeText({ type: 'attachment', attachment: { type: 'queued_command', prompt: NOTICE } }), NOTICE, 'and so is the queued command it becomes');
eq(agentNoticeText({ type: 'queue-operation', content: 'но в нарезке были свои проблемы' }), null, 'a queued message of the person is not one');
eq(agentNoticeText({ type: 'user', message: { content: [] } }), null, 'an ordinary turn is left to the ordinary path');
eq(agentNoticeText(null), null, 'and nothing at all is survivable');

// end to end over those two entries: the row must not outlive them
rows = new AgentRows();
rows.start('toolu_014tNFTUAhVRWYhwW819w3ci', { label: 'Judge adverts 00-04', type: 'general-purpose' });
rows.onToolResult('toolu_014tNFTUAhVRWYhwW819w3ci', { text: LAUNCH, token: 'launch' });
rows.abortForeground();
eq(statuses(rows), ['running'], 'the turn ends, the background agent works on');
eq(rows.onMention(agentNoticeText({ type: 'queue-operation', content: NOTICE }), { token: 'queued' }).length, 1, 'the queued notification ends the row');
eq(statuses(rows), ['done'], 'and the sidebar stops showing it as running');

// Wiring, not behaviour: the rules above are worth nothing if the completion
// never reaches them. It arrives twice over — in the live stream and in the
// transcript — and both paths drop such messages before the feed sees them, so
// the bookkeeping has to run before those drops. This has broken twice.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const server = readFileSync(new URL('../src/host/server.js', import.meta.url), 'utf-8');
const liveHandler = server.slice(server.indexOf("agent.on('chat_message'"), server.indexOf('const lastReplies'));
eq(
  liveHandler.indexOf('trackAgents(chatId, msg)') < liveHandler.indexOf("if (msg.type === 'user' && msg.parent_tool_use_id === null && !hasToolResult(msg)) return"),
  true,
  'the live stream counts agents before it skips messages the feed does not want'
);
const tail = server.slice(server.indexOf('function drainTail'), server.indexOf('// ---------- limits'));
eq(tail.indexOf('trackAgents(chatId, {') < tail.indexOf('if (!msg) continue'), true, 'and so does the transcript tail');
eq(tail.includes('trackAgentNotice(chatId, entry)'), true, 'and the tail offers everything else to the notice path — the completion is not a message');

console.log(failed ? `AGENT ROWS: ${failed} failed` : 'AGENT ROWS OK');
process.exit(failed ? 1 : 0);
