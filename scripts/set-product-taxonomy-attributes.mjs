// Populates Shopify category-taxonomy attributes (`shopify.*` metafields) on
// Real Skin Care products, so Shopify Catalog / Agentic Storefronts can match
// them against AI shopper intent.
//
// WHY: agentic ranking matches product ATTRIBUTES against shopper intent.
// `coconut-lotion` is the only SKU with rich attributes (11) and the only SKU
// that has earned AI orders (15 of 18). AI shoppers search in "free-from"
// terms — "paraben free coconut oil soap", "fluoride free toothpaste". Those
// are `product-certifications-standards` and `fluoride-content` values.
//
// Usage:
//   node scripts/set-product-taxonomy-attributes.mjs                  # dry run (default)
//   node scripts/set-product-taxonomy-attributes.mjs --handle coconut-soap
//   node scripts/set-product-taxonomy-attributes.mjs --handle coconut-soap --apply
//   node scripts/set-product-taxonomy-attributes.mjs --apply          # all products in PLAN
//
// SAFETY / SCOPE
//   - Writes ONLY metafields, via `metafieldsSet`. That mutation structurally
//     cannot touch status, price, publications, inventory, title or body_html.
//   - Never touches a product absent from PLAN. The four deliberately-drafted
//     bundles are absent by construction.
//   - Merges by union with whatever is already on the product. Existing values
//     are never dropped except by an explicit `remove` block with a reason.
//
// TRUTH RULES (non-negotiable — see the `evidence` field on every entry)
//   1. Only assert what is verifiable from config/ingredients.json or the live
//      PDP. An empty attribute is fine; a false one is a claim to defend.
//   2. `product-certifications-standards` carries only DESCRIPTIVE, ingredient-
//      verifiable values (Paraben-free, Vegan, Sulfate-free, ...). Nothing
//      implying a third-party certification we do not hold — no USDA Organic,
//      no Leaping Bunny, no EWG Verified, no Ecocert, no "Organic".
//   3. Health claims are gated by findHealthClaims() before anything is written.
//      These are cosmetics: no disease name, no treat/cure/prevent.
//
// DISCOVERY (nothing is hard-coded that Shopify can tell us)
//   - The valid attribute set is read from the product's own TaxonomyCategory.
//     An attribute not valid for that category is a FATAL error, not a skip.
//   - The valid value set is read from that attribute. An unknown value name is
//     a FATAL error.
//   - The `shopify.<key>` metafield key is resolved from
//     standardMetafieldDefinitionTemplates by attribute name — never guessed.
//     (The attribute named "Color" maps to key `color-pattern`; slugifying the
//     name would have been wrong.)
//   - Metaobject GIDs are resolved by matching each metaobject's
//     `taxonomy_reference` field against the TaxonomyValue id. Missing entries
//     are materialised with metaobjectUpsert. No GID is ever invented.

import { shopifyGraphQL } from '../lib/shopify.js';
import { findHealthClaims } from '../agents/ad-studio/health-claims.js';

// ---------------------------------------------------------------------------
// PLAN — attribute name -> value names, with the evidence for each.
// Attribute names are the Shopify taxonomy attribute names, matched exactly.
// ---------------------------------------------------------------------------

const PLAN = {
  'coconut-soap': {
    note: 'Bar Soap. Single-ingredient saponified coconut oil.',
    set: {
      'Product certifications & standards': {
        values: ['Paraben-free', 'Sulfate-free', 'Vegan', 'All-natural ingredients', 'Dye-free'],
        evidence:
          'config/ingredients.json bar_soap.base_ingredients = ["saponified organic virgin coconut oil"] (no parabens, no sulfates, no animal fat, no dyes). PDP: "No SLS, no SLES, no EDTA, no sodium tallowate"; "No rendered animal fat in the base"; "No parabens, no dyes, no triclosan".',
      },
      'Product form': {
        values: ['Solid'],
        evidence: 'config/ingredients.json bar_soap.format = "bar". A bar of soap is a solid.',
      },
      'Constitutive ingredients': {
        values: ['Coconut oil', 'Essential oil', 'Lavender oil', 'Tea tree oil', 'Lemongrass oil'],
        evidence:
          'config/ingredients.json bar_soap: base = saponified organic virgin coconut oil; variation essential_oils = lavender (calming-lavender), tea tree (nourishing-tea-tree), lemongrass + tea tree (refreshing-lemongrass).',
      },
      Fragrance: {
        values: ['Lavender', 'Tea tree', 'Unscented'],
        evidence:
          'config/ingredients.json bar_soap variations: Calming Lavender, Nourishing Tea Tree, Pure Unscented (essential_oils: []). PDP: "Pure Unscented (no oils added)".',
      },
      'Skin care effect': {
        values: ['Cleansing'],
        evidence: 'The product is soap. PDP: "Saponified organic virgin coconut oil produces true soap molecules".',
      },
      'Body area': {
        values: ['Full body'],
        evidence: 'Sold as a body bar soap — PDP title "Moisturizing Coconut Soap | 3.4oz", body-wash use case.',
      },
    },
  },

  'organic-foaming-hand-soap': {
    note: 'Liquid Hand Soap, 8oz foaming pump. Currently zero taxonomy attributes.',
    set: {
      'Product certifications & standards': {
        values: ['Paraben-free', 'Sulfate-free', 'Vegan', 'All-natural ingredients', 'Dye-free'],
        evidence:
          'config/ingredients.json liquid_soap.base_ingredients = ["saponified organic virgin coconut oil"]. PDP: "No SLS or SLES. No cocamidopropyl betaine. No propylene glycol. No parabens. No triclosan. No EDTA. No dyes."',
      },
      'Product form': {
        values: ['Foam'],
        evidence: 'config/ingredients.json liquid_soap.format = "foaming pump bottle". PDP: "Foaming dispenser only".',
      },
      'Package type': {
        values: ['Pump bottle'],
        evidence: 'config/ingredients.json liquid_soap.format = "foaming pump bottle".',
      },
      'Body area': {
        values: ['Hands'],
        evidence: 'Product title "Foaming Liquid Coconut Oil Soap | 8oz", PDP: "Designed for hands that wash often".',
      },
      'Usage type': {
        values: ['Refillable'],
        evidence: 'The store sells foam-soap-refill-32oz, a refill for this dispenser.',
      },
      'Suitable for skin type': {
        values: ['Sensitive'],
        evidence: 'PDP: "Designed for hands that wash often and react to detergent."',
      },
      'Skin care effect': {
        values: ['Cleansing'],
        evidence: 'The product is soap. PDP: "lifts oil and dirt".',
      },
      'Constitutive ingredients': {
        values: ['Coconut oil', 'Essential oil', 'Lavender oil', 'Orange'],
        evidence:
          'config/ingredients.json liquid_soap: base = saponified organic virgin coconut oil; variation essential_oils include lavender (calming-lavender) and orange/bergamot/lemon/grapefruit (orange-zest).',
      },
      Fragrance: {
        values: ['Citrus', 'Lavender', 'Unscented'],
        evidence:
          'config/ingredients.json liquid_soap variations: Orange Zest (orange, bergamot, lemon, grapefruit oils = citrus), Calming Lavender, Pure Unscented (essential_oils: []).',
      },
    },
  },

  'foam-soap-refill-32oz': {
    note: 'Same formulation as the 8oz, in refill format.',
    set: {
      'Product certifications & standards': {
        values: ['Paraben-free', 'Sulfate-free', 'Vegan', 'All-natural ingredients', 'Dye-free'],
        evidence:
          'Same formulation as organic-foaming-hand-soap — PDP: "The formula is the same as our ready-to-use foam soap". PDP: "No SLS, no SLES, no cocamidopropyl betaine... no parabens, no triclosan, no synthetic fragrance, no EDTA, no dyes."',
      },
      'Package type': {
        values: ['Refill'],
        evidence: 'Product title "Foam Soap Refill | 32oz". PDP: "meant to be diluted before refilling".',
      },
      'Usage type': {
        values: ['Refillable'],
        evidence: 'It is the refill SKU for the foaming dispenser.',
      },
      'Body area': {
        values: ['Hands'],
        evidence: 'Refill for the hand-soap dispenser. PDP: "refills your foaming dispenser".',
      },
      'Skin care effect': {
        values: ['Cleansing'],
        evidence: 'The product is soap. PDP: "nothing else doing the cleaning work".',
      },
      'Constitutive ingredients': {
        values: ['Coconut oil', 'Essential oil', 'Lavender oil', 'Orange'],
        evidence: 'Same formulation and variation set as organic-foaming-hand-soap (config/ingredients.json liquid_soap).',
      },
      Fragrance: {
        values: ['Citrus', 'Lavender', 'Unscented'],
        evidence: 'Variants: Pure Unscented / Coconut Breeze / Calming Lavender / Orange Zest.',
      },
    },
  },

  'coconut-oil-deodorant': {
    note: 'Deodorants category — note it has NO "Constitutive ingredients" attribute.',
    set: {
      'Product certifications & standards': {
        values: ['Aluminum-free', 'Paraben-free', 'Vegan', 'All-natural ingredients', 'Alcohol-free'],
        evidence:
          'config/ingredients.json deodorant.base_ingredients (water, coconut oil, jojoba, plant-based emulsifying wax, grapefruit seed extract, sodium bicarbonate) contains no aluminium, no parabens, no animal ingredient and no alcohol. PDP: "No aluminum, no propylene glycol, no synthetic fragrance"; "we use measured aluminum-free baking soda". tests/config/deodorant-4-pack.test.js asserts the aluminium-free claim against the formulation.',
      },
      'Product form': {
        values: ['Roll-on'],
        evidence:
          'config/ingredients.json deodorant.format = "roll-on". PDP: "A roll-on, not a stick." (Existing value "Liquid" is also true and is kept — the formulation is liquid.)',
      },
      'Dispenser type': {
        values: ['Roll-on'],
        evidence: 'config/ingredients.json deodorant.format = "roll-on". PDP: "A roll-on, not a stick."',
      },
      'Target gender': {
        values: ['Unisex'],
        evidence:
          'Four scents marketed to all buyers; no gendered SKU exists. Matches the Unisex value already set on coconut-oil-lip-balm.',
      },
      'Suitable for skin type': {
        values: ['Sensitive'],
        evidence:
          'PDP: "If five or six \'natural\' deodorants have failed your underarms by 2pm — or triggered a rash the next morning — this was built for you."',
      },
      // NOT SET: Fragrance (Lavender / Floral / Woody / Sandalwood). All four are
      // true of the variants, but Shopify is internally inconsistent here: the
      // Deodorants taxonomy category (hb-3-5-2) lists "Fragrance" as a valid
      // attribute, while the standard `shopify.fragrance` metafield definition
      // is NOT constrained to that category. Writing it returns
      // "Owner subtype does not match the metafield definition's constraints".
      // The preflight below catches this; revisit if Shopify widens the
      // constraint. Nothing false is being suppressed — only unwritable.
    },
  },

  'coconut-oil-toothpaste': {
    note: 'Toothpaste. `Fluoride content` is the highest-value attribute in this job.',
    set: {
      'Fluoride content': {
        values: ['Fluoride-free'],
        evidence:
          'config/ingredients.json toothpaste.base_ingredients contains no fluoride. PDP: "No SLS, no fluoride, no titanium dioxide, no synthetic sweeteners." Product title: "Coconut Oil Toothpaste — Natural Oral Care, Fluoride Free".',
      },
      'Product certifications & standards': {
        values: ['Aluminum-free', 'Paraben-free', 'Sulfate-free', 'Vegan', 'All-natural ingredients'],
        evidence:
          'config/ingredients.json toothpaste.base_ingredients (water, coconut oil, baking soda, xanthan gum, wildcrafted myrrh, stevia) is entirely plant/mineral — no animal ingredient, no parabens, no sulfates, no aluminium. PDP: "No SLS"; "Aluminum-free baking soda".',
      },
      'Product form': {
        values: ['Gel'],
        evidence: 'PDP states it explicitly: "This is a gel, not a paste."',
      },
      Flavor: {
        values: ['Mint', 'Cinnamon'],
        evidence:
          'config/ingredients.json toothpaste variations: Fresh Mint (peppermint + spearmint), Cinnamon Spice (cinnamon + clove), All Natural (peppermint, spearmint, cinnamon, clove).',
      },
    },
  },

  'coconut-moisturizer': {
    note: 'Body Cream — same taxonomy category as coconut-lotion, so the lotion template applies EXCEPT Vegan (this contains beeswax).',
    set: {
      'Product form': {
        values: ['Cream'],
        evidence: 'config/ingredients.json cream.name = "Body Cream", format = "jar". PDP: "We built this cream around organic beeswax".',
      },
      'Product certifications & standards': {
        values: ['All-natural ingredients'],
        evidence:
          'config/ingredients.json cream.base_ingredients are all plant- or bee-derived. PDP: "No lanolin, no synthetic fragrance, no parabens, no phenoxyethanol." (Paraben-free already set. Vegan deliberately NOT set — contains organic beeswax.)',
      },
      'Ingredient origin': {
        values: ['Natural'],
        evidence: 'config/ingredients.json cream.base_ingredients are all plant- or bee-derived; no synthetic actives.',
      },
      'Body area': {
        values: ['Full body'],
        evidence: 'Sold as a body cream (config/ingredients.json cream.name = "Body Cream").',
      },
      'Skin care effect': {
        values: ['Hydrating', 'Moisturizing'],
        evidence: 'It is a moisturiser. PDP: "locks moisture in"; product title "Coconut Moisturizer | 4oz".',
      },
      'Skin care features': {
        values: ['Moisturizing'],
        evidence: 'Same as above. ("Long lasting" deliberately NOT set — not verifiable.)',
      },
      'Suitable for skin type': {
        values: ['Sensitive'],
        evidence: 'PDP states it explicitly: "Sensitive-skin formulated." (Existing value "All skin types" is kept.)',
      },
      Fragrance: {
        values: ['Lavender', 'Rose', 'Unscented'],
        evidence:
          'config/ingredients.json cream variations: Calming Lavender, Lavender & Rose, Rose Petal, Pure Unscented (essential_oils: []).',
      },
    },
  },

  'coconut-oil-lip-balm': {
    note: 'Lip Balms. Contains organic beeswax, so the existing "Vegan" value is FALSE and is removed.',
    remove: {
      'Product certifications & standards': {
        values: ['Vegan'],
        reason:
          'FALSE CLAIM. config/ingredients.json lip_balm.base_ingredients includes "organic beeswax"; PDP: "Organic beeswax forms a breathable barrier". Beeswax is an animal product, so the product is not vegan.',
      },
    },
    set: {
      'Product certifications & standards': {
        values: ['All-natural ingredients'],
        evidence:
          'config/ingredients.json lip_balm.base_ingredients = coconut oil, beeswax, red palm oil. PDP: "No lanolin, no petrolatum, no paraffin, no parabens, no menthol, no synthetic flavoring."',
      },
      'Ingredient origin': {
        values: ['Natural'],
        evidence: 'Three ingredients, all plant- or bee-derived.',
      },
      'Skin care effect': {
        values: ['Hydrating', 'Moisturizing'],
        evidence: 'It is a lip balm. PDP: "beeswax holds water in"; "medium-chain fatty acids that absorb into the thin skin of the lips".',
      },
      'Suitable for skin type': {
        values: ['Dry'],
        evidence: 'PDP: "Built for lips that stay chapped no matter what balm they try."',
      },
      'Lip balm tint level': {
        values: ['Sheer tint'],
        evidence: 'PDP states it explicitly: "The light tint comes from the oil, not added pigment."',
      },
      'Constitutive ingredients': {
        values: ['Essential oil', 'Orange'],
        evidence:
          'config/ingredients.json lip_balm variations: Sweet Tangerine (tangerine, orange, lemon oils), Vanilla Dream, Coconut Breeze. (Coconut oil and Beeswax already set.)',
      },
      Fragrance: {
        values: ['Vanilla', 'Citrus', 'Unscented'],
        evidence:
          'config/ingredients.json lip_balm variations: Vanilla Dream (vanilla extract), Sweet Tangerine (tangerine/orange/lemon = citrus), Pure Unscented (essential_oils: []).',
      },
    },
  },
};

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const onlyHandle = (() => {
  const i = args.indexOf('--handle');
  return i >= 0 ? args[i + 1] : null;
})();

const handles = onlyHandle ? [onlyHandle] : Object.keys(PLAN);
for (const h of handles) {
  if (!PLAN[h]) throw new Error(`FATAL: "${h}" is not in PLAN. Known: ${Object.keys(PLAN).join(', ')}`);
}

// ---------------------------------------------------------------------------
// Gate: health claims. Runs before any network write.
// ---------------------------------------------------------------------------

function gateHealthClaims() {
  const violations = [];
  for (const [handle, spec] of Object.entries(PLAN)) {
    for (const block of ['set', 'remove']) {
      for (const [attr, entry] of Object.entries(spec[block] || {})) {
        for (const text of [attr, ...entry.values]) {
          const hits = findHealthClaims(text);
          if (hits.length) violations.push(`${handle} / ${block} / ${attr} / "${text}": ${hits.map((x) => x.category).join(', ')}`);
        }
      }
    }
  }
  if (violations.length) {
    throw new Error(`FATAL: health-claim gate rejected planned taxonomy values:\n  ${violations.join('\n  ')}`);
  }
}

// ---------------------------------------------------------------------------
// Shopify discovery helpers
// ---------------------------------------------------------------------------

const categoryCache = new Map();
const templateCache = new Map(); // attribute name -> metafield key
const metaobjectCache = new Map(); // "shopify--key" -> Map(taxonomyValueId -> metaobjectGid)
const enabledDefs = new Set();

async function fetchProduct(handle) {
  const d = await shopifyGraphQL(
    `query($h:String!){ productByHandle(handle:$h){
        id handle title status
        category { id name fullName }
        metafields(first: 50, namespace: "shopify") { nodes { key type value } }
      } }`,
    { h: handle },
  );
  if (!d.productByHandle) throw new Error(`FATAL: no product with handle "${handle}"`);
  return d.productByHandle;
}

async function fetchCategoryAttributes(categoryId) {
  if (categoryCache.has(categoryId)) return categoryCache.get(categoryId);
  const d = await shopifyGraphQL(
    `query($id: ID!){ node(id:$id){ ... on TaxonomyCategory {
        id fullName
        attributes(first: 60) { nodes { __typename
          ... on TaxonomyChoiceListAttribute { id name values(first: 250) { nodes { id name } } }
          ... on TaxonomyMeasurementAttribute { id name } } } } } }`,
    { id: categoryId },
  );
  // Flatten `values { nodes }` so callers can treat `values` as a plain array.
  const attrs = d.node.attributes.nodes.map((a) => ({ ...a, values: a.values ? a.values.nodes : null }));
  categoryCache.set(categoryId, attrs);
  return attrs;
}

// The attribute NAME -> metafield KEY map comes from Shopify, never from a slug.
async function loadTemplates() {
  if (templateCache.size) return;
  let after = null;
  for (let page = 0; page < 20; page++) {
    const d = await shopifyGraphQL(
      `query($a:String){ standardMetafieldDefinitionTemplates(first:250, after:$a){
          pageInfo{ hasNextPage endCursor }
          nodes{ id name namespace key ownerTypes } } }`,
      { a: after },
    );
    const c = d.standardMetafieldDefinitionTemplates;
    for (const t of c.nodes) {
      if (t.namespace !== 'shopify') continue;
      if (!t.ownerTypes.includes('PRODUCT')) continue;
      if (!templateCache.has(t.name)) templateCache.set(t.name, t.key);
    }
    if (!c.pageInfo.hasNextPage) break;
    after = c.pageInfo.endCursor;
  }
}

async function ensureDefinitions(key) {
  if (enabledDefs.has(key)) return;
  const mo = await shopifyGraphQL(
    `mutation($t:String!){ standardMetaobjectDefinitionEnable(type:$t){
        metaobjectDefinition{ id type } userErrors{ field message code } } }`,
    { t: `shopify--${key}` },
  );
  const moErrs = (mo.standardMetaobjectDefinitionEnable.userErrors || []).filter((e) => !/taken|already/i.test(`${e.code} ${e.message}`));
  if (moErrs.length) throw new Error(`FATAL: could not enable metaobject definition shopify--${key}: ${JSON.stringify(moErrs)}`);

  const mf = await shopifyGraphQL(
    `mutation($ns:String!,$k:String!){ standardMetafieldDefinitionEnable(ownerType: PRODUCT, namespace:$ns, key:$k){
        createdDefinition{ id key } userErrors{ field message code } } }`,
    { ns: 'shopify', k: key },
  );
  const mfErrs = (mf.standardMetafieldDefinitionEnable.userErrors || []).filter((e) => !/taken|already/i.test(`${e.code} ${e.message}`));
  if (mfErrs.length) throw new Error(`FATAL: could not enable metafield definition shopify.${key}: ${JSON.stringify(mfErrs)}`);

  enabledDefs.add(key);
}

// A standard metafield definition is constrained to a set of taxonomy
// categories. That set does NOT always match the category's own attribute list
// (see the deodorant Fragrance note above), so check it before writing —
// otherwise metafieldsSet fails mid-run with an opaque INVALID_VALUE.
const constraintCache = new Map(); // metafield key -> Set(category short id) | null (unconstrained)

async function loadConstraints(key) {
  if (constraintCache.has(key)) return constraintCache.get(key);
  const d = await shopifyGraphQL(
    `query($ns:String!,$k:String!){ metafieldDefinitions(first:1, ownerType: PRODUCT, namespace:$ns, key:$k){ nodes{ id } } }`,
    { ns: 'shopify', k: key },
  );
  const node = d.metafieldDefinitions.nodes[0];
  if (!node) throw new Error(`FATAL: metafield definition shopify.${key} does not exist after enabling it.`);
  const values = new Set();
  let after = null;
  let unconstrained = false;
  for (let page = 0; page < 30; page++) {
    const r = await shopifyGraphQL(
      `query($id:ID!,$a:String){ node(id:$id){ ... on MetafieldDefinition {
          constraints{ key values(first:250, after:$a){ pageInfo{ hasNextPage endCursor } nodes{ value } } } } } }`,
      { id: node.id, a: after },
    );
    const c = r.node.constraints;
    if (!c) { unconstrained = true; break; }
    for (const v of c.values.nodes) values.add(v.value);
    if (!c.values.pageInfo.hasNextPage) break;
    after = c.values.pageInfo.endCursor;
  }
  const result = unconstrained ? null : values;
  constraintCache.set(key, result);
  return result;
}

function categoryShortId(categoryGid) {
  return categoryGid.split('/').pop();
}

async function assertCategoryAllowed(key, product) {
  const allowed = await loadConstraints(key);
  if (!allowed) return; // unconstrained definition
  const short = categoryShortId(product.category.id);
  if (allowed.has(short)) return;
  throw new Error(
    `FATAL: the standard metafield definition shopify.${key} is not constrained to ` +
      `"${product.category.fullName}" (${short}), even though that category lists the attribute as valid. ` +
      `Shopify would reject the write with "Owner subtype does not match the metafield definition's constraints". ` +
      `Remove this attribute from PLAN["${product.handle}"] or wait for Shopify to widen the constraint.`,
  );
}

async function loadMetaobjects(key) {
  const type = `shopify--${key}`;
  if (metaobjectCache.has(type)) return metaobjectCache.get(type);
  const map = new Map();
  let after = null;
  for (let page = 0; page < 20; page++) {
    const d = await shopifyGraphQL(
      `query($t:String!,$a:String){ metaobjects(type:$t, first:250, after:$a){
          pageInfo{ hasNextPage endCursor }
          nodes{ id handle fields{ key value } } } }`,
      { t: type, a: after },
    );
    for (const n of d.metaobjects.nodes) {
      const ref = n.fields.find((f) => f.key === 'taxonomy_reference');
      if (ref?.value) map.set(ref.value, n.id);
    }
    if (!d.metaobjects.pageInfo.hasNextPage) break;
    after = d.metaobjects.pageInfo.endCursor;
  }
  metaobjectCache.set(type, map);
  return map;
}

function slugify(label) {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

// Resolve a TaxonomyValue to the shop's metaobject GID, materialising it if the
// shop has never used that value. Never invents a GID.
async function resolveMetaobjectGid(key, taxonomyValueId, label, { apply }) {
  const map = await loadMetaobjects(key);
  const existing = map.get(taxonomyValueId);
  if (existing) return { gid: existing, created: false };
  if (!apply) return { gid: null, created: true }; // dry run: report, don't write

  const d = await shopifyGraphQL(
    `mutation($h:MetaobjectHandleInput!,$m:MetaobjectUpsertInput!){
       metaobjectUpsert(handle:$h, metaobject:$m){
         metaobject{ id handle } userErrors{ field message code } } }`,
    {
      h: { type: `shopify--${key}`, handle: slugify(label) },
      m: { fields: [{ key: 'label', value: label }, { key: 'taxonomy_reference', value: taxonomyValueId }] },
    },
  );
  const errs = d.metaobjectUpsert.userErrors || [];
  if (errs.length) throw new Error(`FATAL: metaobjectUpsert failed for shopify--${key} "${label}": ${JSON.stringify(errs)}`);
  const gid = d.metaobjectUpsert.metaobject.id;
  map.set(taxonomyValueId, gid);
  return { gid, created: true };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

gateHealthClaims();
await loadTemplates();

console.log(`\nSet product taxonomy attributes — ${APPLY ? 'APPLY (writing)' : 'DRY RUN (default; pass --apply to write)'}`);
console.log(`Products: ${handles.join(', ')}\n`);

const summary = [];
let totalWrites = 0;

for (const handle of handles) {
  const spec = PLAN[handle];
  const product = await fetchProduct(handle);
  const before = product.metafields.nodes.length;

  console.log(`\n${'='.repeat(78)}`);
  console.log(`${handle} — ${product.title}`);
  console.log(`  status=${product.status}  category=${product.category ? product.category.fullName : 'NONE'}`);
  console.log(`  ${spec.note}`);
  console.log(`  shopify.* attributes before: ${before}`);

  if (!product.category) throw new Error(`FATAL: ${handle} has no taxonomy category; cannot resolve valid attributes.`);

  const attrs = await fetchCategoryAttributes(product.category.id);
  const existingByKey = new Map(product.metafields.nodes.map((m) => [m.key, JSON.parse(m.value)]));

  const metafieldsToSet = [];

  const attrNames = new Set([...Object.keys(spec.set || {}), ...Object.keys(spec.remove || {})]);

  for (const attrName of attrNames) {
    // Fail loudly if the attribute is not valid for this product's category.
    const attr = attrs.find((a) => a.name === attrName);
    if (!attr) {
      throw new Error(
        `FATAL: attribute "${attrName}" is not valid for ${handle}'s category "${product.category.fullName}". ` +
          `Valid: ${attrs.map((a) => a.name).join(', ')}`,
      );
    }
    if (!attr.values) throw new Error(`FATAL: attribute "${attrName}" on ${handle} is not a choice list.`);

    const key = templateCache.get(attrName);
    if (!key) throw new Error(`FATAL: no standard metafield template for attribute "${attrName}".`);

    await ensureDefinitions(key);
    await assertCategoryAllowed(key, product);

    const current = existingByKey.get(key) || [];
    const removeSpec = spec.remove?.[attrName];
    const setSpec = spec.set?.[attrName];

    // Resolve the GIDs we are removing (so we can subtract them from `current`).
    const removeGids = new Set();
    if (removeSpec) {
      await ensureDefinitions(key);
      for (const label of removeSpec.values) {
        const v = attr.values.find((x) => x.name === label);
        if (!v) throw new Error(`FATAL: "${label}" is not a valid value of "${attrName}" for ${handle}.`);
        const map = await loadMetaobjects(key);
        const gid = map.get(v.id);
        if (gid) removeGids.add(gid);
      }
    }

    // Resolve the GIDs we are adding.
    const addGids = [];
    const addLabels = [];
    let pendingNewMetaobjects = 0; // dry run only: values whose metaobject does not exist yet
    if (setSpec) {
      await ensureDefinitions(key);
      for (const label of setSpec.values) {
        const v = attr.values.find((x) => x.name === label);
        if (!v) {
          throw new Error(
            `FATAL: "${label}" is not a valid value of "${attrName}" for ${handle} (${product.category.fullName}). ` +
              `Valid: ${attr.values.map((x) => x.name).join(' | ')}`,
          );
        }
        const { gid, created } = await resolveMetaobjectGid(key, v.id, label, { apply: APPLY });
        addLabels.push(created ? `${label} (new metaobject)` : label);
        if (gid) addGids.push(gid);
        else pendingNewMetaobjects++; // dry run: GID will exist once --apply materialises it
      }
    }

    // Union with what is already there, minus explicit removals.
    const next = [...new Set([...current.filter((g) => !removeGids.has(g)), ...addGids])];
    // In a dry run, values needing a brand-new metaobject have no GID yet; count
    // them so the projected total is not understated.
    const projected = next.length + pendingNewMetaobjects;
    const changed = projected !== current.length || next.some((g, i) => g !== current[i]);

    if (removeSpec) {
      console.log(`  - REMOVE  shopify.${key}: ${removeSpec.values.join(', ')}`);
      console.log(`      reason: ${removeSpec.reason}`);
    }
    if (setSpec) {
      console.log(`  + ${attrName}  ->  shopify.${key}`);
      console.log(`      values: ${addLabels.join(', ')}`);
      console.log(`      evidence: ${setSpec.evidence}`);
    }
    console.log(`      ${current.length} value(s) -> ${projected} value(s)${changed ? '' : '  (no change)'}`);

    if (changed) {
      metafieldsToSet.push({ ownerId: product.id, namespace: 'shopify', key, type: 'list.metaobject_reference', value: JSON.stringify(next) });
    }
  }

  if (!metafieldsToSet.length) {
    console.log(`  nothing to write.`);
    summary.push({ handle, before, after: before, written: 0 });
    continue;
  }

  if (!APPLY) {
    console.log(`  DRY RUN — would write ${metafieldsToSet.length} metafield(s).`);
    summary.push({ handle, before, after: '(dry)', written: metafieldsToSet.length });
    continue;
  }

  const res = await shopifyGraphQL(
    `mutation($m:[MetafieldsSetInput!]!){ metafieldsSet(metafields:$m){
        metafields{ key } userErrors{ field message code } } }`,
    { m: metafieldsToSet },
  );
  const errs = res.metafieldsSet.userErrors || [];
  if (errs.length) throw new Error(`FATAL: metafieldsSet failed for ${handle}: ${JSON.stringify(errs)}`);

  const after = await fetchProduct(handle);
  console.log(`  WROTE ${res.metafieldsSet.metafields.length} metafield(s). shopify.* attributes after: ${after.metafields.nodes.length}`);
  totalWrites += res.metafieldsSet.metafields.length;
  summary.push({ handle, before, after: after.metafields.nodes.length, written: res.metafieldsSet.metafields.length });
}

console.log(`\n${'='.repeat(78)}`);
console.log('SUMMARY  (shopify.* attribute count per product)');
for (const s of summary) console.log(`  ${s.handle.padEnd(30)} ${String(s.before).padStart(3)} -> ${String(s.after).padStart(5)}   (${s.written} metafield writes)`);
console.log(`\n${APPLY ? `Applied. ${totalWrites} metafield writes.` : 'Dry run. Re-run with --apply to write.'}`);
