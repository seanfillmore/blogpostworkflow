#!/usr/bin/env node
/**
 * State the REAL return-shipping policy on the two live pages that speak to it.
 * Dry by default; --apply writes Shopify.
 *
 *   node scripts/state-return-shipping-policy.js            # DRY RUN
 *   node scripts/state-return-shipping-policy.js --apply
 *   node scripts/state-return-shipping-policy.js --only <id>
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────────
 *
 * PR #785 rewrote the dropship-era shipping copy and left exactly ONE thing
 * deliberately unstated, because it could not be measured and guessing either way
 * was worse than silence:
 *
 *   - the old FAQ said "You must ship it back at your own expense"
 *   - the live refund policy says "30-day, no questions asked" and is SILENT on cost
 *
 * Those already contradicted each other. Inventing "free returns" would have been a
 * promise the operator never made; keeping "at your own expense" would have preserved
 * the contradiction. So the FAQ pointed at the refund policy and asserted nothing.
 *
 * The operator has now answered it, verbatim (2026-09-05):
 *
 *   "If someone tries our products and doesn't like them, we are not having them ship
 *    back open product. If there is a mistake on a large order and the items are
 *    unopened, we will issue a shipping label."
 *
 * That is a real policy with a real carve-out, and it is BETTER than either thing the
 * pages used to say — so the deferral closes as a statement, not as a hedge.
 *
 * ── WHAT IS ASSERTED, AND WHAT IS DELIBERATELY NOT ──────────────────────────────
 *
 * ASSERTED (both traceable to the operator's own words):
 *   1. Opened product is NOT shipped back. The customer is not asked to post anything.
 *   2. Our mistake on a LARGER order, items still unopened → we email a prepaid label.
 *
 * NOT ASSERTED — and each omission is a decision:
 *   - Nothing new about WHETHER a refund is issued. The live refund policy already
 *     promises "30-day, no questions asked"; this change is about the return SHIPMENT,
 *     not the money, and widening a refund promise is not what the operator said.
 *   - No prepaid label is promised for a SMALL mistaken order. The operator scoped it
 *     to a large one. "Tell us right away and we'll make it right" already covers the
 *     rest, and over-promising here would be inventing policy in the customer's favour
 *     — still inventing.
 *   - No return WINDOW is restated beyond the 30 days already published.
 *
 * ── THREE EDITS, TWO PAGES, AND WHY THE THIRD IS NOT OPTIONAL ───────────────────
 *
 * The FAQ's "Can I cancel my order?" answer ends "If it has already gone out, send it
 * back under our return policy for a full refund." Left alone, that would sit two
 * paragraphs below the new "please don't ship it back" line and directly contradict it
 * — the same failure PR #785 avoided by moving the FAQ and the shipping policy
 * together. One policy stated in three places moves in one change, or not at all.
 *
 * ── MECHANICS ARE IMPORTED, NOT RE-DECLARED ─────────────────────────────────────
 *
 * `classifyEntry`, `applyEntry` and `decodeBasicEntities` come from
 * `remediate-dropship-era-shipping-copy.js`. A second copy of a drift guard is a
 * second copy that drifts — and that file's guard already carries two hard-won
 * properties: APPLY is byte-exact while ALREADY-APPLIED compares entity-decoded
 * (Shopify decodes `&ndash;` on the way in, so a strict compare reports `drift` on the
 * normal post-apply state), and a body matching neither is SKIPPED, never overwritten.
 *
 * Every AFTER is re-gated through `checkSeoCopyFields` before any write, and every
 * live value is backed up to `data/reports/return-policy-statement/backups/<stamp>/`.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDirectRun } from '../lib/is-direct-run.js';
import { getPages, updatePage } from '../lib/shopify.js';
import { checkSeoCopyFields } from '../lib/seo-copy-health-gate.js';
import {
  classifyEntry,
  applyEntry,
} from './remediate-dropship-era-shipping-copy.js';

const REPORT_DIR = join('data', 'reports', 'return-policy-statement');

const FAQ_RETURN_BEFORE =
  '<strong>Can I return my order?</strong><br>Yes. We have a 30-day return policy, and if anything arrives damaged, defective or simply not what you ordered, tell us straight away and we’ll make it right. Email <span>support@realskincare.com</span> with your order number to start a return — full details are on our <a href="/pages/refund-policy-1">refund policy</a> page.';

const FAQ_RETURN_AFTER =
  '<strong>Can I return my order?</strong><br>Yes — 30 days, no questions asked. Email <span>support@realskincare.com</span> with your order number and we’ll take care of it.<br><br>If you have already opened it and it simply wasn’t for you, please don’t ship it back. We don’t ask you to return opened product.<br><br>If something arrived damaged, defective or wrong, tell us right away and we’ll make it right — and if we got a larger order wrong and the items are still unopened, we’ll email you a prepaid shipping label, so our mistake never costs you postage.<br><br>Full details are on our <a href="/pages/refund-policy-1">refund policy</a> page.';

const FAQ_CANCEL_BEFORE =
  'If it has already gone out, send it back under our return policy for a full refund.';
const FAQ_CANCEL_AFTER =
  'If it has already gone out, email us anyway and we’ll sort out a refund.';

const REFUND_BEFORE =
  '<p>DAMAGES AND ISSUES</p>';
const REFUND_AFTER =
  '<p>RETURN SHIPPING</p>\n<p>We do not ask you to ship opened product back to us. If you tried something and it was not right for you, contact us within 30 days and we will take care of the refund — there is nothing to post back. If we made a mistake on a larger order and the items are still unopened, we will email you a prepaid shipping label, so correcting our error never costs you postage.</p>\n<p>DAMAGES AND ISSUES</p>';

/**
 * Each entry records the operator's own words as `sourcedFrom`, because "we decided
 * this" and "somebody wrote it" are otherwise indistinguishable six weeks later. A
 * test requires the field and requires each claim to trace to that quote.
 */
export const PLAN = [
  {
    id: 'faq-return-answer',
    handle: 'faqs',
    field: 'body_html',
    kind: 'substring',
    expectedOccurrences: 1,
    before: FAQ_RETURN_BEFORE,
    after: FAQ_RETURN_AFTER,
    sourcedFrom:
      'Operator, 2026-09-05: "If someone tries our products and doesn\'t like them, we are not having them ' +
      'ship back open product. If there is a mistake on a large order and the items are unopened, we will ' +
      'issue a shipping label."',
  },
  {
    id: 'faq-cancel-answer',
    handle: 'faqs',
    field: 'body_html',
    kind: 'substring',
    expectedOccurrences: 1,
    before: FAQ_CANCEL_BEFORE,
    after: FAQ_CANCEL_AFTER,
    sourcedFrom:
      'Same quote. This line told the customer to "send it back", which contradicts "we are not having them ' +
      'ship back open product" two paragraphs above it once the return answer changes. It moves in the same run.',
  },
  {
    id: 'refund-policy-return-shipping',
    handle: 'refund-policy-1',
    field: 'body_html',
    kind: 'substring',
    expectedOccurrences: 1,
    before: REFUND_BEFORE,
    after: REFUND_AFTER,
    // INSERTION entry: the AFTER still contains the BEFORE anchor, so without this
    // a re-run appends another copy. See classifyPlanEntry.
    sentinel: '<p>RETURN SHIPPING</p>',
    sourcedFrom:
      'Same quote. The FAQ names this page as the authority for "full details", so the detail has to exist ' +
      'here — a FAQ deferring to a page that is silent on the point is the contradiction wearing a new hat.',
  },
];

/**
 * AN INSERTION ENTRY NEEDS A SENTINEL, AND THIS IS NOT A STYLE RULE — IT SHIPPED
 * BROKEN AND THE SECOND DRY RUN CAUGHT IT.
 *
 * `refund-policy-return-shipping` INSERTS a section above an anchor, so its AFTER
 * still contains its BEFORE (`<p>DAMAGES AND ISSUES</p>`). The shared `classifyEntry`
 * asks "does BEFORE occur the expected number of times?" FIRST, which stays true
 * forever after the write — so a second `--apply` would have appended a SECOND
 * "RETURN SHIPPING" section, and a third a third. Measured: the re-check reported it
 * would grow the page 1444 → 1841 chars again.
 *
 * The fix is to ask "is the new content already here?" before "does the anchor match?"
 * — keyed on a string that exists ONLY in the AFTER. A test derives the requirement
 * from the entry itself (`after.includes(before)` ⇒ sentinel required), so the next
 * insertion entry someone adds cannot repeat this.
 */
export function classifyPlanEntry(liveHtml, entry) {
  const s = typeof liveHtml === 'string' ? liveHtml : '';
  if (entry.sentinel && s.includes(entry.sentinel)) return { action: 'already-applied' };
  return classifyEntry(s, entry);
}

/** Re-gate every AFTER through the SEO-copy health gate. `ok:false` aborts the run. */
export function gatePlan(plan) {
  const failures = [];
  for (const e of plan) {
    const res = checkSeoCopyFields({ [`${e.handle} body`]: e.after });
    if (!res.ok) failures.push({ id: e.id, matches: res.blocking.map((b) => b.match) });
  }
  return { ok: failures.length === 0, failures };
}

async function main() {
  const apply = process.argv.includes('--apply');
  const onlyAt = process.argv.indexOf('--only');
  const only = onlyAt >= 0 ? process.argv[onlyAt + 1] : null;
  const plan = only ? PLAN.filter((e) => e.id === only) : PLAN;
  if (!plan.length) throw new Error(`--only ${only}: no such entry.`);

  const gate = gatePlan(plan);
  if (!gate.ok) {
    console.error('ABORT — a planned rewrite does not pass the SEO-copy health gate:');
    for (const f of gate.failures) console.error(`  ${f.id}: ${f.matches.join(', ')}`);
    process.exit(1);
  }
  console.log(`Gate: ${plan.length}/${plan.length} planned rewrites pass checkSeoCopyFields.\n`);

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = join(REPORT_DIR, 'backups', stamp);
  const rows = [];

  // Re-read per entry: two entries edit the SAME page, so the second must see what
  // the first wrote. Reading the page list once would make the second a guaranteed
  // drift on its own run.
  //
  // THROTTLED because that re-read doubles the call rate and Shopify allows 2/sec:
  // the first --apply run of this plan died on HTTP 429 at the third entry, having
  // already written the first two. Nothing was corrupted — the run aborts before any
  // partial write and the idempotent re-check named exactly what remained — but a
  // plan that stops halfway needs a human to notice, so the fix is to not race it.
  let first = true;
  for (const entry of plan) {
    if (!first) await new Promise((r) => setTimeout(r, 1200));
    first = false;
    const pages = await getPages({ limit: 250 });
    const page = pages.find((p) => p.handle === entry.handle);
    if (!page || !page.published_at) {
      console.error(`  ${entry.id}: SKIPPED — /pages/${entry.handle} is missing or unpublished.`);
      rows.push({ id: entry.id, outcome: 'no-live-page' });
      continue;
    }

    const live = page.body_html ?? '';
    const verdict = classifyPlanEntry(live, entry);

    if (verdict.action === 'already-applied') {
      console.log(`  ${entry.id}: already applied.`);
      rows.push({ id: entry.id, outcome: 'already-applied' });
      continue;
    }
    if (verdict.action === 'drift') {
      console.error(
        `  ${entry.id}: SKIPPED — live body matches neither BEFORE nor AFTER (found ${verdict.found}). ` +
          'Re-read the page and update the plan; nothing was written.'
      );
      rows.push({ id: entry.id, outcome: 'drift', found: verdict.found });
      continue;
    }

    const next = applyEntry(live, entry);
    if (!apply) {
      console.log(`  ${entry.id}: would rewrite /pages/${entry.handle} (${live.length} → ${next.length} chars).`);
      rows.push({ id: entry.id, outcome: 'would-apply' });
      continue;
    }

    mkdirSync(backupDir, { recursive: true });
    writeFileSync(join(backupDir, `${entry.handle}-${entry.id}.html`), live);
    await updatePage(page.id, { body_html: next });
    console.log(`  ${entry.id}: REWROTE /pages/${entry.handle}`);
    rows.push({ id: entry.id, outcome: 'applied', page_id: page.id });
  }

  if (apply) {
    mkdirSync(REPORT_DIR, { recursive: true });
    const record = { at: new Date().toISOString(), backupDir, rows };
    writeFileSync(join(REPORT_DIR, `${stamp}.json`), JSON.stringify(record, null, 2));
    writeFileSync(join(REPORT_DIR, 'latest.json'), JSON.stringify(record, null, 2));
  } else {
    console.log('\nDRY RUN — pass --apply to write.');
  }
}

if (isDirectRun(import.meta.url)) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
