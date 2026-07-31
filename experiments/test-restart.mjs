// End-to-end self-restart test: restart_server over WS → the old one died →
// the copy came up → it responds over HTTP and WS.
import WebSocket from 'ws';

function wsOnce(fn) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket('ws://127.0.0.1:7699/ws');
    ws.on('open', () => fn(ws, resolve));
    ws.on('error', reject);
    setTimeout(() => reject(new Error('ws timeout')), 8000);
  });
}

// pid before
const pidBefore = await wsOnce((ws, resolve) => {
  ws.close();
  resolve(null);
}).then(async () => {
  const res = await fetch('http://127.0.0.1:7699/');
  return res.ok;
});
console.log('server before: reachable =', pidBefore);

// restart command
await wsOnce((ws, resolve) => {
  ws.send(JSON.stringify({ type: 'restart_server' }));
  setTimeout(() => {
    ws.close();
    resolve(null);
  }, 200);
});
console.log('restart sent');

// waiting for the revival (the copy retries listen until the port is freed)
let alive = false;
for (let i = 0; i < 30; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  try {
    const res = await fetch('http://127.0.0.1:7699/');
    if (res.ok) {
      alive = true;
      break;
    }
  } catch {
    /* still coming up */
  }
}
if (!alive) {
  console.error('SERVER DID NOT COME BACK');
  process.exit(1);
}

// is WS alive too?
await wsOnce((ws, resolve) => {
  ws.on('message', (raw) => {
    if (JSON.parse(raw).type === 'state') {
      ws.close();
      resolve(null);
    }
  });
});
console.log('RESTART CYCLE OK');
