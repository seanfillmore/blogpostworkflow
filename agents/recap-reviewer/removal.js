/**
 * Remove LOW_DEMAND ("no-demand") blog posts behind a 301, at most 5 a run.
 *
 * Per post, in this order, and a failure at any step before the delete SKIPS the
 * post with its reason (it is never removed on partial evidence):
 *   1. eligibility (lib/low-demand-removal.js): not locked, not in a CTR
 *      experiment, never converted, not a cannibalization winner, not already a
 *      redirect target, order history readable;
 *   2. pick the target BY NUMBER from live pages in the same cluster (PDP, then
 *      collection, then sibling posts), one `fast` call, parseChoice;
 *   3. HEAD the target, expect 200;
 *   4. back up the article (body, title, tags, metafields);
 *   5. killPost(slug, { reason: 'low-demand', redirectTo }) — redirect BEFORE delete;
 *   6. verify the old URL 301s to the target.
 * After every removal, scripts/fix-redirect-links.mjs --apply runs once.
 *
 * Dry: steps 1-3 run (reads and one LLM call); nothing is written or deleted.
 */
import { removalCandidates, convertedPaths, cannibalizationWinners } from '../../lib/low-demand-removal.js';
import { handleOf } from '../../lib/ctr-protected.js';
import { buildChoiceList, parseChoice } from '../../lib/tech-seo-steward.js';
import { clusterForText } from '../../lib/cluster-revenue.js';

export const MAX_REMOVALS = 5;
const LINK_REPAIR_TIMEOUT_MS = 20 * 60_000;

const pathOf = (u) => {
  let s = String(u || '').replace(/[?#].*$/, '').replace(/^https?:\/\/[^/]+/i, '');
  try { s = decodeURIComponent(s); } catch { /* raw */ }
  return s.replace(/\/+$/, '').toLowerCase() || '/';
};
const textOf = (it) => `${it?.title || ''} ${String(it?.path || '').split('/').pop().replace(/-/g, ' ')}`;

/** Live pages in `cluster`, ordered PDP -> collection -> sibling post, minus `exclude`. */
export function clusterInventory(inventory, cluster, exclude = new Set()) {
  const inCluster = (it) => it?.path && !exclude.has(pathOf(it.path)) && clusterForText(textOf(it)) === cluster;
  return {
    articles: [
      ...(inventory?.products || []).filter(inCluster),
      ...(inventory?.collections || []).filter(inCluster),
      ...(inventory?.articles || []).filter(inCluster),
    ],
  };
}

export function buildRemovalPrompt(row, handle, choices) {
  const lines = choices.map((c, i) => `[${i}] ${c.path} — ${c.title}`).join('\n');
  return [
    'A low-traffic blog post on realskincare.com is being retired behind a permanent redirect. Choose the ONE live page a reader of that post should land on instead.',
    'Prefer the product page that post was selling, then its collection, then the closest sibling post. Use the hub only when nothing specific fits.',
    '',
    `Retiring: /blogs/news/${handle} — ${row?.title || ''}`,
    '',
    'Live pages:',
    lines,
    '',
    'Reply with ONLY a JSON object: {"choice": <number>, "why": "<one short sentence>"}',
  ].join('\n');
}

async function tryOr(fn, fallback) {
  try { return await fn(); } catch { return fallback; }
}

/**
 * @returns {Promise<{outcomes:Array<{row:object, bucket:'resolved'|'unresolved', result:string, evidence:string}>,
 *                    skipped:Array<{slug:string, reason:string}>, removed:number, linkRepair:object|null}>}
 */
export async function runRemovals({ rows, deps, apply, pastCutoff, today }) {
  const outcomes = []; const skipped = [];
  const res = { outcomes, skipped, removed: 0, linkRepair: null };
  if (!rows.length) return res;

  const out = (row, bucket, result, evidence = '') => outcomes.push({ row, bucket, result, evidence });
  if (pastCutoff()) { for (const r of rows) out(r, 'unresolved', 'deferred to tomorrow'); return res; }

  // A 90-day verdict only. An earlier milestone is not evidence of no demand.
  const ripe = [];
  for (const r of rows) {
    if (r?.milestone != null && Number(r.milestone) < 90) skipped.push({ slug: r.slug, reason: `only at the ${r.milestone}-day milestone` });
    else ripe.push(r);
  }

  let ordersOk = false; let orders = [];
  try { orders = await deps.getAllOrders(); ordersOk = true; } catch { ordersOk = false; }
  const redirects = await tryOr(() => deps.getAllRedirects(), null);
  const ctx = {
    ctrHandles: await tryOr(() => deps.ctrHandles(), undefined),
    converted: convertedPaths(orders),
    winners: cannibalizationWinners(await tryOr(() => deps.cannibalizationReport(), null)),
    redirectTargets: Array.isArray(redirects) ? new Set(redirects.map((r) => r?.target).filter(Boolean)) : undefined,
    ordersOk,
    lockStateFor: (h) => deps.lockStateFor(h),
  };
  const { take, skipped: notEligible } = removalCandidates(ripe, ctx, { limit: MAX_REMOVALS });
  skipped.push(...notEligible);
  if (!take.length) return res;

  let inventory;
  try { inventory = await deps.loadInventory(); } catch (e) {
    for (const r of take) skipped.push({ slug: r.slug, reason: `live inventory unreadable: ${e.message}` });
    return res;
  }
  const leaving = new Set(take.map((r) => pathOf(`/blogs/news/${handleOf(r.url) || r.slug}`)));

  for (const row of take) {
    const skip = (reason) => skipped.push({ slug: row.slug, reason });
    if (pastCutoff()) { out(row, 'unresolved', 'deferred to tomorrow'); continue; }
    const handle = handleOf(row.url) || row.slug;
    const oldPath = `/blogs/news/${handle}`;

    const article = await tryOr(() => deps.findArticle(handle), undefined);
    if (article === undefined) { skip('Shopify article lookup failed'); continue; }
    if (!article) { skip('no Shopify article with this handle'); continue; }

    const cluster = clusterForText(`${row.title || ''} ${handle.replace(/-/g, ' ')}`);
    if (!cluster) { skip('post matches no product cluster, so no same-cluster target exists'); continue; }
    const choices = buildChoiceList('blog', clusterInventory(inventory, cluster, leaving));
    if (choices.length < 2) { skip(`no live page in the "${cluster}" cluster to redirect to`); continue; }

    let pick = null;
    try { pick = parseChoice(await deps.askFast(buildRemovalPrompt(row, handle, choices)), choices); } catch (e) {
      skip(`redirect pick failed: ${e.message}`); continue;
    }
    if (!pick) { skip('redirect pick unparseable'); continue; }

    const status = await tryOr(() => deps.headStatus(pick.path), null);
    if (status !== 200) { skip(`target ${pick.path} returned ${status ?? 'no response'}, not 200`); continue; }

    if (!apply) { out(row, 'unresolved', `dry run: would remove ${oldPath} -> 301 ${pick.path}`, pick.why); continue; }

    try {
      const backup = await deps.articleBackup(article);
      await deps.writeBackup(row.slug, today, { removed_at: new Date().toISOString(), reason: 'low-demand', redirect_to: pick.path, flop: row, article: backup });
    } catch (e) { skip(`backup failed, not removed: ${e.message}`); continue; }

    let summary;
    try { summary = await deps.killPost(row.slug, { reason: 'low-demand', redirectTo: pick.path }); } catch (e) {
      out(row, 'unresolved', 'removal failed part-way', e.message); continue;
    }
    if (!summary?.shopify_deleted) {
      out(row, 'unresolved', 'killPost did not delete the article', (summary?.warnings || []).join('; ')); continue;
    }
    res.removed += 1;
    const chk = await tryOr(() => deps.checkRedirect(oldPath), null);
    const ok = chk?.status === 301 && pathOf(chk.location) === pathOf(pick.path);
    if (ok) out(row, 'resolved', `removed; ${oldPath} 301s to ${pick.path}`, pick.why);
    else out(row, 'unresolved', 'removed, but the 301 did not verify', `expected 301 -> ${pick.path}, got ${chk?.status ?? 'no response'} ${chk?.location || ''}`.trim());
  }

  if (res.removed > 0) {
    const r = await deps.exec('node', ['scripts/fix-redirect-links.mjs', '--apply'], { timeout: LINK_REPAIR_TIMEOUT_MS });
    res.linkRepair = { code: r.code, timedOut: !!r.timedOut };
  }
  return res;
}
