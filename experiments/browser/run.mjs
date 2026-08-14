// Browser repro of the comment popover flow. Serves src/web + the test page,
// drives Chrome through the full select→comment→thread cycle, reports errors.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from '../../node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js';

const WEB = fileURLToPath(new URL('../../src/web/', import.meta.url));
const HERE = dirname(fileURLToPath(import.meta.url));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

const server = createServer(async (req, res) => {
  const path = req.url === '/' ? '/test-comments.html' : req.url.split('?')[0];
  for (const root of [HERE, WEB]) {
    try {
      const data = await readFile(join(root, path));
      res.writeHead(200, { 'content-type': MIME[extname(path)] ?? 'text/plain' }).end(data);
      return;
    } catch {
      /* try the next root */
    }
  }
  res.writeHead(404).end('nope');
});
await new Promise((r) => server.listen(7788, '127.0.0.1', r));

const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--no-first-run', '--disable-extensions'],
});
const page = await browser.newPage();
const problems = [];
page.on('console', (m) => {
  // resource 404s (favicon) are noise; JS errors are not
  if (m.type() === 'error' && !m.text().includes('Failed to load resource')) problems.push('console.error: ' + m.text());
});
page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
page.on('dialog', async (d) => {
  problems.push(`DIALOG (${d.type()}): ${d.message()}`);
  await d.dismiss();
});

const fail = async (why) => {
  console.error('FAIL:', why);
  for (const p of problems) console.error(' ', p);
  await browser.close();
  server.close();
  process.exit(1);
};
const ok = (name) => console.log('ok:', name);

await page.goto('http://127.0.0.1:7788/', { waitUntil: 'networkidle0' });
await page.waitForFunction('window.ready === true', { timeout: 5000 }).catch(() => fail('page never became ready'));

// 1. select text -> the floating button must appear
await page.evaluate(`window.selectInDoc('brave new world')`);
await page.waitForFunction(`!document.getElementById('cmt-add').hidden`, { timeout: 6000 }).catch(() => fail('cmt-add never appeared after selection'));
ok('add button appears on selection');

// 1a. the awkward selections: across two blocks, and inside a table cell. Their
// endpoints land on elements rather than text, and that is where anchoring by
// offsets gives up — the button must still work.
for (const [how, expect] of [
  ['selectAcrossBlocks', 'brave new world'],
  ['selectInTable', 'ИНН'],
]) {
  await page.evaluate(`window.${how}()`);
  await page.waitForFunction(`!document.getElementById('cmt-add').hidden`, { timeout: 6000 }).catch(() => fail(`no comment button after ${how}`));
  await page.click('#cmt-add');
  await page.waitForFunction(`getComputedStyle(document.getElementById('cmt-pop')).display !== 'none'`, { timeout: 6000 }).catch(() => fail(`BUG: ${how} — the comment button did nothing`));
  const quote = await page.evaluate(`document.querySelector('#cmt-pop .cmt-quote')?.textContent ?? ''`);
  if (!quote.includes(expect)) await fail(`${how} quoted the wrong thing: "${quote}"`);

  // and the comment it makes must find its place in the text, not sit there
  // orphaned: a quote taken across blocks carries line breaks the document does
  // not have, and an exact search never finds it again
  const before = await page.evaluate(`document.querySelectorAll('mark.doc-hl').length`);
  await page.type('#cmt-pop textarea', `коммент к ${how}`);
  await page.evaluate(String.raw`document.querySelector('#cmt-pop .cmt-primary').click()`);
  await page.waitForFunction(`document.querySelectorAll('mark.doc-hl').length > ${before}`, { timeout: 3000 }).catch(() =>
    fail(`BUG: the comment from ${how} left no highlight in the text`)
  );
  const orphaned = await page.evaluate(`Boolean(document.querySelector('.cmt-orphan'))`);
  if (orphaned) await fail(`${how}: the thread thinks its fragment is gone while it is right there`);
  ok(`an awkward selection still comments, and the text shows it (${how})`);
}
await page.evaluate(`window.selectInDoc('brave new world')`);
await page.waitForFunction(`!document.getElementById('cmt-add').hidden`, { timeout: 6000 }).catch(() => fail('the button did not come back'));

// 1b. some browsers drop the selection the moment the button is pressed — the
// fragment must already be remembered by then, or pressing it does nothing
await page.evaluate(`getSelection().removeAllRanges()`);
await page.click('#cmt-add');
await page.waitForFunction(`getComputedStyle(document.getElementById('cmt-pop')).display !== 'none'`, { timeout: 6000 }).catch(() => fail('BUG: with the selection already gone, the comment button did nothing'));
const quoted = await page.evaluate(`document.querySelector('#cmt-pop .cmt-quote')?.textContent ?? ''`);
if (!quoted.includes('brave new world')) await fail(`the remembered fragment was wrong: "${quoted}"`);
await page.evaluate(`document.querySelector('#cmt-pop .cmt-head-actions button:last-child').click()`);
await new Promise((r) => setTimeout(r, 100));
ok('a lost selection does not lose the fragment');

// 2. click it -> draft popover with textarea
await page.evaluate(`window.selectInDoc('brave new world')`);
await page.waitForFunction(`!document.getElementById('cmt-add').hidden`, { timeout: 6000 }).catch(() => fail('the button did not come back'));
await page.click('#cmt-add');
await page.waitForFunction(`!document.getElementById('cmt-pop').hidden`, { timeout: 6000 }).catch(() => fail('draft popover did not open'));
ok('draft popover opens');

// 3. type and submit
const popGone = `getComputedStyle(document.getElementById('cmt-pop')).display === 'none'`;
await page.type('#cmt-pop textarea', 'первый тестовый коммент');
await page.evaluate(String.raw`document.querySelector('#cmt-pop .cmt-primary').click()`);
await page.waitForFunction(popGone, { timeout: 6000 }).catch(() => fail('popover still VISIBLE after submitting the comment'));
await page.waitForFunction(`document.querySelectorAll('mark.doc-hl').length > 0`, { timeout: 6000 }).catch(() => fail('highlight never rendered after add_comment'));
ok('comment submits, popover closes, highlight renders');

// 4. click the highlight -> thread popover with the reply
// the newest thread is the one just made; several documents' worth of
// highlights are on screen by now
await page.evaluate(`[...document.querySelectorAll('mark.doc-hl')].pop().click()`);
await page.waitForFunction(
  `!document.getElementById('cmt-pop').hidden && document.querySelectorAll('#cmt-pop .cmt-reply').length === 1`,
  { timeout: 6000 }
).catch(() => fail('thread popover did not open on highlight click'));
ok('thread popover opens from highlight');

// 5. reply in the thread
await page.type('#cmt-pop textarea', 'ответ в тред');
await page.evaluate(String.raw`document.querySelector('#cmt-pop .cmt-primary').click()`);
await page.waitForFunction(`document.querySelectorAll('#cmt-pop .cmt-reply').length === 2`, { timeout: 6000 }).catch(() => fail('reply did not appear in the open popover'));
ok('reply lands in the open thread');

// the popover must stay pinned near its highlight, not fly to the corner
const drift = await page.evaluate(`(() => {
  const pop = document.getElementById('cmt-pop').getBoundingClientRect();
  const mark = [...document.querySelectorAll('mark.doc-hl')].pop().getBoundingClientRect();
  return { pop: { top: pop.top, left: pop.left }, dist: Math.abs(pop.top - mark.bottom) + Math.abs(pop.left - mark.left) };
})()`);
if (drift.pop.top < 40 && drift.pop.left < 40) await fail(`BUG: popover flew to the corner (${JSON.stringify(drift.pop)})`);
if (drift.dist > 400) await fail(`BUG: popover drifted far from its highlight (${JSON.stringify(drift)})`);
ok('popover stays pinned after a reply');

// 5b. Ask Claude must NOT close the popover (its click re-renders the popover
// under itself — the outside-click handler used to read that as "outside")
await page.evaluate(String.raw`document.querySelector('#cmt-pop .cmt-llm').click()`);
await new Promise((r) => setTimeout(r, 60));
const popAliveAfterAsk = await page.evaluate(`getComputedStyle(document.getElementById('cmt-pop')).display !== 'none'`);
if (!popAliveAfterAsk) await fail('BUG: Ask Claude closed the thread popover');
await page.waitForFunction(`document.querySelectorAll('#cmt-pop .cmt-reply.llm:not(.pending)').length === 1`, { timeout: 6000 }).catch(() => fail('the LLM reply never appeared in the open popover'));
ok('Ask Claude keeps the popover open, reply arrives');

// a reply arriving into the OPEN thread must be auto-marked as read
await page.waitForFunction(`window.log.includes('mark_thread_seen')`, { timeout: 6000 }).catch(() => fail('BUG: a reply into the open thread was not auto-marked as seen'));
ok('reply into an open thread is read on arrival');

// the unread dot on a document row survives any name truncation (it lives on the icon)
await page.evaluate(`window.dc.onBadge({ total: 1, perDoc: { 'C:\\\\fake\\\\test.md': 1 } })`);
const rowDotVisible = await page.evaluate(`(() => {
  const row = document.querySelector('.att-doc');
  if (!row.classList.contains('has-unseen')) return false;
  const s = getComputedStyle(row.querySelector('.att-ext'), '::after');
  return s.content !== 'none' && parseFloat(s.width) > 0;
})()`);
if (!rowDotVisible) await fail('BUG: unread dot on the doc row is missing or invisible');
ok('doc row dot is actually visible');

// 5c. resolve the thread, then open it back from the 💬 list
const marksBeforeResolve = await page.evaluate(`document.querySelectorAll('mark.doc-hl').length`);
await page.evaluate(`[...document.querySelectorAll('#cmt-pop .cmt-head-actions button')].find((b) => b.textContent.includes('Resolve'))?.click()`);
await page.waitForFunction(`document.querySelectorAll('mark.doc-hl').length === ${marksBeforeResolve - 1}`, { timeout: 6000 }).catch(() => fail('resolving did not clear its highlight'));
await page.evaluate(`document.getElementById('cmt-pop').hidden = true`); // start from a closed popover, like the user
await page.click('#doc-threads');
await page.waitForFunction(`!document.getElementById('cmt-list').hidden`, { timeout: 6000 }).catch(() => fail('threads list did not open'));
await page.evaluate(`document.querySelector('#cmt-list .cmt-list-item.resolved').click()`);
await new Promise((r) => setTimeout(r, 60));
const resolvedOpens = await page.evaluate(`getComputedStyle(document.getElementById('cmt-pop')).display !== 'none' && document.querySelectorAll('#cmt-pop .cmt-reply').length >= 2`);
if (!resolvedOpens) await fail('BUG: a resolved thread does not open from the list');
ok('resolved thread opens from the list');

// put it back to unresolved state context for the close test
await page.evaluate(`[...document.querySelectorAll('#cmt-pop .cmt-head-actions button')].find((b) => b.textContent.includes('Reopen'))?.click()`);
await new Promise((r) => setTimeout(r, 100));

// 6. close the document -> the popover must not survive it
await page.click('#doc-close');
await page.waitForFunction(`document.getElementById('doc-viewer').hidden`, { timeout: 6000 }).catch(() => fail('doc viewer did not close'));
await page.waitForFunction(popGone, { timeout: 6000 }).catch(() => fail('BUG: the popover stayed VISIBLE after the document was closed'));
ok('closing the document closes the popover (visibly)');

// 7. reopen the doc the way the app does and make sure the UI is still alive
await page.evaluate(`document.getElementById('doc-viewer').hidden = false; window.dc.docOpened('C:\\\\fake\\\\test.md', document.getElementById('doc-body').innerHTML)`);
await new Promise((r) => setTimeout(r, 300)); // let the fake server's comments land and re-render
await page.evaluate(`window.selectInDoc('second paragraph')`);
await page.waitForFunction(`!document.getElementById('cmt-add').hidden`, { timeout: 6000 }).catch(() => fail('UI dead after close/reopen cycle'));
ok('UI alive after the full cycle');

if (problems.length) await fail('errors were collected along the way');
console.log('REPRO ALL OK');
await browser.close();
server.close();
