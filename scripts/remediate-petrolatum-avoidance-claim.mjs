#!/usr/bin/env node
/**
 * Cut the unsupported petrolatum/mineral-oil avoidance claim from the live lotion PDP.
 *
 * Dry by default. `--apply` writes. One product, one field, one occurrence.
 *
 * WHY. The Amazon bullet and this PDP both carried "No mineral oil, no petrolatum".
 * Three things are wrong with it and only the first is about compliance:
 *
 *   1. IT IS SOURCED TO ITSELF. agents/ad-studio/claims.js accepts `pdpBody` as a
 *      claim source, so the Amazon copy traced to this PDP line and this PDP line
 *      traces to nothing. A claim that cites our own marketing is not sourced.
 *   2. THE IMPLIED HARM HAS NO BACKING. Cosmetic-grade mineral oil and petrolatum are
 *      assessed safe and non-comedogenic by the CIR panel, the FDA, EU regulators and
 *      Health Canada; Germany's BfR concludes health risks "are not to be expected";
 *      dermal-penetration reviews find they stay in the stratum corneum. The cancer
 *      association belongs to UNREFINED INDUSTRIAL grades, not cosmetic ones. Same
 *      failure mode as the retired EWG "125+ chemicals" angle (see operator-angles).
 *   3. NOBODY SAYS THE WORD. Measured across 3,841 real customer search terms in the
 *      30 days to 2026-09-01: "petrolatum" 0 terms, "dimethicone" 0. Where shoppers
 *      raise the concept at all they use the household word — "silicone" 6, "vaseline"
 *      2, "mineral oil" 2.
 *
 * WHAT IS KEPT, and this is the whole scope decision. "No synthetic fragrance, no
 * parabens" STAYS: both are things customers actually search ("paraben" 3 terms/3
 * clicks) and both are ordinary absence claims about ingredients this formula genuinely
 * omits. The edit removes the two terms with no evidence and no audience, not the
 * sentence.
 *
 * DELIBERATELY OUT OF SCOPE — 4 theme landing-page templates and 6 generator scripts
 * also carry these words, and they are NOT swept here because they are not all the
 * same claim. Three distinct shapes live in that copy:
 *   · bare avoidance ("No mineral oil, no petrolatum") — same defect as this one
 *   · MECHANISTIC CONTRAST ("beeswax breathes without sealing pores the way petrolatum
 *     does", "where petrolatum sits on top, coconut oil absorbs") — this is a factual
 *     formulation comparison, petrolatum IS occlusive, and it is defensible. Cutting it
 *     would be the over-correction.
 *   · IRRITANT framing ("No common irritants. No mineral oil, petrolatum, dimethicone")
 *     — the strongest version and the least supportable, since the evidence says these
 *     are well tolerated.
 * Sorting those needs a per-string judgement pass and a live-ness check (theme/ is a
 * partial mirror and is not auto-deployed), so it is its own change.
 *
 * Usage:
 *   node scripts/remediate-petrolatum-avoidance-claim.mjs           # dry run
 *   node scripts/remediate-petrolatum-avoidance-claim.mjs --apply
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkSeoCopy } from '../lib/seo-copy-health-gate.js';
import { isDirectRun } from '../lib/is-direct-run.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'data', 'reports', 'petrolatum-claim-remediation');

/**
 * A fixed, hand-reviewed plan — never a pattern sweep. Same shape as
 * scripts/remediate-live-health-claims.js: literal BEFORE, literal AFTER, an asserted
 * occurrence count, and a written reason.
 */
export const PLAN = [
  {
    id: 'lotion-pdp-six-ingredients',
    handle: 'coconut-lotion',
    productId: 7691181686954,
    field: 'body_html',
    expectedOccurrences: 1,
    before: 'Built on coconut oil, jojoba and red palm oil. No mineral oil, no petrolatum, no synthetic fragrance, no parabens.',
    after: 'Built on coconut oil, jojoba and red palm oil. No synthetic fragrance, no parabens.',
    reason:
      'Removes the two avoidance terms that are unsourced, unsupported by any regulator, '
      + 'and searched by nobody. Keeps the two the formula genuinely omits and customers '
      + 'do search.',
  },
];

export function occurrences(haystack, needle) {
  if (!needle) return 0;
  let n = 0, i = 0;
  for (;;) {
    const at = haystack.indexOf(needle, i);
    if (at === -1) return n;
    n++; i = at + needle.length;
  }
}

/**
 * Decide what to do with one entry against the live value.
 *
 * The `skip` branch is the guard that matters: when live matches NEITHER before nor
 * after, somebody has edited the copy since this plan was written and blind replacement
 * would clobber their work. That guard has already earned itself once in this repo,
 * catching a transcribed U+00A0 in a health-claim plan.
 */
export function decideEntry(entry, liveValue) {
  if (typeof liveValue !== 'string') {
    return { action: 'skip', why: 'live value missing or not a string' };
  }
  const hasBefore = occurrences(liveValue, entry.before);
  const hasAfter = occurrences(liveValue, entry.after);
  if (hasBefore === 0 && hasAfter > 0) {
    return { action: 'already-applied', why: 'live already carries the AFTER text' };
  }
  if (hasBefore === 0) {
    return { action: 'skip', why: 'live matches neither BEFORE nor AFTER — copy has moved since this plan was written' };
  }
  if (hasBefore !== entry.expectedOccurrences) {
    return {
      action: 'skip',
      why: `expected ${entry.expectedOccurrences} occurrence(s) of BEFORE, found ${hasBefore}`,
    };
  }
  return { action: 'apply', why: `replacing ${hasBefore} occurrence(s)`, next: liveValue.split(entry.before).join(entry.after) };
}

export async function main({ shopify } = {}) {
  const apply = process.argv.includes('--apply');
  const api = shopify ?? await import('../lib/shopify.js');

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const results = [];

  for (const entry of PLAN) {
    // Every AFTER is re-gated at RUN time, not just when the plan was written — this
    // path writes live commercial copy and there is no prompt to regenerate from, the
    // same reason lib/queue-apply.js refuses rather than dismisses.
    const gate = checkSeoCopy({ meta: entry.after });
    if (!gate.ok) {
      throw new Error(`ABORT — entry ${entry.id} AFTER text fails the health gate: `
        + JSON.stringify(gate.blocking));
    }

    const product = await api.getProduct(entry.productId);
    const live = product?.[entry.field];
    const decision = decideEntry(entry, live);
    results.push({ id: entry.id, handle: entry.handle, ...decision, before_value: live });

    console.log(`\n${entry.id} — ${decision.action.toUpperCase()}: ${decision.why}`);
    if (decision.action !== 'apply') continue;

    console.log(`  - ${entry.before}`);
    console.log(`  + ${entry.after}`);
    if (!apply) { console.log('  (dry run — pass --apply to write)'); continue; }

    // Backup BEFORE the write, always. The run record is the restore path.
    mkdirSync(join(OUT_DIR, 'backups', stamp), { recursive: true });
    writeFileSync(join(OUT_DIR, 'backups', stamp, `${entry.handle}.${entry.field}.html`), live);

    await api.updateProduct(entry.productId, { [entry.field]: decision.next });
    console.log('  ✓ written to Shopify');
  }

  mkdirSync(OUT_DIR, { recursive: true });
  const record = { generated_at: new Date().toISOString(), applied: apply, results };
  writeFileSync(join(OUT_DIR, `run-${stamp}.json`), JSON.stringify(record, null, 2));
  console.log(`\nRun record: ${join(OUT_DIR, `run-${stamp}.json`)}`);
  return record;
}

if (isDirectRun(import.meta.url)) {
  main().catch((err) => { console.error(err.message); process.exit(1); });
}
