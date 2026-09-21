/**
 * Which post-performance flops a BODY REFRESH can actually act on.
 *
 * `data/reports/post-performance/latest.json` lists every post whose current
 * 30/60/90-day verdict is not ON_TRACK. Two agents turn that list into paid
 * content-refresher runs — performance-engine (daily, cap 3) and refresh-runner
 * `--from-post-performance` — and both used to take every REFRESH or BLOCKED row
 * straight into their cap. Measured on production 2026-09-21, that jammed the
 * loop for good: the same three rows led the list every morning and none could
 * ever succeed —
 *
 *   - `cocoa-butter-lotion` and `goat-milk-lotion` are LOCKED WINNERS, so
 *     content-refresher refuses the body rewrite and the run records a failure;
 *   - a failure writes no queue item, so nothing ever took them off the list.
 *
 * The flop budget was spent on them daily and the other 125 posts were never
 * reached ("Queued 0 new items" from 2026-09-19). So the filter runs BEFORE the
 * cap, same rule as lib/cluster-hold.js: a row that cannot succeed must not eat
 * a slot.
 *
 * Only REFRESH is refreshable. BLOCKED means zero impressions after 30 days and
 * NOT_INDEXED means Google has not indexed the page — content-refresher builds
 * its rewrite from the page's GSC queries and there are none, and a rewrite
 * does not fix indexing. DEMOTE is a merge/remove decision, not a rewrite.
 *
 * Pure: the lock check is injected, so this is testable without a filesystem.
 * Skipped rows are RETURNED, never dropped silently — a filter nobody can see
 * becomes a mystery outage.
 */

export const REFRESHABLE_VERDICTS = new Set(['REFRESH']);

/**
 * @param {Array<{slug:string, verdict:string}>} rows  action_required rows
 * @param {{ mayRewriteBody: (slug:string) => {allowed:boolean, reason?:string} }} deps
 * @returns {{ kept: object[], skipped: Array<{slug:string, verdict:string, why:string}> }}
 */
export function refreshableFlops(rows, { mayRewriteBody }) {
  const kept = [];
  const skipped = [];
  const seen = new Set();
  for (const row of rows || []) {
    if (!row?.slug || seen.has(row.slug)) continue;
    seen.add(row.slug);
    if (!REFRESHABLE_VERDICTS.has(row.verdict)) {
      skipped.push({ slug: row.slug, verdict: row.verdict, why: 'not-refreshable' });
      continue;
    }
    const lock = mayRewriteBody(row.slug);
    if (!lock?.allowed) {
      skipped.push({ slug: row.slug, verdict: row.verdict, why: 'locked', reason: lock?.reason || '' });
      continue;
    }
    kept.push(row);
  }
  return { kept, skipped };
}

/** One digest line for what the filter withheld, or [] when nothing was. */
export function renderFlopSkipLines(skipped) {
  if (!skipped?.length) return [];
  const locked = skipped.filter((s) => s.why === 'locked');
  const other = skipped.length - locked.length;
  const parts = [];
  if (locked.length) parts.push(`${locked.length} locked winner${locked.length === 1 ? '' : 's'} (${locked.map((s) => s.slug).join(', ')})`);
  if (other) parts.push(`${other} BLOCKED/NOT_INDEXED/LOW_DEMAND/DEMOTE (a rewrite cannot fix these)`);
  return [`Flops not refreshable: ${parts.join('; ')}.`];
}

/**
 * What happens to a flop next — the one question the dashboard card and the
 * digest used to leave unanswered by labelling all 159 rows "Action Required"
 * with a Refresh button, whether or not a refresh was possible or already
 * scheduled.
 *
 *   auto-refresh — REFRESH on an unlocked post: performance-engine refreshes it
 *                  (3 a day, most efficient cluster first). Nothing to do.
 *   locked       — REFRESH on a locked winner: the body rewrite is refused by
 *                  design (lib/post-lock.js). Nothing to do.
 *   not-indexed  — indexing-fixer owns it. Nothing to do here.
 *   no-demand    — BLOCKED (zero impressions at 30 days) or LOW_DEMAND (almost
 *                  no impressions or clicks at 90 days). No agent fixes this;
 *                  merge or remove is a human's call.
 *   demote       — DEMOTE: far under projection at 90 days. Merge or remove is
 *                  a human's call.
 */
export const FLOP_ACTIONS = {
  'auto-refresh': { automated: true, label: 'Queued for automatic refresh' },
  locked: { automated: true, label: 'Locked winner, body rewrite blocked by design' },
  'not-indexed': { automated: true, label: 'Not indexed, handled by indexing-fixer' },
  'no-demand': { automated: false, label: 'Almost no searches or visits: merge or remove' },
  demote: { automated: false, label: 'Far under projection at 90 days: merge or remove' },
};

export function flopAction(row, { mayRewriteBody }) {
  switch (row?.verdict) {
    case 'REFRESH': return mayRewriteBody(row.slug)?.allowed ? 'auto-refresh' : 'locked';
    case 'NOT_INDEXED': return 'not-indexed';
    case 'BLOCKED': return 'no-demand';
    case 'LOW_DEMAND': return 'no-demand';
    case 'DEMOTE': return 'demote';
    default: return 'no-demand';
  }
}

/** Counts per action, in FLOP_ACTIONS order, for a summary line. */
export function countByAction(rows) {
  const out = {};
  for (const key of Object.keys(FLOP_ACTIONS)) out[key] = 0;
  for (const r of rows || []) if (r.action in out) out[r.action] += 1;
  return out;
}
