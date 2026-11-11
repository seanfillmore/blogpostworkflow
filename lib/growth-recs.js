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
import { AOV_TRAILING_90D } from './business-baseline.js';
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
    efficiency: r.efficiency ? top(r.efficiency.ranking || r.efficiency, 12) : undefined,
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

function newestJson(dir) {
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  return files.length ? join(dir, files[files.length - 1]) : null;
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

  const adsPath = newestJson(join(root, 'data', 'snapshots', 'google-ads'));
  if (!adsPath) inputs.missing.push({ source: 'google_ads', reason: 'missing' });
  else {
    const age = (now - statSync(adsPath).mtimeMs) / DAY_MS;
    const data = readJson(adsPath);
    if (age > MAX_AGE_DAYS) inputs.missing.push({ source: 'google_ads', reason: `stale (${Math.floor(age)} days old)` });
    else if (!data) inputs.missing.push({ source: 'google_ads', reason: 'unreadable' });
    else inputs.google_ads = summariseRows(data);
  }

  // lib/commercial-cvr.js aggregates GA4 and order rows; getting them needs
  // network reads, which this gatherer deliberately does not make.
  inputs.missing.push({ source: 'commercial_cvr', reason: 'not computed' });
  return inputs;
}

const NUM_RE = /\$?\d[\d,]*(?:\.\d+)?%?/g;
const normNum = (s) => {
  const n = Number(s.replace(/[$,%]/g, '').replace(/,/g, ''));
  return Number.isFinite(n) ? String(n) : null;
};
export function extractNumbers(text) {
  return [...String(text || '').matchAll(NUM_RE)].map((m) => normNum(m[0])).filter((x) => x !== null);
}

/** Problems with one rec; empty array means it may ship. */
export function growthRecProblems(rec, inputsText) {
  const problems = [];
  if (!rec || typeof rec !== 'object') return ['not an object'];
  if (typeof rec.move !== 'string' || !rec.move.trim()) problems.push('move is empty');
  if (typeof rec.evidence !== 'string' || !rec.evidence.trim()) problems.push('evidence is empty');
  if (!['agent-doing', 'needs-decision'].includes(rec.status)) problems.push('status must be agent-doing or needs-decision');
  if (!Number.isFinite(rec.dollars_low) || !Number.isFinite(rec.dollars_high) || rec.dollars_low > rec.dollars_high) {
    problems.push('dollars_low and dollars_high must be finite numbers with low <= high');
  }
  const text = `${rec.move || ''} ${rec.evidence || ''}`;
  if (text.includes('—')) problems.push('contains an em dash');
  const known = new Set(extractNumbers(inputsText));
  for (const raw of String(rec.evidence || '').matchAll(NUM_RE)) {
    const n = normNum(raw[0]);
    if (n !== null && !known.has(n)) problems.push(`number ${raw[0]} in evidence does not appear in the inputs`);
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
- Every number in "evidence" must appear in the INPUTS. Do not compute new numbers there.
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
      const problems = growthRecProblems(rec, inputsText);
      (problems.length ? bad : good).push(problems.length ? { rec, problems } : rec);
    }
  };
  sort(recs);

  if (bad.length) {
    const named = bad.map((b, i) => `${i + 1}. "${b.rec?.move ?? ''}": ${b.problems.join('; ')}`).join('\n');
    const retry = await ask(client, `${base}\n\nThese recommendations failed checks:\n${named}\nReturn a corrected JSON array of 3 to 5 recommendations.`);
    const firstBad = bad;
    bad = [];
    if (retry) {
      const keep = good;
      good = [];
      sort(retry);
      // Keep first-pass survivors too, de-duplicated by move.
      const seen = new Set(good.map((r) => r.move));
      for (const r of keep) if (!seen.has(r.move)) good.push(r);
    } else bad = firstBad;
    for (const b of bad) dropped.push({ rec: b.rec, reason: b.problems.join('; ') });
  }

  if (good.length < 2) {
    return { recs: [], dropped, reason: `only ${good.length} recommendation(s) passed the checks` };
  }
  return { recs: good.slice(0, 5), dropped };
}
