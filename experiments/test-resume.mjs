// Вопрос: при resume приходят ли старые сообщения в поток (replay)?
// Сессия A: два хода → закрыли. Сессия B: resume A → смотрим, что придёт до и после нового хода.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Chat } from '../src/host/chat.js';

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

// сессия A
const a = new Chat({ cwd: dir, model: 'haiku' });
await turn(a, 'Запомни: моё кодовое слово — багульник. Ответь "запомнил".');
await turn(a, 'Спасибо. Ответь "ок".');
const sessionId = a.sessionId;
a.close();
console.log('session A:', sessionId);
await new Promise((r) => setTimeout(r, 1500));

// сессия B: resume
const b = new Chat({ cwd: dir, model: 'haiku', resume: sessionId });
const replayed = [];
b.on('message', (msg) => replayed.push(`${msg.type}${msg.type === 'user' || msg.type === 'assistant' ? ':' + JSON.stringify(msg.message?.content).slice(0, 60) : ''}`));

// ждём 5 секунд без отправки — придёт ли replay сам?
await new Promise((r) => setTimeout(r, 5000));
console.log('до нового хода пришло:', replayed.length ? replayed.join(' | ') : '(ничего)');

replayed.length = 0;
await turn(b, 'Какое моё кодовое слово? Ответь одним словом.');
console.log('после хода:', replayed.join(' | '));
console.log('resumed session id:', b.sessionId, b.sessionId === sessionId ? '(тот же)' : '(НОВЫЙ!)');
b.close();
