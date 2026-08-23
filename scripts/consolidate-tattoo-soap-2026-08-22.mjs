// One-shot: apply the 2026-08-16 cannibalization-resolver recommendation for
// query "best soap to use on new tattoo" that sat in the unactioned
// draft_needs_review queue for six days (data/reports/cannibalization/
// cannibalization-report.md on the server, "Actions Taken" table + "Drafts
// needing review" section).
//
// Winner: best-soap-for-tattoos-what-to-use-for-safe-healing-2
// Loser:  best-soap-for-tattoos-what-to-use-for-safe-healing   (unsuffixed handle)
//
// What actually happened on 2026-08-16: agents/cannibalization-resolver's
// applyResolutions() DID run the merge (Claude combined both articles' live
// body_html) and wrote the result to
// data/posts/best-soap-for-tattoos-what-to-use-for-safe-healing-2/content.html.
// It then ran the editor, which flagged 5 uncited factual/health claims
// (lipid barrier research, AAD fragrance claim, lauric acid documentation,
// SLS studies, FDA context — see that post's editor-report.md section 9,
// meta.needs_rebuild.reasons: ["overall quality: needs work"]). Per the
// resolver's own code, a blocked merge is HELD: the live winner article is
// never overwritten with unreviewed content (a proven ranking page is not
// force-published past the editor gate), and its own comment explains it
// also skips the redirect in that branch specifically so a redirected loser
// never points at a winner that doesn't yet contain the loser's unique
// content.
//
// This script intentionally diverges from that last part. CLAUDE.md's
// architecture section states plainly that "Redirects always created" for
// CONSOLIDATE, with no carve-out for a held merge, and nothing is actually
// destroyed by redirecting here: the loser is unpublished (never deleted),
// and the content the resolver would have merged into the winner already
// exists in the winner's local draft file for whoever finishes that review.
// Leaving the loser live for a recommendation that's sat idle for six days
// is worse than the alternative of a stale-but-already-good winner page.
// See consolidate-report.md for the full trade-off.
//
// This script does NOT touch the winner's live Shopify content or its
// meta.json needs_rebuild flag — that merge is still legitimately blocked
// and this script does not force a publish past the editor.
//
// It also fixes the one other live post found to link to the
// about-to-redirect loser URL: unscented-antibacterial-soap-what-to-look-for-why
// links to it twice (both in <a href> only; the visible title text does not
// carry the URL). Its live body_html has drifted from the local
// data/posts/unscented-antibacterial-soap/content.html snapshot (a much
// older, unrelated draft that never mentions tattoos at all — pre-existing
// drift, out of scope here), so the fix is applied directly to the live
// article via the API rather than reconstructed locally.
//
// Before-state, recorded 2026-08-22 immediately before this script mutated
// anything (also the durable record needed to reverse it):
//
//   role    handle                                                 article id     blog id      published_at (before)              body_html touched?
//   loser   best-soap-for-tattoos-what-to-use-for-safe-healing     563424362666   48998449187  2026-04-25T09:00:06-06:00          no (unpublish only)
//   winner  best-soap-for-tattoos-what-to-use-for-safe-healing-2   563512344746   48998449187  2026-06-16T07:45:04-06:00          no (untouched by this script)
//   linker  unscented-antibacterial-soap-what-to-look-for-why      563424493738   48998449187  2026-05-01T09:15:38-06:00          yes (2 hrefs repointed loser -> winner)
//
// To reverse: set article 563424362666 published:true, delete the redirect
// created below (/blogs/news/best-soap-for-tattoos-what-to-use-for-safe-healing
// -> /blogs/news/best-soap-for-tattoos-what-to-use-for-safe-healing-2), and in
// article 563424493738's body_html replace the 2 occurrences of
// ".../best-soap-for-tattoos-what-to-use-for-safe-healing-2" back to
// ".../best-soap-for-tattoos-what-to-use-for-safe-healing".
import { getArticle, updateArticle, getRedirects, createRedirect } from '../lib/shopify.js';

const BLOG_ID = 48998449187; // "news"

const LOSER_ID = 563424362666;
const LOSER_HANDLE = 'best-soap-for-tattoos-what-to-use-for-safe-healing';

const WINNER_HANDLE = 'best-soap-for-tattoos-what-to-use-for-safe-healing-2';

const LINKER_ID = 563424493738;
const LINKER_HANDLE = 'unscented-antibacterial-soap-what-to-look-for-why';

const dryRun = !process.argv.includes('--apply');
console.log(dryRun ? '--- DRY RUN (pass --apply to mutate) ---' : '--- APPLYING ---');

// 1. Unpublish the loser. Never delete.
const loser = await getArticle(BLOG_ID, LOSER_ID);
if (loser.handle !== LOSER_HANDLE) {
  throw new Error(`Handle mismatch for loser article ${LOSER_ID}: expected "${LOSER_HANDLE}", got "${loser.handle}". Stopping — refusing to mutate on a mismatch.`);
}
console.log(`\n[loser] ${loser.handle}`);
console.log(`  before: published_at=${loser.published_at}`);
if (!dryRun) {
  const updated = await updateArticle(BLOG_ID, LOSER_ID, { published: false });
  console.log(`  after:  published_at=${updated.published_at}`);
} else {
  console.log('  would unpublish (published: false)');
}

// 2. Redirect loser -> winner. Preserves link equity even though the merge
// into the winner is still held for editorial review.
const sourcePath = `/blogs/news/${LOSER_HANDLE}`;
const targetPath = `/blogs/news/${WINNER_HANDLE}`;
const existingRedirects = await getRedirects({ path: sourcePath });
if (existingRedirects.length > 0) {
  console.log(`\n[redirect] already exists: ${sourcePath} -> ${existingRedirects[0].target}`);
} else if (!dryRun) {
  const redirect = await createRedirect(sourcePath, targetPath);
  console.log(`\n[redirect] created ${sourcePath} -> ${targetPath} (id ${redirect.id})`);
} else {
  console.log(`\n[redirect] would create ${sourcePath} -> ${targetPath}`);
}

// 3. Fix the one live post that links to the loser's (about-to-redirect) URL.
// Matched on the full quoted href value so this is safely re-runnable — the
// winner's href is a strict superset string (same URL + "-2"), so a bare
// substring match would also fire on an already-fixed link.
const linker = await getArticle(BLOG_ID, LINKER_ID);
if (linker.handle !== LINKER_HANDLE) {
  throw new Error(`Handle mismatch for linker article ${LINKER_ID}: expected "${LINKER_HANDLE}", got "${linker.handle}". Stopping.`);
}
const badHref = `href="https://www.realskincare.com/blogs/news/${LOSER_HANDLE}"`;
const goodHref = `href="https://www.realskincare.com/blogs/news/${WINNER_HANDLE}"`;
const occurrences = linker.body_html.split(badHref).length - 1;
console.log(`\n[linker] ${linker.handle} — ${occurrences} link(s) to the loser URL`);
if (occurrences > 0) {
  const fixedHtml = linker.body_html.split(badHref).join(goodHref);
  if (!dryRun) {
    await updateArticle(BLOG_ID, LINKER_ID, { body_html: fixedHtml });
    console.log('  fixed and published');
  } else {
    console.log('  would repoint to the winner URL');
  }
} else {
  console.log('  nothing to fix (already repointed or no match)');
}

console.log('\n--- DONE ---');
