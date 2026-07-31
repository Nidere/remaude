// Прогон реального UI: создаём чат (model=haiku) по WS, дальше всё — кликами
// в headless Edge: выбор чата, отправка сообщения, стриминг, скриншоты.
import { chromium } from 'playwright-core';
import WebSocket from 'ws';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SHOTS = join(dirname(fileURLToPath(import.meta.url)), 'shots');
mkdirSync(SHOTS, { recursive: true });

// -- подготовка: проект + чат с дешёвой моделью через WS --
const projectDir = mkdtempSync(join(tmpdir(), 'remaude-ui-'));
await new Promise((resolve, reject) => {
  const ws = new WebSocket('ws://127.0.0.1:7699/ws');
  ws.on('open', () => {
    ws.send(JSON.stringify({ type: 'add_project', path: projectDir }));
    ws.send(JSON.stringify({ type: 'create_chat', projectPath: projectDir, model: 'haiku' }));
  });
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw);
    if (msg.type === 'chat_created') {
      ws.close();
      resolve();
    }
    if (msg.type === 'error') reject(new Error(msg.message));
  });
  setTimeout(() => reject(new Error('ws timeout')), 10_000);
});

// -- браузер --
const browser = await chromium.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const consoleErrors = [];
page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
page.on('pageerror', (e) => consoleErrors.push(String(e)));

await page.goto('http://localhost:7699');
await page.waitForSelector('.chat-item', { timeout: 10_000 });
await page.screenshot({ path: join(SHOTS, '1-start.png') });

await page.click('.chat-item >> nth=-1');
await page.fill('#input', 'Ответь ровно одной короткой фразой: интерфейс работает');
await page.press('#input', 'Enter');

await page.waitForSelector('.msg-user', { timeout: 5_000 });
console.log('user bubble: ok');
await page.waitForSelector('.msg-assistant', { timeout: 60_000 });
await page.waitForSelector('.msg-meta', { timeout: 60_000 }); // result пришёл
await page.waitForFunction(() => document.getElementById('limits').textContent.length > 0, { timeout: 30_000 });
await page.screenshot({ path: join(SHOTS, '2-reply.png') });

const assistantText = await page.textContent('.msg-assistant >> nth=-1');
const limitsText = await page.textContent('#limits');
console.log('assistant:', assistantText.trim());
console.log('limits:', limitsText.trim());
console.log('console errors:', consoleErrors.length ? consoleErrors : 'none');

await browser.close();
console.log('UI DRIVE OK');
