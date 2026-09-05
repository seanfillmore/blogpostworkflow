#!/usr/bin/env node
/**
 * Replace the dropship-era shipping and returns copy on the three live policy
 * pages that still carry it. Dry by default; --apply writes Shopify.
 *
 *   node scripts/remediate-dropship-era-shipping-copy.js            # DRY RUN
 *   node scripts/remediate-dropship-era-shipping-copy.js --apply
 *   node scripts/remediate-dropship-era-shipping-copy.js --only <id>
 *
 * ── HOW THIS WAS FOUND ──────────────────────────────────────────────────────────
 *
 * Following the single inbound link on the unpublished `/pages/faq` stub (PR #779's
 * leftover). The stub is inert. The LIVE page it should have pointed at is not:
 * `/pages/faqs` is linked from the site footer on every page, sits in the conversion
 * path, and told shoppers their order would take **15-25 BUSINESS DAYS** to arrive.
 *
 * ── WHAT THE LIVE COPY CLAIMED vs WHAT THE ORDERS SAY ───────────────────────────
 *
 * Measured read-only against 108 real Shopify orders, 2026-03-09 → 2026-09-05:
 *
 *   claim (live)                              measured
 *   ─────────────────────────────────────     ──────────────────────────────────────
 *   "4-7 days production time"                order → fulfillment MEDIAN 0.81 days,
 *                                             p75 1.77, p90 2.57, max 4.0.
 *                                             62/105 ship within 1 day, 102/105 within 3.
 *   "average shipping times are 15-21 days"   ship → delivered MEDIAN 5.4 days,
 *   "average shipping time is 15-25           p75 7.0, p90 8.1 (96 delivered samples).
 *    business days"
 *   "we ship worldwide from different         107 of 108 orders shipped to the US.
 *    fulfillment centers based on your        Carriers actually used: USPS (58),
 *    location"                                UPS (47). No DHL ecommerce. No "packet".
 *   "3 to 5 working days" (shipping policy)   same 0.81-day median as above.
 *   "typically 2 to 5 days" until the         same.
 *    tracking email (track-order)
 *
 * So the store was advertising a 3-to-5-WEEK delivery window for a product it
 * actually gets to the customer's door in about a week. That is a conversion leak on
 * the one page a hesitant shopper opens before checking out, and it is the exact
 * shape the Prime Directive calls first-class: not a ranking problem, a sales one.
 *
 * The transit figure comes from `fulfillment.shipment_status === 'delivered'` and uses
 * `updated_at` as the delivery timestamp. That is a PROXY — it is the last time the
 * record changed, which for a delivered fulfillment is the delivery event unless
 * something touched it later. It is corroborated by the direction of the error being
 * enormous (5.4 days vs a claimed 15-25 business days), not by precision. The new copy
 * therefore says "most US orders arrive within about a week of shipping" rather than
 * quoting a number to the day.
 *
 * ── WHY THREE PAGES AND NOT JUST THE FAQ ────────────────────────────────────────
 *
 * The same dropship template seeded all three, and the FAQ's own closing line sends the
 * reader to the shipping policy. Fixing the FAQ alone would leave a shopper who follows
 * that link reading "14 to 21 business days" — a live self-contradiction created BY the
 * fix. Same reasoning as the two consumers that had to move with the schema change:
 * these are one claim in three places, so they move together or not at all.
 *
 * `track-order` is edited as a SUBSTRING, not a whole body, because its markup carries
 * the AfterShip widget (`button.aftership.com` script + `as-track-button` div). A
 * whole-body replacement there would silently delete a working tracking widget.
 *
 * ── WHAT THIS DELIBERATELY DOES NOT DO ──────────────────────────────────────────
 *
 * 1. IT STATES NO RETURN-SHIPPING COST. The live FAQ said "you must ship it back at
 *    your own expense"; the live refund policy page says "30-day, no questions asked"
 *    and is silent on who pays. Those two are already inconsistent and I cannot
 *    measure which is true. Inventing "free returns" would be a promise the operator
 *    never made, and keeping "at your own expense" would preserve a contradiction with
 *    the policy page that governs it. So the FAQ now points at the refund policy for
 *    the details and asserts nothing about cost. THIS IS AN OPEN QUESTION, not an
 *    oversight — see the PR body.
 *
 * 2. IT DOES NOT TOUCH `refund-policy-1`, `privacy-policy-1` or `terms-of-service`.
 *    Those carry no shipping-time claim and are the authority the FAQ now defers to.
 *
 * 3. IT ADDS NO NEW FAQ TOPICS. Tempting ones (made in the USA, aluminium-free) are
 *    real and true, but this change exists to remove false claims, and a page grown
 *    while it is being corrected is a page nobody reviewed.
 *
 * ── EMAIL ADDRESS: `support@`, AND THAT IS EVIDENCE, NOT PREFERENCE ─────────────
 *
 * The stale FAQ was the ONLY live page using `team@realskincare.com` (3 occurrences).
 * `support@realskincare.com` is on three live policy pages — privacy, refund and terms
 * of service. The FAQ is the outlier, so it is the one that moves.
 *
 * ── SAFETY ──────────────────────────────────────────────────────────────────────
 *
 * Dry by default. Every AFTER is re-gated through `checkSeoCopyFields` before any
 * write (one failure aborts the whole run). Every live value is backed up to
 * `data/reports/dropship-copy-remediation/backups/<stamp>/` BEFORE it is overwritten.
 * An entry whose live value matches neither BEFORE nor AFTER is SKIPPED rather than
 * overwritten — the drift guard that caught a U+00A0 in PR #634 — so a page somebody
 * edited by hand in the meantime is never clobbered. A second run reports
 * `already-applied` and writes nothing.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDirectRun } from '../lib/is-direct-run.js';
import { getPages, updatePage } from '../lib/shopify.js';
import { checkSeoCopyFields } from '../lib/seo-copy-health-gate.js';
import { classify, occurrences, replaceAll } from './remediate-live-health-claims.js';

const REPORT_DIR = join('data', 'reports', 'dropship-copy-remediation');

const FAQ_BEFORE =
  '<strong>What currency are the prices do I see in the site?</strong><br>All prices are in USD.<br><br><strong>I just placed an order, when will it ship?</strong><br>We try our best to ship items as fast as we can. Please allow 4-7 days production time for your order to ship out, average shipping times are 15-21 days.<br>Tracking numbers will be updated 3-5 days after your order has been SHIPPED. If you don\'t have a tracking number after 7 business please email us at <span>team@realskincare.com</span>.<br><br><br><strong>I am not in love with my order, can it be returned? What if there is an issue?</strong><br>We offer a 100 % money back guarantee if the product is defective or damaged. We give you 30 days to send it back to us for a full refund. You must ship it back at your own expense, once we have received the product we will refund the full amount of your original purchase. Please Include all a name and order number on the returned parcels.<br>Please note: If your package is on the way, you must wait for it to arrive and return it before receiving a refund.<br><br><strong>Can I cancel my order?</strong><br>You are able to cancel your order with no penalty! You must cancel your order before it ships. If the item is already sent please use our easy return system to get a full refund.<br><br><strong>I have entered an incorrect address what do I do now?</strong><br>If you have miss spelled or auto-filled in an incorrect address, simply reply to your order confirmation email and confirm. Once you double check if the address given is wrong kindly notify us via email at <span>team@realskincare.com</span>. If the given address is wrong we can change the address to the correct one within 24 hours. No refund will be given after the 24 hours of incorrect submission. <br><br><strong>How long does shipping take?</strong><br>Shipping times vary as we do ship worldwide from different fulfillment centers based on your location. The average shipping time is 15-25 business days.<br><br><strong>I have a question that wasn\'t answered, can you please help?</strong><br><br>Absolutely! We are here to help you make your home beautiful! Please send us an email to <span>team@realskincare.com</span> and we will be happy to assist you in any way we can. <br>We do receive a large number of emails, If you wish to get a prompt response please attach your order number and address the problem clearly, thanks.';

const FAQ_AFTER = [
  '<strong>What currency are your prices in?</strong><br>All prices are in USD.',
  '<strong>When will my order ship?</strong><br>Most orders leave us within 1–2 business days, by USPS or UPS. You’ll get a tracking number by email as soon as your parcel is on its way. If you haven’t received tracking within 3 business days, email <span>support@realskincare.com</span> with your order number.',
  '<strong>How long does delivery take?</strong><br>Most US orders arrive within about a week of shipping. Standard shipping is free on US orders over $45.',
  '<strong>Can I return my order?</strong><br>Yes. We have a 30-day return policy, and if anything arrives damaged, defective or simply not what you ordered, tell us straight away and we’ll make it right. Email <span>support@realskincare.com</span> with your order number to start a return — full details are on our <a href="/pages/refund-policy-1">refund policy</a> page.',
  '<strong>Can I cancel my order?</strong><br>Yes, with no penalty, as long as it hasn’t shipped yet. Because we usually ship within a day, email <span>support@realskincare.com</span> as soon as you can. If it has already gone out, send it back under our return policy for a full refund.',
  '<strong>I entered the wrong address — what now?</strong><br>Email <span>support@realskincare.com</span> with your order number the moment you notice. We can correct an address within 24 hours of the order being placed, and orders often ship the next day, so it is worth telling us quickly.',
  '<strong>I have a question that isn’t answered here.</strong><br>Email <span>support@realskincare.com</span> and a real person will get back to you. Including your order number and a clear description of the problem gets you a faster answer.',
].join('<br><br>');

// NOTE the explicit   after "within": the live body carries a NON-BREAKING SPACE
// there, and it transcribes as a plain space in any copy-paste. The drift guard caught
// exactly this on the first dry run — the same U+00A0 trap PR #634 hit — so it is
// sourced as an escape, and a test asserts no rewrite silently normalises it.
const SHIPPING_BEFORE =
  '<div style="text-align: justify;">\n<p>All orders are shipped within' + '\u00A0' + '3 to 5 working days of you placing the order using DHL ecommerce, USPS or packet depending on your location and fastest available service.</p>\n<p>Typical delivery time frame is between 14 to 21 business days however, you may receive your items much earlier.</p>\n<p>All orders are shipped with tracking number so you can track it every step of the way! Packages may be faced with delays beyond our control such as customs or postal delays.</p>\n</div>';

const SHIPPING_AFTER =
  '<div style="text-align: justify;">\n<p>Most orders ship within 1–2 business days of being placed, by USPS or UPS, whichever gets your parcel to you fastest.</p>\n<p>Most US orders arrive within about a week of shipping. Standard shipping is free on US orders over $45.</p>\n<p>Every order ships with a tracking number so you can follow it the whole way. Occasionally a parcel is delayed by the carrier, and if yours looks stuck, email <span>support@realskincare.com</span> with your order number and we will chase it for you.</p>\n</div>';

const TRACK_BEFORE =
  'Once your order is processed, an email will arrive with your tracking number (typically 2 to 5 days after making your purchase).';
const TRACK_AFTER =
  'Once your order ships, an email will arrive with your tracking number (usually within 1–2 business days of your purchase).';

/**
 * Each entry records `basis` — the evidence that makes the AFTER true. A test pins
 * that every entry has one, so a rewrite can never ride along on nothing.
 */
export const PLAN = [
  {
    id: 'faq-whole-body',
    handle: 'faqs',
    field: 'body_html',
    kind: 'whole',
    before: FAQ_BEFORE,
    after: FAQ_AFTER,
    basis:
      '108 orders / 180d: fulfillment median 0.81d, transit median 5.4d, 107/108 US, USPS+UPS only. ' +
      'Removes "4-7 days production", "15-21 days", "15-25 business days", "worldwide from different ' +
      'fulfillment centers", the home-goods boilerplate ("make your home beautiful"), and the ' +
      'team@ address that appears on no other live page.',
  },
  {
    id: 'shipping-policy-whole-body',
    handle: 'shipping-policy',
    field: 'body_html',
    kind: 'whole',
    before: SHIPPING_BEFORE,
    after: SHIPPING_AFTER,
    basis:
      'Same order pull. Removes "3 to 5 working days", "14 to 21 business days" and the carrier list ' +
      '("DHL ecommerce, USPS or packet") that names two services this store has not used in 180 days.',
  },
  {
    id: 'track-order-tracking-lag',
    handle: 'track-order',
    field: 'body_html',
    kind: 'substring',
    expectedOccurrences: 1,
    before: TRACK_BEFORE,
    after: TRACK_AFTER,
    basis:
      'Same order pull: fulfillment median 0.81d, 102/105 within 3 days. Substring edit ONLY, because ' +
      'this body carries the AfterShip tracking widget that a whole-body replacement would delete.',
  },
];

// --- pure helpers -------------------------------------------------------------

/**
 * SHOPIFY DECODES HTML ENTITIES ON THE WAY IN, so the value it stores is not
 * byte-identical to the value you sent. `&ndash;` comes back as an en dash. That is
 * why the AFTER literals here use the real characters — and why the ALREADY-APPLIED
 * test compares decoded, while the APPLY test stays byte-exact.
 *
 * The asymmetry is the safety property, not an inconsistency. A tolerant APPLY test
 * could overwrite a page somebody edited; a tolerant ALREADY-APPLIED test can only
 * ever decide to do NOTHING. Without it a second `--apply` reported `drift` on all
 * three pages — the guard that means "a human edited this, leave it alone" firing on
 * the completely normal post-apply state, which is how a real edit later goes unnoticed.
 */
export function decodeBasicEntities(html) {
  return String(html)
    .replace(/&ndash;/g, '–')
    .replace(/&mdash;/g, '—')
    .replace(/&rsquo;/g, '’')
    .replace(/&amp;/g, '&');
}

/** What to do with one entry given the live body. Never 'apply' on an unexpected value. */
export function classifyEntry(liveHtml, entry) {
  const s = typeof liveHtml === 'string' ? liveHtml : '';
  if (entry.kind === 'whole') {
    if (s === entry.before) return { action: 'apply' };
    if (decodeBasicEntities(s) === decodeBasicEntities(entry.after)) return { action: 'already-applied' };
    return classify(s, entry);
  }
  const found = occurrences(s, entry.before);
  if (found === entry.expectedOccurrences) return { action: 'apply', found };
  if (found === 0 && occurrences(decodeBasicEntities(s), decodeBasicEntities(entry.after)) > 0) {
    return { action: 'already-applied', found };
  }
  return { action: 'drift', found };
}

/** The body this entry would write. */
export function applyEntry(liveHtml, entry) {
  return entry.kind === 'whole' ? entry.after : replaceAll(liveHtml, entry.before, entry.after);
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

// --- runner -------------------------------------------------------------------

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

  const pages = await getPages({ limit: 250 });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = join(REPORT_DIR, 'backups', stamp);
  const rows = [];

  for (const entry of plan) {
    const page = pages.find((p) => p.handle === entry.handle);
    if (!page) {
      console.error(`  ${entry.id}: SKIPPED — no page with handle "${entry.handle}".`);
      rows.push({ id: entry.id, outcome: 'no-page' });
      continue;
    }
    if (!page.published_at) {
      console.error(`  ${entry.id}: SKIPPED — /pages/${entry.handle} is not published.`);
      rows.push({ id: entry.id, outcome: 'not-published' });
      continue;
    }

    const live = page.body_html ?? '';
    const verdict = classifyEntry(live, entry);

    if (verdict.action === 'already-applied') {
      console.log(`  ${entry.id}: already applied.`);
      rows.push({ id: entry.id, outcome: 'already-applied' });
      continue;
    }
    if (verdict.action === 'drift') {
      console.error(
        `  ${entry.id}: SKIPPED — live body matches neither BEFORE nor AFTER (someone edited it). ` +
          'Re-read the page and update the plan; nothing was written.'
      );
      rows.push({ id: entry.id, outcome: 'drift' });
      continue;
    }

    const next = applyEntry(live, entry);
    if (!apply) {
      console.log(`  ${entry.id}: would rewrite /pages/${entry.handle} (${live.length} → ${next.length} chars).`);
      rows.push({ id: entry.id, outcome: 'would-apply' });
      continue;
    }

    mkdirSync(backupDir, { recursive: true });
    writeFileSync(join(backupDir, `${entry.handle}.html`), live);
    await updatePage(page.id, { body_html: next });
    console.log(`  ${entry.id}: REWROTE /pages/${entry.handle} (backup: ${backupDir}/${entry.handle}.html)`);
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
