// tests/lib/faq-blocks.test.js
//
// `agents/editor`'s rule 8 (COMPETITOR NAMES IN FAQ, a BLOCKER) used to find its
// Q&As by parsing the `FAQPage` JSON-LD that `agents/schema-injector` prepended
// to the body. The injector stopped emitting FAQPage on 2026-08-24 — Google
// removed the FAQ rich result — so a schema-fed rule would have gone silently
// Pass on every post from that day on, which is a compliance check quietly
// switching itself off rather than a no-op.
//
// It reads the PROSE now, through this module, which is the same extractor
// `agents/faq-rewriter` has always used. Sharing it is not tidiness: the editor
// AUTO-FIXES competitor names by delegating to faq-rewriter (editor step 1c),
// and faq-rewriter only ever rewrote prose. The check and the fix were reading
// two different copies of the FAQ, and the schema copy was the stale one — so a
// post whose prose had just been cleaned could still be BLOCKED for a name that
// no longer appeared anywhere on the page.

import test from 'node:test';
import assert from 'node:assert/strict';

import { extractFaqBlocks, extractFaqQAs } from '../../lib/faq-blocks.js';

const HEADING_FAQ = `
<h2>Frequently Asked Questions</h2>
<h3>Is coconut oil deodorant safe for sensitive skin?</h3>
<p>Yes for most people. It has no aluminium and no baking soda.</p>
<h3>How long does a jar last?</h3>
<p>About three months at one swipe a day.</p>
`;

const STRONG_FAQ = `
<p><strong>Does it stain clothes?</strong><br>No, it absorbs without an oily residue.</p>
`;

test('extracts the heading + paragraph FAQ shape', () => {
  const blocks = extractFaqBlocks(HEADING_FAQ);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].q, 'Is coconut oil deodorant safe for sensitive skin?');
  assert.match(blocks[0].a, /no aluminium/i);
  assert.equal(blocks[1].q, 'How long does a jar last?');
});

test('extracts the <p><strong>Q</strong><br>A</p> FAQ shape', () => {
  const blocks = extractFaqBlocks(STRONG_FAQ);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].q, 'Does it stain clothes?');
  assert.match(blocks[0].a, /absorbs/);
});

test('blocks carry source offsets so a caller can replace in place', () => {
  const html = `<p>Intro paragraph.</p>${STRONG_FAQ}`;
  const [b] = extractFaqBlocks(html);
  assert.equal(html.slice(b.start, b.end), b.raw);
});

test('blocks come back in source order across both patterns', () => {
  const blocks = extractFaqBlocks(STRONG_FAQ + HEADING_FAQ);
  const starts = blocks.map((b) => b.start);
  assert.deepEqual(starts, [...starts].sort((a, b) => a - b));
});

test('a heading without a question mark is not an FAQ', () => {
  assert.equal(extractFaqBlocks('<h3>How it works</h3><p>Body text.</p>').length, 0);
});

test('a post with no FAQ section yields nothing', () => {
  assert.deepEqual(extractFaqBlocks('<p>Just prose.</p>'), []);
  assert.deepEqual(extractFaqBlocks(''), []);
  assert.deepEqual(extractFaqBlocks(null), []);
});

// ── extractFaqQAs: the editor's view ─────────────────────────────────────────

test('extractFaqQAs returns the {q, a} shape rule 8 scans', () => {
  const qas = extractFaqQAs(HEADING_FAQ);
  assert.equal(qas.length, 2);
  assert.deepEqual(Object.keys(qas[0]).sort(), ['a', 'q']);
});

test('THE REGRESSION THIS EXISTS TO PREVENT: a post with FAQ prose and no JSON-LD still yields Q&As', () => {
  // Post-2026-08-24 this is what every post the pipeline writes looks like:
  // real FAQ prose, and no FAQPage schema anywhere. The schema-fed extractor
  // returned [] here, and `buildFaqCompetitorVerdict([])` renders "Pass — rule
  // does not apply".
  assert.ok(!/FAQPage/.test(HEADING_FAQ), 'precondition: no FAQ schema in this body');
  assert.equal(extractFaqQAs(HEADING_FAQ).length, 2, 'the rule must still have something to scan');
});

test('a competitor name in an FAQ answer is reachable from the prose', () => {
  const html = `<h3>How does it compare?</h3><p>Unlike Dr. Squatch, it uses no fragrance.</p>`;
  const [qa] = extractFaqQAs(html);
  assert.match(`${qa.q}\n${qa.a}`, /Dr\. Squatch/);
});
