#!/usr/bin/env node
/**
 * Remove the "outlasts tallow bars at twice the price" comparison from the live
 * bar-soap PDP body.
 *
 * WHY
 * ---
 * It is a price-anchored superiority claim about a competitor product class that
 * we hold no substantiation for. No copy gate touches it — it carries no disease
 * name, no therapeutic verb and no drug reference, so `health-claims.js` and
 * `product-category-terms.js` both pass it. It is an advertising-substantiation
 * problem, not a health-claim one, which is exactly why it needed a human call.
 * Sean's call, 2026-09-03: cut it.
 *
 * WHY THE PDP AND NOT JUST THE SHOT BOOK
 * --------------------------------------
 * `agents/ad-studio/claims.js` holds `pdp` as one of its four claim SOURCES, so
 * an unsubstantiated line sitting in a live product body is not inert copy — it
 * is sourceable evidence that lets a future generated ad make the same claim and
 * pass the sourcing gate. Same lesson as PR #771 (`founder-narrative.md`): gate
 * the inputs, not only the outputs.
 *
 * SCOPE — three surfaces, two of them NOT handled here
 * ---------------------------------------------------
 *   1. THIS SCRIPT: `product.body_html` on /products/coconut-soap. Shopify
 *      renders it into the PDP description AND mirrors it into the page's
 *      JSON-LD Product node and the Zipify OCU cart metafield, so fixing the
 *      body fixes all three at once.
 *   2. Committed alongside: `theme/templates/product.landing-page-bar-soap.json`
 *      carries the claim ONCE, in the "How long does the bar last?" FAQ row, and
 *      that template is what /products/coconut-soap actually renders through.
 *      **`git pull` does NOT deploy `theme/`** — that edit needs a theme push
 *      (`shopify theme push --only=templates/product.landing-page-bar-soap.json`)
 *      and until it lands, the claim still renders on the live page even though
 *      the product body is clean. Verified by fetching the page after this ran.
 *   3. Committed alongside: `data/brand/cluster-povs.md`, a copy-input file. This
 *      is the propagation source — leave it and the claim reappears in generated
 *      copy regardless of what the live page says.
 *
 * DELIBERATELY NOT CUT
 * --------------------
 * "A coconut bar is harder than tallow-based commercial bars and lasts longer in
 * a wet shower if drained between uses" survives on all three surfaces. It is a
 * different claim — a physical durability statement with no price anchor — and it
 * was not what was flagged or what Sean ruled on. Cutting it silently alongside
 * would be deciding something nobody asked for. Flagged, not actioned.
 *
 * USAGE
 *   node scripts/remediate-tallow-price-comparison.mjs           # dry run
 *   node scripts/remediate-tallow-price-comparison.mjs --apply   # write to Shopify
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getProducts, updateProduct } from '../lib/shopify.js';
import { checkSeoCopy } from '../lib/seo-copy-health-gate.js';

const APPLY = process.argv.includes('--apply');
const BACKUP_DIR = 'data/reports/tallow-claim-remediation/backups';

export const PLAN = [
  {
    id: 'coconut-soap-body-drainage-line',
    handle: 'coconut-soap',
    field: 'body_html',
    expectedOccurrences: 1,
    before:
      'Drain it between uses. A coconut bar on a dry surface outlasts tallow bars at twice the price.',
    after:
      'Drain it between uses. A bar left sitting in water disappears fast; the same bar on a draining dish lasts considerably longer.',
    reason:
      'Price-anchored superiority claim against a competitor product class, unsubstantiated. The replacement keeps the whole point — drainage is the variable — as a comparison of our own bar against itself in two conditions, with no competitor and no price in it.',
  },
];

export function occurrences(haystack, needle) {
  if (!needle) return 0;
  let count = 0;
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    count += 1;
    i = haystack.indexOf(needle, i + needle.length);
  }
  return count;
}

export function replaceAll(haystack, needle, replacement) {
  return haystack.split(needle).join(replacement);
}

/** Decide what to do with one entry against the value currently live. */
export function decideEntry(entry, liveValue) {
  if (typeof liveValue !== 'string') {
    return { action: 'skip', why: 'live value missing or not a string' };
  }
  const beforeCount = occurrences(liveValue, entry.before);
  const afterCount = occurrences(liveValue, entry.after);

  if (beforeCount === entry.expectedOccurrences) {
    return { action: 'apply', why: `found ${beforeCount}×`, next: replaceAll(liveValue, entry.before, entry.after) };
  }
  if (beforeCount === 0 && afterCount > 0) {
    return { action: 'already-applied', why: `AFTER present ${afterCount}×` };
  }
  // Neither shape at the expected count — the live copy has moved on since the
  // plan was written. Never overwrite what we cannot recognise.
  return {
    action: 'skip',
    why: `expected BEFORE ${entry.expectedOccurrences}×, found ${beforeCount}× (AFTER ${afterCount}×) — live copy has changed, re-read it before editing`,
  };
}

async function main() {
  // Gate every replacement before touching anything. One failure aborts the run.
  for (const entry of PLAN) {
    const verdict = checkSeoCopy({ body: entry.after });
    if (!verdict.ok) {
      console.error(`✗ ${entry.id}: replacement text fails the health gate — ${JSON.stringify(verdict)}`);
      process.exit(1);
    }
  }
  console.log(`✓ all ${PLAN.length} replacement(s) pass the SEO-copy health gate\n`);

  const handles = [...new Set(PLAN.map((e) => e.handle))];
  const products = await getProducts({ limit: 250 });
  const byHandle = new Map(products.map((p) => [p.handle, p]));

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  let applied = 0;
  let skipped = 0;

  for (const entry of PLAN) {
    const product = byHandle.get(entry.handle);
    if (!product) {
      console.log(`⏭  ${entry.id}: product /${entry.handle} not found — skipped`);
      skipped += 1;
      continue;
    }

    const decision = decideEntry(entry, product[entry.field]);
    if (decision.action !== 'apply') {
      const mark = decision.action === 'already-applied' ? '✓' : '⏭ ';
      console.log(`${mark} ${entry.id}: ${decision.action} — ${decision.why}`);
      if (decision.action === 'skip') skipped += 1;
      continue;
    }

    console.log(`\n▸ ${entry.id}  (/${entry.handle} · ${entry.field}, ${decision.why})`);
    console.log(`  BEFORE  ${entry.before}`);
    console.log(`  AFTER   ${entry.after}`);
    console.log(`  WHY     ${entry.reason}`);

    if (!APPLY) {
      applied += 1;
      continue;
    }

    mkdirSync(join(BACKUP_DIR, stamp), { recursive: true });
    writeFileSync(
      join(BACKUP_DIR, stamp, `${entry.handle}.${entry.field}.html`),
      product[entry.field],
      'utf8',
    );

    await updateProduct(product.id, { [entry.field]: decision.next });
    console.log(`  ✓ written to Shopify (backup: ${join(BACKUP_DIR, stamp)})`);
    applied += 1;
  }

  console.log(
    `\n${APPLY ? 'Applied' : 'Would apply'}: ${applied} · skipped: ${skipped}` +
      (APPLY ? '' : '\n(dry run — pass --apply to write)'),
  );
  console.log(
    '\nNOTE: one further on-page occurrence lives in the "How long does the bar ' +
      'last?" FAQ row of theme/templates/product.landing-page-bar-soap.json. It is ' +
      'committed in this change, but `git pull` does NOT deploy theme/ — it needs ' +
      'a theme push before it stops rendering on the live page.',
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
