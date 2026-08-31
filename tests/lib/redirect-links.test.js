// tests/lib/redirect-links.test.js
//
// 1,222 INTERNAL LINKS — 29.5% OF EVERY INTERNAL LINK ON THE BLOG — POINT AT A
// REDIRECT SOURCE, ACROSS 174 OF 188 LIVE PAGES.
//
// Measured read-only 2026-08-31 by joining every `<a href>` in every live
// article against Shopify's own redirect table (233 entries). No crawl needed:
// the redirect table IS the ground truth for "is this path a redirect source".
//
// The top targets are the retired collections from the 62 → 5 consolidation,
// and they are COMMERCIAL links — the buy path out of blog content:
//
//     89  /collections/natural-bar-soap      -> /products/coconut-soap
//     85  /collections/coconut-oil-lotion    -> /collections/non-toxic-body-lotion
//     71  /collections/organic-body-lotion   -> /collections/non-toxic-body-lotion
//     66  /collections/natural-deodorant     -> /products/coconut-oil-deodorant
//     64  /collections/natural-toothpaste    -> /products/coconut-oil-toothpaste
//
// BE HONEST ABOUT THE VALUE. A 301 passes essentially full ranking signal, so
// this is NOT a ranking loss and must not be sold as one. What it costs is a
// redundant round trip on every click into the buy path (worst on mobile) and
// crawl budget spent re-discovering the same destination. It is worth doing
// because the fix is fully deterministic — the redirect table IS the mapping,
// no model call and no judgement — not because rankings are bleeding.
//
// `agents/link-repair` cannot see any of this: it only acts on 404s, and every
// one of these resolves 200 for a reader. That is why it went unnoticed.
//
// ── WHY THIS DOES NOT REUSE lib/html-prose.js ────────────────────────────────
//
// That module answers "where is it safe to insert PROSE", and it marks tag
// markup — attribute values included — as PROTECTED. Here the attribute value
// is exactly what must change, so `isProse` would reject every edit this makes.
// The one thing both need is the raw-text scan: an `<a href>` inside a
// `<script type="application/ld+json">` block is a JSON string, not a link, and
// 58 live pages carry anchors trapped inside JSON-LD (CLAUDE.md documents them
// and the deliberate decision to leave them alone). Rewriting one would edit
// structured data while pretending to fix a link, so script and style CONTENTS
// are skipped here too — same hazard, opposite polarity, so the scan is written
// for this job rather than bent out of the other one.
//
// ── THE CONSERVATIVE CHOICES, EACH PINNED BELOW ──────────────────────────────
//
//  * A QUERY STRING IS SKIPPED, NOT REWRITTEN. `/collections/x?variant=123`
//    carries state that is meaningless on a different destination, and Shopify
//    maps PATHS. Rewriting would silently drop or mistranslate it, so these are
//    reported and left. Unknown-means-leave-alone, the same safety property
//    lib/product-category-terms.js states for its whitelists.
//  * A CYCLE OR AN OVER-LONG CHAIN YIELDS NO REWRITE. Not a throw, not a
//    partial hop — the link is left exactly as it is and reported.
//  * ONLY `<a href>`. An `<img src>` or a `<link href>` pointing at a redirect
//    is not a reader's click path and is not this script's business.

import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveRedirectChain, rewriteRedirectLinks } from '../../lib/redirect-links.js';

const MAP = new Map([
  ['/collections/natural-bar-soap', '/products/coconut-soap'],
  ['/collections/coconut-oil-lotion', '/collections/non-toxic-body-lotion'],
  // a real two-hop chain from the live table
  ['/blogs/news/best-sls-free-toothpaste-2025', '/blogs/news/sls-free-toothpaste-list-best-options-for-2026'],
  ['/blogs/news/sls-free-toothpaste-list-best-options-for-2026', '/blogs/news/toothpaste-without-sls-what-to-know-best-options'],
  // a cycle, which must never hang or half-apply
  ['/a', '/b'],
  ['/b', '/a'],
]);

const a = (href, text = 'link') => `<p>See <a href="${href}">${text}</a> for more.</p>`;

// ── chain resolution ─────────────────────────────────────────────────────────

test('a single hop resolves to its target', () => {
  assert.deepEqual(resolveRedirectChain('/collections/natural-bar-soap', MAP), {
    target: '/products/coconut-soap',
    hops: 1,
  });
});

test('a chain resolves all the way to the end, not one hop', () => {
  // Rewriting to the intermediate would leave a redirect behind — the bug this
  // fix exists to remove, moved one step along.
  assert.deepEqual(resolveRedirectChain('/blogs/news/best-sls-free-toothpaste-2025', MAP), {
    target: '/blogs/news/toothpaste-without-sls-what-to-know-best-options',
    hops: 2,
  });
});

test('a path that is not a redirect source resolves to itself at zero hops', () => {
  assert.deepEqual(resolveRedirectChain('/products/coconut-soap', MAP), {
    target: '/products/coconut-soap',
    hops: 0,
  });
});

test('a cycle returns no target rather than looping', () => {
  assert.equal(resolveRedirectChain('/a', MAP).target, null);
});

test('a trailing slash still matches', () => {
  assert.equal(resolveRedirectChain('/collections/natural-bar-soap/', MAP).target, '/products/coconut-soap');
});

// ── rewriting ────────────────────────────────────────────────────────────────

test('a root-relative href is rewritten', () => {
  const { html, rewrites } = rewriteRedirectLinks(a('/collections/natural-bar-soap'), MAP);
  assert.match(html, /href="\/products\/coconut-soap"/);
  assert.equal(rewrites.length, 1);
  assert.equal(rewrites[0].from, '/collections/natural-bar-soap');
});

test('an absolute href on our own domain is rewritten, keeping it absolute', () => {
  const { html } = rewriteRedirectLinks(
    a('https://www.realskincare.com/collections/natural-bar-soap'), MAP,
  );
  assert.match(html, /href="https:\/\/www\.realskincare\.com\/products\/coconut-soap"/);
});

test('an external domain is never touched', () => {
  const src = a('https://www.example.com/collections/natural-bar-soap');
  assert.equal(rewriteRedirectLinks(src, MAP).html, src);
});

test('a chain is rewritten straight to the final destination', () => {
  const { html } = rewriteRedirectLinks(a('/blogs/news/best-sls-free-toothpaste-2025'), MAP);
  assert.match(html, /href="\/blogs\/news\/toothpaste-without-sls-what-to-know-best-options"/);
});

test('a fragment is carried over', () => {
  const { html } = rewriteRedirectLinks(a('/collections/natural-bar-soap#reviews'), MAP);
  assert.match(html, /href="\/products\/coconut-soap#reviews"/);
});

test('a query string is SKIPPED and reported, never guessed at', () => {
  const src = a('/collections/natural-bar-soap?variant=123');
  const { html, rewrites, skipped } = rewriteRedirectLinks(src, MAP);
  assert.equal(html, src, 'the link must be left exactly as it was');
  assert.equal(rewrites.length, 0);
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].reason, 'query-string');
});

test('a cyclic link is skipped and reported, not half-applied', () => {
  const src = a('/a');
  const { html, skipped } = rewriteRedirectLinks(src, MAP);
  assert.equal(html, src);
  assert.equal(skipped[0].reason, 'unresolvable-chain');
});

// ── the JSON-LD hazard ───────────────────────────────────────────────────────

test('an anchor inside a script block is NEVER rewritten', () => {
  // 58 live pages carry anchors trapped inside JSON-LD. Editing one would be
  // rewriting structured data while claiming to fix a link.
  const src = '<script type="application/ld+json">'
    + '{"text":"<a href=\\"/collections/natural-bar-soap\\">soap</a>"}'
    + '</script>' + a('/collections/natural-bar-soap');
  const { html, rewrites } = rewriteRedirectLinks(src, MAP);
  assert.equal(rewrites.length, 1, 'only the real anchor outside the script');
  assert.match(html, /ld\+json">\{"text":"<a href=\\"\/collections\/natural-bar-soap/);
  assert.match(html, /<p>See <a href="\/products\/coconut-soap">/);
});

test('an unclosed script protects the rest of the document', () => {
  // Same failure direction lib/html-prose.js chose: a region we cannot parse
  // stays protected, so the worst case is a skipped edit, never a corrupted page.
  const src = '<script>' + a('/collections/natural-bar-soap');
  assert.equal(rewriteRedirectLinks(src, MAP).rewrites.length, 0);
});

// ── scope ────────────────────────────────────────────────────────────────────

test('an img src pointing at a redirect is left alone', () => {
  const src = '<img src="/collections/natural-bar-soap.jpg">';
  assert.equal(rewriteRedirectLinks(src, MAP).html, src);
});

test('other attributes on the anchor survive untouched', () => {
  const src = '<a class="btn" href="/collections/natural-bar-soap" rel="noopener" target="_blank">x</a>';
  const { html } = rewriteRedirectLinks(src, MAP);
  assert.match(html, /class="btn"/);
  assert.match(html, /rel="noopener"/);
  assert.match(html, /target="_blank"/);
  assert.match(html, /href="\/products\/coconut-soap"/);
});

test('every occurrence is rewritten, not just the first', () => {
  const src = a('/collections/natural-bar-soap') + a('/collections/natural-bar-soap');
  const { html, rewrites } = rewriteRedirectLinks(src, MAP);
  assert.equal(rewrites.length, 2);
  assert.equal((html.match(/\/products\/coconut-soap/g) || []).length, 2);
});

test('IDEMPOTENT — a second pass changes nothing', () => {
  // The scheduler republishes daily; a rewrite that kept firing would churn
  // body_html on live pages forever.
  const once = rewriteRedirectLinks(a('/collections/natural-bar-soap'), MAP).html;
  const twice = rewriteRedirectLinks(once, MAP);
  assert.equal(twice.html, once);
  assert.equal(twice.rewrites.length, 0);
});

test('a document with nothing to fix is returned byte-identical', () => {
  const src = a('/products/coconut-soap');
  const out = rewriteRedirectLinks(src, MAP);
  assert.equal(out.html, src);
  assert.equal(out.rewrites.length, 0);
});

test('single-quoted and unquoted hrefs are left alone rather than mangled', () => {
  // Shopify normalizes to double quotes; anything else is unexpected input and
  // the safe response is to decline, not to improvise a parse.
  const src = "<a href='/collections/natural-bar-soap'>x</a>";
  assert.equal(rewriteRedirectLinks(src, MAP).html, src);
});
