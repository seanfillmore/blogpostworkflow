/**
 * Apply the live-article edit gate (lib/post-edit-gate.js) to a PICK LIST.
 *
 * Pure: the gate is injected as `mayEdit(target, kind)`, so a caller's
 * selection logic can be unit-tested without a post tree on disk, and so this
 * module can be imported by pure planners (lib/queue-autoapply.js style).
 *
 * The rule is the cluster hold's: filter BEFORE the per-run cap. A held item
 * filtered after the cap has already eaten a slot and produced nothing.
 *
 * A held item is never dropped from anywhere durable. The gate decides TIMING,
 * never that the work is worthless: queue items stay pending, briefs stay on
 * disk, and the next run asks again.
 */

/**
 * @template T
 * @param {T[]} items
 * @param {{kind:string, targetOf:(item:T)=>string|null|undefined,
 *          mayEdit:(target:string, kind:string)=>{allowed:boolean, reason:string, until?:string}}} opts
 * @returns {{kept:T[], held:Array<{item:T, target:string, kind:string, reason:string, until?:string}>}}
 */
export function partitionByEditGate(items, { kind, targetOf, mayEdit } = {}) {
  const kept = []; const held = [];
  if (typeof mayEdit !== 'function') return { kept: [...(items || [])], held };
  for (const item of Array.isArray(items) ? items : []) {
    const target = targetOf ? targetOf(item) : null;
    // No resolvable page: nothing to ask about. The writer's own write-site
    // check (where there is one) still applies.
    if (!target) { kept.push(item); continue; }
    const verdict = mayEdit(target, kind);
    if (verdict?.allowed === false) {
      held.push({ item, target, kind, reason: verdict.reason, ...(verdict.until ? { until: verdict.until } : {}) });
    } else {
      kept.push(item);
    }
  }
  return { kept, held };
}

/** Article handle from a URL, handle or slug. */
export function gateTargetHandle(u) {
  return String(u || '').replace(/[?#].*$/, '').replace(/\/+$/, '').split('/').pop() || null;
}

/**
 * Digest/console lines for held items. Empty on a clean run so the block
 * vanishes. A hold is the policy working: callers keep it on the deferred
 * success path, never `status: 'error'`, never `immediate: true`.
 */
export function renderEditGateLines(held) {
  const list = Array.isArray(held) ? held : [];
  if (!list.length) return [];
  const byTarget = new Map();
  for (const h of list) {
    const key = gateTargetHandle(h.target);
    if (!byTarget.has(key)) byTarget.set(key, h);
  }
  return [
    `Edit gate held ${byTarget.size} page(s):`,
    ...[...byTarget.entries()].map(([handle, h]) => `  · ${handle} (${h.kind}) — ${h.reason}`),
  ];
}

/** Short fragment for a notify subject; '' when nothing was held. */
export function editGateSummaryFragment(held) {
  const n = new Set((Array.isArray(held) ? held : []).map((h) => gateTargetHandle(h.target))).size;
  return n ? ` · edit gate held ${n}` : '';
}
