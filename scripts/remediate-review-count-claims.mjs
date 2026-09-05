#!/usr/bin/env node
/**
 * Make the store's review-count and "verified" claims true.
 *
 *   node scripts/remediate-review-count-claims.mjs --measure        # count the corpus, decide nothing
 *   node scripts/remediate-review-count-claims.mjs --in <index.json> [--out <file>]
 *   node scripts/remediate-review-count-claims.mjs --pdp [--apply]  # the PDP attribution fix
 *
 * WHY. The homepage claimed "380+ verified reviews · 290+ five-star ratings".
 * Measured against the live Judge.me corpus on 2026-09-05, every part of that
 * was wrong, and the dedupe in PR #781/#783 made it wronger by removing 64
 * duplicate records that had been propping the number up:
 *
 *                            claimed   actual
 *   reviews                     380+      307 published records
 *   five-star                   290+      256 published records
 *   "verified"                  380+       51 (verified-purchase or buyer)
 *
 * `verified` is `nothing` on 333 of 390 records, so the WORD was always the
 * biggest error — bigger than either number. It is dropped rather than
 * re-scoped to 51, because "51 verified reviews" reads as a smaller store than
 * this one is, and the honest count is not the interesting claim anyway.
 *
 * WHICH BASIS, and why not the smaller one. Two defensible counts exist:
 *   record basis  307 / 256  — what the linked Judge.me widget displays
 *   distinct basis 233 / 182 — distinct bodies; 74 records are the same review
 *                              shown under two product titles (left in place by
 *                              the dedupe, deliberately — see #781)
 * The RECORD basis is used because the counter sits directly above a "Read more
 * reviews →" link to that widget, and a claim a visitor can check by clicking
 * should agree with what the click shows. Both figures round DOWN.
 *
 * Note the operator approved "250+" against an earlier, pre-dedupe distinct
 * measurement (252/185). After the dedupe that basis reads 233, so "250+
 * reviews" would have been newly FALSE. 250+ is kept — it is now the five-star
 * figure, where it is true with 6 to spare.
 *
 * THE SECOND CLAIM, on a different surface entirely. Sweeping for the counter
 * turned up `— verified review` as a testimonial ATTRIBUTION in two live
 * product bodies. One is fine and one is not, and only checking the record says
 * which:
 *   coconut-moisturizer  Ella M.     verified: 'buyer'  → order-matched, kept
 *   coconut-lotion       Mike Gray   verified: 'email'  → NOT a purchase
 * The second becomes "customer review", which keeps the proof and drops the
 * unsupported word. The quote itself is untouched.
 *
 * Dry by default everywhere. The template edit prints a diff through
 * update-theme-asset.mjs; the PDP edit backs up the live body first and skips
 * when it matches neither BEFORE nor AFTER.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { isDirectRun } from '../lib/is-direct-run.js';
import { checkSeoCopyFields } from '../lib/seo-copy-health-gate.js';
import { serializeTemplate } from './merge-homepage-soap-cards.mjs';

export const SECTION = 'featured-testimonial';
export const FIELD = 'custom_liquid';

export const COUNTER_BEFORE = '380+ verified reviews · 290+ five-star ratings';
export const COUNTER_AFTER = '300+ reviews · 250+ five-star ratings';

/** What the claim must stay true against. Re-measure before moving either number. */
export const MEASURED = {
  on: '2026-09-05',
  publishedRecords: 307,
  publishedFiveStar: 256,
  distinctBodies: 233,
  distinctFiveStar: 182,
  genuinelyVerified: 51,
};

export const PDP_PLAN = [
  {
    handle: 'coconut-lotion',
    reviewId: 593827114,
    reviewer: 'Mike Gray',
    verified: 'email',
    before: '— verified review',
    after: '— customer review',
    why: "Judge.me `verified: 'email'` is not an order match, so the review is real but not a verified purchase",
  },
];

/** Every number the copy asserts must be <= what was measured. */
export function assertCounterIsTrue(text = COUNTER_AFTER, m = MEASURED) {
  const nums = [...text.matchAll(/(\d[\d,]*)\+/g)].map((x) => Number(x[1].replace(/,/g, '')));
  if (nums.length !== 2) throw new Error(`expected two "N+" figures in ${JSON.stringify(text)}, found ${nums.length}`);
  const [reviews, fiveStar] = nums;
  if (reviews > m.publishedRecords) throw new Error(`claims ${reviews}+ reviews, only ${m.publishedRecords} published`);
  if (fiveStar > m.publishedFiveStar) throw new Error(`claims ${fiveStar}+ five-star, only ${m.publishedFiveStar} published`);
  if (/verified/i.test(text) && reviews > m.genuinelyVerified) {
    throw new Error(`says "verified" of ${reviews}+ when only ${m.genuinelyVerified} are verified`);
  }
  return { reviews, fiveStar };
}

export function applyCounter(template) {
  const next = JSON.parse(JSON.stringify(template));
  const live = next.sections?.[SECTION]?.settings?.[FIELD];
  if (typeof live !== 'string') return { template: next, changed: false, why: 'field not found' };
  if (live.includes(COUNTER_AFTER)) return { template: next, changed: false, why: 'already applied' };
  if (!live.includes(COUNTER_BEFORE)) return { template: next, changed: false, why: 'live markup matches neither BEFORE nor AFTER' };
  next.sections[SECTION].settings[FIELD] = live.split(COUNTER_BEFORE).join(COUNTER_AFTER);
  return { template: next, changed: true, why: null };
}

async function main() {
  const arg = (f) => { const i = process.argv.indexOf(f); return i === -1 ? null : process.argv[i + 1]; };
  const apply = process.argv.includes('--apply');

  assertCounterIsTrue();
  const g = checkSeoCopyFields({ counter: COUNTER_AFTER, ...Object.fromEntries(PDP_PLAN.map((p) => [p.handle, p.after])) });
  if (!g.ok) throw new Error(`copy trips the health gate: ${g.blocking.map((v) => `${v.category}:"${v.match}"`).join(', ')}`);
  console.log(`  ✓ "${COUNTER_AFTER}" is true against the ${MEASURED.on} corpus and passes the health gate`);
  console.log(`    published ${MEASURED.publishedRecords} · five-star ${MEASURED.publishedFiveStar} · genuinely verified ${MEASURED.genuinelyVerified}\n`);

  if (process.argv.includes('--pdp')) {
    const { getProducts, updateProduct } = await import('../lib/shopify.js');
    const products = await getProducts();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dir = join('data/reports/review-count-claims', `run-${stamp}`);
    for (const p of PDP_PLAN) {
      const prod = products.find((x) => x.handle === p.handle);
      if (!prod) { console.log(`  ! ${p.handle}: not found`); continue; }
      const body = prod.body_html || '';
      if (body.includes(p.after) && !body.includes(p.before)) { console.log(`  = ${p.handle}: already applied`); continue; }
      if (!body.includes(p.before)) { console.log(`  = ${p.handle}: live body matches neither BEFORE nor AFTER — skipped`); continue; }
      console.log(`  ${p.handle}: "${p.before}" → "${p.after}"  (review ${p.reviewId}, ${p.reviewer}, verified:'${p.verified}')`);
      if (!apply) continue;
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${p.handle}.before.html`), body);
      await updateProduct(prod.id, { body_html: body.split(p.before).join(p.after) });
      console.log(`    ✓ written; live body backed up to ${dir}`);
    }
    if (!apply) console.log('\nNothing written. Re-run with --apply.');
    return;
  }

  const input = arg('--in');
  const out = arg('--out');
  if (!input) { console.log('Give --in <live index.json> for the counter, or --pdp for the attribution fix.'); return; }
  const { template, changed, why } = applyCounter(JSON.parse(readFileSync(input, 'utf8')));
  console.log(`  - ${COUNTER_BEFORE}\n  + ${COUNTER_AFTER}`);
  if (!changed) { console.log(`\nNothing to do — ${why}.`); return; }
  if (!out) { console.log('\nNothing written. Re-run with --out <file>.'); return; }
  writeFileSync(out, serializeTemplate(template));
  console.log(`\n  wrote ${out}`);
}

if (isDirectRun(import.meta.url)) {
  main().catch((e) => { console.error(`\n${e.message}`); process.exit(1); });
}
