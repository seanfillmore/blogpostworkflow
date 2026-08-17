// lib/ad-studio-cost.js
//
// What an Ad Studio run will cost, before it is launched.
//
// THE NON-OBVIOUS PART, and the reason this is a module rather than a line of
// arithmetic in a route: A META TARGET BILLS TWO RENDERS. The plate is rendered and
// gated, and then a comp is derived from it as a layout reference for the operator —
// and that derived pass calls budget.take() like any other render. Demand Gen plates
// get no comp (`wantsComp: false` in packaging.js's target table), so they bill one.
//
// Three separate documents — this agent's README, the UI spec's reconciliation table
// and the UI spec's screen 1 — all said a default run was one render per target. It
// is not, and the whole point of the setup screen is a number the operator can trust
// while ticking boxes.
//
// Imports NOTHING on purpose. The launch route needs this to enforce a ceiling and
// the browser needs the same shape to display; keeping it dependency-free means
// neither pays for sharp (which packaging.js pulls in) to do arithmetic.

/** Gemini 3 Pro at 2K. Matches ESTIMATED_COST_PER_RENDER_USD in the agent. */
export const USD_PER_RENDER = 0.13;

/** Plate attempts before renderWithRetry gives up on a target. */
const MAX_ATTEMPTS_PER_PLATE = 3;

/** Split resolved targets by platform. Takes the output of packaging.js's selectTargets. */
export function countTargetKinds(targets = []) {
  let meta = 0, demandGen = 0;
  for (const t of targets) {
    if (t.platform === 'meta') meta += 1;
    else demandGen += 1;
  }
  return { meta, demandGen };
}

const usd = (renders) => Number((renders * USD_PER_RENDER).toFixed(2));

/**
 * expected  = F × V × (2m + d)          every plate passes first attempt, every Meta plate comps
 * worstCase = F × V × (3(m+d) + m)      every plate burns all three attempts
 *
 * The comp term stays at `m` in the worst case rather than tripling: a comp is only
 * derived from a plate that was ACCEPTED, so the run that pays for the most plate
 * attempts is not paying three comps for them.
 */
export function estimateRenders({ formats = [], variations = 1, targets = [] } = {}) {
  const { meta, demandGen } = countTargetKinds(targets);
  const concepts = formats.length * variations;
  const expected = concepts * (2 * meta + demandGen);
  const worstCase = concepts * (MAX_ATTEMPTS_PER_PLATE * (meta + demandGen) + meta);
  return { meta, demandGen, expected, worstCase, expectedUsd: usd(expected), worstCaseUsd: usd(worstCase) };
}
