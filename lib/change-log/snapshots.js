/**
 * Read GSC/GA4 daily snapshots and aggregate metrics for a URL+queries
 * over a date range.
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

function listSnapshotsInRange(snapshotsDir, fromDate, toDate) {
  if (!existsSync(snapshotsDir)) return [];
  return readdirSync(snapshotsDir)
    .filter((f) => f.endsWith('.json'))
    .filter((f) => {
      const d = f.replace('.json', '');
      return d >= fromDate && d <= toDate;
    })
    .sort();
}

export function aggregateGSCForUrl({ snapshotsDir, url, queries, fromDate, toDate }) {
  const files = listSnapshotsInRange(snapshotsDir, fromDate, toDate);
  let totalImpressions = 0;
  let totalClicks = 0;
  const positions = [];
  const byQuery = {};
  for (const q of queries || []) byQuery[q] = { impressions: 0, clicks: 0, positions: [] };

  for (const f of files) {
    const snap = JSON.parse(readFileSync(join(snapshotsDir, f), 'utf8'));
    const pageRow = (snap.topPages || []).find((p) => p.page === url || (p.page && p.page.endsWith(url)));
    if (pageRow) {
      totalImpressions += pageRow.impressions || 0;
      totalClicks += pageRow.clicks || 0;
      if (pageRow.position != null) positions.push(pageRow.position);
    }
    for (const q of queries || []) {
      const queryRow = (snap.queries || []).find(
        (r) => r.query === q && (r.page === url || (r.page && r.page.endsWith(url))),
      );
      if (queryRow) {
        byQuery[q].impressions += queryRow.impressions || 0;
        byQuery[q].clicks += queryRow.clicks || 0;
        if (queryRow.position != null) byQuery[q].positions.push(queryRow.position);
      }
    }
  }

  const meanPosition = positions.length > 0 ? positions.reduce((s, p) => s + p, 0) / positions.length : null;
  const ctr = totalImpressions > 0 ? totalClicks / totalImpressions : 0;

  const byQueryResult = {};
  for (const [q, agg] of Object.entries(byQuery)) {
    byQueryResult[q] = {
      impressions: agg.impressions,
      clicks: agg.clicks,
      ctr: agg.impressions > 0 ? agg.clicks / agg.impressions : 0,
      position: agg.positions.length > 0 ? agg.positions.reduce((s, p) => s + p, 0) / agg.positions.length : null,
    };
  }

  return {
    page: {
      impressions: totalImpressions,
      clicks: totalClicks,
      ctr,
      position: meanPosition,
    },
    byQuery: byQueryResult,
  };
}

export function aggregateGA4ForUrl({ snapshotsDir, pagePath, fromDate, toDate }) {
  const files = listSnapshotsInRange(snapshotsDir, fromDate, toDate);
  let sessions = 0;
  let conversions = 0;
  let page_revenue = 0;

  for (const f of files) {
    const snap = JSON.parse(readFileSync(join(snapshotsDir, f), 'utf8'));
    const row = (snap.pages || []).find((p) => p.page === pagePath);
    if (row) {
      sessions += row.sessions || 0;
      conversions += row.conversions || 0;
      page_revenue += row.page_revenue || 0;
    }
  }

  return { sessions, conversions, page_revenue };
}
