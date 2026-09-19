// One-shot: retire the third-generation tattoo-soap duplicate into the flagship
// winner, BEFORE Google crawls it and splits ranking signal on the flagship.
//
// Winner (KEEP, untouched): best-soap-for-tattoos-what-to-use-for-safe-healing-2
//   article 563512344746, published 2026-06-16, target_keyword
//   "best soap to use on new tattoo". A LOCKED legacy winner
//   (state.json legacy_locked: true, legacy_bucket "winner") and the site's
//   single biggest CTR opportunity — position ~8, ~37,531 impressions/90d.
//   This script never writes to it. It only READS it, twice, as a guard.
//
// Loser (RETIRE): best-soap-for-tattoos-what-to-use-for-safe-healing-3
//   article 564499841194, created 2026-09-06, published 2026-09-09,
//   target_keyword "best soap for tattoos what to use for safe healing".
//   GSC has it as `discovered_not_crawled` with last_crawled: null — it has
//   NEVER been crawled, so there are no rankings, no traffic and no backlinks
//   to preserve. Nothing is lost by retiring it and the split is prevented
//   rather than repaired.
//
// This is the THIRD generation of the same article. The first
// (best-soap-for-tattoos-what-to-use-for-safe-healing, article 563424362666)
// was already consolidated into the same winner on 2026-08-22 by
// scripts/consolidate-tattoo-soap-2026-08-22.mjs; its local state.json carries
// shopify_status: "redirected" and is the model this script mirrors.
//
// UNPUBLISH, NEVER DELETE. This repo's doctrine is move/archive (see
// data/briefs/_dropped/ and data/posts/_orphaned/): a deleted Shopify article
// is unrecoverable, and an unpublished one costs nothing to keep.
//
// ROOT CAUSE, DELIBERATELY NOT FIXED HERE. agents/gsc-opportunity's
// loadCoveredKeywords/isMapped does a bidirectional substring test against a
// single target_keyword per post. The winner's "best soap to use on new tattoo"
// neither contains nor is contained by the duplicate's "best soap for tattoos
// what to use for safe healing", so the topic read as UNCOVERED and
// calendar-runner spent a full paid pipeline on it. CLAUDE.md defers widening
// that matching as "a separate change with its own blast radius" — it would make
// every coverage check in the fleet more aggressive and silently kill planned
// content. Left alone on purpose.
//
// Before-state, recorded 2026-09-19 immediately before this script mutated
// anything (also the durable record needed to reverse it):
//
//   role    handle                                                 article id     blog id      published_at (before)
//   winner  best-soap-for-tattoos-what-to-use-for-safe-healing-2   563512344746   48998449187  2026-06-16T07:45:04-06:00  (untouched)
//   loser   best-soap-for-tattoos-what-to-use-for-safe-healing-3   564499841194   48998449187  2026-09-09T09:13:02-06:00  (unpublish only, body_html untouched)
//
// Neither article's body_html is read or written by this script.
// No live article links to the loser's URL (checked across every local content
// mirror on the server, 2026-09-19: zero hits), so the redirect is a safety net
// for external/index references rather than a repair of internal ones.
//
// To reverse: set article 564499841194 published:true, delete the redirect
// /blogs/news/...-3 -> /blogs/news/...-2, and drop the four state fields this
// script stamps on data/posts/best-soap-for-tattoos-safe-healing-guide/.
//
// Usage: node scripts/retire-tattoo-duplicate-2026-09-19.mjs [--apply]
import { getArticle, updateArticle, getRedirects, createRedirect } from '../lib/shopify.js';
import { getPostMeta, writePostMeta } from '../lib/posts.js';

const BLOG_ID = 48998449187; // "news"

const WINNER = {
  id: 563512344746,
  handle: 'best-soap-for-tattoos-what-to-use-for-safe-healing-2',
};

const LOSER = {
  id: 564499841194,
  handle: 'best-soap-for-tattoos-what-to-use-for-safe-healing-3',
  slug: 'best-soap-for-tattoos-safe-healing-guide', // local post dir
};

const REDIRECT_FROM = `/blogs/news/${LOSER.handle}`;
const REDIRECT_TO = `/blogs/news/${WINNER.handle}`;

const dryRun = !process.argv.includes('--apply');
console.log(dryRun ? '--- DRY RUN (pass --apply to mutate) ---' : '--- APPLYING ---');

// Pace live calls. Cloudflare rate-limits this domain hard and a 429 makes good
// pages look broken (CLAUDE.md, "a trap for anyone auditing the live site").
const pace = () => new Promise((r) => setTimeout(r, 1100));

// ── Guard 1: the WINNER must be healthy before we touch anything ────────────
// A cannibalization-resolver --apply once reported success while silently
// unpublishing two top ranking pages. The winner's health is a precondition,
// not an afterthought: if it is already unpublished, something else is wrong
// and adding a redirect INTO it would point the loser at a dead page.
const winnerBefore = await getArticle(BLOG_ID, WINNER.id);
await pace();
console.log(`\n[winner ${WINNER.handle}]`);
console.log(`  id=${winnerBefore.id} handle=${winnerBefore.handle}`);
console.log(`  title=${JSON.stringify(winnerBefore.title)}`);
console.log(`  published_at=${winnerBefore.published_at}`);

if (winnerBefore.handle !== WINNER.handle) {
  throw new Error(
    `Winner handle mismatch on article ${WINNER.id}: expected "${WINNER.handle}", got "${winnerBefore.handle}". Refusing to mutate.`
  );
}
if (!winnerBefore.published_at) {
  throw new Error(
    `Winner article ${WINNER.id} is NOT published (published_at is null). Refusing to redirect the loser into a dead page — investigate the winner first.`
  );
}

// ── Guard 2: the LOSER is the article we think it is ───────────────────────
const loserBefore = await getArticle(BLOG_ID, LOSER.id);
await pace();
console.log(`\n[loser ${LOSER.handle}]`);
console.log(`  id=${loserBefore.id} handle=${loserBefore.handle}`);
console.log(`  title=${JSON.stringify(loserBefore.title)}`);
console.log(`  published_at=${loserBefore.published_at}`);

if (loserBefore.handle !== LOSER.handle) {
  throw new Error(
    `Loser handle mismatch on article ${LOSER.id}: expected "${LOSER.handle}", got "${loserBefore.handle}". Refusing to mutate.`
  );
}
if (loserBefore.id === WINNER.id) {
  throw new Error('Loser and winner resolved to the same article id. Refusing to mutate.');
}

// ── Guard 3: never create a redirect that shadows the winner ───────────────
const winnerRedirects = await getRedirects({ path: REDIRECT_TO });
await pace();
if (winnerRedirects.length > 0) {
  throw new Error(
    `A redirect already exists FROM the winner's own path ${REDIRECT_TO}: ${JSON.stringify(winnerRedirects)}. Refusing to mutate — the winner would be redirected away.`
  );
}

const existingRedirects = await getRedirects({ path: REDIRECT_FROM });
await pace();

// ── Local state (server-owned, gitignored state.json) ──────────────────────
const localBefore = getPostMeta(LOSER.slug);
const now = new Date().toISOString();

// Mirrors data/posts/best-soap-for-tattoos/state.json, the first generation of
// this same consolidation. Every field below is server-owned per FIELD_OWNERS
// in lib/post-meta-reconcile.js, so writePostMeta routes them all to
// state.json and meta.json (the authored half) is left untouched.
const stateChanges = {
  shopify_status: 'redirected',
  unpublished_at: now,
  unpublished_reason:
    'Duplicate-content consolidation (2026-09-19). Third-generation regeneration of the same topic as the flagship winner ' +
    'best-soap-for-tattoos-what-to-use-for-safe-healing-2 (article 563512344746, position ~8, ~37,531 impressions/90d, a locked legacy winner). ' +
    'Retired before Google crawled it: GSC had it as discovered_not_crawled with last_crawled null, so it had no rankings, no traffic and no backlinks to preserve. ' +
    'Unpublished (never deleted) and 301-redirected to the winner. Root cause is the known gsc-opportunity coverage-matching gap (bidirectional substring on a single target_keyword) and is deliberately NOT fixed here.',
  redirected_to: REDIRECT_TO,
  redirected_at: now,
  redirect_note:
    `Shopify article ${LOSER.id} unpublished (NOT deleted); live 301 ${REDIRECT_FROM} -> ${REDIRECT_TO}. Do not republish or reschedule.`,
};

console.log(`\n[local post dir data/posts/${LOSER.slug}/]`);
if (!localBefore) {
  console.log('  WARNING: no local metadata found for this slug in this checkout.');
  console.log('  The post directory lives only on the production server. Run this there to record the state.');
} else {
  console.log(`  before: shopify_status=${localBefore.shopify_status}`);
}

console.log('\n--- PLAN ---');
console.log(`  1. unpublish article ${LOSER.id} (${LOSER.handle})  [published_at ${loserBefore.published_at} -> null]`);
console.log(
  `  2. redirect ${REDIRECT_FROM} -> ${REDIRECT_TO}  [${existingRedirects.length > 0 ? 'ALREADY EXISTS — would skip' : 'would create'}]`
);
console.log(`  3. stamp local state on data/posts/${LOSER.slug}/state.json:`);
for (const [k, v] of Object.entries(stateChanges)) {
  console.log(`       ${k}: ${JSON.stringify(v).slice(0, 140)}${JSON.stringify(v).length > 140 ? '…' : ''}`);
}
console.log(`  (winner ${WINNER.id} is NOT touched — read twice as a guard only)`);

const result = {
  applied: !dryRun,
  winner: { id: WINNER.id, handle: WINNER.handle, published_at_before: winnerBefore.published_at, touched: false },
  loser: { id: LOSER.id, handle: LOSER.handle, published_at_before: loserBefore.published_at },
  redirect: { from: REDIRECT_FROM, to: REDIRECT_TO },
  local_state: { slug: LOSER.slug, present: Boolean(localBefore) },
};

if (dryRun) {
  result.redirect.status = existingRedirects.length > 0 ? 'already_exists' : 'would_create';
  result.loser.published_at_after = '(unchanged — dry run)';
  console.log('\n--- SUMMARY (dry run, nothing mutated) ---');
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

// ── 1. Unpublish the loser ─────────────────────────────────────────────────
const updated = await updateArticle(BLOG_ID, LOSER.id, { published: false });
await pace();
result.loser.published_at_after = updated.published_at;
console.log(`\n  unpublished: published_at=${updated.published_at}`);
if (updated.published_at) {
  throw new Error(
    `Unpublish did NOT take on article ${LOSER.id} — published_at is still ${updated.published_at}. Stopping before creating a redirect that would shadow a live page.`
  );
}

// ── 2. Create the redirect ─────────────────────────────────────────────────
if (existingRedirects.length > 0) {
  result.redirect.status = 'already_exists';
  result.redirect.id = existingRedirects[0]?.id;
  console.log(`  redirect: already exists (${existingRedirects.length}) — skipped`);
} else {
  const redirect = await createRedirect(REDIRECT_FROM, REDIRECT_TO);
  await pace();
  result.redirect.status = 'created';
  result.redirect.id = redirect.id;
  console.log(`  redirect: created ${REDIRECT_FROM} -> ${REDIRECT_TO} (id ${redirect.id})`);
}

// ── 3. Record the resolution locally ───────────────────────────────────────
if (localBefore) {
  writePostMeta(LOSER.slug, stateChanges);
  const after = getPostMeta(LOSER.slug);
  result.local_state.shopify_status_after = after.shopify_status;
  result.local_state.redirected_to_after = after.redirected_to;
  // The authored half must be untouched: writePostMeta routes by FIELD_OWNERS,
  // and every field above is server-owned, so meta.json should not have moved.
  result.local_state.target_keyword_preserved = after.target_keyword;
  result.local_state.shopify_article_id_preserved = after.shopify_article_id;
  console.log(`  local state: shopify_status=${after.shopify_status}, redirected_to=${after.redirected_to}`);
} else {
  result.local_state.skipped = 'no local post dir in this checkout';
  console.log('  local state: SKIPPED — no local post dir here (run on the production server)');
}

// ── Guard 4: re-read the winner and confirm we did not harm it ─────────────
const winnerAfter = await getArticle(BLOG_ID, WINNER.id);
result.winner.published_at_after = winnerAfter.published_at;
if (!winnerAfter.published_at) {
  throw new Error(
    `POST-CHECK FAILED: winner article ${WINNER.id} is no longer published (published_at is null). RESTORE IT IMMEDIATELY: updateArticle(${BLOG_ID}, ${WINNER.id}, { published: true }).`
  );
}
console.log(`\n  winner post-check: published_at=${winnerAfter.published_at} (still live)`);

console.log('\n--- SUMMARY ---');
console.log(JSON.stringify(result, null, 2));
