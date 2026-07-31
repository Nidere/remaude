// Minimal case: port 7699 cannot be taken (it is already occupied by server A).
// Question: does on('error') catch the retry when a WebSocketServer is attached.
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';

const srv = createServer();
const WITH_WSS = process.argv[2] === 'wss';
if (WITH_WSS) new WebSocketServer({ server: srv, path: '/ws' });

let attempts = 0;
srv.on('error', (e) => {
  console.log(`error handler: ${e.code}, attempt ${attempts}`);
  if (e.code === 'EADDRINUSE' && attempts < 3) {
    attempts++;
    setTimeout(() => srv.listen(7699, '127.0.0.1'), 300);
  } else {
    process.exit(1);
  }
});
process.on('uncaughtException', (e) => {
  console.log('UNCAUGHT:', e.code ?? e.message);
  process.exit(2);
});
srv.listen(7699, '127.0.0.1', () => console.log('bound (unexpected)'));
setTimeout(() => {
  console.log('done retrying, exiting clean');
  process.exit(0);
}, 2000);
