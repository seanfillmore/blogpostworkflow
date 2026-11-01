import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { resolveSlugAmong, declaresOtherArticle } from '../../lib/posts.js';
import { writeTargetSlug, articleForSlugArg } from '../../agents/content-refresher/index.js';

// Production, 2026-09-21: 18 of 221 post dirs are named for one Shopify handle
// while their meta records ANOTHER article. This is the pair that broke the
// flop-refresh loop: article `organic-coconut-oil-types-uses-benefits-for-skin`
// lives in `what-is-organic-coconut-oil-uses-benefits-types/`, and the dir named
// for that handle holds the `-2` duplicate.
const A_HANDLE = 'organic-coconut-oil-types-uses-benefits-for-skin';
const METAS = [
  ['what-is-organic-coconut-oil-uses-benefits-types', { shopify_handle: A_HANDLE, shopify_article_id: 563424592042 }],
  [A_HANDLE, { shopify_handle: `${A_HANDLE}-2`, shopify_article_id: 563512639658 }],
  ['organic-toothpaste', { shopify_handle: 'best-organic-toothpaste-what-to-look-for-why-it-matters', shopify_article_id: 1 }],
  ['legacy-bare', { shopify_article_id: 2 }],
];
const metaOf = (slug) => (METAS.find(([s]) => s === slug) || [])[1] || null;

const HANDLE = { declaredWins: true };

describe('resolveSlugAmong', () => {
  test('as an ARTICLE HANDLE, a dir named for it is not the post when it declares another article', () => {
    assert.equal(resolveSlugAmong(A_HANDLE, METAS, HANDLE), 'what-is-organic-coconut-oil-uses-benefits-types');
  });

  test('as a SLUG (resolvePostSlug), the dir name still wins — callers pass post slugs', () => {
    // Dropping this globally changed 161 production lookups and flipped 38
    // winner-lock verdicts: `cocoa-butter-lotion/` IS that post even though its
    // meta declares a longer handle.
    assert.equal(resolveSlugAmong(A_HANDLE, METAS), A_HANDLE);
    assert.equal(resolveSlugAmong('organic-toothpaste', METAS), 'organic-toothpaste');
  });

  test('the -2 article still resolves to its own dir', () => {
    assert.equal(resolveSlugAmong(`${A_HANDLE}-2`, METAS, HANDLE), A_HANDLE);
  });

  test('a dir that declares nothing is still matched on its name', () => {
    assert.equal(resolveSlugAmong('legacy-bare', METAS, HANDLE), 'legacy-bare');
  });

  test('the shortened-slug case is unchanged', () => {
    assert.equal(resolveSlugAmong('best-organic-toothpaste-what-to-look-for-why-it-matters', METAS, HANDLE), 'organic-toothpaste');
  });

  test('declaresOtherArticle', () => {
    assert.equal(declaresOtherArticle(metaOf(A_HANDLE), A_HANDLE), true);
    assert.equal(declaresOtherArticle(metaOf('legacy-bare'), 'legacy-bare'), false);
    assert.equal(declaresOtherArticle(null, 'x'), false);
  });
});

describe('content-refresher targeting', () => {
  const byHandle = new Map([
    [A_HANDLE, { handle: A_HANDLE, id: 563424592042 }],
    [`${A_HANDLE}-2`, { handle: `${A_HANDLE}-2`, id: 563512639658 }],
  ]);

  test('--slug follows the post\'s DECLARED article, not its dir name', () => {
    assert.equal(articleForSlugArg('what-is-organic-coconut-oil-uses-benefits-types', byHandle, metaOf).id, 563424592042);
    // The dir named for A's handle is article -2; looking its name up as a
    // handle used to refresh article A instead.
    assert.equal(articleForSlugArg(A_HANDLE, byHandle, metaOf).id, 563512639658);
  });

  test('never writes one article\'s refresh into a dir holding another', () => {
    assert.equal(writeTargetSlug(A_HANDLE, () => null, metaOf), null);
    assert.equal(writeTargetSlug('a-brand-new-article', () => null, () => null), 'a-brand-new-article');
  });
});

test('as an article handle, a post DECLARING it beats a leftover dir merely named for it', () => {
  // Production, 2026-09-21: `best-organic-toothpaste-what-to-look-for-why-it-matters/`
  // exists, declares nothing and holds no article id; `organic-toothpaste/` is
  // the published post that declares the handle.
  const metas = [
    ['best-organic-toothpaste-what-to-look-for-why-it-matters', {}],
    ['organic-toothpaste', { shopify_handle: 'best-organic-toothpaste-what-to-look-for-why-it-matters', shopify_article_id: 563324649642 }],
  ];
  assert.equal(resolveSlugAmong('best-organic-toothpaste-what-to-look-for-why-it-matters', metas, HANDLE), 'organic-toothpaste');
  // resolvePostSlug's slug semantics are unchanged.
  assert.equal(resolveSlugAmong('best-organic-toothpaste-what-to-look-for-why-it-matters', metas), 'best-organic-toothpaste-what-to-look-for-why-it-matters');
});
