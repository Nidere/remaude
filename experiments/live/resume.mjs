// Question: on resume, do the old messages arrive in the stream (replay)?
// Session A: two turns → closed it. Session B: resume A → we look at what arrives before and after a new turn.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Chat } from '../../src/host/chat.js';

const dir = mkdtempSync(join(tmpdir(), 'remaude-resume-'));

function turn(chat, text) {
  return new Promise((resolve) => {
    const onMsg = (msg) => {
      if (msg.type === 'result') {
        chat.off('message', onMsg);
        resolve();
      }
    };
    chat.on('message', onMsg);
    chat.send(text);
  });
}

// session A
const a = new Chat({ cwd: dir, model: 'haiku' });
await turn(a, 'Запомни: моё кодовое слово — багульник. Ответь "запомнил".');
await turn(a, 'Спасибо. Ответь "ок".');
const sessionId = a.sessionId;
a.close();
console.log('session A:', sessionId);
await new Promise((r) => setTimeout(r, 1500));

// session B: resume
const b = new Chat({ cwd: dir, model: 'haiku', resume: sessionId });
const replayed = [];
b.on('message', (msg) => replayed.push(`${msg.type}${msg.type === 'user' || msg.type === 'assistant' ? ':' + JSON.stringify(msg.message?.content).slice(0, 60) : ''}`));

// waiting 5 seconds without sending anything — will the replay arrive on its own?
await new Promise((r) => setTimeout(r, 5000));
console.log('arrived before the new turn:', replayed.length ? replayed.join(' | ') : '(nothing)');

replayed.length = 0;
await turn(b, 'Какое моё кодовое слово? Ответь одним словом.');
console.log('after the turn:', replayed.join(' | '));
console.log('resumed session id:', b.sessionId, b.sessionId === sessionId ? '(the same)' : '(NEW!)');
b.close();
