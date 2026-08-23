// tests/lib/calendar-coverage.test.js
//
// Bug reproduced 2026-08-23: the "already covered by a published post" check in
// agents/content-strategist silently cleared calendar items, including items
// matching the post generated FROM them.
//
// Every fixture below is real data pulled from the production box
// (root@137.184.119.230:/root/seo-claude) on 2026-08-23 — see the comments.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  coveragePool,
  findCoverage,
  classifyClearedItems,
  renderClearedLines,
  clearedDigest,
} from '../../lib/calendar-coverage.js';

// ─────────────────────────────────────────────────────────────────────────────
// coveragePool — a post dir is not a published post
// ─────────────────────────────────────────────────────────────────────────────

// REAL: 201 dirs under data/posts/ carry meta.json on the server; two of them
// have neither content.html nor shopify_article_id — they are consolidation
// leftovers whose content was merged away. content-strategist counted both as
// "published" coverage.
const SERVER_SCAFFOLDS = [
  { slug: 'toothpaste-without-sls-what-to-know-best-options', keyword: 'toothpaste with no sls' },
  { slug: 'best-soap-for-tattoos-what-to-use-for-safe-healing', keyword: 'best soap to use on new tattoo' },
];

function fakeCorpus(rows) {
  return {
    slugs: rows.map((r) => r.slug),
    getMeta: (slug) => rows.find((r) => r.slug === slug)?.meta ?? null,
    hasContent: (slug) => Boolean(rows.find((r) => r.slug === slug)?.content),
  };
}

test('coveragePool keeps a post with content.html', () => {
  const { posts, unwritten } = coveragePool(fakeCorpus([
    { slug: 'moisturizing-bar-soap', content: true, meta: { target_keyword: 'moisturizing bar soap' } },
  ]));
  assert.deepEqual(posts, [{ slug: 'moisturizing-bar-soap', keyword: 'moisturizing bar soap' }]);
  assert.deepEqual(unwritten, []);
});

test('coveragePool keeps a legacy post with an article id but no local content', () => {
  const { posts, unwritten } = coveragePool(fakeCorpus([
    { slug: 'aluminum-free-deodorant', content: false, meta: { target_keyword: 'aluminum free deodorant', shopify_article_id: 563571818666 } },
  ]));
  assert.equal(posts.length, 1);
  assert.deepEqual(unwritten, []);
});

test('coveragePool EXCLUDES a scaffold with meta.json but nothing written', () => {
  // This is the self-match: the pipeline writes data/posts/<slug>/meta.json at
  // draft time, so a calendar item that has merely started drafting was
  // thereafter "already covered by a published post" — by its own draft.
  const { posts, unwritten } = coveragePool(fakeCorpus(
    SERVER_SCAFFOLDS.map((s) => ({ slug: s.slug, content: false, meta: { target_keyword: s.keyword } })),
  ));
  assert.deepEqual(posts, []);
  assert.deepEqual(unwritten.map((u) => u.keyword).sort(), [
    'best soap to use on new tattoo',
    'toothpaste with no sls',
  ]);
});

test('coveragePool skips a post with no target_keyword and never yields an empty keyword', () => {
  const { posts } = coveragePool(fakeCorpus([
    { slug: 'no-keyword', content: true, meta: {} },
    { slug: 'null-meta', content: true, meta: null },
  ]));
  assert.deepEqual(posts, []);
});

// ─────────────────────────────────────────────────────────────────────────────
// findCoverage — the published pool
// ─────────────────────────────────────────────────────────────────────────────

// REAL: data/posts/*/meta.json on the server, 2026-08-23.
const PUBLISHED = [
  { slug: 'natural-antiperspirant', keyword: 'natural antiperspirant' },
  { slug: 'sls-sensitivity-toothpaste', keyword: 'SLS sensitivity toothpaste' },
  { slug: 'aluminum-free-deodorant', keyword: 'aluminum free deodorant' },
  { slug: 'fragrance-free-deodorant', keyword: 'fragrance free deodorant' },
];

test('findCoverage blocks an exact match against a published post and names the post', () => {
  const hit = findCoverage('natural antiperspirant', { publishedPosts: PUBLISHED });
  assert.equal(hit.keyword, 'natural antiperspirant');
  assert.equal(hit.slug, 'natural-antiperspirant');
  assert.equal(hit.rule, 'exact');
  assert.equal(hit.pool, 'published');
});

test('findCoverage ignores case when matching a published post', () => {
  const hit = findCoverage('sls sensitivity toothpaste', { publishedPosts: PUBLISHED });
  assert.equal(hit.slug, 'sls-sensitivity-toothpaste');
  assert.equal(hit.rule, 'exact');
});

test('findCoverage blocks a near-duplicate of a published post', () => {
  const hit = findCoverage('deodorant without aluminum', { publishedPosts: PUBLISHED });
  assert.equal(hit.keyword, 'aluminum free deodorant');
  assert.equal(hit.rule, 'near');
  assert.equal(hit.pool, 'published');
});

test('findCoverage keeps a deliberate audience split', () => {
  const hit = findCoverage('aluminum free deodorant for men', { publishedPosts: PUBLISHED });
  assert.equal(hit, null);
});

test('findCoverage returns null when nothing matches', () => {
  assert.equal(findCoverage('oatmeal soap', { publishedPosts: PUBLISHED, calendarKeywords: ['vegan soap'] }), null);
});

test('findCoverage does not match a scaffold that coveragePool excluded', () => {
  // The two halves have to work together: excluding the scaffold from the pool
  // is what stops "toothpaste no sls" being dropped as covered by a post that
  // does not exist. Jaccard("toothpaste no sls", "toothpaste with no sls") = 1.0
  // ("with" is a stopword), so the old code dropped it every time.
  const withScaffold = findCoverage('toothpaste no sls', {
    publishedPosts: [{ slug: 'toothpaste-without-sls-what-to-know-best-options', keyword: 'toothpaste with no sls' }],
  });
  assert.equal(withScaffold.keyword, 'toothpaste with no sls');

  const { posts } = coveragePool(fakeCorpus([
    { slug: 'toothpaste-without-sls-what-to-know-best-options', content: false, meta: { target_keyword: 'toothpaste with no sls' } },
  ]));
  assert.equal(findCoverage('toothpaste no sls', { publishedPosts: posts }), null);
});

// ─────────────────────────────────────────────────────────────────────────────
// findCoverage — the calendar pool and the self-match
// ─────────────────────────────────────────────────────────────────────────────

// REAL: data/calendar/calendar.json on the server, 2026-08-23. Three review
// items whose core token sets are identical — Jaccard 1.0 to each other.
const LIVE_CALENDAR = ['sls-free toothpaste', 'toothpaste sls free', 'toothpaste no sls', 'coconut oil as deodorant'];

test('findCoverage lets a calendar item match itself', () => {
  assert.equal(findCoverage('vegan soap', { calendarKeywords: ['vegan soap'] }), null);
});

test('findCoverage lets a calendar item match itself even when a tied sibling sorts first', () => {
  // THE SELF-MATCH. The old exemption compared the single best match against
  // the proposal AFTER the fact. findSemanticDuplicate breaks ties with `>`,
  // so the FIRST 1.0 entry won and the item was reported as a duplicate of its
  // own twin — dropped on a re-plan despite already being scheduled.
  assert.equal(findCoverage('toothpaste sls free', { calendarKeywords: LIVE_CALENDAR }), null);
  assert.equal(findCoverage('toothpaste no sls', { calendarKeywords: LIVE_CALENDAR }), null);
  assert.equal(findCoverage('sls-free toothpaste', { calendarKeywords: LIVE_CALENDAR }), null);
});

test('findCoverage still blocks a near-duplicate of ANOTHER calendar item', () => {
  const hit = findCoverage('toothpaste without sls', { calendarKeywords: ['sls free toothpaste'] });
  assert.equal(hit.keyword, 'sls free toothpaste');
  assert.equal(hit.pool, 'calendar');
  assert.equal(hit.rule, 'near');
});

test('findCoverage prefers the published pool over the calendar pool', () => {
  const hit = findCoverage('natural antiperspirant', {
    publishedPosts: PUBLISHED,
    calendarKeywords: ['natural antiperspirant'],
  });
  // Already on the calendar AND already published: published wins, because the
  // page exists and the item is finished work, not a plan.
  assert.equal(hit.pool, 'published');
  assert.equal(hit.slug, 'natural-antiperspirant');
});

// ─────────────────────────────────────────────────────────────────────────────
// classifyClearedItems — the part that was invisible
// ─────────────────────────────────────────────────────────────────────────────

// REAL: data/calendar/calendar.json.bak-2026-08-18 (19 items) vs the calendar
// after the 2026-08-19 and 2026-08-21 strategist runs. 12 of the 19 were gone.
const PREVIOUS_19 = [
  { slug: 'fragrance-free-deodorant', keyword: 'fragrance free deodorant' },
  { slug: 'best-antibacterial-soap-for-tattoos', keyword: 'best antibacterial soap for tattoos', status: 'review' },
  { slug: 'glycerin-free-toothpaste', keyword: 'glycerin free toothpaste', status: 'review' },
  { slug: 'scent-free-deodorant', keyword: 'scent free deodorant' },
  { slug: 'moisturizing-bar-soap', keyword: 'moisturizing bar soap' },
  { slug: 'sls-free-toothpaste-for-kids', keyword: 'sls free toothpaste for kids' },
  { slug: 'aluminum-free-deodorant', keyword: 'aluminum free deodorant' },
  { slug: 'deodorant-for-sensitive-skin', keyword: 'deodorant for sensitive skin' },
  { slug: 'aluminum-free-deodorant-for-men', keyword: 'aluminum free deodorant for men' },
  { slug: 'sls-sensitivity-toothpaste', keyword: 'sls sensitivity toothpaste' },
  { slug: 'vegan-soap', keyword: 'vegan soap' },
  { slug: 'oatmeal-soap', keyword: 'oatmeal soap' },
  { slug: 'best-schmidts-deodorant-alternatives', keyword: "best schmidt's deodorant alternatives" },
  { slug: 'natural-antiperspirant', keyword: 'natural antiperspirant' },
  { slug: 'best-body-lotion-without-chemicals', keyword: 'best body lotion without chemicals', status: 'review' },
  { slug: 'soap-making', keyword: 'soap making' },
  { slug: 'travel-size-deodorant', keyword: 'travel size deodorant' },
  { slug: 'best-unscented-body-lotion', keyword: 'best unscented body lotion', status: 'review' },
  { slug: 'microbiome-friendly-toothpaste', keyword: 'microbiome friendly toothpaste' },
];

// REAL: the [SKIP] lines the 2026-08-19 run printed to
// data/reports/scheduler/scheduler.log:284988-284995.
const SKIPS_2026_08_19 = [
  { keyword: 'fragrance free deodorant', reason: 'already_covered', matched: 'fragrance free deodorant', matchedSlug: 'fragrance-free-deodorant', rule: 'exact', pool: 'published' },
  { keyword: 'deodorant for sensitive skin', reason: 'already_covered', matched: 'deodorant for sensitive skin', matchedSlug: 'deodorant-for-sensitive-skin', rule: 'exact', pool: 'published' },
  { keyword: 'deodorant without aluminum', reason: 'already_covered', matched: 'aluminum free deodorant', matchedSlug: 'aluminum-free-deodorant', rule: 'near', pool: 'published' },
  { keyword: 'moisturizing bar soap', reason: 'already_covered', matched: 'moisturizing bar soap', matchedSlug: 'moisturizing-bar-soap', rule: 'exact', pool: 'published' },
  { keyword: 'vegan soap', reason: 'cluster_dud', detail: 'soap cluster does not earn (194 clicks, $0.00)' },
  { keyword: 'oatmeal soap', reason: 'cluster_dud', detail: 'soap cluster does not earn (194 clicks, $0.00)' },
  { keyword: 'natural deodorant transition', reason: 'already_covered', matched: 'natural deodorant', matchedSlug: 'natural-deodorant', rule: 'near', pool: 'published' },
  { keyword: 'soap making', reason: 'cluster_dud', detail: 'soap cluster does not earn (194 clicks, $0.00)' },
];

const SURVIVORS_7 = [
  { slug: 'scent-free-deodorant', keyword: 'scent free deodorant' },
  { slug: 'aluminum-free-deodorant-for-men', keyword: 'aluminum free deodorant for men' },
  { slug: 'best-schmidts-deodorant-alternatives', keyword: "best schmidt's deodorant alternatives" },
  { slug: 'best-antibacterial-soap-for-tattoos', keyword: 'best antibacterial soap for tattoos', status: 'review' },
  { slug: 'glycerin-free-toothpaste', keyword: 'glycerin free toothpaste', status: 'review' },
  { slug: 'best-body-lotion-without-chemicals', keyword: 'best body lotion without chemicals', status: 'review' },
  { slug: 'best-unscented-body-lotion', keyword: 'best unscented body lotion', status: 'review' },
];

// REAL: which of the cleared slugs had a live post on the server.
const LIVE_SLUGS = new Set([
  'fragrance-free-deodorant', 'moisturizing-bar-soap', 'sls-free-toothpaste-for-kids',
  'aluminum-free-deodorant', 'deodorant-for-sensitive-skin', 'sls-sensitivity-toothpaste',
  'natural-antiperspirant', 'microbiome-friendly-toothpaste',
]);
const postState = (slug) => (LIVE_SLUGS.has(slug) ? { exists: true, live: true } : { exists: false, live: false });

test('classifyClearedItems reproduces the 12-of-19 clearing', () => {
  const cleared = classifyClearedItems({
    previousItems: PREVIOUS_19,
    newItems: SURVIVORS_7,
    skips: SKIPS_2026_08_19,
    postState,
  });
  assert.equal(cleared.length, 12);
  assert.deepEqual(cleared.map((c) => c.slug).sort(), [
    'aluminum-free-deodorant', 'deodorant-for-sensitive-skin', 'fragrance-free-deodorant',
    'microbiome-friendly-toothpaste', 'moisturizing-bar-soap', 'natural-antiperspirant',
    'oatmeal-soap', 'sls-free-toothpaste-for-kids', 'sls-sensitivity-toothpaste',
    'soap-making', 'travel-size-deodorant', 'vegan-soap',
  ]);
});

test('classifyClearedItems attributes each clearing to a cause', () => {
  const cleared = classifyClearedItems({
    previousItems: PREVIOUS_19, newItems: SURVIVORS_7, skips: SKIPS_2026_08_19, postState,
  });
  const by = (r) => cleared.filter((c) => c.reason === r).map((c) => c.slug).sort();

  // Four were dropped by the covered check — and the strategist's log said so.
  assert.deepEqual(by('already_covered'), [
    'aluminum-free-deodorant', 'deodorant-for-sensitive-skin',
    'fragrance-free-deodorant', 'moisturizing-bar-soap',
  ]);
  // Three by the soap cluster verdict.
  assert.deepEqual(by('cluster_dud'), ['oatmeal-soap', 'soap-making', 'vegan-soap']);
  // Four vanished with NO [SKIP] line at all, but their post is live, so the
  // item was finished work the calendar never stopped carrying.
  assert.deepEqual(by('completed'), [
    'microbiome-friendly-toothpaste', 'natural-antiperspirant',
    'sls-free-toothpaste-for-kids', 'sls-sensitivity-toothpaste',
  ]);
  // And ONE was a real, unexplained loss: no post, no filter, just gone.
  assert.deepEqual(by('not_reproposed'), ['travel-size-deodorant']);
});

test('classifyClearedItems names the post an already-covered clearing matched', () => {
  const cleared = classifyClearedItems({
    previousItems: PREVIOUS_19, newItems: SURVIVORS_7, skips: SKIPS_2026_08_19, postState,
  });
  const row = cleared.find((c) => c.slug === 'aluminum-free-deodorant');
  assert.equal(row.matched, 'aluminum free deodorant');
  assert.equal(row.matchedSlug, 'aluminum-free-deodorant');
  assert.equal(row.rule, 'near');
  assert.equal(row.pool, 'published');
  // The proposal that collided is recorded too — it is not the item's keyword.
  assert.equal(row.proposal, 'deodorant without aluminum');
});

test('classifyClearedItems flags an item cleared by a post at its OWN slug', () => {
  // A "cannibalization" verdict against the post generated from this very item
  // is not cannibalization. It has to be legible as such in the report.
  const cleared = classifyClearedItems({
    previousItems: PREVIOUS_19, newItems: SURVIVORS_7, skips: SKIPS_2026_08_19, postState,
  });
  assert.equal(cleared.find((c) => c.slug === 'fragrance-free-deodorant').selfMatch, true);
  assert.equal(cleared.find((c) => c.slug === 'aluminum-free-deodorant').selfMatch, true);
});

test('classifyClearedItems never clears a review item', () => {
  // review items are carried by mergeReviewItems and are not in the brief queue,
  // so their absence from newItems would otherwise read as a clearing.
  const cleared = classifyClearedItems({
    previousItems: [{ slug: 'idea', keyword: 'idea kw', status: 'review' }],
    newItems: [], skips: [], postState: () => ({ exists: false, live: false }),
  });
  assert.deepEqual(cleared, []);
});

test('classifyClearedItems matches a skip to an item by slug, not by keyword string', () => {
  const cleared = classifyClearedItems({
    previousItems: [{ slug: 'aluminum-free-deodorant', keyword: 'aluminum free deodorant' }],
    newItems: [],
    skips: [{ keyword: 'ALUMINUM  Free   Deodorant', reason: 'already_covered', matched: 'aluminum free deodorant', matchedSlug: 'aluminum-free-deodorant', rule: 'exact', pool: 'published' }],
    postState: () => ({ exists: true, live: true }),
  });
  assert.equal(cleared[0].reason, 'already_covered');
});

// ─────────────────────────────────────────────────────────────────────────────
// rendering — a clearing that nobody can read is still invisible
// ─────────────────────────────────────────────────────────────────────────────

test('renderClearedLines names the post and the rule for every already-covered row', () => {
  const cleared = classifyClearedItems({
    previousItems: PREVIOUS_19, newItems: SURVIVORS_7, skips: SKIPS_2026_08_19, postState,
  });
  const text = renderClearedLines(cleared).join('\n');
  assert.match(text, /fragrance-free-deodorant/);
  assert.match(text, /already covered/);
  assert.match(text, /data\/posts\/fragrance-free-deodorant/);
  assert.match(text, /self-match/i);
  assert.match(text, /travel-size-deodorant/);
  assert.match(text, /no reason recorded/);
});

test('renderClearedLines caps the listing but still says how many there were', () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ slug: `s${i}`, keyword: `k${i}` }));
  const cleared = classifyClearedItems({
    previousItems: many, newItems: [], skips: [], postState: () => ({ exists: false, live: false }),
  });
  const lines = renderClearedLines(cleared, { max: 10 });
  assert.ok(lines.length <= 12);
  assert.match(lines.join('\n'), /\+20 more/);
});

test('clearedDigest is deferred-safe and reports counts by reason', () => {
  const cleared = classifyClearedItems({
    previousItems: PREVIOUS_19, newItems: SURVIVORS_7, skips: SKIPS_2026_08_19, postState,
  });
  const d = clearedDigest(cleared, { kept: SURVIVORS_7.length });
  assert.match(d.subject, /12/);
  assert.equal(d.immediate, undefined); // never immediate — CLAUDE.md digest convention
  assert.match(d.body, /already covered/);
  assert.match(d.body, /not re-proposed/i);
  // A real loss must be called out separately from finished work.
  assert.match(d.body, /travel-size-deodorant/);
  assert.equal(d.status, 'warning');
});

test('clearedDigest reports success wording when nothing was silently lost', () => {
  const cleared = classifyClearedItems({
    previousItems: [{ slug: 'natural-antiperspirant', keyword: 'natural antiperspirant' }],
    newItems: [],
    skips: [],
    postState,
  });
  const d = clearedDigest(cleared, { kept: 0 });
  assert.equal(cleared[0].reason, 'completed');
  assert.equal(d.status, 'info');
});

test('clearedDigest returns null when nothing was cleared', () => {
  assert.equal(clearedDigest([], { kept: 5 }), null);
});
