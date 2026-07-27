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
  updateCustomCollection, updateSmartCollection, createRedirect, getRedirects,
} from '../lib/shopify.js';
import { buildRedirectPlan } from '../lib/collection-consolidation.js';

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
 * 163 already and this run adds 84 (247, then more on later runs), so the
 * `existing` idempotency check would silently miss real redirects and
 * `createRedirect` would throw mid-run on a duplicate path.
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

  const existing = new Set((await loadAllRedirects(getRedirects)).map((r) => r.path));
  const toWrite = ready.filter((r) => !existing.has(`/collections/${r.handle}`));

  if (asJson) {
    console.log(JSON.stringify({ plan, ready, blocked, toWrite, productCountFailures }, null, 1));
    return;
  }

  console.log(`\nCollection consolidation — ${apply ? 'APPLY' : 'DRY RUN'}`);
  console.log(`  collections: ${collections.length} (live ${collections.filter((c) => c.live).length})`);
  console.log(`  to redirect: ${plan.length}  ready: ${ready.length}  blocked: ${blocked.length}`);
  console.log(`  redirects already present: ${ready.length - toWrite.length}`);

  if (productCountFailures > 0) {
    console.log(`  WARN: product count unavailable for ${productCountFailures} collection${productCountFailures === 1 ? '' : 's'}`);
  }

  if (blocked.length) {
    console.log('\n  BLOCKED (target not returning 200 — not redirected):');
    for (const b of blocked) console.log(`    /collections/${b.handle} -> ${b.target}`);
  }

  console.log('\n  Plan:');
  for (const r of toWrite) {
    console.log(`    ${r.live ? 'LIVE ' : 'draft'} /collections/${r.handle} -> ${r.target}`);
  }

  if (!apply) {
    console.log('\n  Dry run: nothing written. Re-run with --apply.');
    return;
  }

  let unpublished = 0;
  let redirected = 0;
  for (const r of toWrite) {
    if (r.live) {
      const fields = { published: false };
      if (r.kind === 'custom') await updateCustomCollection(r.id, fields);
      else await updateSmartCollection(r.id, fields);
      unpublished++;
    }
    await createRedirect(`/collections/${r.handle}`, r.target);
    redirected++;
    console.log(`    ✓ ${r.handle} -> ${r.target}`);
  }
  console.log(`\n  Unpublished ${unpublished}, redirected ${redirected}.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
