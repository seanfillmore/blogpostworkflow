/**
 * RUM Monitor Agent
 *
 * Aggregates the raw Core Web Vitals beacons written by the dashboard's
 * /api/rum collector into p75 by page and device — the same statistic Google
 * uses for Core Web Vitals — and reports how real users experience the pages
 * that take money.
 *
 * Reads:  data/snapshots/rum/YYYY-MM-DD.jsonl   (one JSON object per beacon)
 * Writes: data/reports/rum/YYYY-MM-DD.md
 *         data/reports/rum/latest.json          (for the dashboard)
 *
 * Why p75 and not the mean: one 24-second outlier drags a mean into nonsense,
 * and Google's thresholds are defined against the 75th percentile. Sample sizes
 * here are small (~33 real sessions/day), so every figure carries its n and
 * anything under MIN_SAMPLES is reported as provisional rather than quietly
 * averaged into a confident-looking number.
 *
 * Usage:
 *   node agents/rum-monitor/index.js                # trailing 7 days
 *   node agents/rum-monitor/index.js --days 28
 *   node agents/rum-monitor/index.js --date 2026-07-28
 *   node agents/rum-monitor/index.js --prune        # drop raw jsonl > RETAIN_DAYS
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'url';
import { notify } from '../../lib/notify.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const RUM_DIR = join(ROOT, 'data', 'snapshots', 'rum');
const REPORTS_DIR = join(ROOT, 'data', 'reports', 'rum');

// Google's Core Web Vitals thresholds (good / needs-improvement boundary).
export const THRESHOLDS = {
  LCP: { good: 2500, poor: 4000, unit: 'ms' },
  INP: { good: 200, poor: 500, unit: 'ms' },
  CLS: { good: 0.1, poor: 0.25, unit: '' },
  FCP: { good: 1800, poor: 3000, unit: 'ms' },
  TTFB: { good: 800, poor: 1800, unit: 'ms' },
};

const CORE = ['LCP', 'INP', 'CLS'];
const MIN_SAMPLES = 10;
const RETAIN_DAYS = 60;

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  const inline = process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
  return inline ?? (i !== -1 ? process.argv[i + 1] : undefined);
};
const hasFlag = (name) => process.argv.includes(`--${name}`);

/** Nearest-rank p75, matching how CrUX reports Core Web Vitals. */
export function percentile(values, p = 75) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.min(Math.max(idx, 0), sorted.length - 1)];
}

export function rate(metric, value) {
  const t = THRESHOLDS[metric];
  if (!t || value == null) return null;
  if (value <= t.good) return 'good';
  if (value <= t.poor) return 'needs-improvement';
  return 'poor';
}

export function readBeacons(dates) {
  const out = [];
  for (const date of dates) {
    const file = join(RUM_DIR, `${date}.jsonl`);
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch { /* skip a torn final line */ }
    }
  }
  return out;
}

export function datesBack(days, end = new Date()) {
  const out = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(end);
    d.setUTCDate(d.getUTCDate() - i);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

/**
 * Group beacon metric samples by an arbitrary key, then reduce to p75 per
 * metric. Returns [{ key, samples, metrics: { LCP: {p75, rating, n}, ... } }]
 * sorted by descending sample count.
 */
export function aggregate(beacons, keyFn) {
  const groups = new Map();
  for (const b of beacons) {
    const key = keyFn(b);
    if (key == null) continue;
    if (!groups.has(key)) groups.set(key, { key, views: 0, values: {}, culprits: {} });
    const g = groups.get(key);
    g.views += 1;
    for (const m of b.metrics || []) {
      if (!THRESHOLDS[m.name]) continue;
      (g.values[m.name] ||= []).push(m.value);
      // Track the most-blamed element so a bad number arrives with a cause.
      const el = m.attr?.element;
      if (el) {
        const byMetric = (g.culprits[m.name] ||= {});
        byMetric[el] = (byMetric[el] || 0) + 1;
      }
    }
  }

  const rows = [];
  for (const g of groups.values()) {
    const metrics = {};
    for (const [name, values] of Object.entries(g.values)) {
      const p75 = percentile(values);
      const culprits = Object.entries(g.culprits[name] || {}).sort((a, b) => b[1] - a[1]);
      metrics[name] = {
        p75: name === 'CLS' ? Math.round(p75 * 10000) / 10000 : Math.round(p75),
        rating: rate(name, p75),
        n: values.length,
        provisional: values.length < MIN_SAMPLES,
        topElement: culprits.length ? culprits[0][0] : null,
      };
    }
    rows.push({ key: g.key, views: g.views, metrics });
  }
  return rows.sort((a, b) => b.views - a.views);
}

const fmt = (name, v) => {
  if (v == null) return 'n/a';
  if (name === 'CLS') return v.toFixed(4);
  return v >= 1000 ? `${(v / 1000).toFixed(2)} s` : `${v} ms`;
};

const ICON = { good: '🟢', 'needs-improvement': '🟡', poor: '🔴' };

function renderTable(rows, label) {
  const lines = [
    `| ${label} | Views | ${CORE.map((m) => `${m} p75`).join(' | ')} |`,
    `|---|---|${CORE.map(() => '---|').join('')}`,
  ];
  for (const r of rows) {
    const cells = CORE.map((m) => {
      const d = r.metrics[m];
      if (!d) return 'no data';
      return `${ICON[d.rating] || ''} ${fmt(m, d.p75)}${d.provisional ? ` _(n=${d.n})_` : ''}`;
    });
    lines.push(`| ${r.key} | ${r.views} | ${cells.join(' | ')} |`);
  }
  return lines.join('\n');
}

function renderMarkdown({ date, days, beacons, byDevice, byPage, worst }) {
  // `beacons` is a count, not the array — the payload carries beacons.length.
  const out = [`# RUM — Core Web Vitals from real users — ${date}`, ''];
  out.push(`**Window:** trailing ${days} days · **Beacons:** ${beacons}`, '');

  if (!beacons) {
    out.push('No beacons received yet. If the snippet is installed, check that');
    out.push('`/api/rum` is reachable from the storefront and not blocked.');
    return out.join('\n');
  }

  out.push('## By device', '', renderTable(byDevice, 'Device'), '');
  out.push('## By page', '', renderTable(byPage.slice(0, 20), 'Page'), '');

  if (worst.length) {
    out.push('## Failing Core Web Vitals (p75 in the poor band)', '');
    for (const w of worst) {
      out.push(`- **${w.page}** (${w.device}) — ${w.metric} p75 **${fmt(w.metric, w.p75)}** ` +
        `(threshold ${fmt(w.metric, THRESHOLDS[w.metric].good)})${w.provisional ? ` — provisional, n=${w.n}` : ''}`);
      if (w.topElement) out.push(`  - most-blamed element: \`${w.topElement}\``);
    }
    out.push('');
  }

  const provisional = [...byDevice, ...byPage].some((r) => Object.values(r.metrics).some((m) => m.provisional));
  if (provisional) {
    out.push(`_Figures marked with n are below ${MIN_SAMPLES} samples — directional only._`);
  }
  return out.join('\n');
}

function prune() {
  if (!existsSync(RUM_DIR)) return 0;
  const keep = new Set(datesBack(RETAIN_DAYS));
  let removed = 0;
  for (const f of readdirSync(RUM_DIR)) {
    const m = f.match(/^(\d{4}-\d{2}-\d{2})\.jsonl$/);
    if (m && !keep.has(m[1])) { unlinkSync(join(RUM_DIR, f)); removed += 1; }
  }
  return removed;
}

async function main() {
  const date = arg('date') || new Date().toISOString().slice(0, 10);
  const days = Number(arg('days') || 7);

  if (hasFlag('prune')) {
    const removed = prune();
    console.log(`Pruned ${removed} raw RUM file(s) older than ${RETAIN_DAYS} days.`);
    return;
  }

  const beacons = readBeacons(datesBack(days, new Date(`${date}T00:00:00Z`)));
  const byDevice = aggregate(beacons, (b) => b.device || 'unknown');
  const byPage = aggregate(beacons, (b) => b.path);

  // Anything in the poor band on a page that can take money is the headline.
  const worst = [];
  for (const b of aggregate(beacons, (b) => `${b.path} ${b.device}`)) {
    const [page, device] = b.key.split(' ');
    for (const m of CORE) {
      const d = b.metrics[m];
      if (d && d.rating === 'poor') {
        worst.push({ page, device, metric: m, p75: d.p75, n: d.n, provisional: d.provisional, topElement: d.topElement });
      }
    }
  }
  worst.sort((a, b) => CORE.indexOf(a.metric) - CORE.indexOf(b.metric));

  const payload = { date, days, beacons: beacons.length, byDevice, byPage, worst };
  const md = renderMarkdown(payload);

  mkdirSync(REPORTS_DIR, { recursive: true });
  writeFileSync(join(REPORTS_DIR, `${date}.md`), md);
  writeFileSync(join(REPORTS_DIR, 'latest.json'), JSON.stringify(payload, null, 2));
  console.log(md);

  const failing = worst.filter((w) => !w.provisional);
  await notify({
    subject: beacons.length
      ? `RUM: ${beacons.length} beacons, ${failing.length} failing Core Web Vitals`
      : 'RUM: no beacons received',
    body: md,
    // NO BEACONS is a real outage — the storefront stopped reporting, or the
    // collector stopped receiving, and nothing else would say so. Poor vitals on
    // some page/device pair is a MEASUREMENT and belongs in the body: the
    // 2026-08-29 row read "2 failing Core Web Vitals" while every device and
    // page in the table was green except tablet INP on 761 views, and it landed
    // in the Failures block looking like a crash.
    status: !beacons.length ? 'error' : failing.length ? 'info' : 'success',
    category: 'performance',
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
