// What the transcript reader lets into the feed. CLI slash commands write their
// bookkeeping into the transcript as user messages — the tail used to push them
// into the chat as raw <command-name> XML under the owner's name.
import { mapEntry, isCliCommandNoise } from '../src/host/transcripts.js';

let failed = 0;
const check = (got, want, name) => {
  if (got !== want) {
    console.error(`FAIL ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
    failed++;
  }
};

const user = (content) => ({ type: 'user', message: { role: 'user', content }, uuid: 'u1' });

// the /model command as Claude Code writes it
check(
  mapEntry(user('<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>fable</command-args>')),
  null,
  'a slash command stays out of the feed'
);
check(mapEntry(user('<local-command-stdout>Set model to fable</local-command-stdout>')), null, 'its stdout too');
check(mapEntry(user([{ type: 'text', text: '<command-name>/clear</command-name>' }])), null, 'block-shaped content too');

// while real conversation passes
check(mapEntry(user('обычное сообщение'))?.type, 'user', 'a real message passes');
check(mapEntry(user('в тексте упоминается <command-name> посреди строки'))?.type, 'user', 'a mention mid-text is not a command');
check(isCliCommandNoise('  <command-name>/x</command-name>'), true, 'leading whitespace does not disguise it');

console.log(failed ? `TRANSCRIPT FILTER: ${failed} failed` : 'TRANSCRIPT FILTER OK');
process.exit(failed ? 1 : 0);
