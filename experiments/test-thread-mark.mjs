// The line a thread message carries. It has to survive being read back — the
// answer is routed by it — and it has to be safe to put a quote inside.
import { threadMark, threadIdInText } from '../src/host/thread-mark.js';
import { readFileSync } from 'node:fs';

let failed = 0;
const check = (cond, name) => {
  if (!cond) {
    console.error('FAIL:', name);
    failed++;
  }
};

const ID = '8865dca2-e939-47ac-9bc6-f22af338f71d';

// without a quote — the shape it had before
const bare = threadMark(ID);
check(threadIdInText(bare) === ID, 'a bare mark still names its thread');
check(!bare.includes('\n'), 'a mark is one line');

// with a quote: the answer needs to know what the thread is about
const marked = threadMark(ID, 'Токены уже под контролем — там жёсткий кэп, а вот время — нет. Разбор и предложение:');
check(threadIdInText(marked) === ID, 'a mark with a quote still names its thread');
check(marked.includes('Токены уже под контролем'), 'the quote is in it');
check(!marked.includes('\n'), 'still one line');

// a quote that would break the line is defused, not passed through
const nasty = threadMark(ID, 'смотри [ссылку] и\nвторую строку ' + 'x'.repeat(400));
check(threadIdInText(nasty) === ID, 'a mark survives an awkward quote');
check(!nasty.includes('\n'), 'line breaks in the quote are flattened');
check(!nasty.includes('[ссылку]'), 'brackets are removed, or the line would end early');
check(nasty.length < 400, `the quote is cut short (got ${nasty.length})`);

// a message that is not from a thread says so
check(threadIdInText('обычное сообщение') === null, 'an ordinary message belongs to no thread');
check(threadIdInText('  ' + marked + '\nтекст') === ID, 'leading whitespace does not hide it');

// what the reader sees: both places that strip the line must take all of it,
// quote included — they used to stop at the first bracket
const shown = (text, re) => text.replace(re, '');
const clientRe = /^\[remaude: thread [^\n]*\n?/i;
const exportRe = /^\[remaude:[^\n]*\n?/i;
const message = marked + '\n1. да, давай так';
check(shown(message, clientRe) === '1. да, давай так', 'the thread panel shows only what was written');
check(shown(message, exportRe) === '1. да, давай так', 'and so does an exported chat');

// the regexes above are the ones actually in use
const threadsJs = readFileSync(new URL('../src/web/threads.js', import.meta.url), 'utf-8');
const exportJs = readFileSync(new URL('../src/host/export-md.js', import.meta.url), 'utf-8');
check(threadsJs.includes(String(clientRe)), 'the thread panel uses this very expression');
check(exportJs.includes(String(exportRe)), 'the export uses this very expression');

console.log(failed ? `THREAD MARK: ${failed} failed` : 'THREAD MARK OK');
process.exit(failed ? 1 : 0);
