// Does an evicted app repaint instantly? We open a chat, then simulate the tab
// being killed (fresh page, socket blocked) and check the transcript is still
// there — that is exactly what iOS does to a backgrounded PWA.
import { chromium } from 'playwright-core';

const browser = await chromium.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: true,
});
const ctx = await browser.newContext({ viewport: { width: 900, height: 800 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto('http://localhost:7699');
await page.waitForSelector('.chat-item', { timeout: 10_000 });
await page.click('.chat-item >> nth=0');
await page.waitForSelector('.msg', { timeout: 15_000 });
const live = await page.locator('.msg').count();
console.log('messages with a live socket:', live);

// the app is killed and relaunched with no connection at all. Going offline is
// the honest simulation: route() does not intercept WebSockets, so blocking the
// socket that way silently lets the page reconnect and the test proves nothing.
await page.waitForTimeout(500); // let the service worker cache the shell
await page.close();
await ctx.setOffline(true);
const offline = await ctx.newPage();
offline.on('pageerror', (e) => errors.push(String(e)));
await offline.goto('http://localhost:7699');
await offline.waitForTimeout(2000);
const cached = await offline.locator('.msg').count();
console.log('messages after a cold start without a socket:', cached);
console.log('errors:', errors.length ? errors : 'none');
console.log(cached > 0 ? 'CACHE OK' : 'CACHE EMPTY — nothing was restored');

await browser.close();
