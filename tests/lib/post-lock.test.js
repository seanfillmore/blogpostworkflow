// tests/lib/post-lock.test.js
//
// Pins the winner-lock semantics AND the path bug that made meta-optimizer's
// guard inert: the lock lives in data/posts/<slug>/meta.json, never in a flat
// data/posts/<slug>.json, and the target is resolved through lib/posts.js's
// resolver because a Shopify article handle is not always the local slug.
//
// SEO_CLAUDE_ROOT must be set BEFORE lib/posts.js is imported — it captures
// ROOT at module load. Hence the dynamic import below.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const ROOT = mkdtempSync(join(tmpdir(), 'post-lock-'));
process.env.SEO_CLAUDE_ROOT = ROOT;

const POSTS = join(ROOT, 'data', 'posts');
mkdirSync(POSTS, { recursive: true });

function writePost(slug, meta) {
  mkdirSync(join(POSTS, slug), { recursive: true });
  writeFileSync(join(POSTS, slug, 'meta.json'), JSON.stringify(meta, null, 2));
}

function writeRawPost(slug, raw) {
  mkdirSync(join(POSTS, slug), { recursive: true });
  writeFileSync(join(POSTS, slug, 'meta.json'), raw);
}

// A locked winner stored under a SHORTENED slug — its live Shopify handle is
// longer. This is the real shape of data/posts/best-soap-for-tattoos/.
writePost('best-soap-for-tattoos', {
  slug: 'best-soap-for-tattoos',
  shopify_article_id: 563424362666,
  shopify_handle: 'best-soap-for-tattoos-what-to-use-for-safe-healing',
  shopify_url: 'https://example.com/blogs/news/best-soap-for-tattoos-what-to-use-for-safe-healing',
  legacy_bucket: 'winner',
  legacy_locked: true,
});

// A locked post whose bucket drifted away from 'winner'. The lock is the
// authority, not the bucket — this is data/posts/natural-soap-bar/ on prod.
writePost('natural-soap-bar', {
  slug: 'natural-soap-bar',
  shopify_article_id: 1,
  shopify_handle: 'natural-soap-bar',
  legacy_bucket: 'flop',
  legacy_locked: true,
});

// A locked post whose local slug is NOT a prefix of its Shopify handle, so the
// resolver's truncation fallback cannot reach it — only an authoritative match
// on the stored handle can. 93 of 94 local metas carry `shopify_handle` and no
// `handle`/`url` at all, which is the common shape, not the exotic one.
writePost('deodorant-guide', {
  slug: 'deodorant-guide',
  shopify_article_id: 3,
  shopify_handle: 'natural-deodorant-complete-guide',
  shopify_url: 'https://example.com/blogs/news/natural-deodorant-complete-guide',
  legacy_bucket: 'winner',
  legacy_locked: true,
});

// An ordinary unlocked post.
writePost('unscented-lotion', {
  slug: 'unscented-lotion',
  shopify_article_id: 2,
  shopify_handle: 'unscented-lotion',
  legacy_bucket: 'rising',
});

// meta.json present but not parseable — "I cannot read the lock", not "absent".
writeRawPost('corrupt-post', '{ this is not json');

// A DECOY flat file at the old, wrong path. If anything still reads
// data/posts/<slug>.json, this file would be what it finds — and it says
// unlocked, so a guard reading it would wave a locked winner straight through.
writeFileSync(
  join(POSTS, 'best-soap-for-tattoos-what-to-use-for-safe-healing.json'),
  JSON.stringify({ legacy_locked: false }),
);

process.on('exit', () => { try { rmSync(ROOT, { recursive: true, force: true }); } catch {} });

const {
  readLockState, mayRewriteBody, mayTestMetadata, decideLockAction,
  LOCK_LOCKED, LOCK_UNLOCKED, LOCK_NO_POST, LOCK_UNREADABLE,
} = await import('../../lib/post-lock.js');

// ── readLockState ────────────────────────────────────────────────────────────

test('readLockState finds the lock in data/posts/<slug>/meta.json, not a flat <slug>.json', () => {
  const s = readLockState('best-soap-for-tattoos');
  assert.equal(s.state, LOCK_LOCKED);
  assert.equal(s.slug, 'best-soap-for-tattoos');
  assert.equal(s.bucket, 'winner');
});

test('readLockState resolves a live URL whose article handle is NOT the local slug', () => {
  // The decoy flat file sits at exactly this handle and claims unlocked.
  // Reading it (the old bug) yields LOCK_UNLOCKED and the guard never fires.
  const s = readLockState('https://example.com/blogs/news/best-soap-for-tattoos-what-to-use-for-safe-healing');
  assert.equal(s.state, LOCK_LOCKED, 'must resolve the handle back to the shortened local slug');
  assert.equal(s.slug, 'best-soap-for-tattoos');
});

test('readLockState resolves a bare article handle that is not the local slug', () => {
  const s = readLockState('best-soap-for-tattoos-what-to-use-for-safe-healing');
  assert.equal(s.state, LOCK_LOCKED);
  assert.equal(s.slug, 'best-soap-for-tattoos');
});

test('readLockState resolves by stored shopify_handle when truncation cannot match', () => {
  const s = readLockState('https://example.com/blogs/news/natural-deodorant-complete-guide');
  assert.equal(s.state, LOCK_LOCKED);
  assert.equal(s.slug, 'deodorant-guide');
});

test('readLockState trusts legacy_locked over legacy_bucket', () => {
  const s = readLockState('natural-soap-bar');
  assert.equal(s.state, LOCK_LOCKED);
  assert.equal(s.bucket, 'flop');
});

test('readLockState reports an unlocked post as unlocked', () => {
  assert.equal(readLockState('unscented-lotion').state, LOCK_UNLOCKED);
});

test('readLockState distinguishes a genuinely absent post from an unreadable one', () => {
  assert.equal(readLockState('no-such-post-anywhere').state, LOCK_NO_POST);
  assert.equal(readLockState('corrupt-post').state, LOCK_UNREADABLE);
});

test('readLockState treats an empty/blank target as no-post rather than throwing', () => {
  assert.equal(readLockState('').state, LOCK_NO_POST);
  assert.equal(readLockState(null).state, LOCK_NO_POST);
});

// ── mayRewriteBody — the guard that must keep blocking ───────────────────────

test('mayRewriteBody refuses a locked winner', () => {
  const d = mayRewriteBody('best-soap-for-tattoos');
  assert.equal(d.allowed, false);
  assert.match(d.reason, /locked/i);
});

test('mayRewriteBody refuses a locked post reached by its live handle', () => {
  assert.equal(mayRewriteBody('best-soap-for-tattoos-what-to-use-for-safe-healing').allowed, false);
});

test('mayRewriteBody FAILS CLOSED when meta.json exists but cannot be read', () => {
  const d = mayRewriteBody('corrupt-post');
  assert.equal(d.allowed, false);
  assert.equal(d.state, LOCK_UNREADABLE);
});

test('mayRewriteBody allows an unlocked post', () => {
  assert.equal(mayRewriteBody('unscented-lotion').allowed, true);
});

test('mayRewriteBody allows a target with no local post record at all', () => {
  // Absence carries no lock signal: the lock is only ever stamped on a local
  // meta.json. Refusing here would make the guard refuse everything it cannot
  // see, which is the same silent stall in the other direction.
  const d = mayRewriteBody('no-such-post-anywhere');
  assert.equal(d.allowed, true);
  assert.equal(d.state, LOCK_NO_POST);
});

// ── mayTestMetadata — the design change ──────────────────────────────────────

test('mayTestMetadata ALLOWS a title/meta test on a locked winner', () => {
  const d = mayTestMetadata('best-soap-for-tattoos');
  assert.equal(d.allowed, true);
  assert.equal(d.state, LOCK_LOCKED);
});

test('mayTestMetadata demands A/B tracking on a locked winner', () => {
  // The whole safety argument for touching a winner is that meta-ab-checker
  // auto-reverts a regression. A mutation with no tracker entry is never
  // reverted, so it is not allowed to happen unattributed.
  assert.equal(mayTestMetadata('best-soap-for-tattoos').requiresAbTracking, true);
  assert.equal(mayTestMetadata('corrupt-post').requiresAbTracking, true);
});

test('mayTestMetadata does not demand A/B tracking on an ordinary unlocked post', () => {
  assert.equal(mayTestMetadata('unscented-lotion').requiresAbTracking, false);
  assert.equal(mayTestMetadata('no-such-post-anywhere').requiresAbTracking, false);
});

// ── decideLockAction — pure policy table, no filesystem ──────────────────────

test('decideLockAction is a pure policy table over the four lock states', () => {
  const body = (s) => decideLockAction('body', s).allowed;
  const meta = (s) => decideLockAction('metadata', s).allowed;

  assert.deepEqual(
    [body(LOCK_UNLOCKED), body(LOCK_NO_POST), body(LOCK_LOCKED), body(LOCK_UNREADABLE)],
    [true, true, false, false],
  );
  assert.deepEqual(
    [meta(LOCK_UNLOCKED), meta(LOCK_NO_POST), meta(LOCK_LOCKED), meta(LOCK_UNREADABLE)],
    [true, true, true, true],
  );
});

test('decideLockAction rejects an unknown action rather than defaulting to allow', () => {
  assert.throws(() => decideLockAction('publish', LOCK_UNLOCKED), /unknown action/i);
});
