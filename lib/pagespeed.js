/**
 * PageSpeed Insights (Lighthouse) client + snapshot helpers.
 *
 * Fetches mobile/desktop performance data from the PSI API, parses it into a
 * compact snapshot record, and diffs snapshots to flag regressions/improvements.
 *
 * Reads PAGESPEEDINSIGHTS_API_KEY from .env.
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

function loadEnv() {
  try {
    const lines = readFileSync(join(ROOT, '.env'), 'utf8').split('\n');
    const env = {};
    for (const line of lines) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const idx = t.indexOf('=');
      if (idx === -1) continue;
      env[t.slice(0, idx).trim()] = t.slice(idx + 1).trim();
    }
    return env;
  } catch { return {}; }
}

const _env = loadEnv();
export const PSI_API_KEY = process.env.PAGESPEEDINSIGHTS_API_KEY || _env.PAGESPEEDINSIGHTS_API_KEY || '';

const LAB_METRIC_KEYS = {
  fcp: 'first-contentful-paint',
  lcp: 'largest-contentful-paint',
  tbt: 'total-blocking-time',
  cls: 'cumulative-layout-shift',
  si: 'speed-index',
  tti: 'interactive',
};

/**
 * Parse a raw PSI runPagespeed response into a compact record.
 * Pure — no IO. Tolerant of missing audits/fields.
 */
export function parsePsiResult(psi, { url, strategy }) {
  const lr = psi?.lighthouseResult || {};
  const audits = lr.audits || {};
  const score = Math.round((lr.categories?.performance?.score ?? 0) * 100);

  const metrics = {};
  for (const [key, auditId] of Object.entries(LAB_METRIC_KEYS)) {
    metrics[key] = audits[auditId]?.numericValue ?? null;
  }

  // CrUX field data (real users). Absent for low-traffic pages.
  let field = null;
  const le = psi?.loadingExperience;
  if (le?.metrics && Object.keys(le.metrics).length > 0) {
    field = {
      category: le.overall_category ?? null,
      lcp: le.metrics.LARGEST_CONTENTFUL_PAINT_MS?.percentile ?? null,
      cls: le.metrics.CUMULATIVE_LAYOUT_SHIFT_SCORE?.percentile ?? null,
      inp: le.metrics.INTERACTION_TO_NEXT_PAINT?.percentile ?? null,
      fcp: le.metrics.FIRST_CONTENTFUL_PAINT_MS?.percentile ?? null,
    };
  }

  // Opportunities: audits with an "opportunity" details block and non-zero savings.
  const opportunities = Object.entries(audits)
    .filter(([, a]) => a?.details?.type === 'opportunity')
    .map(([id, a]) => ({
      id,
      title: a.title || id,
      savingsMs: Math.round(a.details.overallSavingsMs || 0),
      savingsKib: Math.round((a.details.overallSavingsBytes || 0) / 1024),
    }))
    .filter(o => o.savingsMs > 0 || o.savingsKib > 0)
    .sort((a, b) => (b.savingsKib - a.savingsKib) || (b.savingsMs - a.savingsMs));

  const kib = id => Math.round((audits[id]?.details?.overallSavingsBytes || 0) / 1024);
  const diagnostics = {
    mainThreadMs: audits['mainthread-work-breakdown']?.numericValue ?? null,
    bootupMs: audits['bootup-time']?.numericValue ?? null,
    unusedJsKib: kib('unused-javascript'),
    unusedCssKib: kib('unused-css-rules'),
  };

  return { url, strategy, score, metrics, field, opportunities, diagnostics };
}

/**
 * Google's Core Web Vitals thresholds, applied to the lab metrics that stand in
 * for them. `good` and `poor` are the upper bounds of those bands, so a value is
 * "good" when <= good, "poor" when > poor, and "needs-improvement" between.
 *
 * TBT is the lab proxy for responsiveness — Lighthouse cannot measure INP, which
 * needs real interactions. Field INP comes from agents/rum-monitor instead.
 * SI and TTI are diagnostics, not vitals, so they get no band.
 */
export const CWV_THRESHOLDS = {
  lcp: { good: 2500, poor: 4000, label: 'LCP' },
  cls: { good: 0.1, poor: 0.25, label: 'CLS' },
  tbt: { good: 200, poor: 600, label: 'TBT' },
  fcp: { good: 1800, poor: 3000, label: 'FCP' },
};

const BAND_RANK = { good: 0, 'needs-improvement': 1, poor: 2 };

/** Which threshold band a lab metric falls in. Pure. null when not a vital. */
export function band(metric, value) {
  const t = CWV_THRESHOLDS[metric];
  if (!t || value == null || !Number.isFinite(Number(value))) return null;
  const v = Number(value);
  if (v <= t.good) return 'good';
  if (v <= t.poor) return 'needs-improvement';
  return 'poor';
}

/**
 * Diff two snapshots. Pure. Flags per-page score regressions/improvements
 * outside a dead-band, pages with no prior baseline, and — separately — Core
 * Web Vital band changes.
 *
 * Vitals are diffed by BAND CROSSING, never by raw delta. Measured on this site,
 * lab LCP and TBT swing ~4x run-to-run on an unchanged URL (LCP 4.1s -> 16.2s ->
 * 26.7s; TBT 242ms -> 9,398ms), so a raw-delta rule would emit pure noise. A
 * band crossing is a real change in how Google would grade the page.
 *
 * `failing` lists vitals currently in the poor band regardless of whether they
 * moved, so a persistently broken vital keeps being reported instead of going
 * silent on day two when its delta is zero.
 */
export function diffSnapshots(current, previous, { deadBand = 3 } = {}) {
  const out = {
    regressions: [], improvements: [], newPages: [],
    metricRegressions: [], metricImprovements: [], failing: [],
  };

  const key = p => `${p.url}::${p.strategy}`;

  // `failing` is a property of the current snapshot alone, so it is computed
  // even on the very first run when there is nothing to diff against.
  for (const p of current.pages || []) {
    for (const metric of Object.keys(CWV_THRESHOLDS)) {
      const value = p.metrics?.[metric];
      if (band(metric, value) !== 'poor') continue;
      out.failing.push({
        url: p.url, strategy: p.strategy, metric,
        label: CWV_THRESHOLDS[metric].label, value: Number(value), band: 'poor',
      });
    }
  }

  if (!previous) return out;

  const prevByKey = new Map((previous.pages || []).map(p => [key(p), p]));

  for (const p of current.pages || []) {
    const prev = prevByKey.get(key(p));
    if (!prev) {
      out.newPages.push({ url: p.url, strategy: p.strategy, score: p.score });
      continue;
    }

    const delta = p.score - prev.score;
    const row = { url: p.url, strategy: p.strategy, from: prev.score, to: p.score, delta };
    if (delta <= -deadBand) out.regressions.push(row);
    else if (delta >= deadBand) out.improvements.push(row);

    for (const metric of Object.keys(CWV_THRESHOLDS)) {
      const to = p.metrics?.[metric];
      const from = prev.metrics?.[metric];
      const toBand = band(metric, to);
      const fromBand = band(metric, from);
      if (!toBand || !fromBand || toBand === fromBand) continue;

      const entry = {
        url: p.url, strategy: p.strategy, metric, label: CWV_THRESHOLDS[metric].label,
        from: Number(from), to: Number(to), fromBand, toBand,
      };
      if (BAND_RANK[toBand] > BAND_RANK[fromBand]) out.metricRegressions.push(entry);
      else out.metricImprovements.push(entry);
    }
  }
  return out;
}

/**
 * Fetch one URL/strategy from the PSI API, with retry/backoff on 429/5xx and a
 * hard per-request timeout so a hung request can never block the run.
 * Returns the raw PSI JSON. IO.
 *
 * @param {object} [opts]
 * @param {string} [opts.apiKey]
 * @param {number} [opts.retries]    retry attempts after the first (default 4)
 * @param {number} [opts.timeoutMs]  per-request abort deadline (default 90000)
 * @param {number} [opts.backoffMs]  base backoff, multiplied by attempt (default 2000)
 * @param {Function} [opts.fetchImpl] injectable fetch (for tests)
 */
export async function fetchPageSpeed(url, strategy, {
  apiKey = PSI_API_KEY, retries = 4, timeoutMs = 90000, backoffMs = 2000, fetchImpl = fetch,
} = {}) {
  const endpoint = new URL('https://www.googleapis.com/pagespeedonline/v5/runPagespeed');
  endpoint.searchParams.set('url', url);
  endpoint.searchParams.set('strategy', strategy);
  endpoint.searchParams.set('category', 'performance');
  if (apiKey) endpoint.searchParams.set('key', apiKey);

  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0 && backoffMs > 0) await new Promise(r => setTimeout(r, backoffMs * attempt));
    try {
      const res = await fetchImpl(endpoint, { signal: AbortSignal.timeout(timeoutMs) });
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`PSI ${res.status} for ${strategy} ${url}`);
        continue;
      }
      if (!res.ok) throw new Error(`PSI ${res.status} for ${strategy} ${url}: ${await res.text()}`);
      return await res.json();
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error(`PSI fetch failed for ${strategy} ${url}`);
}

/** Assemble a dated snapshot from parsed page records. Pure. */
export function buildSnapshot(pages, date, meta = {}) {
  return { date, ...meta, pages };
}

const fmtMs = ms => (ms == null ? 'n/a' : ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`);

const BAND_ICON = { good: '🟢', 'needs-improvement': '🟡', poor: '🔴' };

/** Format a vital with its band icon, so a bad number cannot read as fine. */
const fmtVital = (metric, value) => {
  const b = band(metric, value);
  const text = metric === 'cls'
    ? (value == null ? 'n/a' : Number(value).toFixed(3))
    : fmtMs(value);
  return b ? `${BAND_ICON[b]} ${text}` : text;
};

/** Render a compact markdown summary of a snapshot + diff. Pure. */
export function summarizeMarkdown(snapshot, diff = {}) {
  const {
    regressions = [], improvements = [], newPages = [],
    metricRegressions = [], metricImprovements = [], failing = [],
  } = diff;

  const lines = [`# PageSpeed Monitor — ${snapshot.date}`, ''];

  // Core Web Vital band changes lead, above score movement. A score is a
  // weighted blend and can rise while a vital Google grades directly gets worse
  // — which is exactly how the 2026-07-26 CLS regression got filed as a win.
  if (metricRegressions.length) {
    lines.push('## 🔴 Core Web Vital regressions');
    for (const m of metricRegressions) {
      lines.push(`- ${m.url} (${m.strategy}): **${m.label}** ${fmtVital(m.metric, m.from)} → ` +
        `${fmtVital(m.metric, m.to)} — ${m.fromBand} → **${m.toBand}**`);
    }
    lines.push('');
  }

  const regressedPages = new Set(metricRegressions.map(m => `${m.url}::${m.strategy}`));

  if (regressions.length) {
    lines.push('## 🔴 Score regressions');
    for (const r of regressions) lines.push(`- ${r.url} (${r.strategy}): ${r.from} → ${r.to} (${r.delta})`);
    lines.push('');
  }
  if (improvements.length) {
    lines.push('## 🟢 Score improvements');
    for (const i of improvements) {
      const caveat = regressedPages.has(`${i.url}::${i.strategy}`)
        ? ' — ⚠️ but a Core Web Vital regressed on this page, see above'
        : '';
      lines.push(`- ${i.url} (${i.strategy}): ${i.from} → ${i.to} (+${i.delta})${caveat}`);
    }
    lines.push('');
  }
  if (metricImprovements.length) {
    lines.push('## 🟢 Core Web Vital improvements');
    for (const m of metricImprovements) {
      lines.push(`- ${m.url} (${m.strategy}): **${m.label}** ${fmtVital(m.metric, m.from)} → ` +
        `${fmtVital(m.metric, m.to)} — ${m.fromBand} → **${m.toBand}**`);
    }
    lines.push('');
  }
  if (failing.length) {
    lines.push('## ⚠️ Vitals currently in the poor band');
    for (const f of failing) {
      lines.push(`- ${f.url} (${f.strategy}): **${f.label}** ${fmtVital(f.metric, f.value)} ` +
        `(good ≤ ${f.metric === 'cls' ? CWV_THRESHOLDS[f.metric].good : fmtMs(CWV_THRESHOLDS[f.metric].good)})`);
    }
    lines.push('');
  }
  if (newPages.length) {
    lines.push('## 🆕 New pages (no prior baseline)');
    for (const n of newPages) lines.push(`- ${n.url} (${n.strategy}): score ${n.score}`);
    lines.push('');
  }

  lines.push('## Scores');
  lines.push('| URL | Strategy | Score | LCP | TBT | CLS | Field |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const p of snapshot.pages) {
    const field = p.field ? p.field.category : 'no data';
    lines.push(`| ${p.url} | ${p.strategy} | ${p.score} | ${fmtVital('lcp', p.metrics.lcp)} | ` +
      `${fmtVital('tbt', p.metrics.tbt)} | ${fmtVital('cls', p.metrics.cls)} | ${field} |`);
  }
  lines.push('');
  lines.push('_Lab measurements under Lighthouse throttling — a deliberate stress test, not what');
  lines.push('buyers experience. Use these for relative regressions only; real-user p75 lives in_');
  lines.push('_`data/reports/rum/`. CrUX field data is absent for this origin (traffic below Google\'s');
  lines.push('reporting threshold), which is why the Field column reads "no data"._');
  return lines.join('\n');
}
