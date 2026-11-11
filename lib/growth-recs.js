// lib/growth-recs.js
//
// The "How to grow" section of Sean's daily email: 3-5 concrete, revenue-ranked
// recommendations built ONLY from data the fleet already holds.
//
// Why it is gated in code rather than trusted to the prompt: a model asked for
// growth ideas invents plausible numbers. Every number quoted in `evidence`
// must therefore appear in the exact JSON that was sent to the model, and
// `move` + `evidence` go through the commercial claim gate (a cosmetic brand
// may not say a product treats anything). Dollar figures are the model's own
// directional estimates, so they are not number-checked, only sanity-checked.
//
// Stale inputs are omitted and named in `inputs.missing`, never quietly used:
// a recommendation built on a three-week-old report reads as current.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import Anthropic from './anthropic.js';
import { LLM_MODELS } from '../config/llm-models.js';
import { AOV_TRAILING_90D, SHOPIFY_MONTHLY_REVENUE } from './business-baseline.js';
import { loadClusterHold } from './cluster-hold.js';
import { rankClusters } from './cluster-efficiency.js';
import { checkSeoCopyFields } from './seo-copy-health-gate.js';
import { seoImpactPath, freshnessOfFile, isFresh } from './seo-impact-freshness.js';

export const MAX_AGE_DAYS = 9;
const TOP_ROWS = 10;
const DAY_MS = 86_400_000;

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

/** Fresh = `generated_at` (when present) else file mtime, under MAX_AGE_DAYS. */
function freshFile(path, now) {
  if (!existsSync(path)) return { ok: false, reason: 'missing' };
  const data = readJson(path);
  if (data == null) return { ok: false, reason: 'unreadable' };
  const stamp = data.generated_at ? Date.parse(data.generated_at) : NaN;
  const t = Number.isFinite(stamp) ? stamp : statSync(path).mtimeMs;
  const age = (now - t) / DAY_MS;
  if (age > MAX_AGE_DAYS) return { ok: false, reason: `stale (${Math.floor(age)} days old)` };
  return { ok: true, data };
}

const top = (v, n = TOP_ROWS) => (Array.isArray(v) ? v.slice(0, n) : v);

function summariseSeoImpact(r) {
  return {
    generated_at: r.generated_at,
    window: r.window,
    totals: r.totals,
    clusters: top(r.clusters, 12),
    not_converting: top(r.not_converting),
    top_revenue: top(r.top_revenue),
    top_growth: top(r.top_growth),
  };
}

function summariseRows(r) {
  const out = { generated_at: r.generated_at };
  for (const [k, v] of Object.entries(r)) {
    if (k === 'generated_at') continue;
    out[k] = Array.isArray(v) ? v.slice(0, TOP_ROWS) : v;
  }
  return out;
}

const ADS_DAYS = 7;
const sum = (rows, k) => Math.round(rows.reduce((t, r) => t + (Number(r[k]) || 0), 0) * 100) / 100;

/** Sum the last 7 days of snapshots, chosen by each snapshot's own `date`, never by mtime. */
function summariseAds(dir, now) {
  if (!existsSync(dir)) return { ok: false, reason: 'missing' };
  const snaps = readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => readJson(join(dir, f)))
    .filter((d) => d && /^\d{4}-\d{2}-\d{2}$/.test(d.date || ''));
  if (!snaps.length) return { ok: false, reason: 'missing' };
  snaps.sort((a, b) => a.date.localeCompare(b.date));
  const newest = snaps[snaps.length - 1];
  const age = (now - Date.parse(newest.date)) / DAY_MS;
  if (age > MAX_AGE_DAYS) return { ok: false, reason: `stale (${Math.floor(age)} days old)` };
  const cutoff = Date.parse(newest.date) - (ADS_DAYS - 1) * DAY_MS;
  const win = snaps.filter((d) => Date.parse(d.date) >= cutoff);
  const campaigns = [...(newest.campaigns || [])].sort((a, b) => (b.spend || 0) - (a.spend || 0)).slice(0, 5)
    .map((c) => ({ name: c.name, status: c.status, spend: c.spend, clicks: c.clicks, conversions: c.conversions, revenue: c.revenue }));
  return {
    ok: true,
    data: {
      window: `${win.length} days ending ${newest.date}`,
      days: win.length,
      spend: sum(win, 'spend'), clicks: sum(win, 'clicks'), conversions: sum(win, 'conversions'), revenue: sum(win, 'revenue'),
      top_campaigns: campaigns,
      top_campaigns_period: `newest day only (${newest.date})`,
    },
  };
}

/**
 * Gather compact, fresh inputs. Missing or stale sources are listed in
 * `inputs.missing` as { source, reason }.
 */
export function gatherGrowthInputs(root, { now = Date.now() } = {}) {
  const inputs = { aov_trailing_90d: AOV_TRAILING_90D, missing: [] };

  const seoPath = seoImpactPath(root);
  if (!existsSync(seoPath)) inputs.missing.push({ source: 'seo-impact', reason: 'missing' });
  else {
    const f = freshnessOfFile(seoPath);
    const data = isFresh(f) ? readJson(seoPath) : null;
    if (data) inputs.seo_impact = summariseSeoImpact(data);
    else inputs.missing.push({ source: 'seo-impact', reason: isFresh(f) ? 'unreadable' : `stale or missing (${f.status})` });
  }

  const simple = [
    ['quick_wins', 'data/reports/quick-wins/latest.json'],
    ['gsc_opportunity', 'data/reports/gsc-opportunity/latest.json'],
    ['ctr_program', 'data/reports/ctr-program/wave.json'],
  ];
  for (const [key, rel] of simple) {
    const f = freshFile(join(root, rel), now);
    if (f.ok) inputs[key] = summariseRows(f.data);
    else inputs.missing.push({ source: key, reason: f.reason });
  }

  const ads = summariseAds(join(root, 'data', 'snapshots', 'google-ads'), now);
  if (ads.ok) inputs.google_ads = ads.data;
  else inputs.missing.push({ source: 'google_ads', reason: ads.reason });

  // Cluster efficiency: what each category SOLD per organic click. Computed by
  // the same loader the fleet's pick lists use, so it shares their staleness rule.
  try {
    const ranking = rankClusters(loadClusterHold({ root }));
    if (ranking.available) {
      inputs.cluster_efficiency = {
        window: ranking.judgingWindow ? `product revenue over the judging window, clicks over the report window (generated ${String(ranking.generatedAt).slice(0, 10)})` : 'report window',
        ranking: ranking.ordered.map((c) => ({ rank: c.rank + 1, cluster: c.cluster, product_revenue: c.productRevenue, clicks: c.clicks })),
      };
    } else inputs.missing.push({ source: 'cluster_efficiency', reason: ranking.reason });
  } catch (e) {
    inputs.missing.push({ source: 'cluster_efficiency', reason: `unreadable (${e.message})` });
  }

  // lib/commercial-cvr.js aggregates GA4 and order rows; getting them needs
  // network reads, which this gatherer deliberately does not make.
  inputs.missing.push({ source: 'commercial_cvr', reason: 'not computed: needs GA4 network read' });
  return inputs;
}

const NUM_RE = /\$?\d[\d,]*(?:\.\d+)?%?/g;
const DATE_RE = /\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z?)?/g;
const normNum = (s) => {
  const n = Number(s.replace(/[$,%]/g, '').replace(/,/g, ''));
  return Number.isFinite(n) ? String(n) : null;
};
export function extractNumbers(text) {
  return [...String(text || '').replace(DATE_RE, ' ').matchAll(NUM_RE)].map((m) => normNum(m[0])).filter((x) => x !== null);
}

const SKIP_KEY = /^(generated_at|date|id)$|(_at|Id|ResourceName|resourceName)$/;

/** Numbers that are real figures in the inputs: no timestamps, dates, ids or resource names. */
export function knownNumbers(inputs) {
  const known = new Set();
  const walk = (v, key) => {
    if (key && SKIP_KEY.test(key)) return;
    if (typeof v === 'number') { if (Number.isFinite(v)) known.add(String(v)); }
    else if (typeof v === 'string') { if (!/^\d{4}-\d{2}-\d{2}/.test(v)) for (const n of extractNumbers(v)) known.add(n); }
    else if (Array.isArray(v)) v.forEach((x) => walk(x, key));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, k);
  };
  walk(inputs, null);
  return known;
}

export const MAX_DOLLARS = SHOPIFY_MONTHLY_REVENUE * 10;

/** Problems with one rec; empty array means it may ship. */
export function growthRecProblems(rec, inputsText, inputsObj) {
  const problems = [];
  if (!rec || typeof rec !== 'object') return ['not an object'];
  if (typeof rec.move !== 'string' || !rec.move.trim()) problems.push('move is empty');
  if (typeof rec.evidence !== 'string' || !rec.evidence.trim()) problems.push('evidence is empty');
  if (!['agent-doing', 'needs-decision'].includes(rec.status)) problems.push('status must be agent-doing or needs-decision');
  if (!Number.isFinite(rec.dollars_low) || !Number.isFinite(rec.dollars_high) || rec.dollars_low < 0
    || rec.dollars_low > rec.dollars_high || rec.dollars_high > MAX_DOLLARS) {
    problems.push(`dollars_low and dollars_high must be finite, 0 <= low <= high <= ${MAX_DOLLARS}`);
  }
  const text = `${rec.move || ''} ${rec.evidence || ''}`;
  if (text.includes('\u2014')) problems.push('contains an em dash');
  let obj = inputsObj;
  if (obj === undefined) { try { obj = JSON.parse(inputsText); } catch { obj = {}; } }
  const known = knownNumbers(obj);
  for (const field of ['move', 'evidence']) {
    const t = String(rec[field] || '').replace(DATE_RE, ' ');
    for (const raw of t.matchAll(NUM_RE)) {
      const n = normNum(raw[0]);
      if (n !== null && !known.has(n)) problems.push(`number ${raw[0]} in ${field} does not appear in the inputs`);
    }
  }
  const gate = checkSeoCopyFields({ move: rec.move, evidence: rec.evidence });
  for (const b of gate.blocking) problems.push(`claim gate (${b.field}): ${b.category} "${b.match}"`);
  return problems;
}

export const GROWTH_PROMPT = `You write the "How to grow" section of a daily email to the owner of Real Skin Care, a natural deodorant, body care, oral care and lip balm brand on Shopify (realskincare.com).

PRIME DIRECTIVE: the goal is Shopify revenue. SEO is only the means. Traffic that does not convert is not a win. Rank every recommendation by expected revenue, and prefer fixing pages that already earn traffic (CTR, conversion path) over creating new pages. A collection exists only where a category holds 2 or more products.

Brand rules you must follow: we sell a deodorant, never an "antiperspirant". Never make whitening claims for our toothpaste. Never claim a product treats, heals, cures or prevents any condition.

Return 3 to 5 recommendations as a JSON array and nothing else. Each element:
{"move": "<one concrete action>", "evidence": "<one or two sentences citing numbers copied exactly from the INPUTS>", "dollars_low": <number>, "dollars_high": <number>, "status": "agent-doing" | "needs-decision"}

Rules:
- Every number in "move" and "evidence" must appear in the INPUTS exactly. Do not compute new numbers.
- Each input names its own period (its "window" or generated_at). The windows differ between inputs, so "evidence" must name the period of any figure it quotes (for example "over the 7 days ending 2026-11-10"). Never present a one-day figure as a weekly one.
- dollars_low and dollars_high are a DIRECTIONAL monthly revenue range (estimates, not forecasts), low <= high.
- status is "agent-doing" if an existing agent in the fleet already does this move (say which in the move), else "needs-decision".
- No em dashes. Plain sentences.`;

function parseRecs(text) {
  const cleaned = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    const v = JSON.parse(cleaned);
    return Array.isArray(v) ? v : null;
  } catch { return null; }
}

async function ask(client, userText) {
  const res = await client.messages.create({
    model: LLM_MODELS.flagship,
    max_tokens: 4000,
    system: GROWTH_PROMPT,
    messages: [{ role: 'user', content: userText }],
  });
  if (res?.stop_reason === 'max_tokens') return null;
  const text = (res?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
  return parseRecs(text);
}

/**
 * @returns {Promise<{recs: object[], dropped: {rec:any, reason:string}[], reason?: string}>}
 */
export async function generateGrowthRecs({ inputs, client } = {}) {
  client = client || new Anthropic();
  const inputsText = JSON.stringify(inputs);
  const base = `INPUTS:\n${inputsText}`;
  const dropped = [];

  let recs = await ask(client, base);
  if (!recs) {
    recs = await ask(client, `${base}\n\nYour previous reply was not a valid, complete JSON array. Reply with only the JSON array.`);
    if (!recs) return { recs: [], dropped, reason: 'model reply was not valid JSON after one retry' };
  }

  let good = [];
  let bad = [];
  const sort = (list) => {
    for (const rec of list) {
      const problems = growthRecProblems(rec, inputsText, inputs);
      (problems.length ? bad : good).push(problems.length ? { rec, problems } : rec);
    }
  };
  sort(recs);

  if (bad.length) {
    const named = bad.map((b, i) => `${i + 1}. "${b.rec?.move ?? ''}": ${b.problems.join('; ')}`).join('\n');
    const retry = await ask(client, `${base}\n\nThese recommendations failed checks:\n${named}\nReturn a corrected JSON array of 3 to 5 recommendations.`);
    const firstBad = bad;
    const keep = good;
    bad = [];
    const fixedIdx = new Set();
    if (retry) {
      good = [];
      sort(retry);
      retry.forEach((r, i) => { if (good.includes(r)) fixedIdx.add(i); });
      const seen = new Set(good.map((r) => r.move));
      for (const r of keep) if (!seen.has(r.move)) good.push(r);
    } else good = keep;
    // First-pass problems are always reported; `fixed_on_retry` says whether the
    // same slot passed on the second attempt.
    for (const b of firstBad) {
      const idx = recs.indexOf(b.rec);
      dropped.push({ rec: b.rec, reason: b.problems.join('; '), ...(fixedIdx.has(idx) ? { fixed_on_retry: true } : {}) });
    }
    for (const b of bad) dropped.push({ rec: b.rec, reason: b.problems.join('; ') });
  }

  if (good.length < 2) {
    return { recs: [], dropped, reason: `only ${good.length} recommendation(s) passed the checks` };
  }
  return { recs: good.slice(0, 5), dropped };
}
