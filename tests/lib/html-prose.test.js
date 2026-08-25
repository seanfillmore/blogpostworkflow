import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  protectedRanges, isProse, replaceFirstInProse, DEFAULT_OPAQUE_ELEMENTS,
} from '../../lib/html-prose.js';

/** The substrings of `html` the scanner says are off limits. */
function protectedText(html, opts) {
  return protectedRanges(html, opts).map(([s, e]) => html.slice(s, e));
}

/** The substrings of `html` the scanner says are prose. */
function proseText(html, opts) {
  const ranges = protectedRanges(html, opts);
  const out = [];
  let cursor = 0;
  for (const [s, e] of ranges) {
    if (s > cursor) out.push(html.slice(cursor, s));
    cursor = Math.max(cursor, e);
  }
  if (cursor < html.length) out.push(html.slice(cursor));
  return out;
}

// ── what counts as prose ─────────────────────────────────────────────────────

test('plain text is entirely prose', () => {
  assert.deepEqual(protectedRanges('just some words'), []);
  assert.deepEqual(proseText('just some words'), ['just some words']);
});

test('tag markup is protected, the text between tags is not', () => {
  assert.deepEqual(proseText('<p class="a">hello</p>'), ['hello']);
});

test('an attribute value containing > does not end the tag early', () => {
  const html = '<img alt="a > b"> visible';
  assert.deepEqual(proseText(html), [' visible']);
});

test('an attribute value containing < is not read as a new tag', () => {
  const html = `<img alt="a < b" title="x"> visible`;
  assert.deepEqual(proseText(html), [' visible']);
});

test('a bare < in prose is not treated as markup', () => {
  assert.deepEqual(proseText('use 2 < 3 water'), ['use 2 < 3 water']);
});

// ── raw-text elements ────────────────────────────────────────────────────────

test('script contents are protected', () => {
  const html = '<p>before</p><script>var a = "x";</script><p>after</p>';
  // Ranges are merged, so the script's content arrives joined to its own tags.
  assert.ok(protectedText(html).some((t) => t.includes('var a = "x";')));
  assert.deepEqual(proseText(html), ['before', 'after']);
});

test('a JSON-LD block is protected in full', () => {
  const html = `a<script type="application/ld+json">{"name":"a"}</script>b`;
  assert.deepEqual(proseText(html), ['a', 'b']);
});

test('a < inside a script string does not confuse the scanner', () => {
  const html = `<script>if (a < b) { s = "</p>"; }</script><p>real</p>`;
  assert.deepEqual(proseText(html), ['real']);
});

test('style contents are protected', () => {
  const html = '<style>p { color: red }</style><p>real</p>';
  assert.deepEqual(proseText(html), ['real']);
});

test('an UNCLOSED script protects the rest of the document', () => {
  const html = '<p>ok</p><script>var a = 1;<p>unreachable</p>';
  assert.deepEqual(proseText(html), ['ok']);
});

test('a script close tag is matched case-insensitively', () => {
  const html = '<SCRIPT>hidden</SCRIPT><p>real</p>';
  assert.deepEqual(proseText(html), ['real']);
});

// ── comments ─────────────────────────────────────────────────────────────────

test('comment contents are protected', () => {
  const html = '<!-- FEATURED PRODUCT --><p>real</p>';
  assert.deepEqual(proseText(html), ['real']);
});

test('an UNTERMINATED comment protects the rest of the document', () => {
  const html = '<p>ok</p><!-- oops <p>unreachable</p>';
  assert.deepEqual(proseText(html), ['ok']);
});

test('a > inside a comment does not end it', () => {
  const html = '<!-- a > b --><p>real</p>';
  assert.deepEqual(proseText(html), ['real']);
});

// ── opaque elements ──────────────────────────────────────────────────────────

test('anchor contents are protected by default', () => {
  const html = '<p>see <a href="/x">this link</a> now</p>';
  assert.ok(protectedText(html).some((t) => t.includes('this link')));
  assert.deepEqual(proseText(html), ['see ', ' now']);
});

test('heading contents are protected by default', () => {
  const html = '<h2>Title</h2><p>body</p>';
  assert.deepEqual(proseText(html), ['body']);
});

test('h4 through h6 are protected too, not just h1-h3', () => {
  assert.deepEqual(DEFAULT_OPAQUE_ELEMENTS, ['a', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
  assert.deepEqual(proseText('<h5>Sub</h5><p>body</p>'), ['body']);
});

test('an anchor whose opening tag is far beyond a 300-char lookback is still caught', () => {
  // This is the exact case the old fixed-window scan missed.
  const filler = 'x'.repeat(500);
  const html = `<p><a href="/x">${filler} target</a></p><p>target</p>`;
  const ranges = protectedRanges(html);
  const inside = html.indexOf('target');
  assert.equal(isProse(ranges, inside, inside + 6), false);
  const outside = html.lastIndexOf('target');
  assert.equal(isProse(ranges, outside, outside + 6), true);
});

test('an </a> inside an attribute value does not close the anchor early', () => {
  const html = `<a href="/x"><img alt="</a>"> target</a><p>target</p>`;
  const ranges = protectedRanges(html);
  assert.equal(isProse(ranges, html.indexOf('target'), html.indexOf('target') + 6), false);
});

test('an UNCLOSED anchor protects the rest of the document', () => {
  const html = '<p>ok</p><p><a href="/x">dangling<p>unreachable</p>';
  assert.deepEqual(proseText(html), ['ok']);
});

test('nested same-name elements unwind by depth, not on the first close', () => {
  // <a> cannot legally nest, but the scanner must not be fooled if it does.
  const html = '<a href="/1">one<a href="/2">two</a>three</a><p>real</p>';
  assert.deepEqual(proseText(html), ['real']);
});

test('a self-closing opaque tag does not open a protected region', () => {
  const html = '<a href="/x"/><p>real prose</p>';
  assert.ok(proseText(html).includes('real prose'));
});

test('the opaque set is configurable and can be emptied', () => {
  const html = '<h2>Heading text</h2>';
  assert.deepEqual(proseText(html, { opaqueElements: [] }), ['Heading text']);
});

// ── isProse ──────────────────────────────────────────────────────────────────

test('isProse is false for a span that merely overlaps a protected region', () => {
  const html = 'ab<script>cd</script>ef';
  const ranges = protectedRanges(html);
  assert.equal(isProse(ranges, 0, 2), true);           // 'ab'
  assert.equal(isProse(ranges, 0, 12), false);         // straddles the script
  assert.equal(isProse(ranges, html.length - 2, html.length), true); // 'ef'
});

// ── replaceFirstInProse ──────────────────────────────────────────────────────

test('the first prose match wins, protected matches are skipped not aborted', () => {
  const html = '<script>soap</script><p>soap</p>';
  const r = replaceFirstInProse(html, /soap/i, () => 'SOAP');
  assert.equal(r.applied, true);
  assert.equal(r.html, '<script>soap</script><p>SOAP</p>');
});

test('no prose match returns the input unchanged', () => {
  const html = '<script>soap</script>';
  const r = replaceFirstInProse(html, /soap/i, () => 'SOAP');
  assert.equal(r.applied, false);
  assert.equal(r.html, html);
  assert.equal(r.index, -1);
});

test('a replacement containing $& or $1 is inserted verbatim', () => {
  const r = replaceFirstInProse('<p>soap</p>', /(soap)/i, () => '$& and $1');
  assert.equal(r.html, '<p>$& and $1</p>');
});

test('a sticky or global pattern is normalised rather than misbehaving', () => {
  for (const flags of ['g', 'y', 'gi', '']) {
    const r = replaceFirstInProse('<p>a soap b soap</p>', new RegExp('soap', flags), () => 'X');
    assert.equal(r.html, '<p>a X b soap</p>', `flags: "${flags}"`);
  }
});

test('an empty input is a no-op', () => {
  assert.deepEqual(replaceFirstInProse('', /x/, () => 'y'), { html: '', applied: false, index: -1 });
});

test('a pattern that can match empty does not spin', () => {
  const r = replaceFirstInProse('<p>abc</p>', /x*/, () => 'Q');
  assert.equal(r.applied, false);
});

// ── the shape that produced the live damage ──────────────────────────────────

test('a body whose JSON-LD is PREPENDED (what schema-injector emits) is safe', () => {
  // agents/schema-injector returns `blocks + '\n' + cleaned`, so byte 0 of
  // every injected post is a script tag. The old `html.search()` found its
  // first match there, every time.
  const html = `<script type="application/ld+json">
{"@context":"https://schema.org","@type":"FAQPage","mainEntity":[{"@type":"Question","name":"Is natural deodorant effective?","acceptedAnswer":{"@type":"Answer","text":"Yes — natural deodorant works once the transition is over."}}]}
</script>
<h2>Natural deodorant</h2>
<p>Most people find natural deodorant effective after two weeks.</p>`;

  const r = replaceFirstInProse(html, /natural deodorant/i, () => 'LINKED');
  assert.equal(r.applied, true);
  const block = r.html.match(/<script[^>]*>([\s\S]*?)<\/script>/)[1];
  assert.doesNotThrow(() => JSON.parse(block));
  assert.ok(!block.includes('LINKED'), 'the schema block must be untouched');
  assert.ok(r.html.includes('Most people find LINKED effective'),
    'the paragraph — not the heading, not the schema — is what changed');
});
