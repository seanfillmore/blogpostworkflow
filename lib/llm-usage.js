// lib/llm-usage.js
//
// Token + cost metering for every Anthropic API call across the fleet. Wired in
// via lib/anthropic.js (a logging subclass) so no call site changes. Writes one
// JSONL line per call to data/reports/llm-usage/YYYY-MM-DD.jsonl — the data we
// were missing entirely (the fleet ran with zero cost visibility).
//
// Cost is an ESTIMATE for relative attribution, not a billing-exact figure.
// Prices are USD per 1M tokens; update PRICING when Anthropic pricing changes.

import { appendFileSync, mkdirSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const USAGE_DIR = join(__dirname, '..', 'data', 'reports', 'llm-usage');

// USD per 1M tokens. Matched by model-name prefix (after the family token).
// cacheWrite = 1.25× input, cacheRead = 0.1× input (Anthropic prompt caching).
const PRICING = {
  opus:   { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 },
  sonnet: { input: 3,  output: 15, cacheWrite: 3.75,  cacheRead: 0.3 },
  haiku:  { input: 1,  output: 5,  cacheWrite: 1.25,  cacheRead: 0.1 },
};

export function priceFor(model) {
  const m = String(model || '').toLowerCase();
  if (m.includes('opus')) return PRICING.opus;
  if (m.includes('haiku')) return PRICING.haiku;
  return PRICING.sonnet; // default/unknown → sonnet rates
}

/**
 * Estimate the USD cost of one Anthropic call from its usage block.
 * @param {string} model
 * @param {{input_tokens?:number, output_tokens?:number, cache_creation_input_tokens?:number, cache_read_input_tokens?:number}} usage
 * @returns {number} USD (rounded to 6 dp)
 */
export function estimateCost(model, usage = {}) {
  const p = priceFor(model);
  const inTok = usage.input_tokens || 0;
  const outTok = usage.output_tokens || 0;
  const cWrite = usage.cache_creation_input_tokens || 0;
  const cRead = usage.cache_read_input_tokens || 0;
  const cost = (inTok * p.input + outTok * p.output + cWrite * p.cacheWrite + cRead * p.cacheRead) / 1e6;
  return Math.round(cost * 1e6) / 1e6;
}

// Identify the calling agent. Agents run as their own process
// (node agents/<name>/index.js), but some import others in-process — so prefer
// the deepest agents/<name>/ frame in the stack, falling back to argv.
export function detectAgent() {
  try {
    const stack = new Error().stack || '';
    const matches = [...stack.matchAll(/\/agents\/([^/]+)\//g)].map((m) => m[1]);
    if (matches.length) return matches[matches.length - 1];
  } catch { /* ignore */ }
  try {
    const argv = process.argv[1] || '';
    const m = argv.match(/\/agents\/([^/]+)\//);
    if (m) return m[1];
    return argv.split('/').pop() || 'unknown';
  } catch { return 'unknown'; }
}

/**
 * Append one usage record. Best-effort: never throws into the caller's flow.
 * @param {{model:string, usage:object, agent?:string, ts?:string}} rec
 */
export function logUsage({ model, usage, agent, ts } = {}) {
  try {
    const stamp = ts || new Date().toISOString();
    const line = {
      ts: stamp,
      agent: agent || detectAgent(),
      model: model || 'unknown',
      input_tokens: usage?.input_tokens || 0,
      output_tokens: usage?.output_tokens || 0,
      cache_read_tokens: usage?.cache_read_input_tokens || 0,
      cache_write_tokens: usage?.cache_creation_input_tokens || 0,
      est_cost_usd: estimateCost(model, usage || {}),
    };
    mkdirSync(USAGE_DIR, { recursive: true });
    appendFileSync(join(USAGE_DIR, `${stamp.slice(0, 10)}.jsonl`), JSON.stringify(line) + '\n');
  } catch { /* metering must never break an agent */ }
}

/**
 * Aggregate a day's usage JSONL into per-agent and per-model breakdowns.
 * Pure given `lines` — pass parsed records (testable without disk).
 */
export function summarizeRecords(records = []) {
  const byAgent = {};
  const byModel = {};
  let totalCost = 0, totalCalls = 0, totalIn = 0, totalOut = 0;
  for (const r of records) {
    totalCost += r.est_cost_usd || 0; totalCalls++;
    totalIn += r.input_tokens || 0; totalOut += r.output_tokens || 0;
    (byAgent[r.agent] ||= { calls: 0, cost: 0 }).calls++;
    byAgent[r.agent].cost += r.est_cost_usd || 0;
    (byModel[r.model] ||= { calls: 0, cost: 0 }).calls++;
    byModel[r.model].cost += r.est_cost_usd || 0;
  }
  const rank = (o) => Object.entries(o).map(([k, v]) => ({ key: k, ...v, cost: Math.round(v.cost * 1e4) / 1e4 })).sort((a, b) => b.cost - a.cost);
  return {
    totalCost: Math.round(totalCost * 1e4) / 1e4,
    totalCalls, totalInputTokens: totalIn, totalOutputTokens: totalOut,
    byAgent: rank(byAgent), byModel: rank(byModel),
  };
}

export function readUsage(dateStr) {
  const path = join(USAGE_DIR, `${dateStr}.jsonl`);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

export function listUsageDates() {
  try { return readdirSync(USAGE_DIR).filter((f) => f.endsWith('.jsonl')).map((f) => f.replace('.jsonl', '')).sort(); }
  catch { return []; }
}
