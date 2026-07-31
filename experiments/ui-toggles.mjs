// Read-only check of the segmented toggles in the attachments panel: they must
// switch state on click and report the value the panel then queries with.
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
const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto('http://localhost:7699');
await page.waitForSelector('.chat-item', { timeout: 8000 });
await page.click('.chat-item');
await page.waitForTimeout(600);
await page.click('#att-btn');
await page.waitForSelector('#attachments-panel:not([hidden])');
await page.waitForTimeout(800);

const active = () => page.evaluate(() => ({
  scope: document.querySelector('#att-scope .active')?.dataset.value,
  filter: document.querySelector('#att-filter .active')?.dataset.value,
}));
console.log('initial:', JSON.stringify(await active()));
await page.click('#att-filter button[data-value="mine"]');
await page.waitForTimeout(200);
console.log('after filter click:', JSON.stringify(await active()));
await page.screenshot({ path: join(SHOTS, '9-toggles.png') });

await page.click('.att-tab[data-tab="docs"]');
await page.waitForTimeout(200);
const filterHidden = await page.$eval('#att-filter', (n) => n.hidden);
console.log('filter hidden on docs tab:', filterHidden);
console.log('errors:', errors.length ? errors : 'none');
await browser.close();
