// tests/lib/post-meta-authored-fields.test.js
//
// `agents/blog-post-writer` used to rebuild meta.json from scratch on every
// redraft and carry the previous file across through an ALLOWLIST OF 11 KEYS.
// Everything not on that list was destroyed: `legacy_locked`, `legacy_bucket`,
// `legacy_triaged_at`, `legacy_triage_reason`, `indexing_state`,
// `indexing_submissions`, `indexing_blocked`, `published_at`,
// `shopify_status_verified_at`, `needs_rebuild`, `blocked_resolution`,
// `performance_review`, the whole image record, and more.
//
// An allowlist of what to KEEP has to be updated by everyone who adds a field,
// and loses data silently when they forget — which is exactly what happened.
// A list of what the writer OWNS is short, stable, and fails safe: forget to
// update it and the worst case is a field nobody classified, never a field
// nobody kept.
//
// These tests pin the three properties that make the inversion trustworthy:
//   1. the merge preserves EVERY key the previous file held that the agent
//      does not author — including keys nobody has heard of yet;
//   2. the authored-field list cannot name a field that FIELD_OWNERS has not
//      classified, so "add a writer field" and "decide who owns it in a deploy"
//      are the same edit;
//   3. the authored-field list is NOT the repo-owned set and must never be
//      collapsed into it — the two axes genuinely disagree.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  AUTHORED_BY,
  authoredFields,
  composeAuthoredMeta,
  classifyField,
  FIELD_OWNERS,
} from '../../lib/post-meta-reconcile.js';

/** The nine fields agents/blog-post-writer actually writes, in source order. */
const WRITER_FIELDS = [
  'slug',
  'title',
  'meta_description',
  'target_keyword',
  'tags',
  'word_count',
  'generated_at',
  'brief_path',
  'tokens_used',
];

/**
 * A real meta.json shape, modelled on data/posts/best-soap-for-tattoos/meta.json
 * as it sits on the production server — i.e. carrying every category of field
 * the old allowlist threw away.
 */
const LIVE_META = () => ({
  slug: 'best-soap-for-tattoos',
  title: 'Best Soap for Tattoos: What to Use for Safe Healing',
  meta_description: 'Looking for the best soap for tattoos?',
  target_keyword: 'best soap for tattoos',
  tags: ['soap', 'natural soap'],
  word_count: 3009,
  generated_at: '2026-04-04T16:59:54.342Z',
  brief_path: '/root/seo-claude/data/briefs/best-soap-for-tattoos.json',
  tokens_used: { input: 8556, output: 6268 },

  // ── everything the 11-key allowlist kept ──
  shopify_blog_id: 48998449187,
  shopify_blog_handle: 'news',
  shopify_article_id: 563424362666,
  shopify_handle: 'best-soap-for-tattoos-what-to-use-for-safe-healing',
  shopify_url: 'https://realskincare.com/blogs/news/best-soap-for-tattoos',
  shopify_status: 'published',
  uploaded_at: '2026-04-04T17:10:00.000Z',
  legacy_synced_at: '2026-05-01T00:00:00.000Z',
  legacy_source: 'sync-legacy-posts',
  last_refreshed_at: '2026-08-01T00:00:00.000Z',

  // ── everything it DESTROYED ──
  legacy_locked: true,
  legacy_bucket: 'winner',
  legacy_triaged_at: '2026-08-10T00:00:00.000Z',
  legacy_triage_reason: 'ranks position 9 on ~38k impressions',
  indexing_state: { state: 'indexed', checked_at: '2026-08-22T11:00:00.000Z' },
  indexing_submissions: [{ at: '2026-07-02T11:30:00.000Z', api: 'indexing' }],
  indexing_blocked: false,
  published_at: '2026-04-05T00:00:00.000Z',
  shopify_status_verified_at: '2026-08-23T09:00:00.000Z',
  shopify_publish_at: '2026-04-05T00:00:00.000Z',
  needs_rebuild: { flagged_at: '2026-08-16T00:00:00.000Z', reasons: ['overall quality: needs work'] },
  blocked_resolution: { report_fingerprint: 'abc123', at: '2026-08-20T00:00:00.000Z' },
  performance_review: { milestone: 90, clicks: 227 },
  image_path: 'data/posts/best-soap-for-tattoos/image.webp',
  image_alt: 'A bar of natural soap beside a healed tattoo',
  image_generated_at: '2026-04-04T17:05:00.000Z',
  post_type: 'topical_authority',
});

/** What a redraft authors. */
const REDRAFT = () => ({
  slug: 'best-soap-for-tattoos',
  title: 'Best Soap for Tattoos in 2026',
  meta_description: 'A fresh description.',
  target_keyword: 'best soap for tattoos',
  tags: ['soap', 'natural soap', 'organic'],
  word_count: 2450,
  generated_at: '2026-08-23T12:00:00.000Z',
  brief_path: '/root/seo-claude/data/briefs/best-soap-for-tattoos.json',
  tokens_used: { input: 9000, output: 5400 },
});

// ── the list itself ──────────────────────────────────────────────────────────

test('blog-post-writer declares exactly the nine fields it authors', () => {
  assert.deepEqual([...authoredFields('blog-post-writer')].sort(), [...WRITER_FIELDS].sort());
});

test('every authored field is classified in FIELD_OWNERS — the two edits are one edit', () => {
  for (const field of authoredFields('blog-post-writer')) {
    assert.notEqual(
      classifyField(field), 'unclassified',
      `${field} is authored by an agent but has no FIELD_OWNERS entry — a deploy reconcile would exit 2 on it`,
    );
  }
});

test('authoredFields REFUSES a field the ownership table has not classified', () => {
  // Simulated by asking for an agent whose list names an unknown field: the
  // guard is what makes "one place that knows" load-bearing rather than a
  // comment. Exercised through the real code path by temporarily registering
  // a bad list is impossible (AUTHORED_BY is frozen), so assert the invariant
  // the guard enforces holds for every registered agent instead.
  for (const [agent, fields] of Object.entries(AUTHORED_BY)) {
    assert.doesNotThrow(() => authoredFields(agent));
    for (const f of fields) assert.ok(Object.hasOwn(FIELD_OWNERS, f), `${agent}: ${f} missing from FIELD_OWNERS`);
  }
});

test('authoredFields throws for an agent with no declared list', () => {
  assert.throws(() => authoredFields('some-new-agent'), /AUTHORED_BY/);
});

test('the authored set is NOT the repo-owned set — do not collapse the two axes', () => {
  const authored = new Set(authoredFields('blog-post-writer'));
  const repoOwned = Object.keys(FIELD_OWNERS).filter((f) => FIELD_OWNERS[f] === 'repo');

  // repo-owned but NOT authored by this agent: using `repo` as the owned set
  // would have the writer clobber a field it never produces.
  assert.ok(repoOwned.includes('post_type'), 'fixture assumption: post_type is repo-owned');
  assert.ok(!authored.has('post_type'), 'post_type is repo-owned but blog-post-writer never writes it');

  // authored but SERVER-owned: using `repo` as the owned set would have the
  // writer preserve a stale word_count/generated_at from the previous draft.
  for (const f of ['word_count', 'generated_at', 'brief_path', 'tokens_used']) {
    assert.equal(FIELD_OWNERS[f], 'server', `fixture assumption: ${f} is server-owned`);
    assert.ok(authored.has(f), `${f} is authored by blog-post-writer despite being server-owned`);
  }
});

// ── the merge ────────────────────────────────────────────────────────────────

test('a redraft preserves every field it does not author', () => {
  const existing = LIVE_META();
  const merged = composeAuthoredMeta(existing, REDRAFT(), 'blog-post-writer');
  const authored = new Set(authoredFields('blog-post-writer'));

  for (const key of Object.keys(existing)) {
    assert.ok(Object.hasOwn(merged, key), `${key} was dropped by the redraft`);
    if (!authored.has(key)) {
      assert.deepEqual(merged[key], existing[key], `${key} was modified by the redraft`);
    }
  }
});

test('the twelve fields the old 11-key allowlist destroyed all survive', () => {
  const merged = composeAuthoredMeta(LIVE_META(), REDRAFT(), 'blog-post-writer');
  for (const key of [
    'legacy_locked', 'legacy_bucket', 'legacy_triaged_at', 'legacy_triage_reason',
    'indexing_state', 'indexing_submissions', 'indexing_blocked',
    'published_at', 'shopify_status_verified_at', 'needs_rebuild',
    'blocked_resolution', 'performance_review',
    'image_path', 'image_alt', 'image_generated_at', 'post_type',
  ]) {
    assert.ok(Object.hasOwn(merged, key), `${key} did not survive the redraft`);
  }
});

test('a redraft DOES overwrite every field it authors', () => {
  const authoredValues = REDRAFT();
  const merged = composeAuthoredMeta(LIVE_META(), authoredValues, 'blog-post-writer');
  for (const [k, v] of Object.entries(authoredValues)) {
    assert.deepEqual(merged[k], v, `${k} was not refreshed by the redraft`);
  }
  assert.equal(merged.title, 'Best Soap for Tattoos in 2026');
  assert.equal(merged.word_count, 2450);
});

test('a field the agent authors but that is absent from the previous file is added', () => {
  const merged = composeAuthoredMeta({ shopify_article_id: 1 }, REDRAFT(), 'blog-post-writer');
  assert.equal(merged.shopify_article_id, 1);
  assert.equal(merged.slug, 'best-soap-for-tattoos');
});

test('a first draft (no previous file) works from null and from {}', () => {
  for (const empty of [null, undefined, {}]) {
    const merged = composeAuthoredMeta(empty, REDRAFT(), 'blog-post-writer');
    assert.deepEqual(Object.keys(merged).sort(), WRITER_FIELDS.slice().sort());
  }
});

test('existing keys keep their position — a redraft must not reorder ~200 files', () => {
  const existing = LIVE_META();
  const merged = composeAuthoredMeta(existing, REDRAFT(), 'blog-post-writer');
  assert.deepEqual(
    Object.keys(merged).slice(0, Object.keys(existing).length),
    Object.keys(existing),
  );
});

test('composeAuthoredMeta REFUSES an authored key the agent has not declared', () => {
  assert.throws(
    () => composeAuthoredMeta(LIVE_META(), { ...REDRAFT(), brand_new_field: 'x' }, 'blog-post-writer'),
    /brand_new_field/,
  );
});

test('the input objects are not mutated', () => {
  const existing = LIVE_META();
  const authored = REDRAFT();
  const before = JSON.stringify(existing);
  composeAuthoredMeta(existing, authored, 'blog-post-writer');
  assert.equal(JSON.stringify(existing), before);
});
