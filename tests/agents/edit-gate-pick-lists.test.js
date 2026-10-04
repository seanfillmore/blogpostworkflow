// The live-article edit gate (lib/post-edit-gate.js) applied to each agent's
// PICK LIST, before its per-run cap. The gate itself is injected, so these run
// against fixtures and never read a post tree. Only modules that are safe to
// import are imported here (guarded agents and pure lib/ helpers).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { excludeEditGated } from '../../agents/meta-optimizer/lib/hold.js';
import { winnerPostSlug } from '../../agents/cannibalization-resolver/post-dir.js';
import { selectLegacyPosts } from '../../agents/legacy-rebuilder/index.js';
import { selectBlockedPostsWithHold } from '../../agents/blocked-post-resolver/index.js';
import { gateSlugs } from '../../agents/refresh-runner/index.js';

const W = 'https://www.realskincare.com/blogs/news/';
const SLS = 'toothpaste-without-sls-what-to-know-best-options';
const HELD = { allowed: false, reason: 'measuring the last change (2026-09-13); next serp edit allowed 2026-10-11', until: '2026-10-11T00:00:00.000Z' };
const OK = { allowed: true, reason: 'ok' };
const gate = (held) => (target) => (held.includes(target) ? HELD : OK);

describe('meta-optimizer: excludeEditGated', () => {
  test('a page inside its cooldown is withheld as a serp edit; others kept in order', () => {
    const asked = [];
    const mayEdit = (t, k) => { asked.push(k); return gate([SLS])(t); };
    const cands = [
      { keyword: 'sls free toothpaste', url: W + SLS },
      { keyword: 'best soap for tattoos', url: W + 'best-soap-for-tattoos-2' },
      { keyword: 'unmapped query' },
    ];
    const { kept, excluded } = excludeEditGated(cands, { mayEdit, pageForKeyword: () => null });
    assert.deepEqual(kept.map((c) => c.keyword), ['best soap for tattoos', 'unmapped query']);
    assert.equal(excluded.length, 1);
    assert.equal(excluded[0].handle, SLS);
    assert.equal(excluded[0].kind, 'serp');
    assert.ok(asked.every((k) => k === 'serp'));
  });

  test('resolves a candidate with no url through pageForKeyword', () => {
    const { excluded } = excludeEditGated([{ keyword: 'sls free toothpaste' }], {
      mayEdit: gate([SLS]), pageForKeyword: () => W + SLS,
    });
    assert.equal(excluded.length, 1);
  });

  test('applied before the cap: three held pages cannot eat a budget of two', () => {
    const cands = ['a', 'b', 'c', 'd', 'e'].map((h) => ({ keyword: h, url: W + h }));
    const { kept } = excludeEditGated(cands, { mayEdit: gate(['a', 'b', 'c']) });
    assert.deepEqual(kept.slice(0, 2).map((c) => c.keyword), ['d', 'e']);
  });
});

describe('cannibalization-resolver: winnerPostSlug (the shadow-dir bug)', () => {
  const metas = [
    ['toothpaste-without-sls', { shopify_handle: SLS, shopify_article_id: 1 }],
    ['best-soap-for-tattoos', { shopify_url: W + 'best-soap-for-tattoos-what-to-use-for-safe-healing' }],
  ];

  test('the SLS article resolves to the dir that DECLARES its handle, not a new dir named for it', () => {
    assert.equal(winnerPostSlug(SLS, metas), 'toothpaste-without-sls');
  });

  test('a shadow dir named for the handle but declaring nothing does not win over the declaring post', () => {
    const withShadow = [[SLS, { title: 'merge leftover' }], ...metas];
    assert.equal(winnerPostSlug(SLS, withShadow), 'toothpaste-without-sls');
  });

  test('falls back to the handle only when no post holds the article', () => {
    assert.equal(winnerPostSlug('brand-new-article', metas), 'brand-new-article');
  });

  test('a dir named for the handle that declares ANOTHER article is refused (null), never written into', () => {
    const m = [['foo', { shopify_handle: 'foo-2', shopify_article_id: 9 }]];
    assert.equal(winnerPostSlug('foo', m), null);
  });
});

describe('legacy-rebuilder: selectLegacyPosts with the edit gate', () => {
  const post = (slug, meta = {}) => ({ slug, meta: { shopify_article_id: 1, ...meta } });

  test('a held post is reported, not rebuilt, and is filtered before the cap', () => {
    const { kept, editGated } = selectLegacyPosts(
      [post('frozen-1'), post('frozen-2'), post('ok')],
      { mayEdit: gate(['frozen-1', 'frozen-2']), limit: 1 },
    );
    assert.deepEqual(kept.map((p) => p.slug), ['ok']);
    assert.equal(editGated.length, 2);
    assert.equal(editGated[0].kind, 'rewrite');
  });

  test('asks about the declared article handle when the meta carries one', () => {
    const seen = [];
    selectLegacyPosts([post('toothpaste-without-sls', { shopify_handle: SLS })], { mayEdit: (t) => { seen.push(t); return OK; } });
    assert.deepEqual(seen, [SLS]);
  });

  test('no gate injected (dry run) withholds nothing', () => {
    assert.equal(selectLegacyPosts([post('a')]).kept.length, 1);
  });
});

describe('blocked-post-resolver: only LIVE posts are asked, before the limit', () => {
  const NEEDS_WORK = '## OVERALL QUALITY\nVERDICT: Needs Work\n\n## BLOCKERS\n1. Factual concerns: an uncited statistic.\n';
  const now = Date.parse('2026-08-22T12:00:00Z');
  const live = (extra = {}) => ({ shopify_blog_id: 1, shopify_article_id: 2, shopify_publish_at: '2025-06-25T11:00:07-06:00', ...extra });
  const entry = (slug) => ({ slug, meta: live(), report: NEEDS_WORK, reportAgeDays: 2 });

  test('a held live post is withheld and the next one takes the slot', () => {
    const { kept, editGated } = selectBlockedPostsWithHold(
      [entry('held-post'), entry('ok-post')],
      { now, limit: 1, mayEdit: gate(['held-post']) },
    );
    assert.deepEqual(kept.map((e) => e.slug), ['ok-post']);
    assert.equal(editGated.length, 1);
  });
});

describe('refresh-runner: gateSlugs', () => {
  test('rewrite kind, held slugs moved out', () => {
    const seen = [];
    const { kept, held } = gateSlugs(['a', 'b'], (t, k) => { seen.push(k); return gate(['a'])(t); });
    assert.deepEqual(kept, ['b']);
    assert.equal(held[0].target, 'a');
    assert.ok(seen.every((k) => k === 'rewrite'));
  });
});
