// The line that says who wrote a message, and what a transcript reader makes of
// it. Offline and free — run it in a loop.
import { withSenderMark, takeSenderMark, senderInText } from '../src/host/sender-mark.js';
import { threadIdInText } from '../src/host/thread-mark.js';
import { mapEntry } from '../src/host/transcripts.js';

let failed = 0;
const check = (got, want, what) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${ok ? '' : `\n     got ${JSON.stringify(got)}\n    want ${JSON.stringify(want)}`}`);
};

const GUEST = 'ostapcove@nidere.com';
const user = (content, extra = {}) => ({ type: 'user', message: { role: 'user', content }, uuid: 'u1', ...extra });
const read = (entry) => mapEntry(entry, { defaultAuthor: 'Nidere' });

// ---- the line itself ----
check(withSenderMark('здарова', GUEST), `[remaude: from ${GUEST}]\nздарова`, 'the line goes in front of the text');
check(senderInText(`[remaude: from ${GUEST}]\nздарова`), GUEST, 'and is read back off it');
check(senderInText('здарова'), null, 'an unsigned message names nobody');
// a bracket or a newline in the address would end the line early or start a second one
check(senderInText(withSenderMark('текст', 'a]b\nc@d.e')), 'abc@d.e', 'nothing in the address can break the line');

// ---- blocks, which is how an image with a caption arrives ----
const blocks = withSenderMark([{ type: 'image', source: {} }, { type: 'text', text: 'вот' }], GUEST);
check(blocks[1].text, `[remaude: from ${GUEST}]\nвот`, 'in blocks it goes in front of the first text');
check(blocks[0].type, 'image', 'and the picture is left alone');
check(takeSenderMark(blocks).email, GUEST, 'the sender is read back out of blocks');
check(takeSenderMark(blocks).content[1].text, 'вот', 'and the block comes back clean');
check(takeSenderMark([{ type: 'image', source: {} }]).email, null, 'a message with no text at all names nobody');

// ---- what the feed is given ----
const theirs = read(user(withSenderMark('здарова', GUEST)));
check(theirs.message.content, 'здарова', 'the feed never sees the line');
check([theirs.author, theirs.authorId], ['ostapcove', GUEST], 'the message is signed by whoever wrote it');

const ours = read(user('привет'));
check(ours.message.content, 'привет', 'an unsigned message is untouched');
check([ours.author, ours.authorId], ['Nidere', '@owner'], "and belongs to the machine's owner");

// a tool result is not a person talking, and is signed by nobody
const result = read(user([{ type: 'tool_result', content: 'ok' }]));
check([result.author, result.authorId], [undefined, undefined], 'tool traffic is signed by nobody');

// ---- the two lines together: a guest writing into a thread ----
const inThread = withSenderMark('[remaude: thread abcdef01 — a side thread]\nда, давай', GUEST);
check(senderInText(inThread), GUEST, 'who is speaking comes first');
check(threadIdInText(inThread), 'abcdef01', 'and the thread is still found behind it');
check(threadIdInText('[remaude: thread abcdef01 — a side thread]\nда'), 'abcdef01', 'an unsigned thread message too');

console.log(failed ? `\n${failed} FAILED` : '\nOK');
process.exit(failed ? 1 : 0);
