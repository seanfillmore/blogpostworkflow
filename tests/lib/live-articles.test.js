import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { liveArticleIdSet, fetchLiveArticleIds, isArticleLive } from '../../lib/live-articles.js';

// The real production case this module exists for: article 563289653418
// (best-sls-free-toothpaste-2025) was consolidated away, but performance-engine
// re-queued its slug every morning and queue-autoapply dismissed it every
// afternoon, every day from 2026-09-08 to 2026-09-18.
const GONE = 563289653418;
const ALIVE = 559520252074;

test('liveArticleIdSet collects ids across every blog page', () => {
  const s = liveArticleIdSet([[{ id: 1 }, { id: 2 }], [{ id: 3 }]]);
  assert.deepEqual([...s].sort(), ['1', '2', '3']);
});

test('ids are normalised to strings — a numeric id must not miss', () => {
  // Shopify returns a NUMBER; meta.json has carried both. A Set.has(number)
  // against string keys matches nothing, which would read as "every article is
  // dead" and empty the pick list on a perfectly healthy store.
  const s = liveArticleIdSet([[{ id: ALIVE }]]);
  assert.ok(s.has(String(ALIVE)));
  assert.equal(isArticleLive(s, ALIVE), true, 'numeric id');
  assert.equal(isArticleLive(s, String(ALIVE)), true, 'string id');
});

test('an id absent from the live set is not live', () => {
  const s = liveArticleIdSet([[{ id: ALIVE }]]);
  assert.equal(isArticleLive(s, GONE), false);
});

test('articles with no id are skipped rather than stored as "null"', () => {
  const s = liveArticleIdSet([[{ id: null }, {}, { id: 7 }]]);
  assert.deepEqual([...s], ['7']);
});

test('a null/undefined page list yields an empty set rather than throwing', () => {
  assert.equal(liveArticleIdSet(null).size, 0);
  assert.equal(liveArticleIdSet([null, undefined]).size, 0);
});

// ── fail-open: the half that matters ─────────────────────────────────────────
//
// A picker that quietly stops picking is worse than the bug being fixed: it
// exits 0, cron reads success, and the digest shows a normal-looking run. So a
// Shopify failure must filter NOTHING, and `null` must never be confused with
// an empty Set.

test('fetchLiveArticleIds returns null when the blog list read throws', async () => {
  const ids = await fetchLiveArticleIds({
    getBlogs: async () => { throw new Error('Shopify API GET /blogs → HTTP 503'); },
    getArticles: async () => [],
  });
  assert.equal(ids, null);
});

test('fetchLiveArticleIds returns null when an article page read throws', async () => {
  const ids = await fetchLiveArticleIds({
    getBlogs: async () => [{ id: 1 }],
    getArticles: async () => { throw new Error('HTTP 429'); },
  });
  assert.equal(ids, null, 'a partial read is not a usable answer');
});

test('a null set means "could not tell" and filters nothing', () => {
  assert.equal(isArticleLive(null, GONE), true, 'the GONE article survives an outage');
  assert.equal(isArticleLive(undefined, GONE), true);
});

test('an EMPTY set is not the same as null — it filters everything', () => {
  // A store that genuinely has no articles should filter; only a FAILED read
  // should pass everything through.
  assert.equal(isArticleLive(new Set(), ALIVE), false);
});

test('fetchLiveArticleIds pages every blog', async () => {
  const seen = [];
  const ids = await fetchLiveArticleIds({
    getBlogs: async () => [{ id: 10 }, { id: 20 }],
    getArticles: async (blogId, limit) => {
      seen.push([blogId, limit]);
      return blogId === 10 ? [{ id: ALIVE }] : [{ id: 99 }];
    },
  });
  assert.deepEqual(seen, [[10, 250], [20, 250]], 'one bulk read per blog, not one per candidate');
  assert.deepEqual([...ids].sort(), ['559520252074', '99'].sort());
  assert.equal(isArticleLive(ids, GONE), false, 'the consolidated-away article is filtered');
});

test('an article id of null is allowed through — that is a different guard', () => {
  // pickMetaRewrites already refuses a post with no shopify_article_id, for its
  // own reason (the publish step would fail). This module must not silently
  // take over that decision.
  assert.equal(isArticleLive(new Set(['1']), null), true);
  assert.equal(isArticleLive(new Set(['1']), undefined), true);
});

// ── wiring: performance-engine must actually consult this ───────────────────
//
// A source scan rather than a behavioural test because importing
// agents/performance-engine/index.js for a real run is not possible — and
// `pickMetaRewrites` is not exported. The library above is tested behaviourally;
// this pins that the agent uses it, uses it BEFORE the cap, and does not
// reintroduce the module-scope lib/shopify.js import that would break every
// machine without a .env.
import { readFileSync as _read } from 'node:fs';
import { join as _join } from 'node:path';

const ENGINE = _read(
  _join(import.meta.dirname, '..', '..', 'agents', 'performance-engine', 'index.js'),
  'utf8',
);

test('performance-engine consults the live-article set', () => {
  assert.match(ENGINE, /from '\.\.\/\.\.\/lib\/live-articles\.js'/, 'imports the shared helper');
  assert.match(ENGINE, /isArticleLive\(/, 'actually calls it');
  assert.match(ENGINE, /fetchLiveArticleIds\(/, 'builds the set once per run');
});

test('the dead-article filter runs BEFORE the per-run cap', () => {
  // CLAUDE.md's rule: filtering after the slice lets a dead article eat the
  // single MAX_META slot and leave the run doing nothing.
  const guard = ENGINE.indexOf('isArticleLive(');
  const cap = ENGINE.indexOf('.slice(0, MAX_META)');
  assert.ok(guard > -1 && cap > -1, 'both the guard and the cap are present');
  assert.ok(guard < cap, 'the guard must precede the cap');
});

test('lib/shopify.js is NOT imported at module scope', () => {
  // It reads .env and throws at import time without credentials, and
  // tests/agents/cluster-hold-wiring.test.js imports this agent for
  // holdCandidates. A static import here breaks that test on any machine
  // without a .env — CI, or a fresh clone.
  const staticImport = /^\s*import\s+[^;]*from\s+'\.\.\/\.\.\/lib\/shopify\.js'/m;
  assert.ok(!staticImport.test(ENGINE), 'must be a dynamic import inside main()');
  assert.match(ENGINE, /await import\('\.\.\/\.\.\/lib\/shopify\.js'\)/, 'dynamic import present');
});

test('a skipped dead article is counted and named, never silently dropped', () => {
  assert.match(ENGINE, /deadArticles/, 'the skips are collected');
  assert.match(ENGINE, /deadLines/, 'and rendered');
  // and reach the deferred notify body, not just stdout
  assert.match(ENGINE, /\.\.\.deadLines,?\s*\.\.\.renderDisagreementLines|\.\.\.deadLines,/, 'included in the notify body');
});
