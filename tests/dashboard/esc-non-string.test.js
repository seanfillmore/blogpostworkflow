// The dashboard's esc() is browser code with no exports, so it is lifted out of
// the source and evaluated. It used to call s.replace on whatever it got, and a
// numeric Social insight (views, reach) threw and froze the Social tab.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../../agents/dashboard/public/js/dashboard.js', import.meta.url), 'utf8');
function lift(name) {
  const i = src.indexOf(`function ${name}(`);
  let depth = 0;
  for (let k = src.indexOf('{', i); k < src.length; k++) {
    if (src[k] === '{') depth++;
    else if (src[k] === '}' && --depth === 0) return src.slice(i, k + 1);
  }
  throw new Error(`${name} not found`);
}
const esc = new Function(`${lift('esc')}; return esc;`)();
const socialStat = new Function(`${lift('esc')}; ${lift('socialStat')}; return socialStat;`)();

test('esc accepts numbers, including 0', () => {
  assert.equal(esc(42), '42');
  assert.equal(esc(0), '0');
});

test('esc still escapes strings and blanks null/undefined', () => {
  assert.equal(esc('<a href="x">&</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;');
  assert.equal(esc(null), '');
  assert.equal(esc(undefined), '');
  assert.equal(esc(''), '');
});

test('a posted item with numeric insights renders its stats', () => {
  assert.equal(socialStat('views', 0) + socialStat('reach', 42), 'views 0 &middot; reach 42 &middot; ');
  assert.equal(socialStat('likes', undefined), '');
});
