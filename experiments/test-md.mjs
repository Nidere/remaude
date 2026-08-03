// Unit check of the markdown renderer: markup + protection against html injections.
import { mdToHtml } from '../src/web/md.js';

const cases = [
  ['**жирный** и *курсив* и `код`', ['<b>жирный</b>', '<i>курсив</i>', '<code>код</code>']],
  ['# Заголовок\nтекст', ['<h3 id="заголовок">Заголовок</h3>']],
  ['- один\n- два\n\n1. раз\n2. два', ['<ul><li>один</li><li>два</li></ul>', '<ol><li>раз</li><li>два</li></ol>']],
  ['[линк](https://example.com)', ['<a href="https://example.com" target="_blank" rel="noopener">линк</a>']],
  ['[зло](javascript:alert(1))', []], // must not become a link
  ['```js\nconst x = 1 < 2;\n```', ['<pre class="md-code"><code>const x = 1 &lt; 2;</code></pre>']],
  ['<script>alert(1)</script>', ['&lt;script&gt;']],
  ['> цитата', ['<blockquote>цитата</blockquote>']],

  // tables: the header, the rule under it, and the rows that follow
  [
    '| Термин | Перевод |\n|---|---|\n| **NIF** | ИНН |\n| IVA | НДС |',
    [
      '<table class="md-table">',
      '<th>Термин</th>',
      '<th>Перевод</th>',
      '<td><b>NIF</b></td>',
      '<td>ИНН</td>',
      '<td>IVA</td>',
    ],
  ],
  // alignment markers
  ['| a | b | c |\n|:---|:---:|---:|\n| 1 | 2 | 3 |', ['<th>a</th>', 'text-align:center">b', 'text-align:right">c']],
  // a ragged row is padded to the header instead of breaking the table
  ['| a | b |\n|---|---|\n| 1 |', ['<td>1</td><td></td>']],
  // text around a table stays prose
  ['до\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nпосле', ['<div>до</div>', '<div>после</div>', '<table class="md-table">']],
  // a stray pipe in a sentence is not a table
  ['так | и вот так', ['<div>так | и вот так</div>']],
  // ...and neither is a single column
  ['| один |\n|---|\n| два |', []],
  // an escaped pipe belongs to the cell
  ['| a | b |\n|---|---|\n| x \\| y | z |', ['<td>x | y</td>']],
  // html inside a cell is still escaped
  ['| a | b |\n|---|---|\n| <img src=x onerror=alert(1)> | z |', ['&lt;img']],

  // headings carry anchors, links inside a document find them
  ['## Действия героя\nтекст', ['<h4 id="действия-героя">Действия героя</h4>']],
  ['## Ход матча / порядок!\n', ['id="ход-матча-порядок"']],
  ['см. [Действия героя](#действия-героя)', ['<a class="md-anchor" data-anchor="действия-героя">Действия героя</a>']],
  // two headings with the same name get distinct anchors
  ['# Раз\n# Раз', ['id="раз"', 'id="раз-1"']],
  // a link to another document of the project
  ['[герои](./heroes.md)', ['<a class="md-doclink" data-href="./heroes.md">герои</a>']],
  ['[глава](../design/combat.md#формация)', ['data-href="../design/combat.md#формация"']],
  // external links keep opening in a new tab
  ['[сайт](https://example.com)', ['<a href="https://example.com" target="_blank"']],
  // and unknown schemes are still not links at all
  ['[зло](data:text/html,<script>alert(1)</script>)', []],

  // a document named in passing becomes clickable by itself
  ['Написал в `cloud/OWNER-SETUP-AWS-ACCOUNT.md` — целиком', ['<code class="md-path" data-path="cloud/OWNER-SETUP-AWS-ACCOUNT.md">']],
  ['см. `docs/дизайн-боёвки.md`', ['data-path="docs/дизайн-боёвки.md"']],
  ['`./README.md`', ['class="md-path"']],
  ['`src\\host\\server.md`', ['class="md-path"']],
  // …but ordinary code stays ordinary
  ['`npm install`', ['<code>npm install</code>']],
  ['`src/host/server.js`', ['<code>src/host/server.js</code>']],
  ['`a/b`', ['<code>a/b</code>']],
  ['`*.md`', ['<code>*.md</code>']],
];

let failed = 0;
for (const [src, expects] of cases) {
  const html = mdToHtml(src);
  for (const exp of expects) {
    if (!html.includes(exp)) {
      console.error(`FAIL: ${JSON.stringify(src)}\n  expected: ${exp}\n  received: ${html}`);
      failed++;
    }
  }
  if (src.includes('javascript:') && html.includes('<a ')) {
    console.error(`FAIL: js link got through: ${html}`);
    failed++;
  }
  if (src.includes('<script>') && html.includes('<script>')) {
    console.error(`FAIL: html injection: ${html}`);
    failed++;
  }
  if (src.includes('onerror') && html.includes('<img')) {
    console.error(`FAIL: html inside a table cell got through: ${html}`);
    failed++;
  }
  if (src.startsWith('| один') && html.includes('<table')) {
    console.error(`FAIL: a single-column block became a table: ${html}`);
    failed++;
  }
  if (src.includes('data:text/html') && html.includes('<a ')) {
    console.error(`FAIL: a data: link got through: ${html}`);
    failed++;
  }
}
console.log(failed ? `${failed} FAILED` : 'MD OK');
process.exit(failed ? 1 : 0);
