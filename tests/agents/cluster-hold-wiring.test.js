import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderDisagreementLines, HOLD_FLAG } from '../../lib/cluster-hold.js';
import {
  holdFor, heldScenario, SOLD_90D, PAGES_EARNED_90D,
} from '../helpers/cluster-fixtures.js';
import { holdContentQuality } from '../../agents/indexing-fixer/index.js';
import { holdCandidates } from '../../agents/performance-engine/index.js';
import { selectLegacyPosts } from '../../agents/legacy-rebuilder/index.js';
import { selectBlockedPosts, selectBlockedPostsWithHold } from '../../agents/blocked-post-resolver/index.js';
import { holdSlugs } from '../../agents/refresh-runner/index.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// A cluster is held only when BOTH sources agree it earns nothing — its products
// sold $0.00 over the 90-day judging window AND its pages earned $0.00 of
// organic revenue over the same window.
//
// SYNTHETIC. Production has no held cluster as of 2026-08-23 (toothpaste, the
// last one, sells $71.50/90d), so the fixture is what keeps the WIRING under
// test: that each gated agent applies the hold at all, and applies it before its
// own per-run cap. See tests/lib/cluster-revenue.test.js for the real verdicts.
const HOLD = holdFor({ ...heldScenario('toothpaste'), generatedAt: '2026-08-23T10:00:00Z' });

// The same cluster, same traffic, one product sale — which is the real
// toothpaste case now. Nothing else changes and the hold releases itself.
const EARNING = holdFor({
  clusters: [
    { cluster: 'toothpaste', revenue: 0, clicks: 640, pages: 24 },
    { cluster: 'lotion', revenue: 313.49, clicks: 106, pages: 39 },
  ],
  sold: { ...SOLD_90D, toothpaste: 12.5 },
  earned: { ...PAGES_EARNED_90D, toothpaste: 0 },
});

const DUD = 'no-fluoride-toothpaste';
const EARNER = 'best-coconut-oil-body-lotion';

// ── indexing-fixer: the crawled_not_indexed → content-quality refresh path ────
// This is the 11-a-day path: on 2026-08-21 a single $0 cluster took 11 of 15
// critical slots and triggered 11 refreshes, each a chain of paid LLM calls.

test('indexing-fixer holds the content-quality refresh for a $0 cluster', () => {
  const results = [{ slug: DUD, url: `https://x/blogs/news/${DUD}` }, { slug: EARNER }];
  const { kept, held } = holdContentQuality(results, HOLD);
  assert.deepEqual(kept.map((r) => r.slug), [EARNER]);
  assert.equal(held.length, 1);
  assert.equal(held[0].cluster, 'toothpaste');
  assert.match(held[0].reason, /stays live/i);
});

test('indexing-fixer refreshes the same posts again once the cluster earns', () => {
  const results = [{ slug: DUD }, { slug: EARNER }];
  assert.equal(holdContentQuality(results, EARNING).held.length, 0);
  assert.equal(holdContentQuality(results, EARNING).kept.length, 2);
});

test(`indexing-fixer's ${HOLD_FLAG} forces the refresh anyway`, () => {
  const out = holdContentQuality([{ slug: DUD }], HOLD, { includeHeld: true });
  assert.equal(out.kept.length, 1);
  assert.equal(out.held.length, 0);
  assert.equal(out.overridden.length, 1, 'the override is still recorded, not hidden');
});

// ── performance-engine: pickFlops / pickQuickWins / pickMetaRewrites / pickLegacyFlops

test('performance-engine holds candidates in a $0 cluster before they cost a refresh', () => {
  const picks = [
    { slug: DUD, title: 'Fluoride-Free Toothpaste', trigger: 'flop-refresh' },
    { slug: EARNER, title: 'Body Lotion', trigger: 'quick-win' },
  ];
  const { kept, held } = holdCandidates(picks, HOLD);
  assert.deepEqual(kept.map((c) => c.slug), [EARNER]);
  assert.equal(held.length, 1);
  assert.equal(held[0].item.trigger, 'flop-refresh', 'the original pick is carried for the summary');
});

test('performance-engine uses the pick title when the slug does not name the cluster', () => {
  const { held } = holdCandidates([{ slug: 'x-2026-guide', title: 'Best Toothpaste Without SLS' }], HOLD);
  assert.equal(held.length, 1);
  assert.equal(held[0].cluster, 'toothpaste');
});

// ── legacy-rebuilder: findLegacyPosts ────────────────────────────────────────

const legacyPost = (slug, meta = {}) => ({ slug, meta: { shopify_article_id: 1, ...meta } });

test('legacy-rebuilder holds a $0-cluster post out of the rebuild list', () => {
  const posts = [legacyPost(DUD), legacyPost(EARNER)];
  const { kept, held } = selectLegacyPosts(posts, { hold: HOLD });
  assert.deepEqual(kept.map((p) => p.slug), [EARNER]);
  assert.equal(held.length, 1);
});

test('legacy-rebuilder clusters on the target keyword when the slug is opaque', () => {
  const posts = [legacyPost('post-114', { target_keyword: 'sls free toothpaste' })];
  const { held } = selectLegacyPosts(posts, { hold: HOLD });
  assert.equal(held.length, 1, 'the recorded keyword is what seo-impact attributes revenue on');
});

test(`legacy-rebuilder's ${HOLD_FLAG} rebuilds a held post anyway`, () => {
  const posts = [legacyPost(DUD)];
  assert.equal(selectLegacyPosts(posts, { hold: HOLD, includeHeld: true }).kept.length, 1);
});

test('legacy-rebuilder with no hold context behaves exactly as before', () => {
  const posts = [legacyPost(DUD), legacyPost(EARNER)];
  assert.equal(selectLegacyPosts(posts).kept.length, 2);
  assert.equal(selectLegacyPosts(posts).held.length, 0);
});

// ── blocked-post-resolver: candidate selection ───────────────────────────────

const NEEDS_WORK = '## OVERALL QUALITY\nVERDICT: Needs Work\n\n## BLOCKERS\n1. Factual concerns: an uncited statistic.\n';
const now = Date.parse('2026-08-22T12:00:00Z');
const live = (extra = {}) => ({ shopify_blog_id: 1, shopify_article_id: 2, shopify_publish_at: '2025-06-25T11:00:07-06:00', ...extra });
const entry = (slug, meta = {}) => ({ slug, meta: live(meta), report: NEEDS_WORK, reportAgeDays: 2 });

test('blocked-post-resolver holds a $0-cluster post — each one is a chain of paid LLM calls', () => {
  const picked = selectBlockedPosts([entry(DUD), entry(EARNER)], { now, hold: HOLD });
  assert.deepEqual(picked.map((p) => p.slug), [EARNER]);
});

test('blocked-post-resolver reports what it held rather than dropping it silently', () => {
  const { kept, held } = selectBlockedPostsWithHold([entry(DUD), entry(EARNER)], { now, hold: HOLD });
  assert.deepEqual(kept.map((p) => p.slug), [EARNER]);
  assert.equal(held.length, 1);
  assert.equal(held[0].cluster, 'toothpaste');
});

test('blocked-post-resolver applies the hold BEFORE the limit, so held posts do not eat the budget', () => {
  const entries = [entry(DUD), entry(`${DUD}-2`), entry(EARNER)];
  const picked = selectBlockedPosts(entries, { now, hold: HOLD, limit: 2 });
  assert.deepEqual(picked.map((p) => p.slug), [EARNER], 'the two held posts do not consume the 2-post cap');
});

test('blocked-post-resolver without a hold context selects exactly what it always did', () => {
  assert.equal(selectBlockedPosts([entry(DUD), entry(EARNER)], { now }).length, 2);
});

// ── refresh-runner: the bulk pick lists ──────────────────────────────────────

test('refresh-runner holds $0-cluster slugs out of its bulk pick lists', () => {
  const { kept, held } = holdSlugs([DUD, EARNER], HOLD);
  assert.deepEqual(kept, [EARNER]);
  assert.equal(held.length, 1);
  assert.equal(held[0].slug, DUD);
});

test('refresh-runner can cluster a slug through its recorded metadata', () => {
  const metaFor = (s) => (s === 'post-114' ? { target_keyword: 'toothpaste without sls' } : null);
  const { held } = holdSlugs(['post-114'], HOLD, { metaFor });
  assert.equal(held.length, 1);
});

test('refresh-runner returns bare slugs, not wrappers — its caller iterates strings', () => {
  const { kept } = holdSlugs([EARNER], HOLD);
  assert.equal(typeof kept[0], 'string');
});

// ── the correction: a misattributed cluster reaches every agent unheld ───────

// The 2026-08-19 incident, reproduced on the new basis: something breaks the
// product-title join and source A reads `soap` at $0 — a category that really
// sold $324.85 over the judging window, 13% of all revenue, second only to
// lotion. Its PAGES earned $110.49 over the same window, so source B contradicts
// A and every gated agent must let soap's posts through, and say why.
//
// Note the click count is soap's REAL 227, not a raised one. Under the old
// entry-page basis this fixture needed 500 clicks to reach the corroboration
// step at all, because a $0 on 223 clicks did not clear the 400-click bar. The
// re-derived precondition (125) means the mechanism is now exercised at the
// traffic the incident actually happened at.
const MISATTRIBUTED = holdFor({
  clusters: [
    { cluster: 'soap', revenue: 0, clicks: 227, pages: 28 },
    { cluster: 'toothpaste', revenue: 0, clicks: 640, pages: 24 },
  ],
  sold: { ...SOLD_90D, soap: 0, toothpaste: 0 },
  earned: { ...PAGES_EARNED_90D, toothpaste: 0 },
  generatedAt: '2026-08-23T10:00:00Z',
});

const SOAP_POST = 'best-natural-bar-soap-for-men';

test('no gated agent holds a cluster the orders show is earning', () => {
  assert.equal(holdContentQuality([{ slug: SOAP_POST }], MISATTRIBUTED).held.length, 0);
  assert.equal(holdCandidates([{ slug: SOAP_POST }], MISATTRIBUTED).held.length, 0);
  assert.equal(selectLegacyPosts([legacyPost(SOAP_POST)], { hold: MISATTRIBUTED }).held.length, 0);
  assert.equal(selectBlockedPostsWithHold([entry(SOAP_POST)], { now, hold: MISATTRIBUTED }).held.length, 0);
  assert.equal(holdSlugs([SOAP_POST], MISATTRIBUTED).held.length, 0);
});

test('the cluster the orders confirm is dead is still held in the same run', () => {
  const { kept, held } = holdSlugs([DUD, SOAP_POST], MISATTRIBUTED);
  assert.deepEqual(kept, [SOAP_POST], 'the earner runs');
  assert.deepEqual(held.map((h) => h.slug), [DUD], 'the real dud is still held');
});

test('the disagreement reaches the DIGEST, not just the console banner', () => {
  // These agents run unattended at 3 and 8 AM. The 5 AM digest is the only
  // channel a broken-attribution finding can speak through.
  const lines = renderDisagreementLines(MISATTRIBUTED).join('\n');
  assert.match(lines, /SOURCES DISAGREE/);
  assert.match(lines, /soap/);
  assert.match(lines, /110\.49/, 'the line quotes what the cluster\'s pages earned');
  assert.deepEqual(renderDisagreementLines(HOLD), [], 'silent when both sources agree');
  assert.deepEqual(renderDisagreementLines(null), []);
});

// ── the contract every gated agent shares ────────────────────────────────────

const GATED = [
  'agents/indexing-fixer/index.js',
  'agents/performance-engine/index.js',
  'agents/legacy-rebuilder/index.js',
  'agents/blocked-post-resolver/index.js',
  'agents/refresh-runner/index.js',
  // Added 2026-08-23. PR #617 gated the five above and missed this one, so the
  // weekly `--apply --limit 5` CTR budget was spending four of its five slots on
  // the held cluster. Its own selector is tested in
  // tests/agents/meta-optimizer-cluster-hold.test.js.
  'agents/meta-optimizer/index.js',
];

/**
 * Executable source only. These files carry long historical docstrings — one
 * names the cluster this rule was built for, another states in prose that it
 * never calls lib/post-kill.js — and both statements are the documentation
 * doing its job. The rules below are about what the CODE does.
 */
function code(rel) {
  return readFileSync(join(ROOT, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

test('every gated agent accepts the override flag and names no cluster in code', () => {
  for (const rel of GATED) {
    const src = readFileSync(join(ROOT, rel), 'utf8');
    assert.ok(src.includes(HOLD_FLAG), `${rel} must accept ${HOLD_FLAG}`);
    assert.ok(src.includes('cluster-hold.js'), `${rel} must use the shared hold rule`);
    assert.ok(!/toothpaste/i.test(code(rel)), `${rel} must not hardcode a cluster name`);
    assert.ok(!/\bsoap\b/i.test(code(rel)), `${rel} must not hardcode a cluster name`);
  }
});

test('nothing in the hold path can kill, unpublish or redirect a held page', () => {
  // A hold is a spend pause. These are live, indexed pages that keep earning
  // whatever traffic they have, so no gated agent may reach for the tools that
  // would take one down.
  const forbidden = [/post-kill/, /\bdeleteArticle\b/, /createRedirect/, /published\s*:\s*false/];
  for (const rel of [...GATED, 'lib/cluster-hold.js', 'scripts/cluster-holds.mjs']) {
    const src = code(rel);
    for (const pattern of forbidden) {
      assert.ok(!pattern.test(src), `${rel} must not ${pattern} a held page`);
    }
  }
});

test('queue-autoapply reads the hold through the same shared loader — one source of truth', () => {
  const src = readFileSync(join(ROOT, 'agents/queue-autoapply/index.js'), 'utf8');
  assert.ok(src.includes('cluster-hold.js'), 'queue-autoapply must not keep its own copy of the load');
  assert.ok(!src.includes('classifyClusters'), 'the inline classification is gone');
});
