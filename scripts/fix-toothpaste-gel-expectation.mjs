#!/usr/bin/env node
/**
 * Fix the toothpaste texture-expectation mismatch. Dry by default; --apply writes.
 *
 * THE FINDING. Toothpaste is the worst-retaining cluster in the catalogue
 * (9.8% raw / 5.8% Wilson first-time-buyer repurchase, `npm run hero-product`),
 * and reading all 20 one-to-three-star reviews showed why it might be: SIX of its
 * EIGHT low-star reviews are one complaint, and it is not about the formula.
 *
 *     "very runny … Watery runny"
 *     "This really isn't a toothpaste, it's really watery and drips off your toothbrush"
 *     "This product is called toothpaste, and on the product page it even says under
 *      'item form' that it is 'paste'. So I expected a paste. This is not a paste—
 *      it is liquid."
 *     "The liquid falls off my toothbrush onto the sink."
 *
 * Every one of those reviewers liked the ingredients and most liked the flavour.
 * This is an EXPECTATION failure, not a product failure — the cheapest possible
 * retention fix on the least efficient cluster we sell.
 *
 * THE ACTUAL CAUSE, which is our own instruction. `body_html` already says "This is
 * a gel, not a paste", so the naming was half-right. But the how-to on the template
 * — in TWO places, the details tab and FAQ 6 — said:
 *
 *     "Squeeze a pea-sized amount onto a WET toothbrush"
 *
 * It is a gel with no SLS. It does not need water to work, and water is exactly what
 * makes it run off the bristles. We were telling people to do the thing that produces
 * the complaint. Every edit here replaces that instruction with a dry brush and says
 * why, so the reason travels with the rule.
 *
 * FOUR EDITS ACROSS TWO SURFACES, because this product renders both:
 *   - template `landing-page-toothpaste`: tab-howto, faq-6 (the two wet-brush
 *     instructions) and faq-1 (the "why is the texture thinner" answer, which had
 *     the batch-variation explanation but never said the consistency is correct).
 *   - product `body_html`: the closing gel line gains the dry-brush instruction, so
 *     the two surfaces agree.
 *
 * The product TITLE keeps the word "toothpaste". It is the category name and the
 * ranking term — the same rule as never renaming an antiperspirant slug: ranking for
 * the query is fine, and "Coconut Oil Gel" would match nothing anybody searches.
 *
 * Template edits go through lib/theme-template-edit.js (raw text, never a
 * reserialise; each BEFORE must occur exactly once or the run is refused). Every
 * AFTER is gated. Originals are written to data/reports/toothpaste-gel-fix/<stamp>/.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getMainThemeId, getThemeAssetRaw, updateThemeAsset, getProducts, updateProduct } from '../lib/shopify.js';
import { checkSeoCopyFields } from '../lib/seo-copy-health-gate.js';
import { applyTemplateEdits, assertParsesAsJson } from '../lib/theme-template-edit.js';

const APPLY = process.argv.includes('--apply');

const TEMPLATE_KEY = 'templates/product.landing-page-toothpaste.json';

const TEMPLATE_EDITS = [
  {
    id: 'howto-dry-brush',
    before:
      "<p>Shake the bottle before use — coconut oil firms below 76°F, so the gel can settle. Squeeze a pea-sized amount onto a wet toothbrush and brush as you normally would for two minutes. It won't foam, and the mint will feel quieter than industrial paste — that's the formula working.</p>",
    after:
      "<p><strong>Use it on a dry brush — do not add water.</strong> Shake the bottle first: coconut oil firms below 76°F, so the gel can settle. Squeeze a pea-sized amount onto a <em>dry</em> toothbrush and brush as you normally would for two minutes. There is no SLS in this formula, so it does not need water to work — wetting the brush only thins the gel and it slides off the bristles. It won't foam, and the mint will feel quieter than industrial paste — that's the formula working.</p>",
  },
  {
    id: 'faq6-dry-brush',
    before:
      "<p>Shake the bottle before use — coconut oil firms up below 76°F, so the gel can settle. Squeeze a pea-sized amount onto a wet toothbrush and brush as you normally would for two minutes. It won't foam. The mint will feel quieter than industrial paste. Many customers report teeth feel polished after use — a side effect of the lauric acid plus baking soda doing their work.</p>",
    after:
      "<p><strong>Use it on a dry brush — do not add water.</strong> Shake the bottle first: coconut oil firms up below 76°F, so the gel can settle. Squeeze a pea-sized amount onto a <em>dry</em> toothbrush and brush as you normally would for two minutes. There is no SLS in this formula, so it does not need water to work — wetting the brush only thins the gel and it runs off. It won't foam. The mint will feel quieter than industrial paste. Many customers report teeth feel polished after use — a side effect of the lauric acid plus baking soda doing their work.</p>",
  },
  {
    id: 'faq1-gel-by-design',
    before:
      '<p>The texture shifts batch to batch because cold-pressed virgin coconut oil shifts batch to batch. Every harvest is a little different. Refined oil is uniform because the lab strips that variation out, along with most of what makes the oil worth using. We accept that, because it is what real oil does. Shake before use; coconut oil firms up below 76&deg;F.</p>',
    after:
      '<p><strong>It is a gel, not a paste</strong> — thinner than drugstore toothpaste is correct, not a defect. Use it on a dry brush and it stays put; add water and it will run off, because there is no SLS in it to hold it together. Beyond that, the texture shifts batch to batch because cold-pressed virgin coconut oil shifts batch to batch. Every harvest is a little different. Refined oil is uniform because the lab strips that variation out, along with most of what makes the oil worth using. We accept that, because it is what real oil does. Shake before use; coconut oil firms up below 76&deg;F.</p>',
  },
];

const PRODUCT_EDIT = {
  handle: 'coconut-oil-toothpaste',
  id: 'body-dry-brush',
  before: '<p>This is a gel, not a paste. Shake before use; coconut oil firms up below 76°F.</p>',
  after:
    "<p>This is a gel, not a paste. Use it on a dry brush — there is no SLS in it, so it does not need water, and wetting the brush only thins the gel and it runs off. Shake before use; coconut oil firms up below 76°F.</p>",
};

async function main() {
  const fields = {};
  for (const e of TEMPLATE_EDITS) fields[`toothpaste:${e.id}`] = e.after;
  fields[`toothpaste:${PRODUCT_EDIT.id}`] = PRODUCT_EDIT.after;
  const gate = checkSeoCopyFields(fields);
  if (!gate.ok) {
    console.error('REFUSED — replacement copy fails the SEO copy health gate:');
    for (const v of gate.blocking) console.error(`  [${v.category}] ${v.field}: "${v.match}"`);
    process.exit(1);
  }
  for (const a of gate.advisory || []) console.log(`  advisory [${a.category}] ${a.field}: "${a.match}"`);
  console.log(`Health gate: PASS on ${Object.keys(fields).length} replacement strings\n`);

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = join('data', 'reports', 'toothpaste-gel-fix', stamp);
  const results = [];

  // ---- template ----
  const themeId = await getMainThemeId();
  const asset = await getThemeAssetRaw(themeId, TEMPLATE_KEY);
  if (!asset || typeof asset.value !== 'string') throw new Error(`Could not read ${TEMPLATE_KEY}.`);
  const originalTemplate = asset.value;
  const { text: newTemplate, results: tplResults } = applyTemplateEdits(originalTemplate, TEMPLATE_EDITS, {
    label: TEMPLATE_KEY,
  });
  for (const r of tplResults) {
    console.log(`  ${TEMPLATE_KEY} :: ${r.id} — ${r.outcome}`);
    results.push({ surface: 'template', ...r });
  }

  // ---- product body ----
  const products = await getProducts({ limit: 250 });
  const product = products.find((p) => p.handle === PRODUCT_EDIT.handle);
  if (!product) throw new Error(`Product ${PRODUCT_EDIT.handle} not found.`);
  const liveBody = product.body_html || '';
  let newBody = null;
  if (liveBody.includes(PRODUCT_EDIT.after)) {
    console.log(`  ${PRODUCT_EDIT.handle} body :: ${PRODUCT_EDIT.id} — already-applied`);
    results.push({ surface: 'product', id: PRODUCT_EDIT.id, outcome: 'already-applied' });
  } else if (!liveBody.includes(PRODUCT_EDIT.before)) {
    throw new Error(
      `${PRODUCT_EDIT.handle} body :: ${PRODUCT_EDIT.id} — BEFORE not found in the live body. ` +
        `The product description has changed since this plan was written; refusing the whole run.`
    );
  } else {
    newBody = liveBody.replace(PRODUCT_EDIT.before, PRODUCT_EDIT.after);
    console.log(`  ${PRODUCT_EDIT.handle} body :: ${PRODUCT_EDIT.id} — rewritten`);
    results.push({ surface: 'product', id: PRODUCT_EDIT.id, outcome: 'rewritten' });
  }

  const templateChanged = newTemplate !== originalTemplate;
  if (!templateChanged && !newBody) {
    console.log('\nNothing to do — every edit is already applied.');
    return;
  }
  if (templateChanged) assertParsesAsJson(newTemplate, TEMPLATE_KEY);

  mkdirSync(dir, { recursive: true });
  if (templateChanged) {
    writeFileSync(join(dir, 'template.before.json'), originalTemplate);
    writeFileSync(join(dir, 'template.after.json'), newTemplate);
  }
  if (newBody) {
    writeFileSync(join(dir, 'product-body.before.html'), liveBody);
    writeFileSync(join(dir, 'product-body.after.html'), newBody);
  }
  writeFileSync(
    join(dir, 'run.json'),
    JSON.stringify({ at: new Date().toISOString(), themeId, applied: APPLY, results }, null, 2)
  );
  console.log(`\nBackup + run record: ${dir}/`);

  if (!APPLY) {
    console.log('\nDRY RUN — pass --apply to write LIVE.');
    return;
  }
  if (templateChanged) {
    await updateThemeAsset(themeId, TEMPLATE_KEY, newTemplate);
    console.log(`  PUSHED ${TEMPLATE_KEY} to theme ${themeId}`);
  }
  if (newBody) {
    await updateProduct(product.id, { body_html: newBody });
    console.log(`  APPLIED body_html to product ${product.id}`);
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
