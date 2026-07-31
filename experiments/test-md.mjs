// Unit check of the markdown renderer: markup + protection against html injections.
import { mdToHtml } from '../src/web/md.js';

const cases = [
  ['**жирный** и *курсив* и `код`', ['<b>жирный</b>', '<i>курсив</i>', '<code>код</code>']],
  ['# Заголовок\nтекст', ['<h3>Заголовок</h3>']],
  ['- один\n- два\n\n1. раз\n2. два', ['<ul><li>один</li><li>два</li></ul>', '<ol><li>раз</li><li>два</li></ol>']],
  ['[линк](https://example.com)', ['<a href="https://example.com" target="_blank" rel="noopener">линк</a>']],
  ['[зло](javascript:alert(1))', []], // must not become a link
  ['```js\nconst x = 1 < 2;\n```', ['<pre class="md-code"><code>const x = 1 &lt; 2;</code></pre>']],
  ['<script>alert(1)</script>', ['&lt;script&gt;']],
  ['> цитата', ['<blockquote>цитата</blockquote>']],
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
}
console.log(failed ? `${failed} FAILED` : 'MD OK');
process.exit(failed ? 1 : 0);
