// tests/agents/cannibalization-held-merge-redirect.test.js
//
// Covers agents/cannibalization-resolver/redirect-decision.js's
// decideHeldMergeRedirect — the fix for the "unresolved forever" failure
// mode where a CONSOLIDATE merge held on editor blockers would never get
// its loser redirected, no matter how long it stayed held. See the module
// header for the tattoo-soap case that motivated the narrowing.
//
// Imported directly (not via agents/cannibalization-resolver/index.js,
// which runs the agent on import — live GSC/Shopify/Claude calls, see
// reference_agents_run_on_import.md) — same reasoning as
// agents/gsc-query-miner/leaks-feed.js and
// agents/seo-opportunity-analyzer/queue-item.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decideHeldMergeRedirect, findLoserClicks, shapeCannibalizationPage,
  NEGLIGIBLE_LOSER_CLICKS,
} from '../../agents/cannibalization-resolver/redirect-decision.js';

// Builds a cannibalization group the same way
// agents/cannibalization-resolver/index.js's detectCannibalization does:
// `pages: rows.map(shapeCannibalizationPage)`. These fixtures are never a
// hand-typed guess at the real output shape — they're produced by the exact
// function detectCannibalization calls, verified by reading that function
// (agents/cannibalization-resolver/index.js's detectCannibalization, ~line
// 152: `pages: sorted.map(shapeCannibalizationPage)`). If
// shapeCannibalizationPage's field names ever change, these fixtures and
// findLoserClicks (which reads the same fields) change together — a
// producer/consumer field mismatch can't pass here the way one shipped
// before (a report's rows destructured `query` when the real field was
// `keyword`; every hand-written test fixture had guessed `query` too, so
// the whole suite stayed green while production silently got nothing).
function buildGroup(query, rows) {
  return { query, pages: rows.map(shapeCannibalizationPage) };
}

test('held merge, zero-click loser: creates the redirect', () => {
  // The actual tattoo-soap case: loser had 0 clicks / 50 impressions / pos 23.
  const result = decideHeldMergeRedirect({ consolidateHeld: true, loserClicks: 0 });
  assert.equal(result.createRedirect, true);
  assert.equal(result.reason, 'held_negligible_loser_traffic');
  // Mutation this catches: flipping the `<=` to `<` (or dropping the branch
  // entirely) would make a literal zero-click loser fall through to "skip",
  // reproducing the exact bug this fix exists to close — the tattoo-soap
  // case would stay unredirected forever.
});

test('held merge, meaningfully-trafficked loser: still skips the redirect', () => {
  const result = decideHeldMergeRedirect({ consolidateHeld: true, loserClicks: 10 });
  assert.equal(result.createRedirect, false);
  assert.equal(result.reason, 'held_loser_has_traffic');
  // Mutation this catches: deleting the traffic check (i.e. always
  // redirecting once consolidateHeld is narrowed) would redirect away a
  // page that's actually earning clicks — the exact loss the original
  // carve-out existed to prevent, and the task explicitly calls this out
  // as the case a correct rule must still refuse.
});

test('unheld merge: unaffected regardless of loser traffic', () => {
  const redirectAction = decideHeldMergeRedirect({ consolidateHeld: false, loserClicks: 0 });
  const consolidateAction = decideHeldMergeRedirect({ consolidateHeld: false, loserClicks: 500 });
  assert.equal(redirectAction.createRedirect, true);
  assert.equal(redirectAction.reason, 'not_held');
  assert.equal(consolidateAction.createRedirect, true);
  assert.equal(consolidateAction.reason, 'not_held');
  // Mutation this catches: if the new traffic-gating logic ran unconditionally
  // instead of being scoped to `consolidateHeld`, a REDIRECT-action or a clean
  // (non-held) CONSOLIDATE with a well-trafficked loser would start skipping
  // its redirect — a regression in behavior this task explicitly says must
  // not change ("not the merge, not the editor gate... only the redirect
  // condition").
});

test('missing traffic data: fails safe and skips the redirect', () => {
  const missingUndefined = decideHeldMergeRedirect({ consolidateHeld: true, loserClicks: undefined });
  const missingNull = decideHeldMergeRedirect({ consolidateHeld: true, loserClicks: null });
  assert.equal(missingUndefined.createRedirect, false);
  assert.equal(missingUndefined.reason, 'held_no_traffic_data');
  assert.equal(missingNull.createRedirect, false);
  assert.equal(missingNull.reason, 'held_no_traffic_data');
  // Mutation this catches: treating missing/null clicks as 0 (e.g. via
  // `loserClicks || 0` instead of an explicit null/undefined check) would
  // silently redirect a loser whose traffic was never actually confirmed as
  // negligible — acting without evidence, which is exactly what the original
  // carve-out exists to prevent.
});

test('NEGLIGIBLE_LOSER_CLICKS threshold is exported and used at the boundary', () => {
  assert.equal(NEGLIGIBLE_LOSER_CLICKS, 0);
  const atThreshold = decideHeldMergeRedirect({ consolidateHeld: true, loserClicks: NEGLIGIBLE_LOSER_CLICKS });
  const oneOver = decideHeldMergeRedirect({ consolidateHeld: true, loserClicks: NEGLIGIBLE_LOSER_CLICKS + 1 });
  assert.equal(atThreshold.createRedirect, true);
  assert.equal(oneOver.createRedirect, false);
  // Mutation this catches: an off-by-one in the comparison operator would
  // move the boundary in either direction without any of the other tests
  // (which use 0 and 10) necessarily catching it.
});

// ── findLoserClicks: the glue between "the run's GSC groups" and a number ──

test('findLoserClicks: matching group + matching path returns that page real click count', () => {
  const groups = [
    buildGroup('best soap for tattoos', [
      {
        page: 'https://realskincare.com/blogs/news/best-soap-for-tattoos-what-to-use-for-safe-healing-2',
        impressions: 1102, clicks: 10, position: 6.9, ctr: 0.9,
      },
      {
        page: 'https://realskincare.com/blogs/news/best-soap-for-tattoos-what-to-use-for-safe-healing',
        impressions: 50, clicks: 7, position: 23.0, ctr: 0,
      },
    ]),
  ];
  const clicks = findLoserClicks({
    groups,
    query: 'best soap for tattoos',
    loserPath: '/blogs/news/best-soap-for-tattoos-what-to-use-for-safe-healing',
  });
  assert.equal(clicks, 7);
  // Mutation this catches: renaming shapeCannibalizationPage's `path` field
  // (e.g. to `url`, colliding with or replacing the full-URL field it
  // already returns) breaks this immediately — findLoserClicks's
  // `p.path === loserPath` and this fixture's pages come from the SAME
  // function, so there is no second hand-written copy of the shape left to
  // quietly keep matching. This is the concrete answer to "would renaming
  // p.path to p.url on the producing side fail a test": yes, this one.
});

test('findLoserClicks: path not present in the matched group returns null, not 0', () => {
  const groups = [
    buildGroup('best soap for tattoos', [
      { page: 'https://realskincare.com/blogs/news/some-other-post', impressions: 200, clicks: 4, position: 8, ctr: 2 },
    ]),
  ];
  const clicks = findLoserClicks({
    groups,
    query: 'best soap for tattoos',
    loserPath: '/blogs/news/best-soap-for-tattoos-what-to-use-for-safe-healing',
  });
  assert.equal(clicks, null);
  // Mutation this catches: `.find(...)` returning `undefined` and the
  // function coercing that to `0` (e.g. `page?.clicks ?? 0` instead of an
  // explicit page-not-found check) would make decideHeldMergeRedirect treat
  // an unmatched path as "provably zero clicks" and redirect on no evidence
  // — exactly the failure this glue exists to prevent.
});

test('findLoserClicks: no group for the query returns null', () => {
  const groups = [buildGroup('unrelated query', [
    { page: 'https://realskincare.com/blogs/news/x', impressions: 10, clicks: 1, position: 5, ctr: 10 },
  ])];
  const clicks = findLoserClicks({ groups, query: 'best soap for tattoos', loserPath: '/blogs/news/x' });
  assert.equal(clicks, null);
  // Mutation this catches: matching the first/only group regardless of its
  // query (e.g. `groups[0]` instead of `.find(g => g.query === query)`)
  // would silently attribute one query's traffic to a completely different
  // decision whenever decisions and groups are processed out of lockstep.
});

test('findLoserClicks: page present with a non-numeric clicks value returns null', () => {
  const groups = [
    buildGroup('best soap for tattoos', [
      {
        page: 'https://realskincare.com/blogs/news/best-soap-for-tattoos-what-to-use-for-safe-healing',
        impressions: 50, clicks: undefined, position: 23.0, ctr: 0,
      },
    ]),
  ];
  const clicks = findLoserClicks({
    groups,
    query: 'best soap for tattoos',
    loserPath: '/blogs/news/best-soap-for-tattoos-what-to-use-for-safe-healing',
  });
  assert.equal(clicks, null);
  // Mutation this catches: dropping the `typeof page.clicks !== 'number'`
  // guard would make findLoserClicks return `undefined` here instead of
  // `null` — a different "no data" value than the rest of this module's
  // contract promises callers, and one decideHeldMergeRedirect's own
  // null/undefined check happens to also catch today. That overlap is
  // accidental, not a reason to let this guard rot: a future caller that
  // checks `=== null` specifically (as the JSDoc promises) would silently
  // treat an unresolved `undefined` as truthy/present.
});
