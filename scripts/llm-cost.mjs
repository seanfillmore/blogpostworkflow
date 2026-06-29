#!/usr/bin/env node
// LLM cost report. Reads data/reports/llm-usage/*.jsonl and prints per-agent +
// per-model spend. Usage:
//   node scripts/llm-cost.mjs            # today
//   node scripts/llm-cost.mjs 2026-06-29 # a specific day
//   node scripts/llm-cost.mjs --week     # last 7 days combined + daily totals
import { readUsage, listUsageDates, summarizeRecords } from '../lib/llm-usage.js';

const arg = process.argv[2];
let dates;
if (arg === '--week') dates = listUsageDates().slice(-7);
else if (arg && /^\d{4}-\d{2}-\d{2}$/.test(arg)) dates = [arg];
else dates = [new Date().toISOString().slice(0, 10)];

const records = dates.flatMap((d) => readUsage(d));
if (!records.length) {
  console.log(`No usage recorded for ${dates.join(', ')}. (Metering may not have run yet.)`);
  process.exit(0);
}

const s = summarizeRecords(records);
const usd = (n) => '$' + n.toFixed(2);

console.log(`\nLLM cost — ${dates[0]}${dates.length > 1 ? ` … ${dates[dates.length - 1]}` : ''}`);
console.log('='.repeat(52));
console.log(`Total: ${usd(s.totalCost)}  |  ${s.totalCalls} calls  |  ${(s.totalInputTokens / 1e6).toFixed(2)}M in / ${(s.totalOutputTokens / 1e6).toFixed(2)}M out`);

console.log('\nBy model:');
for (const m of s.byModel) console.log(`  ${usd(m.cost).padStart(9)}  ${String(m.calls).padStart(5)} calls  ${m.key}`);

console.log('\nBy agent (top 15):');
for (const a of s.byAgent.slice(0, 15)) console.log(`  ${usd(a.cost).padStart(9)}  ${String(a.calls).padStart(5)} calls  ${a.key}`);

if (dates.length > 1) {
  console.log('\nDaily totals:');
  for (const d of dates) {
    const day = summarizeRecords(readUsage(d));
    console.log(`  ${d}  ${usd(day.totalCost).padStart(9)}  (${day.totalCalls} calls)`);
  }
  const avg = s.totalCost / dates.length;
  console.log(`\n  Projected weekly run-rate: ${usd(avg * 7)} (avg ${usd(avg)}/day)`);
}
console.log('');
