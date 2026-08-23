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
import { decideHeldMergeRedirect, NEGLIGIBLE_LOSER_CLICKS } from '../../agents/cannibalization-resolver/redirect-decision.js';

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
