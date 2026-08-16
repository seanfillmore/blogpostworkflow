#!/usr/bin/env node
/**
 * Enforce the data/creatives/ disk budget.
 *
 * The Ad Studio agent sweeps at the end of every run, so this script exists for the two
 * cases the agent cannot cover: the Creatives TAB fills the same directory and never calls
 * the agent, and a box can drift over budget while nobody runs anything at all. Scheduled
 * on the server; safe to run by hand.
 *
 * DRY RUN BY DEFAULT — pass --apply to delete. Same posture as prune-ad-studio.mjs, and the
 * same reason: the cheapest action is the one you get by accident.
 *
 * Usage:
 *   node scripts/creatives-budget.mjs [--apply] [--budget-gb N] [--dir <path>]
 *   npm run creatives-budget -- --apply
 */
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  enforceBudget, planPurge, formatBytes, resolveBudgetBytes,
} from '../lib/creatives-budget.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i === -1 ? undefined : argv[i + 1]; };

const apply = argv.includes('--apply');
const gb = flag('--budget-gb');
const budgetBytes = gb === undefined ? resolveBudgetBytes() : Number(gb) * 1024 * 1024 * 1024;
const creativesDir = flag('--dir') || join(ROOT, 'data', 'creatives');

if (!Number.isFinite(budgetBytes) || budgetBytes <= 0) {
  console.error(`creatives-budget: --budget-gb must be a positive number (got ${gb})`);
  process.exit(1);
}

const plan = planPurge({ creativesDir, budgetBytes });
console.log(`Creatives disk budget — ${apply ? 'APPLY (deleting)' : 'DRY RUN (pass --apply to delete)'}`);
console.log(`  ${creativesDir}`);
console.log(`  using ${formatBytes(plan.totalBytes)} of ${formatBytes(plan.budgetBytes)}`);

if (plan.underBudget && !plan.deletions.length) {
  console.log('  under budget — nothing to do.');
  process.exit(0);
}

const byTier = plan.deletions.reduce((m, d) => { (m[d.tier] ||= []).push(d); return m; }, {});
const TIER_LABEL = {
  1: 'rejected Ad Studio frames past their grace period',
  2: 'Ad Studio images from old runs',
  3: 'idle Creatives-tab session images',
};
for (const tier of Object.keys(byTier).sort()) {
  const files = byTier[tier];
  const bytes = files.reduce((n, f) => n + f.bytes, 0);
  console.log(`  tier ${tier} — ${TIER_LABEL[tier]}: ${files.length} file(s), ${formatBytes(bytes)}`);
}
console.log(`  would free ${formatBytes(plan.freedBytes)}, leaving ${formatBytes(plan.wouldRemain)}`);
if (!plan.underBudget) {
  console.warn('  STILL OVER after everything eligible — raise the budget or widen the windows.');
}

if (apply) {
  const res = enforceBudget({ creativesDir, budgetBytes, apply: true });
  console.log(`  deleted ${res.deletions.length} file(s), freed ${formatBytes(res.freedBytes)}.`);
}
