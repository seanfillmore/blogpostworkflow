/**
 * Aggregate GA4 page-level snapshots over a date range. Joined to GSC
 * queries by landing-page URL.
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

function listSnapshotsInRange(dir, fromDate, toDate) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .filter((f) => {
      const d = f.replace('.json', '');
      return d >= fromDate && d <= toDate;
    })
    .sort();
}

export function aggregateGa4Window({ snapshotsDir, fromDate, toDate }) {
  const files = listSnapshotsInRange(snapshotsDir, fromDate, toDate);
  const acc = {};
  for (const file of files) {
    let snap;
    try {
      snap = JSON.parse(readFileSync(join(snapshotsDir, file), 'utf8'));
    } catch {
      continue;
    }
    // Real ga4-collector snapshots store per-page rows under
    // `topLandingPages` with `revenue` (not `page_revenue`). Older
    // fixtures used `pages`/`page_revenue`; accept both.
    const rows = snap.topLandingPages || snap.pages || [];
    for (const row of rows) {
      const path = row.page;
      if (!path) continue;
      if (!acc[path]) acc[path] = { sessions: 0, conversions: 0, page_revenue: 0 };
      acc[path].sessions += row.sessions || 0;
      acc[path].conversions += row.conversions || 0;
      acc[path].page_revenue += (row.page_revenue ?? row.revenue ?? 0);
    }
  }
  return acc;
}

/**
 * Look up GA4 metrics for a URL or path. Accepts either a full URL
 * or a path; full URLs have their pathname extracted.
 */
export function ga4ForUrl(ga4Map, urlOrPath) {
  if (!urlOrPath) return null;
  let path = urlOrPath;
  if (path.startsWith('http')) {
    try { path = new URL(path).pathname; } catch { return null; }
  }
  return ga4Map[path] || null;
}
