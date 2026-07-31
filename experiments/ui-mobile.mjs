// Read-only проверка адаптива: мобильный вьюпорт, открытие сайдбара, десктоп.
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

const errors = [];

// мобильный
const mob = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
mob.on('pageerror', (e) => errors.push('mobile: ' + e));
await mob.goto('http://localhost:7699');
await mob.waitForSelector('#menu-btn');
await mob.waitForTimeout(800);
const overflow = await mob.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
console.log('horizontal overflow px:', overflow, overflow > 0 ? 'BAD' : 'OK');
await mob.screenshot({ path: join(SHOTS, '5-mobile.png') });
await mob.click('#menu-btn');
await mob.waitForTimeout(400);
await mob.screenshot({ path: join(SHOTS, '6-mobile-sidebar.png') });

// десктоп
const desk = await browser.newPage({ viewport: { width: 1280, height: 800 } });
desk.on('pageerror', (e) => errors.push('desktop: ' + e));
await desk.goto('http://localhost:7699');
await desk.waitForSelector('.project-head', { timeout: 8000 });
await desk.waitForTimeout(800);
await desk.screenshot({ path: join(SHOTS, '7-desktop.png') });

console.log('errors:', errors.length ? errors : 'none');
await browser.close();
console.log('MOBILE OK');
