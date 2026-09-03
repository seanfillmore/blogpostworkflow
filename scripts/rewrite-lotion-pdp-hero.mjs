#!/usr/bin/env node
/**
 * Rewrite the hero-SKU PDP body in customer language. Dry by default; --apply writes.
 *
 * WHY THIS PRODUCT. `npm run hero-product` ranks entry SKUs by whether their
 * first-time buyers come back. `coconut-lotion` (Lightweight Coconut Lotion 8oz)
 * is the hero on every cut: 154 first-time buyers since 2024, 29.2% repurchase
 * (Wilson lower bound 22.6%, top on both), and $3,722.70 of returning revenue —
 * more than every other SKU combined.
 *
 * WHY THIS COPY. `npm run claim-audit` counts brand vocabulary against customer
 * language. The live body is written almost entirely in vocabulary no reviewer
 * has ever used: `cold-pressed` (20 uses / 0 customer mentions), `cold-pressed
 * virgin` (17/0), `organic jojoba` (10/0), `petrolatum` (8/0), `palm oil` (14/1).
 * Measured across the 193 lotion-family reviews, what buyers actually talk about:
 *
 *     scent / smell        119 / 193   (62% — the single most-discussed thing)
 *     moisturiz*            83 / 193
 *     absorbs / soaks in    45 / 193
 *     ingredients           38 / 193
 *     not greasy            36 / 193
 *     soft                  35 / 193
 *     dry skin / eczema     21 / 193
 *     sensitive skin        17 / 193
 *
 * Every line below traces to one of those counts. Note two things the counts
 * changed about the first draft of this rewrite:
 *
 *   1. SCENT IS THE #1 TOPIC, not absorption. The audit's bigram tokeniser split
 *      "coconut scent" and "lavender scent" into separate low-count terms and
 *      buried it. It gets its own line here.
 *   2. THE INGREDIENT STORY SURVIVES. 38/193 reviewers do talk about
 *      ingredients ("so hard to find brands that don't have a ton of chemicals").
 *      What tested dead is the specific CHEMISTRY vocabulary — medium-chain
 *      fatty acids, sebum, beta-carotene, PEG emulsifiers — not the simple-formula
 *      positioning. So the six-ingredient claim is kept and compressed rather than cut.
 *
 * WHAT IS DELIBERATELY NOT CLAIMED. Of the 8 one-to-three-star lotion reviews,
 * three say the opposite of the hero claim — "very greasy… did not sink into the
 * skin", "takes forever to absorb", "left my skin a bit tacky" — so the copy says
 * what people notice, not that it is universal. Two of those 8 are plainly
 * mis-clicked ratings (1★ on glowing text) and are ignored.
 *
 * The scent line names the variant picker deliberately. Scent is the most-discussed
 * thing in the corpus (119/193) and this product carries five scent variants on one
 * page — Pure Unscented, Coconut Breeze, Rose Petal, Lavender & Rose, Calming
 * Lavender (verified live, four in stock) — so the copy points at a control the
 * reader can actually use rather than describing a separate product.
 *
 * The TITLE is untouched. "Non-Toxic Body Lotion Made With Only 6 Clean
 * Ingredients" is a live SEO asset, nothing in the audit says it is wrong, and a
 * product-title change is the riskiest edit available here.
 *
 * Every AFTER is re-gated through lib/seo-copy-health-gate.js at run time; one
 * failure aborts before any write. The live value is backed up first, and a live
 * value matching neither the expected BEFORE nor the AFTER is SKIPPED rather than
 * overwritten — the same drift guard scripts/remediate-live-health-claims.js uses.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getProducts, updateProduct } from '../lib/shopify.js';
import { checkSeoCopyFields } from '../lib/seo-copy-health-gate.js';

const APPLY = process.argv.includes('--apply');
const HANDLE = 'coconut-lotion';

const BEFORE = `<p>Most lotions are mostly water, mineral oil, and a thickener — the moisturizing claim does more work than the formula. We built this around six ingredients that actually absorb into skin instead of sitting on top of it.</p><ul>
<li>
<strong>Cold-pressed virgin coconut oil</strong> delivers medium-chain fatty acids the skin barrier recognizes — not the lab-stripped, refined version most lotions use.</li>
<li>
<strong>Organic jojoba</strong> mirrors the skin's own sebum closely enough to absorb without leaving a film. No mineral oil, no petrolatum, no dimethicone.</li>
<li>
<strong>Organic red palm oil</strong> contributes naturally occurring vitamin E and beta-carotene — the antioxidants refining strips out of conventional palm oil.</li>
<li>
<strong>No synthetic fragrance, no parabens, no phenoxyethanol, no propylene glycol.</strong> Plant-based emulsifying wax binds water and oil instead of PEG-based emulsifiers.</li>
</ul><p>Shake before the first pump if the bottle has been stored cool — coconut oil firms below 76°F. Texture shifts batch-to-batch because the oil itself does.</p>`;

const AFTER = `<p>Most lotions are mostly water and a thickener — which is why you can still feel one sitting on your skin an hour later. This is six ingredients built on coconut oil, and what people notice first is that it soaks in instead of sitting on top.</p><blockquote>
<p>"It absorbs quickly, is not greasy like some lotions can be, and has a great scent." — verified review</p>
</blockquote><ul>
<li>
<strong>It soaks in.</strong> Goes on smooth and absorbs quickly, without the slick film that makes you wait before getting dressed.</li>
<li>
<strong>The scent is the oils, not added fragrance.</strong> Light, and it fades. Five to choose from above — and Pure Unscented is the same formula with none at all.</li>
<li>
<strong>Six ingredients.</strong> Built on coconut oil, jojoba and red palm oil. No mineral oil, no petrolatum, no synthetic fragrance, no parabens.</li>
</ul><p>Two things worth knowing: shake before the first pump if the bottle has been stored somewhere cool — coconut oil firms below 76°F. And the texture shifts a little batch to batch, because the oil does.</p>`;

async function main() {
  const gate = checkSeoCopyFields({ 'product body': AFTER });
  if (!gate.ok) {
    console.error('REFUSED — the replacement copy does not clear the SEO copy health gate:');
    for (const v of gate.violations) console.error(`  [${v.category}] ${v.field}: "${v.match}"`);
    process.exit(1);
  }
  console.log('Health gate: PASS (blocking tier clean)');
  if (gate.advisory?.length) {
    for (const a of gate.advisory) console.log(`  advisory [${a.category}] "${a.match}" — reported, not blocking`);
  }

  const products = await getProducts({ limit: 250 });
  const p = products.find((x) => x.handle === HANDLE);
  if (!p) throw new Error(`Product ${HANDLE} not found.`);

  const live = p.body_html || '';
  const norm = (s) => s.replace(/\r\n/g, '\n').trim();

  if (norm(live) === norm(AFTER)) {
    console.log('Already applied — live body matches the AFTER. Nothing to do.');
    return;
  }
  if (norm(live) !== norm(BEFORE)) {
    console.error('SKIPPED — the live body matches neither the expected BEFORE nor the AFTER.');
    console.error('Someone or something has edited this product since the plan was written.');
    console.error(`  live length ${live.length}, expected BEFORE length ${BEFORE.length}`);
    process.exit(2);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = join('data', 'reports', 'pdp-copy-rewrite', stamp);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${HANDLE}.before.html`), live);
  writeFileSync(join(dir, `${HANDLE}.after.html`), AFTER);
  writeFileSync(
    join(dir, 'run.json'),
    JSON.stringify(
      { handle: HANDLE, product_id: p.id, applied: APPLY, at: new Date().toISOString(), gate: gate.ok },
      null,
      2
    )
  );
  console.log(`Backup written to ${dir}/`);

  if (!APPLY) {
    console.log('\nDRY RUN — pass --apply to write. Proposed body:\n');
    console.log(AFTER.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
    return;
  }

  await updateProduct(p.id, { body_html: AFTER });
  console.log(`APPLIED to product ${p.id} (${HANDLE}).`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
