// tests/lib/content-mirror.test.js
//
// The local `data/posts/<slug>/content.html` mirror vs the live Shopify
// `body_html`, and the gate that decides whether a republish may proceed.
//
// The thresholds asserted here are DERIVED FROM MEASUREMENT, not chosen. See
// lib/content-mirror.js's header for the working; the two anchors are:
//
//   * the widest "different article" pair measured across the 89 comparable
//     posts scored 0.221 block similarity, and the next post up scored 0.324;
//   * the deepest LEGITIMATE rewrite measured (agents/content-refresher's own
//     queued drafts, content-refreshed.html vs content.html) scored 0.775.
//
// So REFUSE at 0.25 sits inside a real gap in the data and three times below
// the deepest legitimate rewrite. A test that has to move one of these numbers
// is a test telling you the corpus changed shape — re-measure, do not re-tune.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DIFFERENT_ARTICLE_MAX,
  DIVERGENT_WARN_MAX,
  MIN_BLOCK_CHARS,
  normalizeText,
  textBlocks,
  compareBodies,
  assessRepublish,
} from '../../lib/content-mirror.js';

const para = (t) => `<p>${t}</p>`;
const body = (...paras) => `<div>${paras.map(para).join('\n')}</div>`;

// 60+ chars each so every one clears MIN_BLOCK_CHARS.
const P = (n) => `Paragraph number ${n} about coconut oil body care and why it matters to you.`;
const doc = (from, to) => {
  const out = [];
  for (let i = from; i <= to; i++) out.push(P(i));
  return body(...out);
};

// ── normalization ────────────────────────────────────────────────────────────

test('normalizeText strips tags, decodes the entities that actually appear, and folds whitespace', () => {
  const a = normalizeText('<p>Coconut&nbsp;oil &amp; shea&#39;s blend</p>');
  const b = normalizeText('<p style="color:#000">Coconut oil & shea’s blend</p>');
  assert.equal(a, b);
});

test('a non-breaking space is not silently the same as a letter — normalization folds space, not content', () => {
  assert.notEqual(normalizeText('<p>one two</p>'), normalizeText('<p>onetwo</p>'));
});

test('textBlocks ignores short fragments so nav crumbs and one-word list items cannot inflate similarity', () => {
  const blocks = textBlocks('<p>tiny</p>' + para(P(1)));
  assert.equal(blocks.size, 1);
  assert.ok([...blocks][0].length >= MIN_BLOCK_CHARS);
});

test('textBlocks reads paragraphs, list items and headings — a rewrite that only moves prose into <li> still compares', () => {
  const asP = textBlocks(`<p>${P(1)}</p>`);
  const asLi = textBlocks(`<ul><li>${P(1)}</li></ul>`);
  assert.deepEqual([...asP], [...asLi]);
});

// ── compareBodies ────────────────────────────────────────────────────────────

test('byte-identical bodies report identical', () => {
  const html = doc(1, 10);
  const r = compareBodies(html, html);
  assert.equal(r.tier, 'identical');
  assert.equal(r.identical, true);
  assert.equal(r.blockSimilarity, 1);
  assert.equal(r.liveOnlyBlocks, 0);
});

test('markup-only drift is COSMETIC, not divergence — this is the class a resync would churn for nothing', () => {
  // The real shape: agents/featured-product-injector restyles the CTA block, so
  // every style attribute differs and not one word of prose does.
  const local = '<section style="margin:16px 0"><p>' + P(1) + '</p></section>';
  const live = '<section style="margin:0 0 20px;background:#fafafa"><p style="color:#000">' + P(1) + '</p></section>';
  const r = compareBodies(local, live);
  assert.equal(r.identical, false);
  assert.equal(r.textIdentical, true);
  assert.equal(r.tier, 'cosmetic');
  assert.equal(r.blockSimilarity, 1);
});

test('an edit to a few paragraphs is DIVERGENT, and the report says how many live blocks it would drop', () => {
  const local = doc(1, 20);                                    // 20 blocks
  const live = body(...[...Array(18)].map((_, i) => P(i + 1)), P(101), P(102)); // 18 shared + 2 live-only
  const r = compareBodies(local, live);
  assert.equal(r.tier, 'divergent');
  assert.equal(r.sharedBlocks, 18);
  assert.equal(r.liveOnlyBlocks, 2);
  assert.equal(r.localOnlyBlocks, 2);
  assert.ok(r.blockSimilarity > DIVERGENT_WARN_MAX);
});

test('two wholly different articles are DIFFERENT-ARTICLE — the PR #645 finding, reproduced', () => {
  const r = compareBodies(doc(1, 40), doc(100, 140));
  assert.equal(r.tier, 'different-article');
  assert.equal(r.sharedBlocks, 0);
  assert.equal(r.blockSimilarity, 0);
  assert.equal(r.liveCoverage, 0);
});

test('a shared CTA block does not rescue two different articles', () => {
  // Every post carries the same injected product CTA, so a naive comparison
  // finds overlap between articles that share nothing else. Measured: the
  // worst real pair still scored 0.035 with its CTA counted.
  const cta = P(999);
  const local = body(cta, ...[...Array(40)].map((_, i) => P(i + 1)));
  const live = body(cta, ...[...Array(40)].map((_, i) => P(i + 100)));
  const r = compareBodies(local, live);
  assert.equal(r.tier, 'different-article');
  assert.ok(r.blockSimilarity < DIFFERENT_ARTICLE_MAX);
});

test('an empty live body compares as empty rather than throwing, and has nothing to destroy', () => {
  const r = compareBodies(doc(1, 5), '');
  assert.equal(r.liveBlocks, 0);
  assert.equal(r.liveOnlyBlocks, 0);
});

test('similarity is symmetric but coverage is not — the direction is the whole finding', () => {
  const small = doc(1, 10);
  const big = doc(1, 100);
  const r = compareBodies(small, big);
  assert.equal(r.localCoverage, 1);          // everything local has, live has
  assert.ok(r.liveCoverage < 0.2);           // live holds 90 blocks local never saw
  assert.equal(r.direction, 'live-superset'); // => local is STALE, never "ahead"
  const back = compareBodies(big, small);
  assert.equal(back.direction, 'local-superset');
  assert.equal(back.blockSimilarity, r.blockSimilarity);
});

test('direction is "both-moved" when each side holds blocks the other lacks', () => {
  const local = body(...[...Array(10)].map((_, i) => P(i + 1)), P(500));
  const live = body(...[...Array(10)].map((_, i) => P(i + 1)), P(600));
  assert.equal(compareBodies(local, live).direction, 'both-moved');
});

// ── thresholds ───────────────────────────────────────────────────────────────

test('the refuse threshold sits inside the measured gap, and far below a real refresh', () => {
  // Measured 2026-08-23 against live Shopify, read-only:
  //   worst same-article pair that is genuinely a different article: 0.221
  //   next post up:                                                  0.324
  //   deepest legitimate content-refresher rewrite:                  0.775
  assert.ok(DIFFERENT_ARTICLE_MAX > 0.221, 'must catch the worst measured different-article pair');
  assert.ok(DIFFERENT_ARTICLE_MAX < 0.324, 'must not reach the next post up');
  assert.ok(DIFFERENT_ARTICLE_MAX * 3 <= 0.775, 'must sit well clear of a real refresh');
  assert.ok(DIVERGENT_WARN_MAX < 0.775, 'a real refresh must not routinely warn');
  assert.ok(DIVERGENT_WARN_MAX > DIFFERENT_ARTICLE_MAX);
});

// ── assessRepublish: the gate ────────────────────────────────────────────────

test('a create (no live article yet) is always allowed — there is nothing to overwrite', () => {
  const g = assessRepublish({ localHtml: doc(1, 5), liveHtml: null, liveReadable: true, hasLiveArticle: false });
  assert.equal(g.allow, true);
  assert.equal(g.tier, 'create');
});

test('a cosmetic or ordinary divergence is allowed quietly', () => {
  const html = doc(1, 20);
  assert.equal(assessRepublish({ localHtml: html, liveHtml: html, liveReadable: true, hasLiveArticle: true }).allow, true);
  const nearly = body(...[...Array(19)].map((_, i) => P(i + 1)), P(77));
  const g = assessRepublish({ localHtml: html, liveHtml: nearly, liveReadable: true, hasLiveArticle: true });
  assert.equal(g.allow, true);
  assert.equal(g.severity, 'ok');
});

test('a deep-but-plausible rewrite is ALLOWED and WARNED — blocking it would stop a legitimate refresh', () => {
  // 12 of 20 blocks survive => 0.6 similarity: below the warn line, above refuse.
  const local = body(...[...Array(12)].map((_, i) => P(i + 1)), ...[...Array(8)].map((_, i) => P(i + 200)));
  const live = doc(1, 20);
  const g = assessRepublish({ localHtml: local, liveHtml: live, liveReadable: true, hasLiveArticle: true });
  assert.equal(g.allow, true);
  assert.equal(g.severity, 'warn');
  assert.equal(g.tier, 'divergent');
  assert.ok(/8 of 20/.test(g.reason), `reason should count what live loses, got: ${g.reason}`);
});

test('a different article is REFUSED — the whole point', () => {
  const g = assessRepublish({ localHtml: doc(1, 40), liveHtml: doc(100, 140), liveReadable: true, hasLiveArticle: true });
  assert.equal(g.allow, false);
  assert.equal(g.severity, 'refuse');
  assert.equal(g.tier, 'different-article');
  assert.match(g.reason, /different article/i);
});

test('the refusal is overridable ONLY by its own flag, never by the generic --force', () => {
  const args = { localHtml: doc(1, 40), liveHtml: doc(100, 140), liveReadable: true, hasLiveArticle: true };
  // scheduler.js's daily link-repair republish passes --force. If --force
  // disarmed this gate, the exact unattended path that fires the hazard would
  // still fire it.
  assert.equal(assessRepublish({ ...args, force: true }).allow, false);
  const o = assessRepublish({ ...args, allowDivergentMirror: true });
  assert.equal(o.allow, true);
  assert.equal(o.severity, 'override');
});

test('an unreadable live body REFUSES — same rule as lib/post-lock.js\'s "unreadable"', () => {
  const g = assessRepublish({ localHtml: doc(1, 5), liveHtml: null, liveReadable: false, hasLiveArticle: true });
  assert.equal(g.allow, false);
  assert.equal(g.tier, 'unreadable');
  assert.match(g.reason, /could not be read/i);
});

test('an EMPTY live body is allowed — an empty page has nothing to lose', () => {
  const g = assessRepublish({ localHtml: doc(1, 5), liveHtml: '', liveReadable: true, hasLiveArticle: true });
  assert.equal(g.allow, true);
  assert.equal(g.tier, 'empty-live');
});

test('assessRepublish never mutates its inputs and is a pure function of them', () => {
  const local = doc(1, 5), live = doc(1, 5);
  const a = assessRepublish({ localHtml: local, liveHtml: live, liveReadable: true, hasLiveArticle: true });
  const b = assessRepublish({ localHtml: local, liveHtml: live, liveReadable: true, hasLiveArticle: true });
  assert.deepEqual(a, b);
});
