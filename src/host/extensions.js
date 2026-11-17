// Project extensions: panels a project ships in its own repository, shown by
// remaude in a sandboxed frame, fed by a command the host runs for them.
//
//   <project>/.remaude-ext/<id>/manifest.json
//   { "name": "CI", "icon": "🔧", "entry": "index.html",
//     "command": ["python", "tools/status.py", "json"], "timeout": 20 }
//
// Everything is read from disk on every request, so a new or edited extension
// shows up without restarting anything. The frame never reaches the network or
// the host: its page arrives as one inlined document, and the only thing it can
// ask for is the output of the command its own manifest names.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve, sep, extname, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';

export const EXT_DIR = '.remaude-ext';
export const LIMITS = {
  outputBytes: 1024 * 1024, // stdout of one run
  pageBytes: 8 * 1024 * 1024, // the page with everything inlined into it
  timeoutDefault: 20, // seconds
  timeoutMax: 60,
  minGapMs: 2000, // a run asked for sooner than this after the last one gets that one's result
};

const ID_RE = /^[\w.-]{1,64}$/;

/** Inside `root`, or null: nothing a manifest names may reach out of its folder. */
function inside(root, rel) {
  const abs = resolve(root, rel);
  return abs === root || abs.startsWith(root + sep) ? abs : null;
}

function readManifest(project, id) {
  if (!ID_RE.test(id)) throw new Error('bad extension id');
  const dir = join(resolve(project), EXT_DIR, id);
  const file = join(dir, 'manifest.json');
  const raw = readFileSync(file, 'utf-8');
  let m;
  try {
    m = JSON.parse(raw);
  } catch (e) {
    throw new Error(`${EXT_DIR}/${id}/manifest.json is not valid JSON: ${e.message}`);
  }
  const command = m.command ?? null;
  if (command !== null && typeof command !== 'string' && !(Array.isArray(command) && command.length && command.every((a) => typeof a === 'string')))
    throw new Error(`${id}: "command" must be a string or a non-empty array of strings`);
  return {
    id,
    dir,
    name: String(m.name ?? id).slice(0, 60),
    icon: String(m.icon ?? '🧩').slice(0, 8),
    entry: String(m.entry ?? 'index.html'),
    command,
    timeout: Math.min(Math.max(Number(m.timeout) || LIMITS.timeoutDefault, 1), LIMITS.timeoutMax),
    // what the owner approves: the manifest as written, so any change asks again
    hash: createHash('sha256').update(raw).digest('hex').slice(0, 32),
  };
}

/** Every extension the project declares; a broken one is listed with its error, not dropped. */
export function listExtensions(project) {
  const root = join(resolve(project), EXT_DIR);
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory() || !ID_RE.test(e.name) || !existsSync(join(root, e.name, 'manifest.json'))) continue;
    try {
      const m = readManifest(project, e.name);
      out.push({ id: m.id, name: m.name, icon: m.icon, command: m.command, hash: m.hash });
    } catch (err) {
      out.push({ id: e.name, name: e.name, icon: '⚠', error: String(err.message ?? err) });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function manifestOf(project, id) {
  return readManifest(project, id);
}

const MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};
const isLocal = (url) => url && !/^([a-z][a-z0-9+.-]*:|\/\/|#)/i.test(url);

// The frame may not fetch anything — not the host, not the internet. Scripts
// and styles are inline because that is how they arrive; pictures and fonts
// only as data: URLs, which is also how they arrive.
const CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:";

// `remaude.run()` resolves with the command's output; `remaude.open(path)`
// shows a project file in remaude's viewer. Both are postMessage underneath,
// for anyone who would rather speak it directly (see README).
//
// A page in srcdoc resolves links against remaude's own address, so following
// one would replace the extension with a copy of the app: every link click is
// stopped here, and an #anchor is scrolled to by hand.
const HELPER = `<script>(()=>{let n=0;const w=new Map();addEventListener('message',e=>{const d=e.data;if(e.source!==parent||!d||!d.remaude)return;if(d.remaude==='data'&&w.has(d.id)){const f=w.get(d.id);w.delete(d.id);f(d)}});window.remaude={run(){const id=++n;return new Promise(r=>{w.set(id,r);parent.postMessage({remaude:'run',id},'*')})},open(path){parent.postMessage({remaude:'open',path:String(path)},'*')}};addEventListener('click',e=>{const a=e.target.closest&&e.target.closest('a[href]');if(!a)return;e.preventDefault();const h=a.getAttribute('href');if(h.startsWith('#')&&h.length>1)document.getElementById(h.slice(1))?.scrollIntoView()})})();</script>`;

/** The extension's page as one self-contained document, ready for srcdoc. */
export function buildPage(project, id) {
  const m = readManifest(project, id);
  const entry = inside(m.dir, m.entry);
  if (!entry) throw new Error(`${id}: entry points outside its folder`);
  let html = readFileSync(entry, 'utf-8');
  const base = dirname(entry);
  // a path the page names, resolved from the file that names it, kept to the extension's folder
  const asset = (rel, from = base) => {
    const abs = inside(m.dir, resolve(from, rel.split(/[?#]/)[0]));
    if (!abs || !existsSync(abs) || !statSync(abs).isFile()) throw new Error(`${id}: ${rel} not found in the extension folder`);
    return abs;
  };
  const dataUrl = (rel, from) => {
    const abs = asset(rel, from);
    const mime = MIME[extname(abs).toLowerCase()] ?? 'application/octet-stream';
    return `data:${mime};base64,${readFileSync(abs).toString('base64')}`;
  };
  const inlineCss = (css, from) =>
    css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (all, q, url) => (isLocal(url) ? `url("${dataUrl(url, from)}")` : all));

  html = html.replace(/<script\b([^>]*?)\bsrc\s*=\s*(['"])([^'"]+)\2([^>]*)>\s*<\/script>/gi, (all, pre, q, src, post) => {
    if (!isLocal(src)) return all;
    const code = readFileSync(asset(src), 'utf-8').replace(/<\/script/gi, '<\\/script');
    return `<script${pre}${post}>${code}</script>`;
  });
  html = html.replace(/<link\b[^>]*>/gi, (tag) => {
    if (!/\brel\s*=\s*(['"]?)stylesheet\1/i.test(tag)) return tag;
    const href = /\bhref\s*=\s*(['"])([^'"]+)\1/i.exec(tag)?.[2];
    if (!isLocal(href)) return tag;
    const abs = asset(href);
    return `<style>${inlineCss(readFileSync(abs, 'utf-8'), dirname(abs))}</style>`;
  });
  html = html.replace(/<style\b([^>]*)>([\s\S]*?)<\/style>/gi, (all, attrs, css) => `<style${attrs}>${inlineCss(css, base)}</style>`);
  html = html.replace(/(<img\b[^>]*?\bsrc\s*=\s*)(['"])([^'"]+)\2/gi, (all, pre, q, src) =>
    isLocal(src) ? `${pre}"${dataUrl(src)}"` : all
  );

  // Ours goes first, ahead of anything the page says: a second policy can only
  // narrow the first, never widen it.
  const head = `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${CSP}">${HELPER}`;
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html)?.[0] ?? '';
  html = doctype + head + html.slice(doctype.length);
  if (Buffer.byteLength(html) > LIMITS.pageBytes) throw new Error(`${id}: page is over ${LIMITS.pageBytes >> 20} MB with its assets inlined`);
  return { page: html, manifest: m };
}

function killTree(child) {
  if (process.platform === 'win32') execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => {});
  else child.kill('SIGKILL');
}

/** One run of the manifest's command in the project folder: stdout, parsed as JSON when it is. */
function runOnce(project, m) {
  return new Promise((done) => {
    const started = Date.now();
    const finish = (r) => done({ ...r, at: Date.now(), ms: Date.now() - started });
    const [cmd, args, shell] = typeof m.command === 'string' ? [m.command, [], true] : [m.command[0], m.command.slice(1), false];
    let child;
    try {
      child = spawn(cmd, args, { cwd: resolve(project), shell, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return finish({ ok: false, error: String(e.message ?? e) });
    }
    const out = [];
    let outBytes = 0;
    let err = '';
    let failed = null;
    const timer = setTimeout(() => {
      failed = `timed out after ${m.timeout} s`;
      killTree(child);
    }, m.timeout * 1000);
    child.stdout.on('data', (b) => {
      outBytes += b.length;
      if (outBytes > LIMITS.outputBytes) {
        if (!failed) {
          failed = `output is over ${LIMITS.outputBytes >> 10} KB`;
          killTree(child);
        }
        return;
      }
      out.push(b);
    });
    child.stderr.on('data', (b) => {
      if (err.length < 8192) err += b.toString('utf-8');
    });
    child.on('error', (e) => {
      failed ??= String(e.message ?? e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const text = Buffer.concat(out).toString('utf-8');
      if (failed) return finish({ ok: false, error: failed, stderr: err.slice(-4000) });
      if (code !== 0) return finish({ ok: false, error: `exited with code ${code}`, text, stderr: err.slice(-4000) });
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        /* not JSON: the page gets the text */
      }
      finish(json === undefined ? { ok: true, text, stderr: err.slice(-4000) || undefined } : { ok: true, json });
    });
  });
}

// One run in flight per extension: a second ask joins it, and an ask right
// after one finished gets that result instead of starting the command again.
const runs = new Map(); // "project|id" -> {promise, result}

export function runCommand(project, id) {
  const m = readManifest(project, id);
  if (!m.command) return Promise.resolve({ ok: false, error: `${id} has no command in its manifest`, at: Date.now() });
  const key = `${resolve(project).toLowerCase()}|${id}`;
  const slot = runs.get(key);
  if (slot?.promise) return slot.promise;
  if (slot?.result && Date.now() - slot.result.at < LIMITS.minGapMs) return Promise.resolve(slot.result);
  const promise = runOnce(project, m).then((result) => {
    runs.set(key, { result });
    return result;
  });
  runs.set(key, { promise });
  return promise;
}

/** A project file the page wants shown, or null if the path leaves the project. */
export function projectFile(project, rel) {
  return inside(resolve(project), String(rel ?? ''));
}
