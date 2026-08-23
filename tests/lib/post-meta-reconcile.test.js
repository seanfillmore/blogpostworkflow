// tests/lib/post-meta-reconcile.test.js
//
// `data/posts/<slug>/meta.json` is TRACKED in git and WRITTEN continuously by
// production cron. On 2026-08-23 that combination produced invalid JSON on the
// production server TWICE in one day:
//
//   Incident 1 (PR #629, data/rejected-keywords.json) — `git stash pop`
//     conflicted and left 20 conflict markers in a tracked JSON file.
//   Incident 2 (PR #634, five meta.json files) — same dance, five conflicted
//     files, all invalid JSON. The resolution was NOT "take one side": HEAD was
//     missing `indexing_state`, `indexing_submissions`, `published_at` and
//     `shopify_status: published`, INCLUDING a backfill run hours earlier,
//     because the committed copies are stale by construction. Taking either
//     side wholesale destroys real data. It was resolved field-by-field:
//     server as base, the PR's `title`/`meta_description` overlaid.
//
// These tests pin the properties that make that resolution mechanical:
//   1. a merge never drops a key either side holds;
//   2. a field whose owner is known resolves the same way every time;
//   3. a field whose owner is NOT known can never resolve silently;
//   4. nothing is ever written that does not re-parse to the same object.
//
// Shapes below are modelled on real files read out of data/posts/ on
// 2026-08-23 (best-soap-for-tattoos, best-natural-roll-on-deodorant,
// no-fluoride-toothpaste) — including the two details that matter:
// `brief_path` is an ABSOLUTE path on whichever box wrote it
// (`/root/seo-claude/...` on the server, `/Users/seanfillmore/...` locally),
// and 89 of 94 files carry NO trailing newline.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  FIELD_OWNERS,
  CONTESTED_FIELDS,
  classifyField,
  reconcileMeta,
  reconcilePosts,
  serializeMeta,
  parseMetaText,
  renderReconcileReport,
} from '../../lib/post-meta-reconcile.js';

// ── fixtures ─────────────────────────────────────────────────────────────────

/** What git HEAD carried for best-soap-for-tattoos before PR #634. */
const REPO_BASE = () => ({
  slug: 'best-soap-for-tattoos',
  title: 'Best Soap for Tattoos: What to Use for Safe Healing',
  meta_description: 'Looking for the best soap for tattoos? Learn what ingredients to look for, what to avoid, and how a natural bar soap supports healthy tattoo aftercare.',
  target_keyword: 'best soap for tattoos',
  tags: ['soap', 'natural soap', 'natural skincare', 'organic'],
  word_count: 3009,
  generated_at: '2026-04-04T16:59:54.342Z',
  brief_path: '/root/seo-claude/data/briefs/best-soap-for-tattoos.json',
  tokens_used: { input: 8556, output: 6268 },
  shopify_blog_id: 48998449187,
  shopify_blog_handle: 'news',
  shopify_article_id: 563424362666,
  shopify_handle: 'best-soap-for-tattoos-what-to-use-for-safe-healing',
  shopify_status: 'draft',
  legacy_bucket: 'winner',
  legacy_locked: true,
});

/** The same file after PR #634's compliance commit — title only. */
const REPO_NEW = () => ({ ...REPO_BASE(), title: 'Best Soap for Tattoos: Clean, Gentle, Fragrance-Free' });

/** The production working tree: everything cron stamped since the last commit. */
const SERVER = () => ({
  ...REPO_BASE(),
  shopify_status: 'published',
  shopify_status_verified_at: '2026-08-23T04:10:00.000Z',
  published_at: '2026-04-24T15:00:02.049Z',
  shopify_url: 'https://realskincare-com.myshopify.com/blogs/news/best-soap-for-tattoos-what-to-use-for-safe-healing',
  indexing_state: {
    state: 'discovered_not_crawled',
    coverage: 'Discovered - currently not indexed',
    last_checked: '2026-08-22T13:12:37.716Z',
    last_crawled: null,
    google_canonical: null,
    canonical_mismatch: false,
    page_fetch_state: 'PAGE_FETCH_STATE_UNSPECIFIED',
  },
  indexing_submissions: [
    { method: 'sitemap_resubmit', submitted_at: '2026-08-09T13:13:53.025Z', result: 'ok' },
  ],
  legacy_triage_reason: 'Position 9, 36354 impressions. Page 1 — auto-locked.',
  legacy_triaged_at: '2026-08-04T03:55:43.000Z',
});

// ── the ownership table itself ───────────────────────────────────────────────

test('every field the census found has an owner, and none is owned twice', () => {
  // The 40 keys actually present across data/posts/*/meta.json on 2026-08-23,
  // plus the keys writers emit that no file currently carries.
  const census = [
    'slug', 'title', 'meta_description', 'target_keyword', 'tags', 'post_type',
    'word_count', 'generated_at', 'brief_path', 'tokens_used',
    'shopify_blog_id', 'shopify_blog_handle', 'shopify_article_id', 'shopify_handle',
    'shopify_url', 'shopify_status', 'shopify_publish_at', 'shopify_image_url',
    'shopify_status_verified_at', 'shopify_scheduled_at',
    'uploaded_at', 'published_at', 'unpublished_at', 'unpublished_reason',
    'indexing_state', 'indexing_submissions', 'indexing_blocked',
    'indexing_blocked_reason', 'indexing_blocked_at', 'indexing_unblocked_at', 'indexing_unblocked_by',
    'legacy_bucket', 'legacy_triage_reason', 'legacy_triaged_at', 'legacy_locked',
    'legacy_synced_at', 'legacy_source', 'legacy_winner_ack_at', 'legacy_broken_ack_at',
    'last_refreshed_at', 'refreshed_at', 'rebuilt_at',
    'needs_rebuild', 'blocked_resolution', 'blocked_resolved_at', 'publisher_block',
    'performance_review',
    'image_path', 'image_prompt', 'image_revised_prompt', 'image_alt', 'image_generated_at',
    'image_blocked', 'image_blocked_at', 'image_blocked_reason',
    'redirected_to', 'redirected_at', 'redirect_note',
    'handle', 'url', 'bootstrapped_from_live',
  ];
  const unowned = census.filter((f) => classifyField(f) === 'unclassified');
  assert.deepEqual(unowned, [], `these fields have a known writer but no owner: ${unowned.join(', ')}`);
});

test('brief_path is server-owned because it records an absolute path on the writing box', () => {
  // Real values seen in data/posts/: `/root/seo-claude/data/briefs/...` on the
  // server, `/Users/seanfillmore/Code/Claude/data/briefs/...` locally. Letting
  // a deploy overwrite the server's copy points it at a directory that does
  // not exist on that machine.
  assert.equal(classifyField('brief_path'), 'server');
});

test('the copy fields a human edits are repo-owned', () => {
  for (const f of ['title', 'meta_description', 'target_keyword', 'tags', 'slug', 'post_type']) {
    assert.equal(classifyField(f), 'repo', `${f} should be repo-owned`);
  }
});

test('title, meta_description and target_keyword are flagged contested', () => {
  // agents/editor:1097 (stale-year bump), agents/meta-optimizer:288 and :347
  // (weekly CTR rewrite) and agents/cannibalization-resolver:391/714 all write
  // these on the production server. They stay repo-owned — a committed change
  // to them is how a compliance fix reaches the site — but a conflict on one is
  // never routine and must always be named in the report.
  for (const f of ['title', 'meta_description', 'target_keyword']) {
    assert.ok(CONTESTED_FIELDS.has(f), `${f} should be contested`);
    assert.equal(classifyField(f), 'repo');
  }
  assert.ok(!CONTESTED_FIELDS.has('tags'));
});

test('an unknown field is unclassified, not silently assigned a side', () => {
  assert.equal(classifyField('some_field_invented_next_month'), 'unclassified');
  assert.equal(FIELD_OWNERS.some_field_invented_next_month, undefined);
});

// ── reconcileMeta: 3-way, the mode a deploy actually runs in ─────────────────

test('incident 2, exactly: server keeps its state, the PR keeps its title', () => {
  const { merged, decisions } = reconcileMeta({ base: REPO_BASE(), repo: REPO_NEW(), server: SERVER() });

  // The PR's authored change survives.
  assert.equal(merged.title, 'Best Soap for Tattoos: Clean, Gentle, Fragrance-Free');
  // Everything cron stamped survives — this is what taking git's side destroyed.
  assert.equal(merged.shopify_status, 'published');
  assert.equal(merged.published_at, '2026-04-24T15:00:02.049Z');
  assert.equal(merged.shopify_status_verified_at, '2026-08-23T04:10:00.000Z');
  assert.deepEqual(merged.indexing_state, SERVER().indexing_state);
  assert.deepEqual(merged.indexing_submissions, SERVER().indexing_submissions);
  assert.equal(merged.legacy_triaged_at, '2026-08-04T03:55:43.000Z');

  // And every one of those is a named decision, not a side effect.
  const byField = Object.fromEntries(decisions.map((d) => [d.field, d]));
  assert.equal(byField.title.outcome, 'repo-only-change');
  assert.equal(byField.shopify_status.outcome, 'server-only-change');
  assert.equal(byField.published_at.outcome, 'added-server');
});

test('a one-sided change needs no ownership rule at all', () => {
  // Only the server moved shopify_status; ownership never has to arbitrate,
  // so a field this side owns and a field the other side owns behave the same.
  const base = { title: 'A', shopify_status: 'draft' };
  const { decisions } = reconcileMeta({ base, repo: { ...base }, server: { ...base, shopify_status: 'published' } });
  const d = decisions.find((x) => x.field === 'shopify_status');
  assert.equal(d.outcome, 'server-only-change');
  assert.equal(d.arbitratedBy, null, 'a one-sided change must not be recorded as an ownership call');
});

test('a repo-side change to a SERVER-owned field still wins when the server did not touch it', () => {
  // 3-way semantics: ownership decides conflicts, not every field. A commit
  // that clears a stale indexing_blocked flag must actually clear it.
  const base = { indexing_blocked: true, indexing_blocked_reason: 'stale' };
  const repo = {};
  const server = { indexing_blocked: true, indexing_blocked_reason: 'stale' };
  const { merged, decisions } = reconcileMeta({ base, repo, server });
  assert.equal('indexing_blocked' in merged, false);
  assert.equal(decisions.find((d) => d.field === 'indexing_blocked').outcome, 'deleted-repo');
});

test('both sides changed a repo-owned field: repo wins, and the server value is recorded verbatim', () => {
  // meta-optimizer rewrote the title on the server for CTR; a compliance commit
  // rewrote it in git. The compliance fix wins — but the CTR title is not lost
  // to history, it is in the run record.
  const base = REPO_BASE();
  const server = { ...SERVER(), title: 'Best Tattoo Soap — Fragrance-Free Bar (CTR test B)' };
  const { merged, decisions, conflicts } = reconcileMeta({ base, repo: REPO_NEW(), server });

  assert.equal(merged.title, 'Best Soap for Tattoos: Clean, Gentle, Fragrance-Free');
  const d = decisions.find((x) => x.field === 'title');
  assert.equal(d.outcome, 'resolved-by-owner');
  assert.equal(d.arbitratedBy, 'repo');
  assert.equal(d.contested, true);
  assert.equal(d.serverValue, 'Best Tattoo Soap — Fragrance-Free Bar (CTR test B)');
  assert.equal(d.repoValue, 'Best Soap for Tattoos: Clean, Gentle, Fragrance-Free');
  assert.equal(conflicts.length, 1);
});

test('both sides changed a server-owned field: server wins, repo value recorded', () => {
  const base = { shopify_status: 'draft' };
  const { merged, decisions } = reconcileMeta({
    base,
    repo: { shopify_status: 'scheduled' },
    server: { shopify_status: 'published' },
  });
  assert.equal(merged.shopify_status, 'published');
  const d = decisions.find((x) => x.field === 'shopify_status');
  assert.equal(d.arbitratedBy, 'server');
  assert.equal(d.repoValue, 'scheduled');
});

test('both sides changed an UNCLASSIFIED field: nothing resolves silently', () => {
  const base = { mystery_field: 1 };
  const r = reconcileMeta({ base, repo: { mystery_field: 2 }, server: { mystery_field: 3 } });
  // The safer default is the live box, but the point is that it is flagged.
  assert.equal(r.merged.mystery_field, 3);
  const d = r.decisions.find((x) => x.field === 'mystery_field');
  assert.equal(d.outcome, 'unclassified-conflict');
  assert.equal(r.unclassifiedConflicts.length, 1);
  assert.equal(r.unclassifiedConflicts[0].field, 'mystery_field');
});

// ── reconcileMeta: 2-way, the mode with no merge base ────────────────────────

test('without a base, a field present on only one side is KEPT, never dropped', () => {
  // This is the whole difference between 2-way and 3-way: with no base we
  // cannot tell "added here" from "deleted there", so we keep it. Dropping a
  // field on a guess is the failure this script exists to prevent.
  const r = reconcileMeta({
    base: null,
    repo: { title: 'T', post_type: 'listicle' },
    server: { title: 'T', indexing_state: { state: 'indexed' } },
  });
  assert.equal(r.merged.post_type, 'listicle');
  assert.deepEqual(r.merged.indexing_state, { state: 'indexed' });
  const outcomes = Object.fromEntries(r.decisions.map((d) => [d.field, d.outcome]));
  assert.equal(outcomes.post_type, 'kept-one-sided');
  assert.equal(outcomes.indexing_state, 'kept-one-sided');
});

test('without a base, a differing field is decided by ownership alone', () => {
  const r = reconcileMeta({
    base: null,
    repo: { title: 'authored', shopify_status: 'draft' },
    server: { title: 'machine', shopify_status: 'published' },
  });
  assert.equal(r.merged.title, 'authored');
  assert.equal(r.merged.shopify_status, 'published');
});

// ── never drop a field ───────────────────────────────────────────────────────

test('the merged key set is never smaller than the union minus deliberate deletions', () => {
  const repo = REPO_NEW();
  const server = SERVER();
  const r = reconcileMeta({ base: REPO_BASE(), repo, server });
  const union = new Set([...Object.keys(repo), ...Object.keys(server)]);
  for (const k of union) {
    assert.ok(k in r.merged, `${k} vanished from the merge`);
  }
});

test('every key in the union produces exactly one decision', () => {
  const repo = REPO_NEW();
  const server = SERVER();
  const r = reconcileMeta({ base: REPO_BASE(), repo, server });
  const union = [...new Set([...Object.keys(repo), ...Object.keys(server)])].sort();
  assert.deepEqual(r.decisions.map((d) => d.field).sort(), union);
});

// ── idempotency ──────────────────────────────────────────────────────────────

test('reconciling the merged result again changes nothing', () => {
  const first = reconcileMeta({ base: REPO_BASE(), repo: REPO_NEW(), server: SERVER() });
  assert.equal(first.changed, true);
  // Second run: the working tree now holds `merged`, git still holds REPO_NEW,
  // and the base is unchanged.
  const second = reconcileMeta({ base: REPO_BASE(), repo: REPO_NEW(), server: first.merged });
  assert.equal(second.changed, false);
  assert.deepEqual(second.merged, first.merged);
});

test('two files already in sync report changed:false and no conflicts', () => {
  const r = reconcileMeta({ base: REPO_BASE(), repo: REPO_BASE(), server: REPO_BASE() });
  assert.equal(r.changed, false);
  assert.equal(r.conflicts.length, 0);
  assert.equal(r.unclassifiedConflicts.length, 0);
});

// ── key order and serialization ──────────────────────────────────────────────

test('output preserves the order of the file being written, appending new keys', () => {
  const repo = { slug: 's', title: 'T', tags: [] };
  const server = { slug: 's', title: 'T', shopify_status: 'published', indexing_state: {} };
  const r = reconcileMeta({ base: null, repo, server, orderFrom: server });
  assert.deepEqual(Object.keys(r.merged), ['slug', 'title', 'shopify_status', 'indexing_state', 'tags']);
});

test('serializeMeta preserves the file\'s trailing-newline style', () => {
  // 89 of 94 real files end WITHOUT a newline (JSON.stringify written raw);
  // 5 end with one. Rewriting the style churns a diff line on every file.
  const obj = { a: 1 };
  assert.equal(serializeMeta(obj, { trailingNewline: false }), '{\n  "a": 1\n}');
  assert.equal(serializeMeta(obj, { trailingNewline: true }), '{\n  "a": 1\n}\n');
});

test('parseMetaText rejects a conflict-markered file rather than guessing', () => {
  const conflicted = '{\n<<<<<<< HEAD\n  "title": "A"\n=======\n  "title": "B"\n>>>>>>> origin/main\n}';
  assert.throws(() => parseMetaText(conflicted, 'x/meta.json'), /conflict marker/i);
});

test('parseMetaText rejects a non-object', () => {
  assert.throws(() => parseMetaText('[1,2,3]', 'x/meta.json'), /object/i);
  assert.throws(() => parseMetaText('not json', 'x/meta.json'), /parse/i);
});

test('serialize → parse round-trips every real-shaped value', () => {
  const merged = reconcileMeta({ base: REPO_BASE(), repo: REPO_NEW(), server: SERVER() }).merged;
  const text = serializeMeta(merged, { trailingNewline: false });
  assert.deepEqual(parseMetaText(text, 'roundtrip'), merged);
});

// ── reconcilePosts: the whole tree ───────────────────────────────────────────

test('reconcilePosts handles a post that exists on only one side', () => {
  const r = reconcilePosts({
    base: new Map(),
    repo: new Map([['only-in-git', { slug: 'only-in-git', title: 'G' }]]),
    server: new Map([['only-on-server', { slug: 'only-on-server', title: 'S' }]]),
  });
  const bySlug = Object.fromEntries(r.posts.map((p) => [p.slug, p]));
  assert.equal(bySlug['only-in-git'].status, 'repo-only');
  assert.equal(bySlug['only-on-server'].status, 'server-only');
  // Neither is a divergence to fix — a post git has and the box does not is
  // arriving with the pull; a post only the box has is an undrafted local post.
  assert.equal(r.summary.changed, 0);
});

test('reconcilePosts summarises divergence and unclassified conflicts across posts', () => {
  const r = reconcilePosts({
    base: new Map([['a', REPO_BASE()], ['b', { slug: 'b', mystery: 1 }]]),
    repo: new Map([['a', REPO_NEW()], ['b', { slug: 'b', mystery: 2 }]]),
    server: new Map([['a', SERVER()], ['b', { slug: 'b', mystery: 3 }]]),
  });
  // `changed` counts files that need a WRITE. Post "b" resolved to exactly what
  // the live box already holds, so there is nothing to write there — but the
  // unclassified conflict is still counted, and that is deliberately a separate
  // number. A conflict that happens to resolve to the current file contents is
  // still a field nobody has taken a position on; the script gives it its own
  // exit code rather than letting `changed: 0` read as "all clear".
  assert.equal(r.summary.changed, 1);
  assert.equal(r.summary.unclassifiedConflicts, 1);
  assert.equal(r.summary.inSync, false);
});

test('an unclassified conflict is counted even when it needs no write', () => {
  const r = reconcilePosts({
    base: new Map([['b', { slug: 'b', mystery: 1 }]]),
    repo: new Map([['b', { slug: 'b', mystery: 2 }]]),
    server: new Map([['b', { slug: 'b', mystery: 3 }]]),
  });
  assert.equal(r.summary.changed, 0);
  assert.equal(r.summary.inSync, true, 'nothing to write');
  assert.equal(r.summary.unclassifiedConflicts, 1, 'but a human still has to classify the field');
});

test('renderReconcileReport names every field-level decision that was arbitrated', () => {
  const r = reconcilePosts({
    base: new Map([['a', REPO_BASE()]]),
    repo: new Map([['a', REPO_NEW()]]),
    server: new Map([['a', { ...SERVER(), title: 'CTR variant B' }]]),
  });
  const text = renderReconcileReport(r, { repoLabel: 'git origin/main', serverLabel: 'working tree' });
  assert.match(text, /title/);
  assert.match(text, /CTR variant B/, 'the losing value must appear in the report');
  assert.match(text, /Best Soap for Tattoos: Clean, Gentle, Fragrance-Free/);
  assert.match(text, /contested/i);
});
