// Transcript search e2e: ask the host for a phrase that exists in this very
// project's history, then ask for the next page.
import WebSocket from 'ws';

const query = process.argv[2] ?? 'багульник';
const ws = new WebSocket('ws://127.0.0.1:7699/ws');
let pages = 0;

const done = new Promise((resolve, reject) => {
  setTimeout(() => reject(new Error('timeout')), 60_000);
  ws.on('open', () => ws.send(JSON.stringify({ type: 'search', query })));
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.type !== 'search_results') return;
    pages++;
    console.log(`[page ${pages}] ${m.results.length} hits, scanned ${m.scanned}/${m.total}, more: ${m.hasMore}`);
    for (const r of m.results)
      console.log(`   · ${(r.title ?? r.sessionId).slice(0, 50)} — ${r.matches} matches — ${(r.snippet ?? '').slice(0, 80)}`);
    if (pages === 1 && m.hasMore) ws.send(JSON.stringify({ type: 'search', query, more: true }));
    else resolve(m);
  });
  ws.on('error', reject);
});

const last = await done;
ws.close();
console.log(last.results.length || pages > 1 ? 'SEARCH OK' : 'SEARCH: no hits');
