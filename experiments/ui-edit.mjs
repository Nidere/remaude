// Read-only look at edit mode: what actually renders on a project row.
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
const page = await browser.newPage({ viewport: { width: 900, height: 800 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto('http://localhost:7699');
await page.waitForSelector('.project-head', { timeout: 8000 });
await page.waitForTimeout(800);

await page.click('#edit-btn');
await page.waitForTimeout(400);
const counts = await page.evaluate(() => ({
  editing: document.body.classList.contains('editing'),
  projectActions: document.querySelectorAll('.project-actions').length,
  hostActions: document.querySelectorAll('.host-actions').length,
  editActions: document.querySelectorAll('.edit-actions').length,
  visibleProjectButtons: [...document.querySelectorAll('.project-actions')].filter((n) => n.offsetParent !== null).length,
}));
console.log(JSON.stringify(counts));
await page.screenshot({ path: join(SHOTS, '8-edit.png') });

// drag the first project below the second and see whether the DOM order changes
const order = () => page.$$eval('.project[data-sort-id]', (ns) => ns.map((n) => n.dataset.sortId));
const before = await order();
const rows = await page.$$('.project[data-sort-id]');
if (rows.length >= 2) {
  const a = await rows[0].boundingBox();
  const b = await rows[1].boundingBox();
  await page.mouse.move(a.x + 40, a.y + 10);
  await page.mouse.down();
  await page.mouse.move(a.x + 40, a.y + 25, { steps: 5 });
  await page.mouse.move(b.x + 40, b.y + b.height - 4, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(300);
}
const after = await order();
console.log('before:', before.slice(0, 3).map((p) => p.split(/[\\/]/).pop()).join(', '));
console.log('after: ', after.slice(0, 3).map((p) => p.split(/[\\/]/).pop()).join(', '));
console.log(before.join() === after.join() ? 'DRAG: no change (BAD)' : 'DRAG OK');
console.log('errors:', errors.length ? errors : 'none');
await browser.close();
