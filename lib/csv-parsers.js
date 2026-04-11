/**
 * Shared CSV parsing utilities for Ahrefs data files.
 *
 * Extracted from agents/content-researcher/index.js so that multiple
 * modules (content-researcher, keyword-index, etc.) can reuse them.
 */

export function parseCSV(text) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map((h) => h.replace(/^"|"$/g, '').trim().toLowerCase());
  return lines.slice(1).map((line) => {
    // Handle quoted fields containing commas
    const fields = [];
    let inQuote = false;
    let cur = '';
    for (const ch of line) {
      if (ch === '"') { inQuote = !inQuote; }
      else if (ch === ',' && !inQuote) { fields.push(cur.trim()); cur = ''; }
      else { cur += ch; }
    }
    fields.push(cur.trim());
    const row = {};
    headers.forEach((h, i) => { row[h] = fields[i]?.replace(/^"|"$/g, '') ?? ''; });
    return row;
  });
}

function num(v) { const n = parseFloat(String(v ?? '').replace(/,/g, '')); return isNaN(n) ? null : n; }

// Get a value from a row by trying multiple possible column names (all lowercased)
function g(row, ...keys) {
  for (const k of keys) if (k in row && row[k] !== '') return row[k];
  return null;
}

export function parseSerpCsv(rows) {
  // The first row with no URL is the keyword-level overview summary
  const overviewRow = rows.find((r) => !g(r, 'url'));
  const overview = overviewRow ? {
    volume: num(g(overviewRow, 'volume')),
    keyword_difficulty: num(g(overviewRow, 'difficulty')),
    traffic_potential: num(g(overviewRow, 'traffic potential')),
    global_volume: num(g(overviewRow, 'global volume')),
    cpc_cents: num(g(overviewRow, 'cpc')),
    parent_topic: g(overviewRow, 'parent topic'),
    search_intent: g(overviewRow, 'intents'),
  } : {};

  const skip = ['youtube.com', 'reddit.com', 'facebook.com', 'tiktok.com', 'instagram.com', 'amazon.com'];
  const serp = rows
    .filter((r) => g(r, 'url') && !skip.some((s) => (g(r, 'url') ?? '').includes(s)))
    .map((r) => ({
      position: num(g(r, 'position')),
      url: g(r, 'url'),
      title: g(r, 'title'),
      domain_rating: num(g(r, 'domain rating')),
      traffic: num(g(r, 'traffic')),
      keywords: num(g(r, 'keywords')),
      refdomains: num(g(r, 'referring domains')),
      type: g(r, 'type'),
    }))
    .slice(0, 10);

  return { overview, serp };
}

export function parseKeywordsCsv(rows) {
  return rows
    .map((r) => ({
      keyword: g(r, 'keyword'),
      volume: num(g(r, 'volume')),
      difficulty: num(g(r, 'difficulty')),
      traffic_potential: num(g(r, 'traffic potential')),
      cpc: num(g(r, 'cpc')),
    }))
    .filter((r) => r.keyword);
}

export function parseVolumeHistoryCsv(rows) {
  const recent = rows.slice(-24);
  const byMonth = {};
  for (const r of recent) {
    const date = g(r, 'date');
    const vol = num(g(r, 'volume', ' volume'));
    if (!date || vol === null) continue;
    const month = new Date(date).getMonth();
    if (!byMonth[month]) byMonth[month] = [];
    byMonth[month].push(vol);
  }
  const names = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const seasonality = Object.entries(byMonth)
    .map(([m, vols]) => ({ month: names[+m], avg: Math.round(vols.reduce((a, b) => a + b) / vols.length) }))
    .sort((a, b) => b.avg - a.avg);
  return { peak_month: seasonality[0]?.month, low_month: seasonality[seasonality.length - 1]?.month, seasonality };
}
