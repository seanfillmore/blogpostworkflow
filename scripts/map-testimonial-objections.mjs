#!/usr/bin/env node
/**
 * Assign every live testimonial slot a DISTINCT objection to answer, and swap
 * the one slot that duplicated another.
 *
 *   node scripts/map-testimonial-objections.mjs                      # print the map
 *   node scripts/map-testimonial-objections.mjs --in <template.json> [--out <file>]
 *
 * THE RULE (Carl Weische, 2026-08-28): "Every single testimonial you have on
 * your pre-sell page & PDP should handle a specific objection." Selecting a
 * testimonial for being positive, compliant and specific — which is how the
 * current set was chosen in PRs #758/#759 — is NOT the same as selecting one
 * for the job it does.
 *
 * MEASURED BEFORE CHANGING ANYTHING, against the 13 ranked objections in
 * `data/context/voice-of-customer.md`. FOUR of the five live slots answered the
 * SAME objection (greasy / doesn't absorb), and three of the top objections had
 * no testimonial at all:
 *
 *   greasy / absorption (5 mentions)      ████ home, ugc-1, ugc-2, ugc-4
 *   value / size-for-price (5+4+4)        ███  home, ugc-3, ugc-4
 *   comedogenic — "it'll break me out" (6)  —  NOTHING
 *   scent doesn't match the label (6)       —  NOTHING
 *   bar soap strips and dries (4)           —  NOTHING
 *
 * ONE SWAP, on evidence rather than taste. `ugc-1` duplicated the HOMEPAGE
 * slot's exact angle, so it was the only slot buying nothing. It moves to the
 * scent objection — 6 mentions, previously unanswered, and the replacement is
 * about the body cream that is actually IN the Sensitive Skin Set. Note the
 * quote reads "very light, yet barely smell it": for a brand whose buyers react
 * to synthetic fragrance that is the reassurance, not a complaint.
 *
 * THE BIGGEST OBJECTION CANNOT BE ANSWERED HERE, and that is a finding, not an
 * omission. Only 5 of 390 reviews mention pores or breaking out at all, and the
 * single good one ("...by far my favorite because it doesn't clog up my pores",
 * which also answers price skepticism) is `verified: "nothing"` on BOTH of its
 * copies — not a verified purchase. The homepage labels its quote "verified
 * customer", so using it would make the page's own attribution false. Per
 * Weische's same section, a main objection belongs in a dedicated page SECTION
 * rather than being forced into a testimonial slot or an FAQ.
 *
 * SELECTION IS VERIFIED-ONLY, AND A RATING FILTER IS NOT A QUALITY FILTER.
 * Judge.me review 372138986-class records carry `rating: 5` on plainly negative
 * text — this store has at least one: "Was hoping to find a natural ingredient
 * body moisturizer that really moisturizes, this wasn't it!" is a PUBLISHED,
 * VERIFIED-PURCHASE 5-star review. Never auto-select on rating alone.
 *
 * Upload with update-theme-asset.mjs. Writes no Shopify state. IDEMPOTENT.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { isDirectRun } from '../lib/is-direct-run.js';
import { checkSeoCopyFields } from '../lib/seo-copy-health-gate.js';
import { hasHealthClaim } from '../agents/ad-studio/health-claims.js';
import { serializeTemplate } from './merge-homepage-soap-cards.mjs';

export const LANDER_KEY = 'templates/product.landing-page-sensitive-skin-set-lander.json';
export const SECTION = 'ugc-photos';

/**
 * Every live testimonial slot, the objection it is there to answer, and the
 * words in the quote that do the answering. `evidence` is asserted by a test —
 * an objection nothing in the quote supports is a label, not a job.
 */
export const SLOTS = [
  {
    slot: 'homepage/featured-testimonial',
    surface: 'homepage',
    objection: 'greasy — natural oils are assumed not to absorb',
    evidence: ["doesn't feel greasy"],
    name: 'Nicole H.',
    body: "I'm obsessed with all things Real Skin Care. This is THE moisturizer for Wisconsin winters for my whole family. It's long lasting and doesn't feel greasy. We use it all over and love it!",
    change: null,
  },
  {
    slot: 'ugc-1',
    surface: 'sensitive-skin-set lander',
    objection: "scent doesn't match the label",
    evidence: ['coconut scent is very light'],
    name: 'Rochelle B.',
    body: 'The coconut scent is very light, yet barely smell it and the body cream makes your skin feel soft and not dry. The Real hand soap is terrific too .',
    source: { reviewId: 514327200, product: 'Coconut Moisturizer | 4oz', createdAt: '2023-04-17', rating: 5, verified: 'buyer' },
    change: {
      fromName: 'Ella M.',
      fromBody: '<p>"Incredibly soft. Doesn’t make you feel greasy or sticky after use. It makes you feel incredibly moisturized."</p>',
      why: 'duplicated the homepage slot\'s greasy/absorption angle; moved to the unanswered scent objection',
    },
  },
  {
    slot: 'ugc-2',
    surface: 'sensitive-skin-set lander',
    objection: 'drugstore brands are the default recommendation',
    evidence: ['better than any Bath & Body Works product'],
    name: 'Ariel M.',
    body: "As soon as you put it on it just absorbs. My hands are in water all day at my job and this locks moisture in better than any Bath &amp; Body Works product. Doesn't burn my cuts either.",
    change: null,
  },
  {
    slot: 'ugc-3',
    surface: 'sensitive-skin-set lander',
    objection: "ingredients aren't easy to find or trust before buying",
    evidence: ['you can read the ingredients'],
    name: 'Michaela',
    body: 'I love this lotion. It feels great on my skin and isn’t irritating. I love that you can read the ingredients and it’s all things I know. Great value and great for your skin!',
    change: null,
  },
  {
    slot: 'ugc-4',
    surface: 'sensitive-skin-set lander',
    objection: 'a natural lotion will irritate already-sensitive skin',
    evidence: ["Doesn't irritate their skin further"],
    name: 'Nicole H.',
    body: "Perfect moisturizer for my kids. Absorbs quickly, lasts all day. Doesn't irritate their skin further like other lotions do — I even use it on their faces.",
    change: null,
  },
];

/** Objections with no testimonial behind them, and why. Recorded, not hidden. */
export const UNANSWERED = [
  {
    objection: 'coconut oil is comedogenic — "it will break me out"',
    mentions: 6,
    why: 'only 5 of 390 reviews mention pores or breaking out, and the one usable quote is verified:"nothing" on both copies — the homepage labels its slot "verified customer"',
    fix: 'a dedicated page section, per Weische: a main objection must not be buried in an FAQ',
  },
  {
    objection: 'bar soap strips and dries sensitive skin',
    mentions: 4,
    why: 'the one clean quote is about the foaming hand soap, and these surfaces sell the lotion/cream set',
    fix: 'belongs on the soap PDPs or /collections/soap, not here',
  },
];

export const renderQuote = (body) => `<p>"${body}"</p>`;

export function applySwaps(template, slots = SLOTS) {
  const next = JSON.parse(JSON.stringify(template));
  const section = next.sections?.[SECTION];
  const applied = []; const skipped = [];
  if (!section) return { template: next, applied, skipped: [{ slot: SECTION, why: 'section not found' }] };

  for (const s of slots.filter((x) => x.change && x.surface !== 'homepage')) {
    const block = section.blocks?.[s.slot];
    if (!block) { skipped.push({ ...s, why: 'block not found' }); continue; }
    const after = renderQuote(s.body);
    if (block.settings.text === after && block.settings.title === s.name) { skipped.push({ ...s, why: 'already applied' }); continue; }
    if (block.settings.text !== s.change.fromBody || block.settings.title !== s.change.fromName) {
      skipped.push({ ...s, why: 'live value matches neither BEFORE nor AFTER' }); continue;
    }
    block.settings.text = after;
    block.settings.title = s.name;
    applied.push(s);
  }
  return { template: next, applied, skipped };
}

async function main() {
  const arg = (f) => { const i = process.argv.indexOf(f); return i === -1 ? null : process.argv[i + 1]; };
  const input = arg('--in'); const out = arg('--out');

  console.log('TESTIMONIAL → OBJECTION MAP\n');
  for (const s of SLOTS) {
    console.log(`  ${s.slot.padEnd(32)} ${s.name}`);
    console.log(`  ${''.padEnd(32)} answers: ${s.objection}`);
    if (s.change) console.log(`  ${''.padEnd(32)} SWAP from ${s.change.fromName} — ${s.change.why}`);
    console.log('');
  }
  console.log(`  UNANSWERED (${UNANSWERED.length}):`);
  for (const u of UNANSWERED) console.log(`    ! ${u.objection} (${u.mentions} mentions) — ${u.fix}`);

  for (const s of SLOTS) {
    const g = checkSeoCopyFields({ testimonial: s.body });
    if (!g.ok || hasHealthClaim(s.body)) throw new Error(`${s.slot}: quote trips a health gate`);
  }
  console.log('\n  ✓ every quote passes both health gates');

  if (!input) { console.log('\nNo --in given; map printed only.'); return; }
  const { template, applied, skipped } = applySwaps(JSON.parse(readFileSync(input, 'utf8')));
  for (const a of applied) console.log(`\n  ${a.slot}: ${a.change.fromName} → ${a.name}`);
  for (const s of skipped) console.log(`  = ${s.slot}: ${s.why}`);
  if (!applied.length) { console.log('\nNothing to do.'); return; }
  if (!out) { console.log('\nNothing written. Re-run with --out <file>.'); return; }
  writeFileSync(out, serializeTemplate(template));
  console.log(`\n  wrote ${out}`);
}

if (isDirectRun(import.meta.url)) {
  main().catch((e) => { console.error(`\n${e.message}`); process.exit(1); });
}
