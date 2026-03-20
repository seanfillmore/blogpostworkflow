// agents/competitor-intelligence/brief-writer.js

/**
 * Deduplicate recommended changes across competitors.
 * When multiple competitors suggest the same change type,
 * take the one from the competitor with the highest traffic_value.
 */
export function deduplicateChanges(changes) {
  const byType = new Map();
  for (const change of changes) {
    const existing = byType.get(change.type);
    if (!existing || change.fromTrafficValue > existing.fromTrafficValue) {
      byType.set(change.type, change);
    }
  }

  return Array.from(byType.values()).map((change, i) => {
    const { fromTrafficValue: _, ...rest } = change;
    return { id: `change-${String(i + 1).padStart(3, '0')}`, ...rest, status: 'pending' };
  });
}

/**
 * Compute Optimize tab KPI values from the briefs array.
 * Returns plain object (not the KPI array format — that's done in client JS).
 */
export function computeOptimizeKpis(d) {
  const briefs = d.briefs || [];
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  const pendingPages = briefs.filter(b =>
    (b.proposed_changes || []).some(c => c.status === 'pending')
  ).length;

  const approvedChanges = briefs
    .flatMap(b => b.proposed_changes || [])
    .filter(c => c.status === 'approved').length;

  // A page is "optimized this month" if it has at least one applied change,
  // no remaining approved changes, and was generated within the current month.
  const optimizedThisMonth = briefs.filter(b => {
    const changes = b.proposed_changes || [];
    const hasApplied  = changes.some(c => c.status === 'applied');
    const noneApproved = !changes.some(c => c.status === 'approved');
    return hasApplied && noneApproved && new Date(b.generated_at) >= monthStart;
  }).length;

  const allTrafficValues = briefs.flatMap(b =>
    (b.competitors || []).map(c => (c.traffic_value || 0) / 100)
  );
  const avgTrafficValue = allTrafficValues.length
    ? Math.round(allTrafficValues.reduce((s, v) => s + v, 0) / allTrafficValues.length)
    : 0;

  return { pendingPages, approvedChanges, optimizedThisMonth, avgTrafficValue };
}
