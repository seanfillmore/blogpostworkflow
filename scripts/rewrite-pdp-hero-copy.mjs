#!/usr/bin/env node
/**
 * Rewrite lotion-family PDP bodies in customer language. Dry by default; --apply writes.
 *
 * WHY THESE PRODUCTS. `npm run hero-product` ranks entry SKUs by whether their
 * first-time buyers come back. Lotion is the hero cluster on every cut, and
 * `coconut-lotion` (Lightweight Coconut Lotion 8oz) is the hero SKU: 154
 * first-time buyers since 2024, 29.2% repurchase (Wilson lower bound 22.6%, top
 * on both), $3,722.70 of returning revenue — more than every other SKU combined.
 * `coconut-moisturizer` (Coconut Moisturizer 4oz) is second at 143 buyers /
 * 23.1% / Wilson 16.9%.
 *
 * `body-lotion-1` is NOT in this plan and that is a finding, not an omission: it
 * 404s and is absent from the catalogue. It is a retired listing. See the
 * objections note below, because that fact changes how its reviews read.
 *
 * WHY THIS COPY. `npm run claim-audit` counts brand vocabulary against customer
 * language across 390 Judge.me reviews. Both live bodies were written almost
 * entirely in vocabulary no reviewer has ever used — `cold-pressed` (20 uses / 0
 * customer mentions), `cold-pressed virgin` (17/0), `organic jojoba` (10/0),
 * `beeswax` (12/0), `petrolatum` (8/0), `palm oil` (14/1).
 *
 * What buyers actually discuss differs BETWEEN the two products, which is why
 * they do not get the same copy:
 *
 *   coconut-lotion (193 lotion-family reviews)   coconut-moisturizer (38)
 *     scent / smell        119 (62%)               scent / smell        25 (66%)
 *     moisturiz*            83                     moisturiz*           17
 *     absorbs / soaks in    45                     hands                10
 *     ingredients           38                     soft                 10
 *     not greasy            36                     thick / rich/butter   9
 *     soft                  35                     absorbs / soaks in    7
 *                                                  greasy (negated)      5
 *                                                  a little goes far     4
 *                                                  sensitive             0
 *
 * So the lotion leads on ABSORPTION and the cream leads on TEXTURE and WHERE it
 * gets used (hands, knees, legs, feet). The live cream body claims
 * "Sensitive-skin formulated" — a phrase zero of its 38 reviewers reach for —
 * and that line is cut rather than reworded.
 *
 * WHAT THE OBJECTION MINING CHANGED. All 20 one-to-three-star reviews in the
 * corpus were read. The greasy / slow-to-absorb complaints — "very greasy… did
 * not sink into the skin", "takes forever to absorb", "left my skin a bit tacky"
 * — are ALL on `body-lotion-1`, the retired listing. Across 97 `coconut-lotion`
 * reviews and 38 `coconut-moisturizer` reviews there is not one genuine
 * absorption complaint (`coconut-lotion`'s two 1★ ratings carry glowing text and
 * are plainly mis-clicks). That does NOT make the retired complaints irrelevant:
 * Rose Petal and Lavender & Rose are live variants on both products, so the
 * scent-mismatch objection ("caramel chocolate smell instead of lavender") is
 * live even though the listing is not. Whether the greasiness complaints
 * transfer is UNKNOWN — a retired listing may or may not have been this formula
 * — so neither body claims universality, and neither says "never greasy".
 *
 * The scent lines name the variant picker deliberately. Scent is the most-
 * discussed thing on both products and each carries five scent variants on one
 * page (verified live), so the copy points at a control the reader can use.
 *
 * TITLES ARE UNTOUCHED. Both are live SEO assets, nothing in the audit says
 * either is wrong, and a product-title change is the riskiest edit available.
 *
 * Every AFTER is re-gated through lib/seo-copy-health-gate.js at run time; one
 * failure aborts before any write. The live value is backed up first, and a live
 * value matching neither the expected BEFORE nor the AFTER is SKIPPED rather than
 * overwritten — the same drift guard scripts/remediate-live-health-claims.js uses.
 * Idempotent: an entry whose live body already equals its AFTER is reported as
 * already-applied and not rewritten.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getProducts, updateProduct } from '../lib/shopify.js';
import { checkSeoCopyFields } from '../lib/seo-copy-health-gate.js';

const APPLY = process.argv.includes('--apply');
const ONLY = (() => {
  const i = process.argv.indexOf('--handle');
  return i === -1 ? null : process.argv[i + 1];
})();

const PLAN = [
  {
    handle: 'coconut-lotion',
    before: `<p>Most lotions are mostly water, mineral oil, and a thickener — the moisturizing claim does more work than the formula. We built this around six ingredients that actually absorb into skin instead of sitting on top of it.</p><ul>
<li>
<strong>Cold-pressed virgin coconut oil</strong> delivers medium-chain fatty acids the skin barrier recognizes — not the lab-stripped, refined version most lotions use.</li>
<li>
<strong>Organic jojoba</strong> mirrors the skin's own sebum closely enough to absorb without leaving a film. No mineral oil, no petrolatum, no dimethicone.</li>
<li>
<strong>Organic red palm oil</strong> contributes naturally occurring vitamin E and beta-carotene — the antioxidants refining strips out of conventional palm oil.</li>
<li>
<strong>No synthetic fragrance, no parabens, no phenoxyethanol, no propylene glycol.</strong> Plant-based emulsifying wax binds water and oil instead of PEG-based emulsifiers.</li>
</ul><p>Shake before the first pump if the bottle has been stored cool — coconut oil firms below 76°F. Texture shifts batch-to-batch because the oil itself does.</p>`,
    after: `<p>Most lotions are mostly water and a thickener — which is why you can still feel one sitting on your skin an hour later. This is six ingredients built on coconut oil, and what people notice first is that it soaks in instead of sitting on top.</p><blockquote>
<p>"It absorbs quickly, is not greasy like some lotions can be, and has a great scent." — verified review</p>
</blockquote><ul>
<li>
<strong>It soaks in.</strong> Goes on smooth and absorbs quickly, without the slick film that makes you wait before getting dressed.</li>
<li>
<strong>The scent is the oils, not added fragrance.</strong> Light, and it fades. Five to choose from above — and Pure Unscented is the same formula with none at all.</li>
<li>
<strong>Six ingredients.</strong> Built on coconut oil, jojoba and red palm oil. No mineral oil, no petrolatum, no synthetic fragrance, no parabens.</li>
</ul><p>Two things worth knowing: shake before the first pump if the bottle has been stored somewhere cool — coconut oil firms below 76°F. And the texture shifts a little batch to batch, because the oil does.</p>`,
  },
  {
    handle: 'coconut-moisturizer',
    before: `<p>For skin that needs more than a lotion. We built this cream around organic beeswax — a true breathable barrier that locks moisture in without sealing pores closed the way petrolatum does. Cold-pressed virgin coconut oil delivers lauric acid and medium-chain fatty acids; organic red palm oil contributes its naturally retained vitamin E and beta-carotene; palm stearic gives the cream its rich body without synthetic thickeners. Grapefruit seed extract preserves it.</p><ul>
<li>
<strong>Breathable barrier.</strong> Organic beeswax locks in moisture — no petrolatum, no mineral oil sealing the skin shut.</li>
<li>
<strong>Nourishment, not just occlusion.</strong> Unrefined red palm oil keeps its antioxidants; refined palm oil strips them out.</li>
<li>
<strong>No silicone slip.</strong> No dimethicone mimicking softness — palm stearic delivers real cream body.</li>
<li>
<strong>Sensitive-skin formulated.</strong> No lanolin, no synthetic fragrance, no parabens, no phenoxyethanol.</li>
</ul><p>This is thicker than a pump lotion. Warm a small amount between your fingers; it firms in cold weather because beeswax does that.</p>`,
    after: `<p>Thicker than the lotion — a cream for the places that need more. Reviewers reach for it on hands, knees, legs and feet, and a little goes further than you expect.</p><blockquote>
<p>"Incredibly soft. Doesn't make you feel greasy or sticky after use. It makes you feel incredibly moisturized." — verified review</p>
</blockquote><ul>
<li>
<strong>Thick, but it does not sit on you.</strong> It goes on like butter and works in — heavy enough for rough spots, without the slick film.</li>
<li>
<strong>A little goes a long way.</strong> A tiny bit covers more than a pump of lotion does.</li>
<li>
<strong>The scent is light.</strong> It comes from the oils, not added fragrance. Five to choose from above — and Pure Unscented is the same cream with none at all.</li>
<li>
<strong>Beeswax is what makes it a cream.</strong> No petrolatum, no mineral oil, no synthetic fragrance, no parabens.</li>
</ul><p>Two things worth knowing: warm a small amount between your fingers first — beeswax firms in cold weather. And because it is real coconut oil, it can separate a little in the jar.</p>`,
  },
];

const norm = (s) => String(s || '').replace(/\r\n/g, '\n').trim();

async function main() {
  const entries = ONLY ? PLAN.filter((e) => e.handle === ONLY) : PLAN;
  if (!entries.length) throw new Error(`No plan entry for handle "${ONLY}".`);

  // Gate every AFTER before touching Shopify at all — one failure aborts the run.
  for (const e of entries) {
    const gate = checkSeoCopyFields({ [`${e.handle} product body`]: e.after });
    if (!gate.ok) {
      // `blocking`, not `violations` — checkSeoCopyFields names the field that way,
      // and the wrong name threw a TypeError instead of naming the offending copy.
      console.error(`REFUSED — ${e.handle} replacement copy fails the SEO copy health gate:`);
      for (const v of gate.blocking || []) console.error(`  [${v.category}] ${v.field}: "${v.match}"`);
      process.exit(1);
    }
    for (const a of gate.advisory || []) {
      console.log(`  advisory [${a.category}] ${e.handle}: "${a.match}" — reported, not blocking`);
    }
  }
  console.log(`Health gate: PASS on ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}\n`);

  const products = await getProducts({ limit: 250 });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = join('data', 'reports', 'pdp-copy-rewrite', stamp);
  const results = [];

  for (const e of entries) {
    const p = products.find((x) => x.handle === e.handle);
    if (!p) {
      console.error(`  ${e.handle}: NOT FOUND in the catalogue — skipped.`);
      results.push({ handle: e.handle, outcome: 'not-found' });
      continue;
    }
    const live = p.body_html || '';

    if (norm(live) === norm(e.after)) {
      console.log(`  ${e.handle}: already applied.`);
      results.push({ handle: e.handle, outcome: 'already-applied' });
      continue;
    }
    if (norm(live) !== norm(e.before)) {
      console.error(
        `  ${e.handle}: SKIPPED — live body matches neither the expected BEFORE nor the AFTER.\n` +
          `    Something has edited this product since the plan was written. live=${live.length}b expected=${e.before.length}b`
      );
      results.push({ handle: e.handle, outcome: 'drifted' });
      continue;
    }

    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${e.handle}.before.html`), live);
    writeFileSync(join(dir, `${e.handle}.after.html`), e.after);

    if (!APPLY) {
      console.log(`  ${e.handle}: DRY RUN — would rewrite (backup in ${dir}/).`);
      console.log(`    ${e.after.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200)}…`);
      results.push({ handle: e.handle, outcome: 'would-apply' });
      continue;
    }

    await updateProduct(p.id, { body_html: e.after });
    console.log(`  ${e.handle}: APPLIED to product ${p.id}.`);
    results.push({ handle: e.handle, outcome: 'applied', product_id: p.id });
  }

  if (results.some((r) => ['applied', 'would-apply'].includes(r.outcome))) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'run.json'),
      JSON.stringify({ at: new Date().toISOString(), applied: APPLY, results }, null, 2)
    );
    console.log(`\nRun record: ${dir}/run.json`);
  }
  if (!APPLY) console.log('\nDRY RUN — pass --apply to write.');
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
