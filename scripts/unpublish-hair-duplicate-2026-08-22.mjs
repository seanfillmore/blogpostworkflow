// One-shot: unpublish (not delete) the fourth hair-cluster blog post missed
// by yesterday's cleanup (scripts/unpublish-hair-posts-2026-08-22.mjs).
// RSC sells no hair products (owner-confirmed). This is a third-generation
// republish of "is-coconut-oil-good-for-your-hair-benefits-how-to-use-it"
// (the fleet regenerated the same topic repeatedly in April 2026 and left
// orphans behind). Its unsuffixed sibling is already unpublished and 301s to
// coconut-oil-for-skin-ultimate-guide-to-benefits-and-potential-downsides —
// this post redirects to the same destination so the duplicates land in one
// place.
//
// Before-state, recorded 2026-08-22 immediately before this script mutated
// anything (also the durable record needed to reverse it — flip `published`
// back to true on the article id below and delete the corresponding
// redirect):
//
//   handle                                                       article id     blog id      published_at (before)
//   is-coconut-oil-good-for-your-hair-benefits-how-to-use-it-2   563512541354   48998449187  2026-06-08T09:41:12-06:00
//
// A repo-wide scan at the same time for other live hair-topic duplicates
// (siblings of the four now-removed posts, including any further -2/-3
// suffixed handles) found two additional suffixed handles
// (best-diy-natural-hair-masks-for-dry-hair-that-work,
// is-coconut-oil-good-for-your-hair-benefits-how-to-use-it-1) but both
// already had published_at: null and returned 404 live — no action needed.
// No other live hair-focused article was found. Verification transcripts:
// see the PR this script shipped in.
import { getArticle, updateArticle, getRedirects, createRedirect } from '../lib/shopify.js';

const BLOG_ID = 48998449187; // "news"

const POST = {
  id: 563512541354,
  handle: 'is-coconut-oil-good-for-your-hair-benefits-how-to-use-it-2',
  redirectTo: '/blogs/news/coconut-oil-for-skin-ultimate-guide-to-benefits-and-potential-downsides',
};

const dryRun = !process.argv.includes('--apply');
console.log(dryRun ? '--- DRY RUN (pass --apply to mutate) ---' : '--- APPLYING ---');

const article = await getArticle(BLOG_ID, POST.id);
const state = {
  id: article.id,
  handle: article.handle,
  title: article.title,
  published_at_before: article.published_at,
};
console.log(`\n[${POST.handle}]`);
console.log(`  before: published_at=${article.published_at}`);

if (article.handle !== POST.handle) {
  throw new Error(
    `Handle mismatch for article ${POST.id}: expected "${POST.handle}", got "${article.handle}". Stopping — refusing to mutate on a mismatch.`
  );
}

const sourcePath = `/blogs/news/${POST.handle}`;
const existingRedirects = await getRedirects({ path: sourcePath });
const redirectStatus = { path: sourcePath, target: POST.redirectTo };

if (!dryRun) {
  const updated = await updateArticle(BLOG_ID, POST.id, { published: false });
  state.published_at_after = updated.published_at;
  console.log(`  after:  published_at=${updated.published_at}`);

  if (existingRedirects.length > 0) {
    redirectStatus.status = 'already_exists';
    console.log(`  redirect: already exists (${existingRedirects.length}) — skipped`);
  } else {
    const redirect = await createRedirect(sourcePath, POST.redirectTo);
    redirectStatus.status = 'created';
    redirectStatus.id = redirect.id;
    console.log(`  redirect: created ${sourcePath} -> ${POST.redirectTo}`);
  }
} else {
  console.log(`  would unpublish and redirect ${sourcePath} -> ${POST.redirectTo}`);
  redirectStatus.status = existingRedirects.length > 0 ? 'already_exists' : 'would_create';
}

console.log('\n--- SUMMARY ---');
console.log(JSON.stringify({ ...state, redirect: redirectStatus }, null, 2));
