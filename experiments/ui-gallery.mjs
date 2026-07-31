// The gallery must not ship full-size pictures with the grid: the payload
// carries metadata, each cell fetches its own image as it scrolls in and keeps
// only a thumbnail, and the viewer zooms instead of closing on a tap.
// Runs against its own throwaway host so nothing depends on the live one.
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { makeTestPng } from './png.mjs';

const PORT = 7793;
const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const SHOTS = join(repo, 'experiments', 'shots');
mkdirSync(SHOTS, { recursive: true });

// a project whose transcript holds a few pictures
const projectDir = mkdtempSync(join(tmpdir(), 'remaude-gal-'));
const sessionId = randomUUID();
const sessionsDir = join(homedir(), '.claude', 'projects', projectDir.replace(/[^a-zA-Z0-9-]/g, '-'));
mkdirSync(sessionsDir, { recursive: true });

const png = makeTestPng(512).toString('base64');
const lines = [
  JSON.stringify({
    type: 'user',
    message: { role: 'user', content: 'gallery test' },
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
  }),
];
for (let i = 0; i < 6; i++)
  lines.push(
    JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } }],
      },
      uuid: randomUUID(),
      timestamp: new Date().toISOString(),
    })
  );
writeFileSync(join(sessionsDir, `${sessionId}.jsonl`), lines.join('\n') + '\n');

const cfgDir = mkdtempSync(join(tmpdir(), 'remaude-galcfg-'));
const config = join(cfgDir, 'host.json');
writeFileSync(
  config,
  JSON.stringify({ projects: [projectDir], openChats: [{ projectPath: projectDir, sessionId, title: 'gallery' }] })
);

const host = spawn(process.execPath, [join(repo, 'src', 'host', 'server.js')], {
  cwd: repo,
  env: { ...process.env, REMAUDE_PORT: String(PORT), REMAUDE_CONFIG: config },
  stdio: 'ignore',
});
await new Promise((r) => setTimeout(r, 3500));

const browser = await chromium.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1000, height: 820 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.addInitScript(() => {
  window.__att = null;
  const OrigWS = window.WebSocket;
  window.WebSocket = class extends OrigWS {
    constructor(...args) {
      super(...args);
      this.addEventListener('message', (e) => {
        try {
          const m = JSON.parse(e.data);
          if (m.type === 'attachments') window.__att = { images: m.images.length, bytes: e.data.length };
        } catch {}
      });
    }
  };
});

await page.goto(`http://localhost:${PORT}`);
await page.waitForSelector('.chat-item', { timeout: 10000 });
await page.click('.chat-item');
await page.waitForTimeout(800);
await page.click('#att-btn');
await page.waitForSelector('.att-cell', { timeout: 8000 });
await page.waitForTimeout(2000);

const att = await page.evaluate(() => window.__att);
const cells = await page.$$eval('.att-cell', (ns) => ns.length);
const filled = await page.$$eval('.att-cell img', (ns) => ns.length);
console.log(`grid payload: ${att?.images} images in ${Math.round((att?.bytes ?? 0) / 1024)} KB`);
console.log(`cells: ${cells}, thumbnails loaded: ${filled}`);
await page.screenshot({ path: join(SHOTS, '10-gallery.png') });

await page.click('.att-cell');
await page.waitForSelector('#lightbox:not([hidden])');
await page.waitForTimeout(1200);
await page.evaluate(() => document.querySelector('#lightbox img').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
await page.waitForTimeout(300);
const zoomed = await page.$eval('#lightbox img', (n) => n.style.transform);
const stillOpen = await page.$eval('#lightbox', (n) => !n.hidden);
console.log(`after double tap: transform="${zoomed}", viewer still open: ${stillOpen}`);

console.log('errors:', errors.length ? errors : 'none');
const ok = att && att.bytes < 50_000 && filled === cells && zoomed.includes('scale(2.5)') && stillOpen;
console.log(ok ? 'GALLERY OK' : 'GALLERY PROBLEM');
await browser.close();
process.exitCode = ok ? 0 : 1;
host.kill();
