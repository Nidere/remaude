// Read-only взгляд на живой UI: скриншот + консольные ошибки. Ничего не мутирует.
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
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto('http://localhost:7699');
await page.waitForSelector('.project-head', { timeout: 8000 });
await page.waitForTimeout(1200); // история/лимиты
await page.screenshot({ path: join(SHOTS, '4-look.png') });
console.log('errors:', errors.length ? errors : 'none');
await browser.close();
console.log('LOOK OK');
