// One-shot: republish the one blog post confirmed as genuine publish drift
// out of a 34-article unpublished audit on blog 48998449187 ("news").
//
// best-boka-alternatives-2025 — local data/posts/best-boka-alternatives-2025/meta.json
// carries a real shopify_publish_at (2025-06-06T14:50:55-06:00) from the
// 2026-04-09 legacy sync, live Shopify currently reports published_at: null,
// no redirect points away from this handle, no cannibalization/kill report
// or meta.json needs_rebuild/kill marker explains the unpublish, and the
// page still carries traffic (2,881 impressions at position 12 as of the
// 2026-08-04 legacy triage; 14 impressions / 0 clicks in the current 90-day
// GSC window). Matches this project's documented "posts silently revert to
// draft" failure mode — fix is republish and verify 200.
//
// NOTE: the task brief that prompted this script named article id
// 562322047146 for this post. That id belongs to a DIFFERENT article
// ("SLS Free Toothpaste: The Gentle Switch Worth Making") — confirmed by
// fetching it live. The correct id, verified against meta.json, the live
// handle, and the live title ("Boka Toothpaste Alternative With Cleaner
// Ingredients"), is 562322571434. This script uses the verified id.
//
// Pre-checks completed before writing this script (see republish-report.md
// for full detail):
//   1. No other live article's title/handle mentions "boka" (218 articles
//      scanned, published_status=any) — no duplicate live coverage.
//   2. No redirect targets /blogs/news/best-boka-alternatives-2025 (229
//      redirects scanned; one unrelated redirect exists from the OLD
//      /collections/boka-toothpaste-alternative path to the toothpaste PDP).
//   3. meta.json carries no needs_rebuild flag, kill marker, or unpublish
//      reason. data/reports/technical-seo, meta-optimizer, and meta-ab
//      reports all reference this URL as a live, actively-optimized page —
//      none suggest a deliberate kill.
//   4. Article body_html (9,293 chars) ends on a complete, properly closed
//      paragraph; all 18 href attributes are opened and closed; no
//      href="...$ truncation pattern. Not truncated.
//
// Before-state, recorded 2026-08-22 immediately before this script mutated
// anything (also the durable record needed to reverse it — flip `published`
// back to false on this article id):
//
//   handle                         article id      blog id       published_at (before)
//   best-boka-alternatives-2025    562322571434    48998449187   null
//
import { getArticle, updateArticle } from '../lib/shopify.js';

const BLOG_ID = 48998449187; // "news"
const ARTICLE_ID = 562322571434;
const EXPECTED_HANDLE = 'best-boka-alternatives-2025';

const dryRun = !process.argv.includes('--apply');
console.log(dryRun ? '--- DRY RUN (pass --apply to mutate) ---' : '--- APPLYING ---');

const article = await getArticle(BLOG_ID, ARTICLE_ID);
const state = {
  id: article.id,
  handle: article.handle,
  title: article.title,
  published_at_before: article.published_at,
};
console.log(`\n[${article.handle}]`);
console.log(`  before: published_at=${article.published_at}`);

if (article.handle !== EXPECTED_HANDLE) {
  throw new Error(
    `Handle mismatch for article ${ARTICLE_ID}: expected "${EXPECTED_HANDLE}", got "${article.handle}". Stopping — refusing to mutate on a mismatch.`
  );
}

if (!dryRun) {
  const updated = await updateArticle(BLOG_ID, ARTICLE_ID, { published: true });
  state.published_at_after = updated.published_at;
  console.log(`  after:  published_at=${updated.published_at}`);
} else {
  console.log('  would set published: true');
}

console.log('\n--- SUMMARY ---');
console.log(JSON.stringify(state, null, 2));
