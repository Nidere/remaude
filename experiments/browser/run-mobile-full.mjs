// A phone-sized pass over everything added lately: the project explorer, the
// document viewer, inline comments as a bottom sheet, the title button and the
// inbox button. The real app, a fake host, and taps checked with
// elementFromPoint — a button that something else covers is not a button.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from '../../node_modules/ws/wrapper.mjs';
import puppeteer from '../../node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js';

const WEB = fileURLToPath(new URL('../../src/web/', import.meta.url));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.webmanifest': 'application/json' };
const CHAT = 'chat-1';
const PROJ = 'C:\\fake\\proj';
const DOC = PROJ + '\\docs\\spec.md';
const MD =
  '# Spec\n\nthe design lives here, next to the code\n\nsecond paragraph for good measure\n\n' +
  '| Термин | Перевод | Что это на практике, довольно длинная колонка |\n|---|---|---|\n' +
  '| **NIF** | ИНН | Твой номер налогоплательщика в этой стране |\n| IVA | НДС | Ставка 23% |\n\n' +
  'см. [Действия героя](#действия-героя) и [соседний док](./heroes.md)\n\n' +
  Array.from({ length: 40 }, (_, i) => `наполнитель ${i}`).join('\n\n') +
  '\n\n## Действия героя\n\nтекст про действия\n';
const HEROES = '# Герои\n\nсписок героев проекта\n';

const server = createServer(async (req, res) => {
  const path = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  try {
    res.writeHead(200, { 'content-type': MIME[extname(path)] ?? 'text/plain' }).end(await readFile(join(WEB, path)));
  } catch {
    res.writeHead(404).end('nope');
  }
});

const threads = [];
const seen = {};
let added = null; // path handed to add_artifact
let removed = null; // …and to remove_artifact
let exportDoc = null; // when set, the host answers document requests with this
const reads = []; // every read_artifact, to tell opening from downloading

const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (ws) => {
  const say = (o) => ws.send(JSON.stringify(o));
  const comments = () => say({ type: 'comments', path: DOC, threads, seen, me: '@owner' });
  say({
    type: 'state',
    projects: [
      {
        path: PROJ,
        name: null,
        chats: [{ id: CHAT, sessionId: 'a4b2c1d0-1111-2222-3333-444455556666', status: 'idle', title: 'тестовый чат', model: 'opus', permissionMode: 'bypassPermissions' }],
      },
    ],
  });
  say({ type: 'comments_badge', total: 0, perDoc: {} });

  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.type === 'history') say({ type: 'history', chatId: m.chatId, messages: [] });
    if (m.type === 'list_dir') {
      const at = m.path ?? PROJ;
      const entries =
        at === PROJ
          ? [
              { name: 'docs', path: PROJ + '\\docs', dir: true, size: null, mtime: 1 },
              { name: 'README.md', path: PROJ + '\\README.md', dir: false, size: 2048, mtime: 2 },
              { name: 'logo.png', path: PROJ + '\\logo.png', dir: false, size: 90210, mtime: 3 },
              { name: 'a-rather-long-file-name-that-should-be-clipped.txt', path: PROJ + '\\long.txt', dir: false, size: 12, mtime: 4 },
            ]
          : [{ name: 'spec.md', path: DOC, dir: false, size: MD.length, mtime: 5 }];
      say({ type: 'dir_listing', projectPath: PROJ, path: at, parent: at === PROJ ? null : PROJ, entries });
    }
    if (m.type === 'read_artifact') {
      reads.push(m);
      say(
        m.asText === false
          ? { type: 'artifact', path: m.path, name: m.path.split('\\').pop(), text: null, base64: Buffer.from(MD).toString('base64') }
          : { type: 'artifact', path: m.path, name: m.path.split('\\').pop(), text: MD, base64: null }
      );
    }
    if (m.type === 'open_doc_link') {
      // the host resolves the link; here we only answer what it would answer
      const [rel, anchor] = String(m.href).split('#');
      const name = rel.replace(/^\.\//, '').split('/').pop();
      if (exportDoc) {
        say({ type: 'artifact', path: PROJ + '\\chat.md', name: 'chat.md', text: exportDoc, base64: null });
        return;
      }
      const target = PROJ + '\\docs\\' + name;
      say({
        type: 'artifact',
        path: target,
        name,
        text: name === 'spec.md' ? MD : HEROES,
        base64: null,
        anchor: anchor ?? null,
      });
    }
    if (m.type === 'list_comments') comments();
    if (m.type === 'add_comment') {
      threads.push({
        id: 't' + (threads.length + 1),
        anchor: m.anchor,
        resolved: false,
        createdAt: Date.now(),
        replies: [{ id: 'r1', author: 'Nidere', authorId: '@owner', role: 'user', text: m.text, createdAt: Date.now() }],
      });
      comments();
      say({ type: 'comments_badge', total: 1, perDoc: { [DOC]: 1 } });
    }
    if (m.type === 'reply_comment') {
      threads.find((t) => t.id === m.threadId).replies.push({ id: 'r' + Math.random(), author: 'Nidere', authorId: '@owner', role: 'user', text: m.text, createdAt: Date.now() });
      comments();
    }
    if (m.type === 'mark_thread_seen') {
      seen[m.threadId] = Date.now();
      comments();
    }
    if (m.type === 'add_artifact') {
      added = m.path;
      say({ type: 'artifact_added', artifact: { path: m.path } });
    }
    if (m.type === 'remove_artifact') {
      removed = m.path;
      say({ type: 'artifact_removed', path: m.path });
    }
    if (m.type === 'history')
      say({
        type: 'chat_message',
        chatId: CHAT,
        msg: {
          type: 'assistant',
          parent_tool_use_id: null,
          uuid: 'u-mention',
          message: { role: 'assistant', content: [{ type: 'text', text: 'Написал в `docs/spec.md` — целиком' }] },
        },
      });
  });
});
await new Promise((r) => server.listen(7786, '127.0.0.1', r));

const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
});
const page = await browser.newPage();
const W = 390;
const H = 844;
await page.setViewport({ width: W, height: H, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
const problems = [];
page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
page.on('console', (m) => {
  if (m.type() === 'error' && !m.text().includes('Failed to load resource')) problems.push('console: ' + m.text());
});
page.on('dialog', async (d) => {
  problems.push(`DIALOG: ${d.message()}`);
  await d.dismiss();
});

const fail = async (why) => {
  console.error('FAIL:', why);
  for (const p of problems) console.error(' ', p);
  await browser.close();
  server.close();
  process.exit(1);
};
const ok = (n) => console.log('ok:', n);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Is this element on screen, big enough for a thumb, and actually the thing a tap would hit? */
const tappable = (sel) => `(() => {
  const n = document.querySelector('${sel}');
  if (!n) return { ok: false, why: 'missing' };
  const r = n.getBoundingClientRect();
  if (r.width < 1 || r.height < 1) return { ok: false, why: 'zero size' };
  if (r.left < 0 || r.top < 0 || r.right > ${W} || r.bottom > ${H}) return { ok: false, why: 'outside the viewport: ' + JSON.stringify(r) };
  if (r.width < 28 || r.height < 28) return { ok: false, why: 'too small for a finger: ' + r.width + 'x' + r.height };
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  if (!hit || (hit !== n && !n.contains(hit))) return { ok: false, why: 'covered by ' + (hit ? hit.tagName + '.' + hit.className : 'nothing') };
  return { ok: true };
})()`;

const mustTap = async (sel, label) => {
  const v = await page.evaluate(tappable(sel));
  if (!v.ok) await fail(`${label}: ${v.why}`);
};

await page.goto('http://127.0.0.1:7786/', { waitUntil: 'networkidle2' });
await page.waitForFunction(`document.querySelector('.chat-item') !== null`, { timeout: 5000 }).catch(() => fail('sidebar never rendered'));
await page.evaluate(`document.querySelector('.chat-item').click()`);
await wait(200);

// ---------- a document named in a message opens by itself ----------
await page.waitForFunction(`document.querySelector('#feed code.md-path') !== null`, { timeout: 3000 }).catch(() => fail('a file named in a message was not made clickable'));
await page.click('#feed code.md-path');
await page.waitForFunction(`!document.getElementById('doc-viewer').hidden`, { timeout: 3000 }).catch(() => fail('clicking a named file did not open the viewer'));
ok('a file named in a message opens on a tap');

// the header offers to keep it in the inbox, and says so once it is there
await mustTap('#doc-inbox', 'the "keep in the inbox" button');
await page.click('#doc-inbox');
await wait(200);
if (!(await page.evaluate(`document.getElementById('doc-inbox').classList.contains('done')`)))
  await fail('the inbox button did not confirm');
if (!added) await fail('the host was never asked to file the document');
ok('the viewer files a document into the inbox');

// pressed by accident: the same button takes it back out
await page.click('#doc-inbox');
await wait(200);
if (await page.evaluate(`document.getElementById('doc-inbox').classList.contains('done')`))
  await fail('BUG: the inbox button cannot be un-pressed');
if (!removed) await fail('the host was never asked to take the document back out');
ok('a press by accident is undoable');
await page.click('#doc-close');
await wait(150);

// ---------- header ----------
await mustTap('#title-btn', 'the "name this chat" button');
await mustTap('#att-btn', 'the inbox button');
ok('header buttons reachable on a phone');

// ---------- sidebar: the explorer button ----------
await page.evaluate(`document.getElementById('menu-btn').click()`);
await wait(250);
const projRow = await page.evaluate(`(() => {
  const row = document.querySelector('.project-head');
  const r = row.getBoundingClientRect();
  const name = row.querySelector('.project-name').getBoundingClientRect();
  return { rowW: r.width, nameW: name.width, buttons: row.querySelectorAll('.project-actions button').length, overflow: row.scrollWidth > row.clientWidth + 1 };
})()`);
if (projRow.buttons !== 4) await fail(`the project row should now carry 4 buttons, has ${projRow.buttons}`);
if (projRow.overflow) await fail(`the project row overflows on a phone: ${JSON.stringify(projRow)}`);
if (projRow.nameW < 40) await fail(`the project name is squeezed to ${projRow.nameW}px by the buttons`);
ok(`project row fits 4 buttons (name keeps ${Math.round(projRow.nameW)}px)`);

const filesBtn = '.project-actions button:nth-child(3)';
await mustTap(filesBtn, 'the 📁 explorer button');
await page.click(filesBtn);
await page.waitForFunction(`!document.getElementById('picker').hidden && document.querySelectorAll('#picker-list .exp-row').length > 0`, { timeout: 3000 }).catch(() => fail('the explorer did not open'));
ok('explorer opens from the project row');

// ---------- explorer: layout and navigation ----------
const listing = await page.evaluate(`(() => {
  const box = document.getElementById('picker-box').getBoundingClientRect();
  const rows = [...document.querySelectorAll('#picker-list .exp-row')];
  const clipped = rows.every((r) => r.scrollWidth <= r.clientWidth + 1);
  const names = rows.map((r) => r.querySelector('.exp-name').textContent);
  return { box: { w: box.width, h: box.height, top: box.top, bottom: box.bottom }, clipped, names, rowH: rows[0].getBoundingClientRect().height };
})()`);
if (listing.box.w > W || listing.box.bottom > H + 1) await fail(`the explorer box does not fit the screen: ${JSON.stringify(listing.box)}`);
if (!listing.clipped) await fail('a long file name overflows its row instead of being clipped');
if (listing.rowH < 28) await fail(`explorer rows are ${listing.rowH}px tall — too small for a finger`);
ok(`explorer fits the screen, long names clipped, rows ${Math.round(listing.rowH)}px tall`);

// every file offers to be downloaded, markdown included
const dlBtn = '#picker-list .exp-row:nth-child(2) .exp-star';
await mustTap(dlBtn, 'the ⤓ download button');
await page.click(dlBtn);
await wait(200);
if (!reads.some((r) => r.asText === false)) await fail('the download button did not ask for the file itself');
ok('the explorer offers to download a file');

await mustTap('#picker-list .exp-row:nth-child(2) .exp-star + .exp-star', 'the ☆ add-to-inbox button');
await page.click('#picker-list .exp-row:nth-child(2) .exp-star + .exp-star');
await wait(150);
if (!(await page.evaluate(`document.querySelector('#picker-list .exp-row:nth-child(2) .exp-star + .exp-star').disabled`)))
  await fail('the ☆ button did not confirm the file was filed');
ok('☆ files a document into the inbox');

// into the folder, then back up
await page.evaluate(`[...document.querySelectorAll('#picker-list .exp-row')].find((r) => r.querySelector('.exp-name').textContent === 'docs').click()`);
await page.waitForFunction(`[...document.querySelectorAll('#picker-list .exp-name')].some((n) => n.textContent === 'spec.md')`, { timeout: 3000 }).catch(() => fail('could not walk into a folder'));
await page.waitForFunction(`[...document.querySelectorAll('#picker-list .exp-name')].some((n) => n.textContent === '..')`, { timeout: 2000 }).catch(() => fail('no ".." row to climb back'));
ok('navigating in and back out works');

// ---------- the document viewer ----------
await page.evaluate(`[...document.querySelectorAll('#picker-list .exp-row')].find((r) => r.querySelector('.exp-name').textContent === 'spec.md').click()`);
await page.waitForFunction(`!document.getElementById('doc-viewer').hidden`, { timeout: 3000 }).catch(() => fail('the viewer did not open from the explorer'));
const docBox = await page.evaluate(`(() => { const r = document.getElementById('doc-box').getBoundingClientRect(); return { w: r.width, h: r.height, top: r.top, bottom: r.bottom }; })()`);
if (docBox.w > W || docBox.bottom > H + 1) await fail(`the viewer does not fit the screen: ${JSON.stringify(docBox)}`);
await mustTap('#doc-close', 'the viewer close button');
ok('project markdown opens in the viewer and fits the screen');

// full width: the document takes the window, and a line of prose runs to the edge
await mustTap('#doc-full', 'the full-width button');
const narrow = await page.evaluate(`(() => {
  const line = [...document.querySelectorAll('#doc-body > div')].find((d) => d.textContent.includes('the design lives here'));
  return line.getBoundingClientRect().width;
})()`);
await page.click('#doc-full');
await wait(200);
const wide = await page.evaluate(`(() => {
  const box = document.getElementById('doc-box').getBoundingClientRect();
  const line = [...document.querySelectorAll('#doc-body > div')].find((d) => d.textContent.includes('the design lives here'));
  return { box: box.width, boxH: box.height, line: line.getBoundingClientRect().width, wraps: getComputedStyle(line).whiteSpace };
})()`);
if (Math.abs(wide.box - W) > 1) await fail(`full width did not take the window: ${wide.box} of ${W}`);
if (wide.line <= narrow) await fail(`the line did not get any wider (${narrow} → ${wide.line})`);
if (wide.line < W * 0.8) await fail(`a line still sits in a column: ${wide.line} of ${W}`);
ok(`full width lets a line run to the edge (${Math.round(narrow)} → ${Math.round(wide.line)}px)`);

// and the choice survives, as a reading preference should
await page.reload({ waitUntil: 'networkidle2' });
await wait(300);
if (!(await page.evaluate(`document.getElementById('doc-viewer').classList.contains('full')`)))
  await fail('the full-width choice was forgotten on reload');
await page.evaluate(`document.getElementById('doc-full').click()`); // back to a column for the rest
ok('the choice is remembered');

// the reload closed the document — open it again the quick way, by its mention
await page.waitForFunction(`document.querySelector('#feed code.md-path') !== null`, { timeout: 3000 }).catch(() => fail('the feed came back without its mention'));
await page.click('#feed code.md-path');
await page.waitForFunction(`!document.getElementById('doc-viewer').hidden`, { timeout: 3000 }).catch(() => fail('could not reopen the document after the reload'));

// a table renders as a table, and a wide one scrolls inside itself instead of
// stretching the document
const table = await page.evaluate(`(() => {
  const t = document.querySelector('#doc-body table.md-table');
  if (!t) return { ok: false, why: 'no table rendered' };
  const wrap = t.closest('.md-table-wrap');
  const body = document.getElementById('doc-body');
  const raw = body.textContent.includes('|---|');
  const box = t.getBoundingClientRect();
  const cell = t.querySelector('tbody td')?.getBoundingClientRect() ?? { width: 0, height: 0 };
  return {
    ok: true,
    cols: t.querySelectorAll('thead th').length,
    rows: t.querySelectorAll('tbody tr').length,
    bold: Boolean(t.querySelector('td b')),
    rawPipes: raw,
    scrolls: wrap.scrollWidth > wrap.clientWidth,
    overflowsDoc: body.scrollWidth > body.clientWidth + 1,
    // being in the dom is not being on screen: a wrong layout can flatten it
    seen: box.width > 40 && box.height > 20 && cell.width > 10 && cell.height > 5,
    size: Math.round(box.width) + 'x' + Math.round(box.height),
  };
})()`);
if (!table.ok) await fail(table.why);
if (table.cols !== 3 || table.rows !== 2) await fail(`the table lost cells: ${JSON.stringify(table)}`);
if (!table.bold) await fail('markup inside a cell was not rendered');
if (table.rawPipes) await fail('the raw |---| rule is still visible as text');
if (table.overflowsDoc) await fail('a wide table stretched the whole document instead of scrolling itself');
if (!table.seen) await fail(`the table is in the document but not on screen: ${table.size}`);
ok(`markdown tables render and are visible (${table.cols}×${table.rows}, ${table.size})`);

// an anchor link scrolls this document to its section. A link inside prose is
// text, not an icon button — it only has to be visible and actually hittable.
const linkHit = await page.evaluate(`(() => {
  const n = document.querySelector('#doc-body a.md-anchor');
  if (!n) return { ok: false, why: 'the in-document link was not rendered as a link' };
  const r = n.getBoundingClientRect();
  if (r.width < 1 || r.height < 1) return { ok: false, why: 'zero size' };
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return hit && (hit === n || n.contains(hit)) ? { ok: true } : { ok: false, why: 'covered' };
})()`);
if (!linkHit.ok) await fail(`an in-document link: ${linkHit.why}`);
const before = await page.evaluate(`document.getElementById('doc-body').scrollTop`);
await page.click('#doc-body a.md-anchor');
await wait(300);
const jumped = await page.evaluate(`(() => {
  const body = document.getElementById('doc-body');
  const h = body.querySelector('[id="действия-героя"]');
  if (!h) return { ok: false, why: 'the heading has no anchor id' };
  const top = h.getBoundingClientRect().top - body.getBoundingClientRect().top;
  // a section at the very end cannot reach the top — the container runs out of
  // scroll — so what matters is that it is on screen now
  return { ok: true, scrollTop: body.scrollTop, top, visible: top >= -1 && top < body.clientHeight };
})()`);
if (!jumped.ok) await fail(jumped.why);
if (jumped.scrollTop <= before) await fail('the anchor link did not scroll anywhere');
if (!jumped.visible) await fail(`the section is not on screen after the jump: ${jumped.top}px off`);
ok('an in-document link jumps to its section');

// a link to a neighbouring document opens it in the same viewer
await page.click('#doc-body a.md-doclink');
await page.waitForFunction(`document.getElementById('doc-title').textContent === 'heroes.md'`, { timeout: 3000 }).catch(() => fail('the link to another document did not open it'));
if (!(await page.evaluate(`document.getElementById('doc-body').textContent.includes('список героев')`)))
  await fail('the neighbouring document opened empty');
ok('a link opens another document of the project');

// back to the first document for the commenting pass — by its mention in the feed
await page.click('#doc-close');
await wait(150);
await page.click('#feed code.md-path');
await page.waitForFunction(`document.getElementById('doc-title').textContent === 'spec.md'`, { timeout: 3000 }).catch(() => fail('could not get back to the first document'));

// ---------- an exported conversation reads as a conversation ----------
const EXPORT = [
  '<!-- remaude -->',
  '<!-- remaude:chat -->',
  '# Сохранённый чат',
  '',
  '**Проект:** C:\\fake\\proj',
  '',
  '---',
  '',
  '## Nidere · 04.08.2026, 10:00',
  '',
  'мой вопрос',
  '',
  '## Nidere · 04.08.2026, 10:00',
  '',
  'а это длинное сообщение, ' + 'которое должно занять всю доступную ширину, а не сидеть в узкой колонке. '.repeat(6),
  '',
  '## Claude · 04.08.2026, 10:01',
  '',
  'мой **ответ** со ссылкой',
  '',
].join('\n');
await page.evaluate(`document.getElementById('doc-close').click()`);
await wait(100);
exportDoc = EXPORT;
await page.click('#feed code.md-path');
await page.waitForFunction(`document.querySelector('#doc-body .msg-user') !== null`, { timeout: 3000 }).catch(() => fail('an exported chat did not come out as a conversation'));
const laidOut = await page.evaluate(`(() => {
  const body = document.getElementById('doc-body');
  const mine = body.querySelector('.msg-user');
  const theirs = body.querySelector('.msg-assistant');
  const box = body.getBoundingClientRect();
  return {
    mineText: mine.textContent,
    theirsText: theirs.textContent,
    mineRight: Math.abs(mine.getBoundingClientRect().right - box.right) < 40,
    theirsLeft: Math.abs(theirs.getBoundingClientRect().left - box.left) < 40,
    bold: Boolean(theirs.querySelector('b')),
    marker: body.textContent.includes('<!--'),
    heading: Boolean(body.querySelector('h4')),
    // a long message of mine must use the width, exactly as it does in the feed
    // (measured against the text area itself, padding excluded)
    longShare: (() => {
      const s = getComputedStyle(body);
      const content = body.clientWidth - parseFloat(s.paddingLeft) - parseFloat(s.paddingRight);
      return [...body.querySelectorAll('.msg-user')].map((n) => n.getBoundingClientRect().width / content).sort((a, b) => b - a)[0];
    })(),
  };
})()`);
if (!laidOut.mineText.includes('мой вопрос')) await fail('my own message lost its words');
if (!laidOut.mineRight) await fail('my messages are not on the right');
if (!laidOut.theirsLeft) await fail("the answers are not on the left");
if (!laidOut.bold) await fail('markup inside a message stopped rendering');
if (laidOut.marker) await fail('the machine marker is showing in the document');
if (laidOut.heading) await fail('the headings were left as headings instead of becoming messages');
if (laidOut.longShare < 0.9) await fail(`a long message of mine sits in a column: ${Math.round(laidOut.longShare * 100)}% of the width`);
ok(`a saved conversation reads as one, mine on the right, long ones full width (${Math.round(laidOut.longShare * 100)}%)`);
exportDoc = null;
await page.evaluate(`document.getElementById('doc-close').click()`);
await wait(100);
await page.click('#feed code.md-path');
await page.waitForFunction(`document.getElementById('doc-title').textContent === 'spec.md'`, { timeout: 3000 }).catch(() => fail('could not get back to the plain document'));

// ---------- commenting, as a bottom sheet ----------
await page.evaluate(`(() => {
  const walker = document.createTreeWalker(document.getElementById('doc-body'), NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const i = n.nodeValue.indexOf('design');
    if (i === -1) continue;
    const range = document.createRange();
    range.setStart(n, i); range.setEnd(n, i + 6);
    const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range);
    return;
  }
})()`);
await page.waitForFunction(`!document.getElementById('cmt-add').hidden`, { timeout: 3000 }).catch(() => fail('the 💬 button never appeared on a phone selection'));
await mustTap('#cmt-add', 'the 💬 comment button');
ok('selection offers to comment');

await page.click('#cmt-add');
await page.waitForFunction(`getComputedStyle(document.getElementById('cmt-pop')).display !== 'none'`, { timeout: 2000 }).catch(() => fail('the draft sheet did not open'));
const sheet = await page.evaluate(`(() => { const r = document.getElementById('cmt-pop').getBoundingClientRect(); return { left: r.left, width: r.width, bottom: r.bottom, top: r.top }; })()`);
if (Math.abs(sheet.left) > 1 || Math.abs(sheet.width - W) > 1 || Math.abs(sheet.bottom - H) > 1)
  await fail(`on a phone the popover must be a full-width bottom sheet, got ${JSON.stringify(sheet)}`);
ok('the thread opens as a bottom sheet, not a stray popover');

await mustTap('#cmt-pop textarea', 'the comment field');
await mustTap('#cmt-pop .cmt-primary', 'the Comment button');
await page.type('#cmt-pop textarea', 'коммент с телефона');
await page.click('#cmt-pop .cmt-primary');
await page.waitForFunction(`document.querySelectorAll('mark.doc-hl').length > 0`, { timeout: 3000 }).catch(() => fail('the highlight never appeared after commenting'));
ok('comment lands and highlights the fragment');

await page.click('mark.doc-hl');
await wait(200);
const thread = await page.evaluate(`(() => {
  const pop = document.getElementById('cmt-pop');
  const r = pop.getBoundingClientRect();
  return { visible: getComputedStyle(pop).display !== 'none', replies: pop.querySelectorAll('.cmt-reply').length, bottom: r.bottom, width: r.width, tall: r.height };
})()`);
if (!thread.visible || thread.replies !== 1) await fail(`tapping the highlight did not open the thread: ${JSON.stringify(thread)}`);
if (Math.abs(thread.bottom - H) > 1 || Math.abs(thread.width - W) > 1) await fail(`the thread sheet drifted: ${JSON.stringify(thread)}`);
if (thread.tall > H * 0.75) await fail(`the sheet eats the whole screen (${thread.tall}px of ${H})`);
ok('tapping a highlight opens its thread as a sheet');

await mustTap('#cmt-pop .cmt-llm', 'the "Ask Claude" button');
await mustTap('#doc-threads', 'the threads counter');
await page.click('#doc-threads');
await page.waitForFunction(`!document.getElementById('cmt-list').hidden`, { timeout: 2000 }).catch(() => fail('the threads list did not open'));
const listBox = await page.evaluate(`(() => { const r = document.getElementById('cmt-list').getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; })()`);
if (listBox.left < 0 || listBox.right > W + 1 || listBox.bottom > H + 1) await fail(`the threads list hangs off the screen: ${JSON.stringify(listBox)}`);
ok('threads list stays on screen');

// ---------- escape closes one layer at a time ----------
// the thread sheet is open over the document, which is open over the explorer
await page.keyboard.press('Escape');
await wait(150);
if (await page.evaluate(`getComputedStyle(document.getElementById('cmt-pop')).display !== 'none'`))
  await fail('escape did not close the thread');
if (await page.evaluate(`document.getElementById('doc-viewer').hidden`))
  await fail('escape closed the document as well as the thread on it');
ok('escape closes the thread first');

// the list of threads is still open under it — that is the next layer, not the document
await page.keyboard.press('Escape');
await wait(150);
if (!(await page.evaluate(`document.getElementById('cmt-list').hidden`))) await fail('escape did not close the list of threads');
if (await page.evaluate(`document.getElementById('doc-viewer').hidden`)) await fail('escape skipped a layer and closed the document');
ok('then the list of threads');

await page.keyboard.press('Escape');
await wait(150);
if (!(await page.evaluate(`document.getElementById('doc-viewer').hidden`))) await fail('escape did not close the document');
ok('then the document');

// with everything closed, escape has nothing left to take
await page.keyboard.press('Escape');
await wait(150);
if (!(await page.evaluate(`document.getElementById('input') !== null && document.getElementById('feed') !== null`)))
  await fail('escape took the chat itself with it');
ok('and leaves the chat alone');

// ---------- the inbox, with its unread dot ----------
await page.evaluate(`document.getElementById('cmt-list').hidden = true; document.getElementById('doc-viewer').hidden = true`);
await page.evaluate(`document.getElementById('picker').hidden = true`);
await wait(100);
if (!(await page.evaluate(`document.getElementById('att-btn').classList.contains('has-unseen')`)))
  await fail('the inbox button never lit up for the new comment');
ok('unread dot reaches the inbox button on mobile');

if (problems.length) await fail('errors were collected along the way');
console.log('MOBILE FULL PASS OK');
await browser.close();
server.close();
