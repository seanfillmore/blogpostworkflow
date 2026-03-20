/**
 * Rank Alerter Agent
 *
 * Compares yesterday's GSC snapshot against 7 days ago.
 * Flags rank drops (≥5 positions), traffic drops (≥20%), new Page 1 entries.
 * Writes report to data/reports/rank-alerts/YYYY-MM-DD.md
 * Sends notify alert if issues found.
 *
 * Usage:
 *   node agents/rank-alerter/index.js
 *   node agents/rank-alerter/index.js --date=2026-03-18
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { notify } from '../../lib/notify.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const GSC_DIR     = join(ROOT, 'data', 'snapshots', 'gsc');
const REPORTS_DIR = join(ROOT, 'data', 'reports', 'rank-alerts');

// ── pure diff function (exported for tests) ────────────────────────────────

export function diffSnapshots(curr, prev) {
  const drops       = [];
  const gains       = [];
  const trafficDrops = [];

  // Build prev query map
  const prevQueries = new Map((prev.topQueries || []).map(q => [q.query, q]));

  for (const q of (curr.topQueries || [])) {
    const p = prevQueries.get(q.query);
    if (!p) continue;
    const delta = q.position - p.position; // positive = rank got worse
    if (delta >= 5) {
      drops.push({ query: q.query, from: p.position, to: q.position, delta });
    } else if (delta <= -5 && q.position <= 10) {
      gains.push({ query: q.query, from: p.position, to: q.position, delta: Math.abs(delta) });
    }
  }

  // Page-level traffic drops
  const prevPages = new Map((prev.topPages || []).map(p => [p.page, p]));
  for (const pg of (curr.topPages || [])) {
    const p = prevPages.get(pg.page);
    if (!p || p.clicks === 0) continue;
    const pctDrop = ((p.clicks - pg.clicks) / p.clicks) * 100;
    if (pctDrop >= 20) {
      trafficDrops.push({ page: pg.page, from: p.clicks, to: pg.clicks, pctDrop: Math.round(pctDrop) });
    }
  }

  return { drops, gains, trafficDrops };
}

// ── date helpers ──────────────────────────────────────────────────────────

function ptDate(daysAgo = 0) {
  return new Date(Date.now() - daysAgo * 86400000)
    .toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
}

function loadSnapshot(date) {
  const p = join(GSC_DIR, `${date}.json`);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}

// ── main ──────────────────────────────────────────────────────────────────

async function main() {
  const dateArg = process.argv.find(a => a.startsWith('--date='))?.split('=')[1];
  const targetDate = dateArg || ptDate(1); // default: yesterday
  const compareDate = (() => {
    const d = new Date(targetDate + 'T12:00:00Z');
    d.setDate(d.getDate() - 7);
    return d.toISOString().slice(0, 10);
  })();

  console.log(`Rank Alerter — ${targetDate} vs ${compareDate}`);

  const curr = loadSnapshot(targetDate);
  const prev = loadSnapshot(compareDate);

  if (!curr) { console.log(`No snapshot for ${targetDate}, skipping.`); return; }
  if (!prev) { console.log(`No snapshot for ${compareDate}, skipping.`); return; }

  const { drops, gains, trafficDrops } = diffSnapshots(curr, prev);

  if (!drops.length && !gains.length && !trafficDrops.length) {
    console.log('No significant changes detected.');
    return;
  }

  // Build report
  const lines = [`# Rank Alert — ${targetDate}`, ''];
  if (drops.length) {
    lines.push('## 🔻 Rank Drops (≥5 positions)');
    for (const d of drops) lines.push(`- **${d.query}**: ${d.from.toFixed(1)} → ${d.to.toFixed(1)} (Δ${d.delta.toFixed(1)})`);
    lines.push('');
  }
  if (gains.length) {
    lines.push('## 🚀 New Page 1 Entries');
    for (const g of gains) lines.push(`- **${g.query}**: ${g.from.toFixed(1)} → ${g.to.toFixed(1)} (+${g.delta.toFixed(1)})`);
    lines.push('');
  }
  if (trafficDrops.length) {
    lines.push('## 📉 Traffic Drops (≥20% week-over-week)');
    for (const t of trafficDrops) lines.push(`- **${t.page}**: ${t.from} → ${t.to} clicks (−${t.pctDrop}%)`);
    lines.push('');
  }

  mkdirSync(REPORTS_DIR, { recursive: true });
  const reportPath = join(REPORTS_DIR, `${targetDate}.md`);
  writeFileSync(reportPath, lines.join('\n'));
  console.log(`Report saved: ${reportPath}`);

  const isNeg = drops.length > gains.length;
  await notify({
    subject: `Rank Alert ${targetDate}: ${drops.length} drops, ${gains.length} gains`,
    body: lines.join('\n'),
    status: isNeg ? 'error' : 'success',
  });
  console.log('Notification sent.');
}

main().catch(e => { console.error(e.message); process.exit(1); });
