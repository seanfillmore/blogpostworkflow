// One-shot: unpublish (not delete) the three live hair-cluster blog posts.
// RSC sells no hair products (owner-confirmed) — these were still cited to AI
// assistants as canonical sources for a product line that doesn't exist.
// Records before-state, sets published:false, and creates a redirect for
// each URL to the closest genuinely relevant live page. See
// unpublish-report.md for full reasoning.
import { getArticle, updateArticle, getRedirects, createRedirect } from '../lib/shopify.js';

const BLOG_ID = 48998449187; // "news"

const POSTS = [
  {
    id: 563424624810,
    handle: 'best-hair-mask-for-dry-hair-diy-natural-options',
    redirectTo: '/blogs/news/coconut-oil-body-lotion-that-actually-works-for-dry-skin-2025-roundup',
  },
  {
    id: 563424559274,
    handle: 'is-coconut-oil-good-for-your-hair-benefits-how-to-use-it',
    redirectTo: '/blogs/news/coconut-oil-for-skin-ultimate-guide-to-benefits-and-potential-downsides',
  },
  {
    id: 563512311978,
    handle: 'best-diy-natural-hair-masks-for-dry-hair-that-work-1',
    redirectTo: '/blogs/news/coconut-oil-body-lotion-that-actually-works-for-dry-skin-2025-roundup',
  },
];

const dryRun = !process.argv.includes('--apply');
console.log(dryRun ? '--- DRY RUN (pass --apply to mutate) ---' : '--- APPLYING ---');

const before = [];
const results = [];

for (const post of POSTS) {
  const article = await getArticle(BLOG_ID, post.id);
  const state = {
    id: article.id,
    handle: article.handle,
    title: article.title,
    published_at_before: article.published_at,
  };
  before.push(state);
  console.log(`\n[${post.handle}]`);
  console.log(`  before: published_at=${article.published_at}`);

  if (article.handle !== post.handle) {
    throw new Error(
      `Handle mismatch for article ${post.id}: expected "${post.handle}", got "${article.handle}". Stopping — refusing to mutate on a mismatch.`
    );
  }

  const sourcePath = `/blogs/news/${post.handle}`;
  const existingRedirects = await getRedirects({ path: sourcePath });
  const redirectStatus = { path: sourcePath, target: post.redirectTo };

  if (!dryRun) {
    const updated = await updateArticle(BLOG_ID, post.id, { published: false });
    state.published_at_after = updated.published_at;
    console.log(`  after:  published_at=${updated.published_at}`);

    if (existingRedirects.length > 0) {
      redirectStatus.status = 'already_exists';
      console.log(`  redirect: already exists (${existingRedirects.length}) — skipped`);
    } else {
      const redirect = await createRedirect(sourcePath, post.redirectTo);
      redirectStatus.status = 'created';
      redirectStatus.id = redirect.id;
      console.log(`  redirect: created ${sourcePath} -> ${post.redirectTo}`);
    }
  } else {
    console.log(`  would unpublish and redirect ${sourcePath} -> ${post.redirectTo}`);
    redirectStatus.status = existingRedirects.length > 0 ? 'already_exists' : 'would_create';
  }

  results.push({ ...state, redirect: redirectStatus });
}

console.log('\n--- SUMMARY ---');
console.log(JSON.stringify(results, null, 2));
