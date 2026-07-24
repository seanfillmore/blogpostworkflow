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
 * Diff two snapshots. Pure. Flags per-page score regressions/improvements
 * outside a dead-band, and pages with no prior baseline.
 */
export function diffSnapshots(current, previous, { deadBand = 3 } = {}) {
  const out = { regressions: [], improvements: [], newPages: [] };
  if (!previous) return out;

  const key = p => `${p.url}::${p.strategy}`;
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

/** Render a compact markdown summary of a snapshot + diff. Pure. */
export function summarizeMarkdown(snapshot, diff = { regressions: [], improvements: [], newPages: [] }) {
  const lines = [`# PageSpeed Monitor — ${snapshot.date}`, ''];

  if (diff.regressions.length) {
    lines.push('## 🔴 Regressions');
    for (const r of diff.regressions) lines.push(`- ${r.url} (${r.strategy}): ${r.from} → ${r.to} (${r.delta})`);
    lines.push('');
  }
  if (diff.improvements.length) {
    lines.push('## 🟢 Improvements');
    for (const i of diff.improvements) lines.push(`- ${i.url} (${i.strategy}): ${i.from} → ${i.to} (+${i.delta})`);
    lines.push('');
  }

  lines.push('## Scores');
  lines.push('| URL | Strategy | Score | LCP | TBT | CLS | Field |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const p of snapshot.pages) {
    const field = p.field ? p.field.category : 'no data';
    const cls = p.metrics.cls == null ? 'n/a' : Number(p.metrics.cls).toFixed(3);
    lines.push(`| ${p.url} | ${p.strategy} | ${p.score} | ${fmtMs(p.metrics.lcp)} | ${fmtMs(p.metrics.tbt)} | ${cls} | ${field} |`);
  }
  lines.push('');
  return lines.join('\n');
}
