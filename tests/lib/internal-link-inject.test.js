import { test } from 'node:test';
import assert from 'node:assert/strict';
import { injectLink } from '../../lib/internal-link-inject.js';

// ── the live defect ──────────────────────────────────────────────────────────
//
// `agents/internal-linker` inserts <a href="…"> anchors into an article body
// with a regex over the WHOLE HTML string. An article body carries injected
// JSON-LD in a <script type="application/ld+json"> block, and that block is
// full of prose — FAQ questions and answers, the Article headline and
// description — so the anchor text the model picked out of the visible article
// also occurs inside the JSON.
//
// Wrapping it there splices raw <a href="…"> markup, with its unescaped double
// quotes, into a JSON *string value*. The block stops parsing. Measured live
// 2026-08-24: 30 of 183 blog pages carry at least one JSON-LD block that will
// not JSON.parse, and every one of them is an injected block (FAQPage, the
// injected Article, HowTo). The theme's own BreadcrumbList is untouched, because
// it holds no prose for a linker to hit.
//
// The fix is a positive guard: a replacement may only land in a prose region.

const LD_BODY = `<h2>Natural deodorant</h2>
<p>Switching to a natural deodorant takes about two weeks.</p>
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"FAQPage","mainEntity":[{"@type":"Question","name":"How long is the transition?","acceptedAnswer":{"@type":"Answer","text":"Switching to a natural deodorant takes about two weeks."}}]}
</script>`;

function ldBlocks(html) {
  return [...html.matchAll(
    /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  )].map((m) => m[1]);
}

test('a link is never inserted inside a JSON-LD block', () => {
  const { html, applied } = injectLink(
    LD_BODY, 'natural deodorant', 'https://www.realskincare.com/blogs/news/x', 'X'
  );
  assert.equal(applied, true, 'the visible paragraph should still get its link');

  for (const raw of ldBlocks(html)) {
    assert.doesNotThrow(() => JSON.parse(raw),
      'JSON-LD must still parse after a link is injected');
    assert.ok(!raw.includes('<a href'),
      'no anchor markup may appear inside a JSON-LD block');
  }
});

test('the JSON-LD block is left byte-identical', () => {
  const { html } = injectLink(
    LD_BODY, 'natural deodorant', 'https://www.realskincare.com/blogs/news/x', 'X'
  );
  assert.deepEqual(ldBlocks(html), ldBlocks(LD_BODY));
});

// The dangerous shape: the anchor text occurs ONLY inside the script block.
// The old code happily linked it; there is nothing to link, so nothing should
// happen and the block must survive.
test('anchor text that occurs only inside JSON-LD is not applied at all', () => {
  const body = `<p>Nothing relevant here.</p>
<script type="application/ld+json">
{"@type":"FAQPage","mainEntity":[{"@type":"Question","name":"Is coconut oil comedogenic?"}]}
</script>`;
  const { html, applied } = injectLink(body, 'coconut oil', 'https://x.test/a', 'A');
  assert.equal(applied, false);
  assert.equal(html, body);
  assert.doesNotThrow(() => JSON.parse(ldBlocks(html)[0]));
});

// ── the other non-prose regions ──────────────────────────────────────────────

test('a link is never inserted inside a <style> block', () => {
  const body = `<style>.body-lotion { color: red; }</style><p>Our body lotion is thick.</p>`;
  const { html, applied } = injectLink(body, 'body lotion', 'https://x.test/a', 'A');
  assert.equal(applied, true);
  assert.ok(html.startsWith('<style>.body-lotion { color: red; }</style>'),
    'the style block must be untouched');
});

test('a link is never inserted inside a plain <script> block', () => {
  const body = `<script>var t = "hand soap";</script><p>Try our hand soap today.</p>`;
  const { html } = injectLink(body, 'hand soap', 'https://x.test/a', 'A');
  assert.ok(html.startsWith('<script>var t = "hand soap";</script>'));
  assert.ok(html.includes('<a href="https://x.test/a" title="A">hand soap</a>'));
});

test('a link is never inserted inside an HTML comment', () => {
  const body = `<!-- CTA: lip balm block goes here --><p>Our lip balm is unscented.</p>`;
  const { html } = injectLink(body, 'lip balm', 'https://x.test/a', 'A');
  assert.ok(html.startsWith('<!-- CTA: lip balm block goes here -->'));
  assert.ok(html.includes('>lip balm</a>'));
});

test('a link is never inserted inside an existing anchor', () => {
  const body = `<p>See <a href="/old">bar soap</a> and also bar soap here.</p>`;
  const { html } = injectLink(body, 'bar soap', 'https://x.test/a', 'A');
  assert.ok(html.includes('<a href="/old">bar soap</a>'), 'the existing anchor is untouched');
  assert.equal((html.match(/<a /g) || []).length, 2, 'exactly one new anchor');
});

test('a link is never inserted inside tag markup (attribute values)', () => {
  const body = `<p><img src="/x.png" alt="natural soap bar"> A natural soap bar lasts weeks.</p>`;
  const { html } = injectLink(body, 'natural soap bar', 'https://x.test/a', 'A');
  assert.ok(html.includes('alt="natural soap bar"'), 'the alt attribute is untouched');
  assert.ok(html.includes('<a href="https://x.test/a" title="A">natural soap bar</a>'));
});

// ── behaviour that must not regress ──────────────────────────────────────────

test('headings are still skipped', () => {
  const body = `<h2>Best natural deodorant</h2><p>Best natural deodorant picks below.</p>`;
  const { html } = injectLink(body, 'best natural deodorant', 'https://x.test/a', 'A');
  assert.ok(html.startsWith('<h2>Best natural deodorant</h2>'), 'the heading is untouched');
  assert.ok(html.includes('>Best natural deodorant</a>'), 'the paragraph is linked');
});

test('only the first prose occurrence is linked', () => {
  const body = `<p>lip balm here and lip balm again.</p>`;
  const { html } = injectLink(body, 'lip balm', 'https://x.test/a', 'A');
  assert.equal((html.match(/<a /g) || []).length, 1);
  assert.equal(html, `<p><a href="https://x.test/a" title="A">lip balm</a> here and lip balm again.</p>`);
});

test('matching is case-insensitive and preserves the original casing', () => {
  const body = `<p>Coconut Oil is the base.</p>`;
  const { html } = injectLink(body, 'coconut oil', 'https://x.test/a', 'A');
  assert.ok(html.includes('>Coconut Oil</a>'));
});

test('a quote in the title is escaped', () => {
  const body = `<p>hand soap</p>`;
  const { html } = injectLink(body, 'hand soap', 'https://x.test/a', 'The "Best" Soap');
  assert.ok(html.includes('title="The &quot;Best&quot; Soap"'));
});

test('anchor text with regex metacharacters is matched literally', () => {
  const body = `<p>Read our FAQ (2026) now.</p>`;
  const { html, applied } = injectLink(body, 'FAQ (2026)', 'https://x.test/a', 'A');
  assert.equal(applied, true);
  assert.ok(html.includes('>FAQ (2026)</a>'));
});

test('missing anchor text is a no-op', () => {
  const body = `<p>nothing here</p>`;
  const { html, applied } = injectLink(body, 'body butter', 'https://x.test/a', 'A');
  assert.equal(applied, false);
  assert.equal(html, body);
});

// A real post body: prose, an existing anchor, a heading, the featured-product
// CTA, and the injected JSON-LD — all at once.
test('a realistic body keeps every JSON-LD block parseable', () => {
  const body = `<h2>Best Soap for Tattoos</h2>
<p>A fragrance-free soap is the safest choice for a new tattoo.</p>
<p>See our <a href="/collections/soap">fragrance-free soap</a> range.</p>
<!-- FEATURED PRODUCT -->
<div class="rsc-featured-product"><h2>Our pick for fragrance-free soap: Coconut Soap</h2></div>
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"Article","headline":"Best Soap for Tattoos","description":"A fragrance-free soap is the safest choice for a new tattoo."}
</script>
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"BreadcrumbList","itemListElement":[{"@type":"ListItem","position":1,"name":"Home"}]}
</script>`;

  const { html, applied } = injectLink(body, 'fragrance-free soap', 'https://x.test/a', 'A');
  assert.equal(applied, true);
  const blocks = ldBlocks(html);
  assert.equal(blocks.length, 2);
  for (const raw of blocks) assert.doesNotThrow(() => JSON.parse(raw));
  assert.deepEqual(blocks, ldBlocks(body), 'both JSON-LD blocks byte-identical');
  // the link landed in the first paragraph, not in the existing anchor
  assert.ok(html.includes('<p>A <a href="https://x.test/a" title="A">fragrance-free soap</a> is the safest'));
  assert.ok(html.includes('<a href="/collections/soap">fragrance-free soap</a>'));
});
