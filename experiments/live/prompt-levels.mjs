// Do the host and project levels of the system prompt actually reach the model,
// and does an edited one reach a chat that was already going?
//
// The second half is the claim the settings popup makes to the user ("reaches a
// chat the next time it starts"), and it only holds because the prompt is read
// in #spawn rather than captured in the constructor. That is easy to undo by
// accident, so it is worth a probe.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Chat } from '../../src/host/chat.js';

// two words nothing else would say, so finding them proves where they came from
let hostWord = 'PERIWINKLE';
const projectWord = 'ZEPPELIN';

const chat = new Chat({
  cwd: mkdtempSync(join(tmpdir(), 'remaude-prompt-')),
  model: 'haiku',
  permissionMode: 'bypassPermissions',
  extraPrompt: () =>
    `## This machine\n\nThe host word is ${hostWord}.\n\n## This project\n\nThe project word is ${projectWord}.`,
  onPermissionRequest: async ({ input }) => ({ behavior: 'allow', updatedInput: input }),
});

function ask(text) {
  return new Promise((done) => {
    let out = '';
    const onMsg = (msg) => {
      if (msg.type === 'assistant')
        for (const b of msg.message.content ?? []) if (b.type === 'text') out += b.text;
      if (msg.type === 'result') {
        chat.off('message', onMsg);
        done(out);
      }
    };
    chat.on('message', onMsg);
    chat.send(text);
  });
}

const timer = setTimeout(() => {
  console.log('TIMEOUT 120s');
  chat.close();
  process.exit(1);
}, 120_000);

const first = await ask('Reply with the host word and the project word, nothing else.');
console.log(`[1] ${first.trim()}`);
const gotHost = first.includes(hostWord);
const gotProject = first.includes(projectWord);
console.log(`host level: ${gotHost ? 'reached the model' : 'MISSING'}`);
console.log(`project level: ${gotProject ? 'reached the model' : 'MISSING'}`);

// now edit the host level under a sleeping chat, exactly as the settings popup does
hostWord = 'MARMALADE';
chat.sleep();
const second = await ask('Reply with the host word, nothing else.');
console.log(`[2] ${second.trim()}`);
const picked = second.includes('MARMALADE');
console.log(`edited text after a sleep: ${picked ? 'picked up' : 'STILL THE OLD ONE'}`);

clearTimeout(timer);
chat.close();
console.log(gotHost && gotProject && picked ? '\nOK' : '\nFAILED');
process.exit(gotHost && gotProject && picked ? 0 : 1);
