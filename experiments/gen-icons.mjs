// Генерация PNG-иконок PWA из SVG через headless Chrome.
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'web', 'icons');
mkdirSync(OUT, { recursive: true });

const svg = (size) => `
<div id="icon" style="width:${size}px;height:${size}px;background:#14151a;display:flex;align-items:center;justify-content:center;border-radius:${size * 0.18}px">
  <svg width="${size * 0.62}" height="${size * 0.62}" viewBox="0 0 100 100">
    <path d="M14 22 h72 a8 8 0 0 1 8 8 v38 a8 8 0 0 1 -8 8 h-44 l-16 14 v-14 h-12 a8 8 0 0 1 -8 -8 v-38 a8 8 0 0 1 8 -8 z"
      fill="#7aa2f7"/>
    <circle cx="32" cy="49" r="6" fill="#14151a"/>
    <circle cx="50" cy="49" r="6" fill="#14151a"/>
    <circle cx="68" cy="49" r="6" fill="#14151a"/>
  </svg>
</div>`;

const browser = await chromium.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 600, height: 600 } });
for (const size of [192, 512]) {
  await page.setContent(`<body style="margin:0;background:transparent">${svg(size)}</body>`);
  const el = await page.$('#icon');
  await el.screenshot({ path: join(OUT, `icon-${size}.png`), omitBackground: true });
  console.log(`icon-${size}.png`);
}
await browser.close();
console.log('ICONS OK');
