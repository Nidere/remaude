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

console.log(failed ? `AGENT ROWS: ${failed} failed` : 'AGENT ROWS OK');
process.exit(failed ? 1 : 0);
