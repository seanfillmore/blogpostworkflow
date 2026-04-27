/**
 * Aggregate GSC daily snapshots over a date range.
 *
 * Reads `data/snapshots/gsc/YYYY-MM-DD.json` (or any directory
 * matching that shape). For each (query, page) row across the window,
 * sums impressions/clicks and computes mean position. Returns a map
 * keyed by normalized query text.
 *
 * For each query, picks the page with the most clicks across the
 * window as `top_page` and lists all pages in `pages`.
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { normalize } from './normalize.js';

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

export function aggregateGscWindow({ snapshotsDir, fromDate, toDate }) {
  const files = listSnapshotsInRange(snapshotsDir, fromDate, toDate);
  // Per normalized-query: { impressions, clicks, positions[], pages: { url -> { impressions, clicks, positions[] } } }
  const acc = {};

  for (const file of files) {
    let snap;
    try {
      snap = JSON.parse(readFileSync(join(snapshotsDir, file), 'utf8'));
    } catch {
      continue; // skip corrupt snapshots
    }
    for (const row of snap.queries || []) {
      const key = normalize(row.query);
      if (!key) continue;
      if (!acc[key]) acc[key] = { impressions: 0, clicks: 0, positions: [], pages: {} };
      acc[key].impressions += row.impressions || 0;
      acc[key].clicks += row.clicks || 0;
      if (row.position != null) acc[key].positions.push(row.position);
      const url = row.page;
      if (url) {
        if (!acc[key].pages[url]) acc[key].pages[url] = { url, impressions: 0, clicks: 0, positions: [] };
        acc[key].pages[url].impressions += row.impressions || 0;
        acc[key].pages[url].clicks += row.clicks || 0;
        if (row.position != null) acc[key].pages[url].positions.push(row.position);
      }
    }
  }

  // Finalize: compute mean position, top_page, pages array, CTR
  const out = {};
  for (const [key, agg] of Object.entries(acc)) {
    const pagesArr = Object.values(agg.pages).map((p) => ({
      url: p.url,
      impressions: p.impressions,
      clicks: p.clicks,
      position: p.positions.length > 0 ? p.positions.reduce((s, x) => s + x, 0) / p.positions.length : null,
    }));
    pagesArr.sort((a, b) => b.clicks - a.clicks);
    out[key] = {
      impressions: agg.impressions,
      clicks: agg.clicks,
      ctr: agg.impressions > 0 ? agg.clicks / agg.impressions : 0,
      position: agg.positions.length > 0 ? agg.positions.reduce((s, x) => s + x, 0) / agg.positions.length : null,
      top_page: pagesArr[0]?.url || null,
      pages: pagesArr,
    };
  }
  return out;
}
