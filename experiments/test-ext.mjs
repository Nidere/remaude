// Project extensions (src/host/extensions.js). Offline and free.
//
//   node experiments/test-ext.mjs                 the mechanism, on a throwaway extension
//   node experiments/test-ext.mjs <project> [id]  a real project's extension, the way the
//                                                 host will see it: manifest, one run of its
//                                                 command, and the built page written to a
//                                                 file you can open in a browser
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { listExtensions, buildPage, runCommand, projectFile, LIMITS } from '../src/host/extensions.js';

if (process.argv[2]) {
  const project = resolve(process.argv[2]);
  const exts = listExtensions(project);
  if (!exts.length) {
    console.log(`no extensions in ${join(project, '.remaude-ext')} (each needs <id>/manifest.json)`);
    process.exit(1);
  }
  let bad = 0;
  for (const e of exts.filter((x) => !process.argv[3] || x.id === process.argv[3])) {
    console.log(`\n${e.icon} ${e.name}  [${e.id}]`);
    if (e.error) {
      console.log(`  manifest: ${e.error}`);
      bad++;
      continue;
    }
    try {
      const { page } = buildPage(project, e.id);
      const out = join(tmpdir(), `remaude-ext-${e.id}.html`);
      writeFileSync(out, page);
      console.log(`  page: ${(Buffer.byteLength(page) / 1024).toFixed(1)} KB inlined -> ${out}`);
      console.log('        (opened straight from disk it cannot reach remaude: remaude.run() will wait forever there)');
    } catch (err) {
      console.log(`  page: ${err.message}`);
      bad++;
    }
    if (!e.command) {
      console.log('  command: none');
      continue;
    }
    const r = await runCommand(project, e.id);
    console.log(`  command: ${Array.isArray(e.command) ? e.command.join(' ') : e.command}`);
    console.log(`  run: ${r.ok ? 'ok' : 'FAILED: ' + r.error} in ${r.ms} ms`);
    if (r.ok) console.log(r.json !== undefined ? `  output: JSON, ${(JSON.stringify(r.json).length / 1024).toFixed(1)} KB` : `  output: not JSON, page gets .text (${r.text.length} chars)`);
    if (r.stderr) console.log(`  stderr: ${r.stderr.trim().split('\n').slice(-5).join('\n          ')}`);
    if (!r.ok) bad++;
  }
  process.exit(bad ? 1 : 0);
}

let failed = 0;
const check = (got, want, what) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${ok ? '' : `\n     got ${JSON.stringify(got)}\n    want ${JSON.stringify(want)}`}`);
};
const throws = (fn) => {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
};

const project = mkdtempSync(join(tmpdir(), 'remaude-ext-'));
const dir = join(project, '.remaude-ext', 'ci');
mkdirSync(join(dir, 'img'), { recursive: true });
const node = JSON.stringify(process.execPath);
const manifest = (extra) =>
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ name: 'CI', icon: '🔧', entry: 'index.html', ...extra }));
writeFileSync(
  join(dir, 'index.html'),
  `<!doctype html><html><head><link rel="stylesheet" href="style.css"><script src="app.js"></script>
<script src="https://example.com/x.js"></script></head><body><img src="img/dot.png"></body></html>`
);
writeFileSync(join(dir, 'style.css'), 'body{background:url(img/dot.png)}');
writeFileSync(join(dir, 'app.js'), 'const s = "</script>";');
writeFileSync(join(dir, 'img', 'dot.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
writeFileSync(join(project, 'status.js'), 'console.log(JSON.stringify({ stage: "test", done: 237, of: 530 }))');
writeFileSync(join(project, 'slow.js'), 'setTimeout(() => {}, 10000)');
writeFileSync(join(project, 'loud.js'), `process.stdout.write("x".repeat(${LIMITS.outputBytes + 10}))`);
mkdirSync(join(project, '.remaude-ext', 'broken'));
writeFileSync(join(project, '.remaude-ext', 'broken', 'manifest.json'), '{ nope');

// ---- the list ----
manifest({ command: [process.execPath, 'status.js'] });
const list = listExtensions(project);
check(list.map((e) => [e.id, !!e.error]), [['broken', true], ['ci', false]], 'both found, the broken one with its error');
check(listExtensions(join(project, 'nowhere')), [], 'a project without the folder has none');

// ---- the page ----
const { page } = buildPage(project, 'ci');
check(page.indexOf('Content-Security-Policy') < page.indexOf('<html'), true, 'the policy comes before anything of the page');
check(page.startsWith('<!doctype html>'), true, 'the doctype stays first');
check(page.includes('"<\\/script>"'), true, 'a script that says </script> is inlined without ending itself');
check(page.includes('src="app.js"'), false, 'local script inlined');
check(page.includes('https://example.com/x.js'), true, 'a remote one is left alone (and the policy stops it)');
check(page.includes('href="style.css"'), false, 'stylesheet inlined');
check((page.match(/data:image\/png;base64,/g) ?? []).length, 2, 'the picture, from the img and from the css, as data: URLs');
check(page.includes('window.remaude'), true, 'the helper is there');

writeFileSync(join(dir, 'index.html'), '<script src="../../status.js"></script>');
check(throws(() => buildPage(project, 'ci')), true, 'an asset outside the extension folder is refused');
manifest({ entry: '../../status.js' });
check(throws(() => buildPage(project, 'ci')), true, 'so is an entry outside it');
check(throws(() => buildPage(project, '../x')), true, 'and an id that is a path');
check(projectFile(project, '../outside.txt'), null, 'open() cannot leave the project');
check(projectFile(project, 'logs/a.log'), join(project, 'logs', 'a.log'), 'but reaches inside it');

// ---- the command ----
manifest({ command: [process.execPath, 'status.js'] });
const [a, b] = await Promise.all([runCommand(project, 'ci'), runCommand(project, 'ci')]);
check([a.ok, a.json], [true, { stage: 'test', done: 237, of: 530 }], 'JSON output arrives parsed');
check(a === b, true, 'two asks at once share one run');
check((await runCommand(project, 'ci')) === a, true, 'an ask right after gets the same result');

await new Promise((r) => setTimeout(r, LIMITS.minGapMs));
manifest({ command: `${node} slow.js`, timeout: 1 });
const slow = await runCommand(project, 'ci');
check([slow.ok, slow.error], [false, 'timed out after 1 s'], 'a command over its timeout is killed (string command, through the shell)');

await new Promise((r) => setTimeout(r, LIMITS.minGapMs));
manifest({ command: [process.execPath, 'loud.js'] });
const loud = await runCommand(project, 'ci');
check([loud.ok, loud.error], [false, `output is over ${LIMITS.outputBytes >> 10} KB`], 'output over the limit is cut off');

manifest({ timeout: 999 });
check((await runCommand(project, 'ci')).ok, false, 'no command, no run');

rmSync(project, { recursive: true, force: true });
console.log(failed ? `\n${failed} failed` : '\nall ok');
process.exit(failed ? 1 : 0);
