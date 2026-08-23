import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildClusterHold, HOLD_FLAG } from '../../lib/cluster-hold.js';
import { classifyClusters } from '../../lib/cluster-revenue.js';
import { holdContentQuality } from '../../agents/indexing-fixer/index.js';
import { holdCandidates } from '../../agents/performance-engine/index.js';
import { selectLegacyPosts } from '../../agents/legacy-rebuilder/index.js';
import { selectBlockedPosts, selectBlockedPostsWithHold } from '../../agents/blocked-post-resolver/index.js';
import { holdSlugs } from '../../agents/refresh-runner/index.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// Production shape (2026-08-22). One $0 cluster with real traffic, one earner.
const HOLD = buildClusterHold(classifyClusters([
  { cluster: 'toothpaste', revenue: 0, clicks: 663, pages: 24 },
  { cluster: 'body lotion', revenue: 313.49, clicks: 35, pages: 20 },
]), { generatedAt: '2026-08-22T10:00:00Z' });

const EARNING = buildClusterHold(classifyClusters([
  { cluster: 'toothpaste', revenue: 12.5, clicks: 663, pages: 24 },
  { cluster: 'body lotion', revenue: 313.49, clicks: 35, pages: 20 },
]));

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

// ── the contract every gated agent shares ────────────────────────────────────

const GATED = [
  'agents/indexing-fixer/index.js',
  'agents/performance-engine/index.js',
  'agents/legacy-rebuilder/index.js',
  'agents/blocked-post-resolver/index.js',
  'agents/refresh-runner/index.js',
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
