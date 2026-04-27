/**
 * Sort low-CTR candidates so amazon-validated queries land at the top of
 * the daily processing list. Stable within each band; works whether rows
 * carry validation_source (from gsc-opportunity/latest.json) or not
 * (from the live-GSC fallback path).
 */
export function sortByValidation(rows) {
  const band = (r) => (r.validation_source === 'amazon' ? 0 : 1);
  return [...rows].sort((a, b) => {
    const db = band(a) - band(b);
    if (db !== 0) return db;
    return (b.impressions ?? 0) - (a.impressions ?? 0);
  });
}
