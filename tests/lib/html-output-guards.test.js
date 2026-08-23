import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertHtmlComplete, externalLinksAdded, futureDatesAdded } from '../../lib/html-output-guards.js';

test('throws when the model stopped at max_tokens (truncated output)', () => {
  assert.throws(
    () => assertHtmlComplete({ html: '<p>fine</p>', stopReason: 'max_tokens' }),
    /max_tokens|truncat/i
  );
});

test('throws on an unclosed href attribute (truncated mid-link)', () => {
  assert.throws(
    () => assertHtmlComplete({ html: '<p>see <a href="https://x.com/best', stopReason: 'end_turn' }),
    /href/i
  );
});

test('passes for complete HTML that ended normally', () => {
  assert.doesNotThrow(() =>
    assertHtmlComplete({ html: '<p>see <a href="https://x.com/best">best</a></p>', stopReason: 'end_turn' })
  );
});

test('passes when stopReason is absent and HTML is well-formed', () => {
  assert.doesNotThrow(() => assertHtmlComplete({ html: '<p>hello</p>' }));
});

// ── unclosed block tags: truncation that ends mid-PROSE, not mid-link ──────────
//
// The cannibalization-resolver's merge hit its 8000-token ceiling and returned
// HTML ending "...fragrance-free (or scented" — no closing </p>, no CTA, no
// Sources section. stop_reason was not inspected and the href check did not fire
// (the cut was mid-sentence, not mid-attribute), so this shape passed every
// guard the fleet had. Verified against all 203 live articles: zero unbalanced.
import { unclosedBlockTags } from '../../lib/html-output-guards.js';

test('unclosedBlockTags: flags a paragraph left open by truncation', () => {
  const truncated = '<h2>Title</h2>\n<p>done</p>\n<p>cut off mid sen';
  assert.deepEqual(unclosedBlockTags(truncated), [{ tag: 'p', open: 2, close: 1 }]);
});

test('unclosedBlockTags: empty for well-formed HTML', () => {
  assert.deepEqual(unclosedBlockTags('<h2>T</h2><ul><li>a</li><li>b</li></ul><p>x</p>'), []);
});

test('unclosedBlockTags: does not confuse <pre> with <p>', () => {
  assert.deepEqual(unclosedBlockTags('<pre>code</pre><p>x</p>'), []);
});

test('unclosedBlockTags: counts an attributed opening tag (not just the bare form)', () => {
  // balanced with attributes → clean
  assert.deepEqual(unclosedBlockTags('<p class="lead">x</p><li id="a">y</li>'), []);
  // attributed tag left open → still counted
  assert.deepEqual(unclosedBlockTags('<p class="lead">x</p><li id="a">y'), [{ tag: 'li', open: 1, close: 0 }]);
});

test('unclosedBlockTags: empty/missing input is clean', () => {
  assert.deepEqual(unclosedBlockTags(''), []);
  assert.deepEqual(unclosedBlockTags(null), []);
});

test('assertHtmlComplete throws on truncation that left a block tag open', () => {
  assert.throws(
    () => assertHtmlComplete({ html: '<p>done</p><p>cut off mid sen', stopReason: 'end_turn' }),
    /unclosed|truncat/i
  );
});

test('assertHtmlComplete still passes well-formed HTML with balanced blocks', () => {
  assert.doesNotThrow(() =>
    assertHtmlComplete({ html: '<h2>T</h2><ul><li>a</li></ul><p>x</p>', stopReason: 'end_turn' })
  );
});

// ── fabricated-fact guards (content-remediator must not invent citations/dates) ──
const ORIG = '<p>PFAS in cosmetics. <a href="https://www.realskincare.com/x">internal</a></p>';

test('externalLinksAdded flags a newly-introduced off-site citation', () => {
  const rev = ORIG + '<p>See <a href="https://www.fda.gov/dead-404">FDA</a></p>';
  const added = externalLinksAdded(ORIG, rev);
  assert.equal(added.length, 1);
  assert.match(added[0], /fda\.gov/);
});
test('externalLinksAdded ignores unchanged content and added INTERNAL links', () => {
  assert.deepEqual(externalLinksAdded(ORIG, ORIG), []);
  assert.deepEqual(externalLinksAdded(ORIG, ORIG + '<a href="https://www.realskincare.com/y">i2</a>'), []);
});
test('futureDatesAdded flags a same-year future month and a future bare year', () => {
  const now = { year: 2026, month: 6 }; // June 2026
  assert.deepEqual(futureDatesAdded('the report', 'the report (December 2026)', now), ['december 2026']);
  assert.deepEqual(futureDatesAdded('x', 'published 2027', now), ['2027']);
});
test('futureDatesAdded ignores pre-existing, past, and earlier-this-year dates', () => {
  const now = { year: 2026, month: 6 };
  assert.deepEqual(futureDatesAdded('from December 2026', 'from December 2026', now), []); // already present
  assert.deepEqual(futureDatesAdded('x', 'study from March 2025', now), []);               // past
  assert.deepEqual(futureDatesAdded('x', 'in May 2026', now), []);                          // earlier this year
});

// ── droppedLinks: which links a revision lost, not just how many ─────────────
// content-remediator's guard reported only counts ("16 < 19"), which is a number
// nobody can act on and nothing can retry against. Naming the anchors lets the
// reviser be told exactly what to put back.
const LINKED = '<p>See <a href="https://www.realskincare.com/a">alpha</a> and <a href="https://www.realskincare.com/b">beta</a>.</p>';

test('droppedLinks names the href and anchor text of each lost link', async () => {
  const { droppedLinks } = await import('../../lib/html-output-guards.js');
  const revised = '<p>See <a href="https://www.realskincare.com/a">alpha</a> and beta.</p>';
  const gone = droppedLinks(LINKED, revised);
  assert.equal(gone.length, 1);
  assert.equal(gone[0].href, 'https://www.realskincare.com/b');
  assert.equal(gone[0].anchor, 'beta');
});

test('droppedLinks returns [] when every link survives, even if prose changed', async () => {
  const { droppedLinks } = await import('../../lib/html-output-guards.js');
  assert.deepEqual(droppedLinks(LINKED, LINKED.replace('See', 'Have a look at')), []);
});

test('droppedLinks is count-aware for repeated hrefs', async () => {
  const { droppedLinks } = await import('../../lib/html-output-guards.js');
  const twice = '<a href="/x">one</a><a href="/x">two</a>';
  const once = '<a href="/x">one</a>';
  assert.equal(droppedLinks(twice, once).length, 1);
  assert.deepEqual(droppedLinks(once, twice), []);
});

test('droppedLinks strips nested markup from the anchor text', async () => {
  const { droppedLinks } = await import('../../lib/html-output-guards.js');
  const gone = droppedLinks('<a href="/x"><strong>bold  anchor</strong></a>', '');
  assert.equal(gone[0].anchor, 'bold anchor');
});
