// The whole conversation as one document: what goes in, what stays out.
import { chatToMarkdown, exportFileName } from '../src/host/export-md.js';

let failed = 0;
const check = (cond, name) => {
  if (!cond) {
    console.error('FAIL:', name);
    failed++;
  }
};

const user = (text, extra = {}) => ({
  type: 'user',
  parent_tool_use_id: null,
  message: { role: 'user', content: text },
  timestamp: '2026-08-04T09:00:00.000Z',
  author: 'Nidere',
  ...extra,
});
const assistant = (text, blocks = [], extra = {}) => ({
  type: 'assistant',
  parent_tool_use_id: null,
  message: { role: 'assistant', content: [{ type: 'text', text }, ...blocks] },
  timestamp: '2026-08-04T09:01:00.000Z',
  ...extra,
});

const md = chatToMarkdown({
  title: 'Приёмка боёвки',
  project: 'C:/proj/game',
  exportedAt: Date.parse('2026-08-04T10:00:00.000Z'),
  messages: [
    user('посмотри дизайн боёвки'),
    assistant('Посмотрел, вот замечания', [
      { type: 'tool_use', name: 'Read', input: { file_path: 'C:/proj/game/docs/combat.md' } },
      { type: 'tool_use', name: 'Bash', input: { description: 'запустить тесты', command: 'npm test' } },
    ]),
    // a tool result comes back as a user message with no words of its own
    { type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }] } },
    // a subagent's chatter is not this conversation
    assistant('я сабагент', [], { parent_tool_use_id: 'tool-1' }),
    // the machinery talking to itself
    user('[remaude: a service request — hidden from the chat feed]\nCome up with a name'),
    // a thread exchange keeps its mark and loses its marker line
    user('[remaude: thread abc12345 — a side thread of this chat.]\nуточню по этому месту', { chatThread: 'abc12345' }),
    assistant('отвечаю в ветке', [], { chatThread: 'abc12345' }),
    user('и картинка', { message: { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'x' } }] } }),
  ],
});

check(md.startsWith('<!-- remaude -->\n'), 'the marker is the very first line, so it lands in the inbox');
check(md.includes('# Приёмка боёвки'), 'the chat is titled');
check(md.includes('**Проект:** C:/proj/game'), 'the project is named');
// the hour is whatever the machine's timezone says, so only the shape is checked
check(/## Nidere · 04\.08\.2026, \d{2}:\d{2}/.test(md), 'a message says who and when');
check(md.includes('посмотри дизайн боёвки'), 'what was said is there');
check(md.includes('## Claude'), 'the answers are attributed');
check(md.includes('- 🔧 Read · combat.md'), 'a file that was read is named');
check(md.includes('- 🔧 Bash · запустить тесты'), 'a command is described, not dumped');
check(!md.includes('я сабагент'), "a subagent's own chatter stays out");
check(!md.includes('Come up with a name'), 'service turns stay out');
check(md.includes('· в ветке'), 'a thread message is marked as one');
check(md.includes('уточню по этому месту'), 'the thread message keeps its words');
check(!md.includes('[remaude:'), 'no machine markers survive into the document');
check(md.includes('*(изображение)*'), 'a picture leaves a trace');
check(!/\n{3,}/.test(md), 'no runs of blank lines');
check(md.includes('**Сообщений:** 5'), `the count matches what is in it (got: ${/\*\*Сообщений:\*\* \d+/.exec(md)?.[0]})`);

check(exportFileName('Приёмка: боёвки/старт', Date.parse('2026-08-04T10:00:00Z')) === '2026-08-04 Приёмка боёвки старт.md', 'the file name survives a file system');
check(exportFileName('', Date.parse('2026-08-04T10:00:00Z')) === '2026-08-04 chat.md', 'an unnamed chat still gets a name');

console.log(failed ? `EXPORT MD: ${failed} failed` : 'EXPORT MD OK');
process.exit(failed ? 1 : 0);
