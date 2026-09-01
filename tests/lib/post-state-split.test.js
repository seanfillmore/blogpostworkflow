// The meta/state split: authored copy stays in the tracked meta.json, machine
// state moves to a gitignored state.json sibling, and a deploy can no longer
// collide with cron.
//
// `SEO_CLAUDE_ROOT` is set BEFORE the dynamic import because lib/posts.js
// resolves ROOT at module scope. node --test gives each file its own process, so
// this cannot leak into another suite.
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = mkdtempSync(join(tmpdir(), 'post-state-'));
process.env.SEO_CLAUDE_ROOT = ROOT;

let posts;
before(async () => { posts = await import('../../lib/posts.js'); });

const SLUG = 'a-post';
const dir = () => join(ROOT, 'data', 'posts', SLUG);

beforeEach(() => {
  rmSync(join(ROOT, 'data'), { recursive: true, force: true });
  mkdirSync(dir(), { recursive: true });
});

const writeMeta = (o) => writeFileSync(join(dir(), 'meta.json'), JSON.stringify(o, null, 2));
const writeState = (o) => writeFileSync(join(dir(), 'state.json'), JSON.stringify(o, null, 2));
const readMeta = () => JSON.parse(readFileSync(join(dir(), 'meta.json'), 'utf8'));
const readState = () => JSON.parse(readFileSync(join(dir(), 'state.json'), 'utf8'));

// ── the pure partition ──────────────────────────────────────────────────────

test('partitionMetaFields splits on FIELD_OWNERS, not on a guess', () => {
  const { meta, state } = posts.partitionMetaFields({
    title: 'A Title',                 // repo
    target_keyword: 'kw',             // repo
    shopify_article_id: 123,          // server
    indexing_state: { state: 'indexed' }, // server
  });
  assert.deepEqual(meta, { title: 'A Title', target_keyword: 'kw' });
  assert.deepEqual(state, { shopify_article_id: 123, indexing_state: { state: 'indexed' } });
});

test('an UNCLASSIFIED field goes to state, and is reported', () => {
  // Direction matters. The repo-owned set is a closed list of six fields a human
  // authors; anything new is written by code and is therefore machine state. A
  // machine field wrongly in state.json is merely untracked (and backed up
  // offsite); an authored field wrongly there would vanish from review. Routing
  // the unknown to state is the failure this repo can absorb.
  const { meta, state, unclassified } = posts.partitionMetaFields({
    title: 'T',
    some_new_stamp_at: '2026-08-31T00:00:00Z',
  });
  assert.deepEqual(meta, { title: 'T' });
  assert.deepEqual(state, { some_new_stamp_at: '2026-08-31T00:00:00Z' });
  assert.deepEqual(unclassified, ['some_new_stamp_at']);
});

test('the three fields production carried but the table never classified', () => {
  // Measured on the server 2026-08-31: 207 posts, 59 distinct fields, these three
  // classified by nothing. All record an observation about the live world plus
  // the action taken — the same call as republished_at.
  const { state, unclassified } = posts.partitionMetaFields({
    legacy_lock_cleared_at: 'x', legacy_lock_cleared_reason: 'y', merge_hold_resolved: true,
  });
  assert.deepEqual(unclassified, [], 'all three must now be classified, not fall through as unknown');
  assert.equal(Object.keys(state).length, 3);
});

// ── the merged read ─────────────────────────────────────────────────────────

test('with no state.json, getPostMeta behaves exactly as before', () => {
  writeMeta({ title: 'T', shopify_article_id: 9 });
  assert.deepEqual(posts.getPostMeta(SLUG), { title: 'T', shopify_article_id: 9 });
});

test('getPostMeta merges both files', () => {
  writeMeta({ title: 'T' });
  writeState({ shopify_article_id: 9 });
  assert.deepEqual(posts.getPostMeta(SLUG), { title: 'T', shopify_article_id: 9 });
});

test('state WINS on a server field present in both — it is the newer authority', () => {
  // During the shim period meta.json still carries stale copies of server fields
  // (nothing has split them out yet) while every write goes to state.json. If
  // meta won, every migrated writer's value would be masked by the stale copy.
  writeMeta({ title: 'T', shopify_article_id: 'STALE' });
  writeState({ shopify_article_id: 'FRESH' });
  assert.equal(posts.getPostMeta(SLUG).shopify_article_id, 'FRESH');
  assert.equal(posts.getPostMeta(SLUG).title, 'T');
});

test('a post with no meta.json at all still reads null, as before', () => {
  assert.equal(posts.getPostMeta(SLUG), null);
});

test('an unparseable state.json does NOT erase the meta it sits beside', () => {
  // Every reader in the fleet catch{}s a parse failure and carries on as though
  // the file were empty. Returning null here would make a single corrupt state
  // file look, to all 31 readers, exactly like a post that does not exist.
  writeMeta({ title: 'T', shopify_article_id: 9 });
  writeFileSync(join(dir(), 'state.json'), '{ not json');
  assert.deepEqual(posts.getPostMeta(SLUG), { title: 'T', shopify_article_id: 9 });
});

// ── the write chokepoint ────────────────────────────────────────────────────

test('writePostMeta routes each field to its own file', () => {
  writeMeta({ title: 'T' });
  posts.writePostMeta(SLUG, { shopify_article_id: 42, meta_description: 'D' });
  assert.deepEqual(readMeta(), { title: 'T', meta_description: 'D' });
  assert.deepEqual(readState(), { shopify_article_id: 42 });
});

test('writePostMeta MERGES onto what is there — it never rebuilds', () => {
  // This is the property blog-post-writer lacked: it rebuilt the object from a
  // literal and carried the previous file across through an allowlist, so 91 of
  // 94 posts would lose at least one field on a redraft, legacy_locked on 21 of
  // them. A chokepoint that merges makes that class of bug unwritable.
  writeMeta({ title: 'T', tags: ['a'] });
  writeState({ shopify_article_id: 42, legacy_locked: true });
  posts.writePostMeta(SLUG, { title: 'NEW' });
  assert.deepEqual(readMeta(), { title: 'NEW', tags: ['a'] });
  assert.deepEqual(readState(), { shopify_article_id: 42, legacy_locked: true },
    'an untouched server field must survive a repo-field write');
});

test('writePostMeta returns the merged view, so callers can keep chaining', () => {
  writeMeta({ title: 'T' });
  const after = posts.writePostMeta(SLUG, { shopify_article_id: 42 });
  assert.equal(after.title, 'T');
  assert.equal(after.shopify_article_id, 42);
});

test('writePostMeta can DELETE a field with undefined', () => {
  // needs_rebuild is cleared by six writers. Without an explicit delete they
  // would each have to fall back to raw writeFileSync, which is the chokepoint
  // leaking on the exact field that most needs to pass through it.
  writeState({ needs_rebuild: { reason: 'x' }, shopify_article_id: 42 });
  posts.writePostMeta(SLUG, { needs_rebuild: undefined });
  assert.deepEqual(readState(), { shopify_article_id: 42 });
  assert.equal(posts.getPostMeta(SLUG).needs_rebuild, undefined);
});

test('writePostMeta creates the post directory when it is missing', () => {
  rmSync(dir(), { recursive: true, force: true });
  posts.writePostMeta(SLUG, { title: 'T', shopify_article_id: 1 });
  assert.ok(existsSync(join(dir(), 'meta.json')));
  assert.ok(existsSync(join(dir(), 'state.json')));
});

test('writePostMeta does not create an empty state.json for a repo-only write', () => {
  // 207 empty files would be pure noise in a tree somebody greps by hand.
  writeMeta({ title: 'T' });
  posts.writePostMeta(SLUG, { title: 'NEW' });
  assert.equal(existsSync(join(dir(), 'state.json')), false);
});

test('a write is atomic — no reader can observe a half-written file', () => {
  // A crash mid-write leaves a truncated object, and every reader's catch{}
  // reads that as "this post has no metadata". Temp file + rename, the same
  // shape lib/rejected-keywords.js already uses.
  writeMeta({ title: 'T' });
  posts.writePostMeta(SLUG, { shopify_article_id: 1 });
  const stray = readdirSync(dir()).filter((f) => f.includes('.tmp'));
  assert.deepEqual(stray, [], 'no temp file may be left behind');
});

test('writePostMeta round-trips through getPostMeta', () => {
  posts.writePostMeta(SLUG, { title: 'T', shopify_article_id: 1, legacy_locked: true });
  const m = posts.getPostMeta(SLUG);
  assert.equal(m.title, 'T');
  assert.equal(m.shopify_article_id, 1);
  assert.equal(m.legacy_locked, true);
});
