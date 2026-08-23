// One-shot: delete 15 abandoned duplicate blog drafts from blog 48998449187
// ("news"). Re-derived independently from live Shopify + redirects + GSC
// history (prior audit's report was lost). Full article objects for every
// id below were archived to data/archive/orphan-drafts-2026-08-22/ BEFORE
// this script was written or run — see that directory's README for the
// four-criteria evidence (no redirect, zero GSC traffic across the full
// 2026-03-02 -> present snapshot history, a published sibling covering the
// same topic, no scheduled/rebuild/kill marker anywhere in the repo) and
// the accounting for why this is 15, not the prior estimate of 17.
//
// Re-verified live immediately before this script was written (2026-08-22):
// every id below still had published_at: null and the expected handle.
// This script re-verifies the same two facts again, per-id, immediately
// before calling deleteArticle, and refuses to delete on any mismatch
// rather than silently proceeding.
//
// Explicitly NOT touched (do not add these, do not re-run this script
// against a different id list without re-deriving the classification):
//   - 7 pending-cannibalization drafts redirected to a live sibling
//   - 2 deliberate drafts redirected to a converting page (collection/product)
//   - 4 scheduled drafts awaiting a future publish date
//   - 4 hair-cluster posts deliberately unpublished+redirected in the two
//     days before this cleanup (scripts/unpublish-hair-posts-2026-08-22.mjs,
//     scripts/unpublish-hair-duplicate-2026-08-22.mjs)
//   - 2 hair-cluster leftovers (563474006186, 563473809578) that fit the
//     April-duplicate pattern but have no live published sibling any more,
//     because the hair cluster's own anchor page was itself taken down —
//     see data/archive/orphan-drafts-2026-08-22/README.md
//   - 562322047146 (best-sls-free-toothpaste-2025) — has an exact redirect
//     to /blogs/news/best-toothpaste-without-sls-2025, fails criterion 1
import { getArticle, deleteArticle } from '../lib/shopify.js';

const BLOG_ID = 48998449187; // "news"

const ORPHANS = [
  { id: 563474104490, handle: 'unscented-deodorant-what-it-is-why-it-works-1' },
  { id: 563474071722, handle: 'organic-coconut-oil-types-uses-benefits-for-skin-1' },
  { id: 563474038954, handle: 'natural-soap-bar-the-clean-skin-guide-you-need-1' },
  { id: 563473973418, handle: 'how-to-dry-brush-your-body-step-by-step-guide-1' },
  { id: 563473907882, handle: 'dry-brushing-skin-benefits-technique-what-to-expect-1' },
  { id: 563473875114, handle: 'charcoal-toothpaste-does-it-work-is-it-safe-1' },
  { id: 563473776810, handle: 'antibacterial-body-soap-what-to-look-for-why-it-matters-1' },
  { id: 563473744042, handle: 'aluminum-free-antiperspirant-what-it-is-does-it-work-1' },
  { id: 563473711274, handle: 'natural-lip-balm-recipe-easy-diy-in-15-minutes' },
  { id: 563473678506, handle: 'coconut-oil-deodorant-benefits-diy-recipes-what-to-know' },
  { id: 563473612970, handle: 'is-coconut-oil-good-for-stretch-marks-heres-the-truth' },
  { id: 563472072874, handle: 'clean-body-lotion-what-to-look-for-best-picks' },
  { id: 563471941802, handle: 'does-coconut-oil-help-with-stretch-marks-the-truth' },
  { id: 563471909034, handle: 'best-non-toxic-body-lotion-clean-ingredients-guide' },
  { id: 563469910186, handle: 'coconut-oil-for-stretch-marks-does-it-really-work' },
];

const dryRun = !process.argv.includes('--apply');
console.log(dryRun ? '--- DRY RUN (pass --apply to mutate) ---' : '--- APPLYING ---');
console.log(`${ORPHANS.length} candidates queued for deletion.\n`);

const results = [];

for (const o of ORPHANS) {
  const article = await getArticle(BLOG_ID, o.id);

  if (article.handle !== o.handle) {
    throw new Error(
      `Handle mismatch for article ${o.id}: expected "${o.handle}", got "${article.handle}". Stopping — refusing to delete on a mismatch.`
    );
  }
  if (article.published_at) {
    throw new Error(
      `Article ${o.id} (${o.handle}) is now published (published_at=${article.published_at}). Stopping — refusing to delete a live article.`
    );
  }

  console.log(`[${o.handle}] id=${o.id} — verified unpublished, handle matches.`);

  if (!dryRun) {
    await deleteArticle(BLOG_ID, o.id);
    console.log(`  deleted.`);
    results.push({ id: o.id, handle: o.handle, deleted: true });
  } else {
    console.log(`  would delete.`);
    results.push({ id: o.id, handle: o.handle, deleted: false });
  }
}

console.log('\n--- SUMMARY ---');
console.log(JSON.stringify(results, null, 2));
console.log(`\n${dryRun ? 'Would have deleted' : 'Deleted'} ${results.length} articles.`);
