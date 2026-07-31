/**
 * Collection consolidation — unpublish + 301 every non-survivor.
 *
 * Dry-run by default. Pass --apply to mutate the live store.
 *
 * Usage:
 *   node scripts/consolidate-collections.mjs            # dry run, prints the plan
 *   node scripts/consolidate-collections.mjs --apply    # writes
 *   node scripts/consolidate-collections.mjs --json     # machine-readable plan
 */

import {
  getCustomCollections, getSmartCollections, getCollectionProductCount,
  updateCustomCollection, updateSmartCollection, createRedirect, deleteRedirect, getRedirects,
} from '../lib/shopify.js';
import { buildRedirectPlan } from '../lib/collection-consolidation.js';
import { appendAction, assertPreStateCaptured } from '../lib/consolidation-log.js';

const SITE = 'https://www.realskincare.com';

/**
 * Split the plan into redirects whose target is actually live and those whose
 * is not. Never redirect to an unpublished or missing target — a 301 into a 404
 * destroys the equity the redirect exists to preserve.
 *
 * Health is cached per distinct target: 84 sources share 7 targets, so an
 * uncached check would issue 84 requests for 7 answers.
 */
export async function partitionByTargetHealth(plan, isLive) {
  const cache = new Map();
  const ready = [];
  const blocked = [];
  for (const row of plan) {
    if (!cache.has(row.target)) cache.set(row.target, await isLive(row.target));
    (cache.get(row.target) ? ready : blocked).push(row);
  }
  return { ready, blocked };
}

async function targetIsLive(path) {
  try {
    const res = await fetch(`${SITE}${path}`, { method: 'HEAD', redirect: 'manual' });
    return res.status === 200;
  } catch {
    return false;
  }
}

/**
 * --apply and --json cannot be combined: the --json branch returns before the
 * apply guard runs, so `--apply --json` would print valid JSON, exit 0, and
 * write nothing — a silent no-op that looks like a successful applied run to
 * an automated caller. Reject the combination outright instead.
 */
export function validateFlags({ apply, asJson }) {
  if (apply && asJson) {
    throw new Error(
      '--apply and --json cannot be combined: --json exits before applying, ' +
      'which would silently no-op the write. Run them separately.'
    );
  }
}

/**
 * Page through every redirect via since_id. A single `{ limit: 250 }` call
 * truncates once the store has more than 250 redirects — the live store has
 * 163 already and this run adds 83 (246, then more on later runs), so the
 * idempotency check would silently miss real redirects and `createRedirect`
 * would throw mid-run on a duplicate path.
 */
export async function loadAllRedirects(fetchRedirects) {
  const all = [];
  let sinceId;
  for (;;) {
    const params = sinceId ? { limit: 250, since_id: sinceId } : { limit: 250 };
    const page = await fetchRedirects(params);
    all.push(...page);
    if (page.length < 250) break;
    sinceId = page[page.length - 1].id;
  }
  return all;
}

/**
 * Compare the plan against existing redirects by (path, target), not path
 * alone. A source whose redirect already points at the plan's target is done
 * — `alreadyCorrect`. A source with a redirect pointing somewhere stale needs
 * deleting and recreating — `toRewrite`, carrying the existing redirect's id
 * and stale target so the apply loop and the report can show the diff. A
 * source with no redirect at all is `toCreate`.
 *
 * This replaces a path-only idempotency check that treated "a redirect
 * exists" as "the redirect is correct" — live audit found 22 of 23
 * previously-skipped sources had a stale target that check would never fix.
 */
export function diffRedirectsAgainstPlan(readyPlan, existingRedirects) {
  const byPath = new Map(existingRedirects.map((r) => [r.path, r]));
  const toCreate = [];
  const toRewrite = [];
  const alreadyCorrect = [];
  for (const row of readyPlan) {
    const path = `/collections/${row.handle}`;
    const existing = byPath.get(path);
    if (!existing) {
      toCreate.push({ ...row, path });
    } else if (existing.target === row.target) {
      alreadyCorrect.push({ ...row, path });
    } else {
      toRewrite.push({ ...row, path, existingRedirectId: existing.id, staleTarget: existing.target });
    }
  }
  return { toCreate, toRewrite, alreadyCorrect };
}

/**
 * Existing store redirects (independent of this run's sources — e.g. a prior
 * consolidation's `/collections/toothpaste -> /collections/natural-toothpaste`)
 * whose target is itself one of this plan's sources become a 301->301->200
 * chain the moment this run's own redirect lands. Repoint them straight at
 * the plan's final (terminal) target instead. Plan targets are always
 * survivors or PDPs, never another plan source, so a single pass fully
 * collapses any chain regardless of how many hops it had before.
 *
 * Scoped to `readyPlan` (not the full plan) so a chain is never repointed at
 * a target that failed the health check.
 *
 * Excludes any record whose own `path` is itself a plan source. Live audit
 * found 22 of 22 `toRewrite` rows (see `diffRedirectsAgainstPlan`) also
 * satisfied this function's predicate — e.g.
 * `/collections/no-sls-toothpaste -> /collections/sls-free-toothpaste`, where
 * both `no-sls-toothpaste` and `sls-free-toothpaste` are plan sources.
 * `diffRedirectsAgainstPlan` already sets that record's target authoritatively
 * to `classifyTarget(no-sls-toothpaste)` via `toRewrite` — reprocessing the
 * same redirect id here would mean two loops both delete-then-recreate the
 * same record under --apply, and the second one always 404s on the delete
 * (the first already removed it) or 422s on the create (the first already
 * recreated the path). Skipping it here is safe: `toRewrite` is authoritative
 * for this record because it classifies the row by the row's own handle,
 * not by whatever a possibly-stale existing redirect happens to point at —
 * so `diffRedirectsAgainstPlan`'s target and this function's would-be
 * `newTarget` are not guaranteed to agree (a chain between two plan sources
 * can compute different targets in each loop), and `toRewrite` correctly
 * wins.
 */
export function findChainedRedirects(readyPlan, existingRedirects) {
  const finalTargetByPath = new Map(readyPlan.map((row) => [`/collections/${row.handle}`, row.target]));
  const out = [];
  for (const r of existingRedirects) {
    if (finalTargetByPath.has(r.path)) continue;
    const finalTarget = finalTargetByPath.get(r.target);
    if (finalTarget && finalTarget !== r.target) {
      out.push({ id: r.id, path: r.path, staleTarget: r.target, newTarget: finalTarget });
    }
  }
  return out;
}

async function loadCollections() {
  const [custom, smart] = await Promise.all([
    getCustomCollections({ limit: 250 }),
    getSmartCollections({ limit: 250 }),
  ]);
  const rows = [];
  let productCountFailures = 0;
  for (const c of [...custom.map((x) => ({ ...x, kind: 'custom' })),
                   ...smart.map((x) => ({ ...x, kind: 'smart' }))]) {
    let products = 0;
    try {
      products = await getCollectionProductCount(c.id);
    } catch {
      products = -1;
      productCountFailures++;
    }
    rows.push({ handle: c.handle, id: c.id, kind: c.kind, live: Boolean(c.published_at), products });
  }
  return { rows, productCountFailures };
}

async function main() {
  const apply = process.argv.includes('--apply');
  const asJson = process.argv.includes('--json');
  validateFlags({ apply, asJson });

  const { rows: collections, productCountFailures } = await loadCollections();
  const plan = buildRedirectPlan(collections);
  const { ready, blocked } = await partitionByTargetHealth(plan, targetIsLive);

  const existingRedirects = await loadAllRedirects(getRedirects);
  const { toCreate, toRewrite, alreadyCorrect } = diffRedirectsAgainstPlan(ready, existingRedirects);
  const chained = findChainedRedirects(ready, existingRedirects);
  const toWrite = [...toCreate, ...toRewrite];

  // Unpublishing is derived independently of what needs writing — a source
  // whose redirect is already correct still needs its (still-live) collection
  // unpublished. Coupling this to toWrite meant a live collection with an
  // already-correct redirect never got unpublished and stayed served, since
  // Shopify redirects only fire on 404.
  const toUnpublish = ready.filter((r) => r.live);

  if (asJson) {
    console.log(JSON.stringify({
      plan, ready, blocked, toCreate, toRewrite, alreadyCorrect, chained, toWrite, toUnpublish,
      productCountFailures,
    }, null, 1));
    return;
  }

  console.log(`\nCollection consolidation — ${apply ? 'APPLY' : 'DRY RUN'}`);
  console.log(`  collections: ${collections.length} (live ${collections.filter((c) => c.live).length})`);
  console.log(`  to redirect: ${plan.length}  ready: ${ready.length}  blocked: ${blocked.length}`);
  console.log(`  redirects already correct: ${alreadyCorrect.length}  needing rewrite (stale target): ${toRewrite.length}  new: ${toCreate.length}`);
  console.log(`  chained redirects to repoint (existing redirect -> a source in this plan): ${chained.length}`);
  console.log(`  to unpublish: ${toUnpublish.length}`);

  if (productCountFailures > 0) {
    console.log(`  WARN: product count unavailable for ${productCountFailures} collection${productCountFailures === 1 ? '' : 's'}`);
  }

  if (blocked.length) {
    console.log('\n  BLOCKED (target not returning 200 — not redirected):');
    for (const b of blocked) console.log(`    /collections/${b.handle} -> ${b.target}`);
  }

  // Print the skipped rows, not just a count — an operator otherwise cannot
  // see which already-correct sources are still live and about to be
  // unpublished for the first time.
  if (alreadyCorrect.length) {
    console.log('\n  Already correct (redirect exists, target matches — still unpublished below if live):');
    for (const r of alreadyCorrect) console.log(`    ${r.live ? 'LIVE ' : 'draft'} ${r.path} -> ${r.target}`);
  }

  if (chained.length) {
    console.log('\n  CHAIN FIX (existing redirect currently points at a source this run redirects):');
    for (const c of chained) console.log(`    ${c.path} -> ${c.staleTarget}  =>  ${c.newTarget}`);
  }

  console.log('\n  Plan:');
  for (const r of toCreate) console.log(`    CREATE  ${r.live ? 'LIVE ' : 'draft'} ${r.path} -> ${r.target}`);
  for (const r of toRewrite) console.log(`    REWRITE ${r.live ? 'LIVE ' : 'draft'} ${r.path} -> ${r.target} (was ${r.staleTarget})`);

  if (!apply) {
    console.log('\n  Dry run: nothing written. Re-run with --apply.');
    return;
  }

  // Hard precondition: this script must never be the first to mutate the
  // store on a given day. setup-survivor-collections.mjs --apply is the
  // documented first step and is the only place that captures the rollback
  // baseline — see lib/consolidation-log.js. Enforce it instead of merely
  // documenting it.
  assertPreStateCaptured();

  // Chain fixes first — independent of the sources' own redirects/unpublish.
  // These records are disjoint from toRewrite by construction (see
  // findChainedRedirects) — no redirect id is ever touched by both loops.
  let chainFixed = 0;
  for (const c of chained) {
    await deleteRedirect(c.id);
    await createRedirect(c.path, c.newTarget);
    chainFixed++;
    appendAction({ action: 'chain_fix', path: c.path, from: c.staleTarget, to: c.newTarget });
    console.log(`    ✓ chain-fixed ${c.path} -> ${c.newTarget}`);
  }

  // Rewrites: delete the stale redirect and create the correct one for the
  // SAME row before moving to the next — Shopify does not expose an update,
  // a path can't hold two redirects, so the delete must land first, but
  // batching all 22 deletes before any create would leave every one of those
  // paths redirect-less for up to ~83 API calls. Interleaving bounds that
  // window to the single gap between these two calls.
  let redirected = 0;
  for (const r of toRewrite) {
    await deleteRedirect(r.existingRedirectId);
    appendAction({ action: 'delete_redirect', path: r.path, target: r.staleTarget });
    await createRedirect(r.path, r.target);
    redirected++;
    appendAction({ action: 'create_redirect', path: r.path, target: r.target });
    console.log(`    ✓ redirect ${r.handle} -> ${r.target}`);
  }

  // New redirects (no existing record to replace) BEFORE unpublishing
  // anything. A redirect lies dormant while its source collection is still
  // published and only activates the moment the collection 404s, so if the
  // loop crashes midway there are zero permanent 404s — versus
  // unpublish-then-redirect, which opens a live 404 window between the two
  // calls for every source.
  for (const r of toCreate) {
    await createRedirect(r.path, r.target);
    redirected++;
    appendAction({ action: 'create_redirect', path: r.path, target: r.target });
    console.log(`    ✓ redirect ${r.handle} -> ${r.target}`);
  }

  let unpublished = 0;
  for (const r of toUnpublish) {
    const fields = { published: false };
    if (r.kind === 'custom') await updateCustomCollection(r.id, fields);
    else await updateSmartCollection(r.id, fields);
    unpublished++;
    appendAction({ action: 'unpublish', handle: r.handle, id: r.id, kind: r.kind });
    console.log(`    ✓ unpublished ${r.handle}`);
  }

  console.log(`\n  Unpublished ${unpublished}, redirected ${redirected}, chain-fixed ${chainFixed}.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
