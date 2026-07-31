// A check of the project picker modal: click on 📁 → list of the root's subfolders → screenshot.
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SHOTS = join(dirname(fileURLToPath(import.meta.url)), 'shots');
mkdirSync(SHOTS, { recursive: true });

const browser = await chromium.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto('http://localhost:7699');
await page.waitForSelector('#pick-project');
await page.click('#pick-project');
await page.waitForSelector('.picker-item', { timeout: 5000 });
await page.screenshot({ path: join(SHOTS, '3-picker.png') });

const root = await page.textContent('#picker-root');
const items = await page.$$eval('.picker-item', (els) => els.map((e) => e.textContent));
console.log('root:', root);
console.log('folders:', items.join(', '));
console.log('errors:', errors.length ? errors : 'none');

await page.click('#picker-cancel');
await page.waitForSelector('#picker', { state: 'hidden' });
console.log('cancel: ok');

await browser.close();
console.log('PICKER OK');
