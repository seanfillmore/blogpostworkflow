# Bundle Roster Build Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the three remaining bundles (Hand Soap Set, The Clean Swap $59, Gift Box $62) as componentized Shopify products, driven by a declarative roster that also becomes the input to demand forecasting.

**Architecture:** `config/bundles.json` becomes the single source of truth for every bundle's component mapping. `lib/bundle-roster.js` holds the pure logic (load, validate, derive economics rows) and is where all the tests live. `scripts/build-bundle.mjs` is thin I/O that reconciles Shopify against the roster. `scripts/bundle-economics.mjs` stops hardcoding item counts and derives them from the roster instead, so the financial model can no longer disagree with what ships.

**Tech Stack:** Node 22+ ESM, `node:test` + `node:assert/strict`, Shopify Admin GraphQL `2025-01` via `lib/shopify.js`.

Spec: [`docs/superpowers/specs/2026-07-26-bundle-roster-build-design.md`](../specs/2026-07-26-bundle-roster-build-design.md)

## Global Constraints

- **Componentizing overwrites the variant price with the component sum.** Prices are re-asserted in a separate step *after* componentization, never before. This has caused a production price error twice.
- **Only Online Store and Shop accept componentized bundles.** Google, Meta, Pinterest, TikTok and Buy Button all reject them. Publish one channel at a time and tolerate refusals.
- **Shopify allows a maximum of 3 options per product.** The Hand Soap Set uses 2.
- **Body lotion and body cream ship exactly two scents: Pure Unscented and Coconut Breeze.** A merchandising rule that outranks availability — `coconut-lotion` has a Calming Lavender variant that must not be used.
- **Never create a selling plan group through Shopify's Admin API.** Subscriptions belong to Recurpay; a native group sells but never bills.
- **Bundle inventory takes ~10 seconds to compute** after component mapping. An immediate read of `0` is not a failure.
- **Copy rule:** every bundle leads with duration or completeness, never with savings-versus-single. Compare-at pricing is set, but never leads a heading.
- Money is dollars. Rounding is `Math.round(n * 100) / 100`.
- All new scripts are dry-run by default and take `--apply` to write.

---

## File Structure

| File | Responsibility |
|---|---|
| `config/bundles.json` | **Create.** The roster: every bundle's variants, prices, component mappings, lander copy |
| `lib/bundle-roster.js` | **Create.** Pure logic — load, validate, derive economics rows, handle→SKU map |
| `scripts/build-bundle.mjs` | **Create.** Reconcile one bundle (or all) in Shopify from the roster |
| `scripts/roster-from-shopify.mjs` | **Create.** One-shot generator that emits roster entries for the 5 live bundles |
| `scripts/bundle-economics.mjs` | **Modify.** Derive `items` from the roster; carry `packaging` |
| `lib/shipping-costs.js` | **Modify.** `contribution()` accepts `packaging` |
| `scripts/verify-bundle-contents.mjs` | **Modify.** Add spec↔Shopify and lander↔components checks |
| `tests/lib/bundle-roster.test.js` | **Create.** Roster validation, economics derivation, Hand Soap Set grid |
| `tests/scripts/bundle-economics.test.js` | **Modify.** Packaging cost coverage |

---

### Task 1: Packaging cost in the contribution model

The Gift Box ships in a custom box costing $1.00/unit that the model currently treats as free, overstating its contribution by exactly that. Every other bundle has `packaging: 0` and is unaffected.

**Files:**
- Modify: `lib/shipping-costs.js:98-100`
- Modify: `scripts/bundle-economics.mjs` (the `evaluate` function, ~line 92)
- Test: `tests/scripts/bundle-economics.test.js`

**Interfaces:**
- Consumes: nothing
- Produces: `contribution({ price, cogs, shipping, packaging = 0, feeRate = 0.029, feeFixed = 0.30 }) -> number`; `evaluate()` result objects gain a `packaging` number field

- [ ] **Step 1: Write the failing test**

Append to `tests/scripts/bundle-economics.test.js`:

```javascript
test('packaging cost comes straight off contribution', () => {
  const withoutBox = ev({ name: 'Gift Box', status: 'x', price: 62,
    items: { lotion: 1, lipbalm: 1, barsoap: 1, deo: 1 }, story: '' });
  const withBox = ev({ name: 'Gift Box', status: 'x', price: 62, packaging: 1.00,
    items: { lotion: 1, lipbalm: 1, barsoap: 1, deo: 1 }, story: '' });

  assert.equal(withoutBox.contrib - withBox.contrib, 1.00,
    'a $1 box must cost exactly $1 of contribution');
  assert.equal(withBox.packaging, 1.00, 'packaging must survive onto the result');
});

test('packaging defaults to zero so every other bundle is unchanged', () => {
  const r = ev({ name: 'Reset', status: 'draft', price: 99, items: { lotion: 3, cream: 1 }, story: '' });
  assert.equal(r.packaging, 0);
  assert.equal(r.contrib, 68.06, 'the Reset contribution must not move');
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `node --test tests/scripts/bundle-economics.test.js`
Expected: FAIL — `withoutBox.contrib - withBox.contrib` is `0`, and `withBox.packaging` is `undefined`.

- [ ] **Step 3: Add packaging to `contribution()`**

In `lib/shipping-costs.js`, replace lines 98-100:

```javascript
export function contribution({ price, cogs, shipping, packaging = 0, feeRate = 0.029, feeFixed = 0.30 }) {
  return Math.round((price - cogs - shipping - packaging - (price * feeRate + feeFixed)) * 100) / 100;
}
```

- [ ] **Step 4: Thread it through `evaluate()`**

In `scripts/bundle-economics.mjs`, inside `evaluate()`, replace the `contrib` line and add `packaging` to the returned object:

```javascript
  const packaging = bundle.packaging ?? 0;
  const contrib = contribution({ price: bundle.price, cogs, shipping, packaging });
  return {
    ...bundle, msrp, cogs: round(cogs), pounds: round(pounds), units, shipping, packaging, contrib,
    discountPct: msrp > 0 ? Math.round((1 - bundle.price / msrp) * 100) : 0,
    verdict: contrib >= CAC * 2 ? 'scale' : contrib >= CAC ? 'breakeven' : contrib > 0 ? 'thin' : 'loss',
  };
```

- [ ] **Step 5: Set the Gift Box's packaging cost**

In the `BUNDLES` array in `scripts/bundle-economics.mjs`, add `packaging: 1.00` to the Gift Box entry:

```javascript
  { name: 'Gift Box', status: 'proposed', price: 62, packaging: 1.00,
    items: { lotion: 1, lipbalm: 1, barsoap: 1, deo: 1 },
    story: 'Gifting escapes price comparison entirely. Q4. Ships in the custom box (\$1/unit).' },
```

- [ ] **Step 6: Run the full test suite**

Run: `node --test tests/scripts/bundle-economics.test.js tests/lib/shipping-costs.test.js`
Expected: PASS, all tests. The Gift Box contribution is now `$34.32`.

- [ ] **Step 7: Regenerate the economics doc and commit**

```bash
node scripts/bundle-economics.mjs --write
git add lib/shipping-costs.js scripts/bundle-economics.mjs tests/scripts/bundle-economics.test.js docs/bundle-economics.md
git commit -m "feat(bundles): model per-order packaging cost

The Gift Box ships in a custom box at \$1/unit that the model treated as
free, overstating contribution \$35.32 -> \$34.32. Packaging defaults to 0
so every other bundle is unchanged."
```

---

### Task 2: The roster library — load and validate

Pure logic with no Shopify calls, so it is fully testable. Validation is what makes `config/bundles.json` authoritative: a typo'd variant title must fail loudly rather than silently build the wrong box.

**Files:**
- Create: `lib/bundle-roster.js`
- Test: `tests/lib/bundle-roster.test.js`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `SKU_BY_HANDLE: Record<string, string>` — Shopify product handle → `bundle-economics` SKU key
  - `loadRoster(path?: string) -> { bundles: Bundle[] }`
  - `validateRoster(roster, catalogue) -> string[]` — array of human-readable errors, empty when valid. `catalogue` is `Record<handle, string[]>` mapping a product handle to its variant titles.

- [ ] **Step 1: Write the failing tests**

Create `tests/lib/bundle-roster.test.js`:

```javascript
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { validateRoster, SKU_BY_HANDLE } from '../../lib/bundle-roster.js';

const CATALOGUE = {
  'coconut-lotion': ['Pure Unscented', 'Coconut Breeze', 'Calming Lavender'],
  'coconut-oil-deodorant': ['Geranium Flower', 'Calming Lavender'],
  'coconut-soap': ['Calming Lavender', 'Pure Unscented'],
};

const bundle = (over = {}) => ({
  handle: 'test-bundle', title: 'Test Bundle', status: 'live', packaging: 0,
  options: [{ name: 'Kit', values: ['Gentle'] }],
  variants: [{
    options: { Kit: 'Gentle' }, price: 59, compareAtPrice: 69, contents: '1 × lotion',
    components: [{ product: 'coconut-lotion', variant: 'Pure Unscented', qty: 1 }],
  }],
  ...over,
});

test('a well-formed bundle validates clean', () => {
  assert.deepEqual(validateRoster({ bundles: [bundle()] }, CATALOGUE), []);
});

test('an unknown component product is rejected', () => {
  const bad = bundle({ variants: [{ ...bundle().variants[0],
    components: [{ product: 'nonexistent-product', variant: 'Pure Unscented', qty: 1 }] }] });
  const errs = validateRoster({ bundles: [bad] }, CATALOGUE);
  assert.equal(errs.length, 1);
  assert.match(errs[0], /nonexistent-product/);
});

test('an unknown variant title is rejected — this is the typo that ships the wrong box', () => {
  const bad = bundle({ variants: [{ ...bundle().variants[0],
    components: [{ product: 'coconut-lotion', variant: 'Unscented', qty: 1 }] }] });
  const errs = validateRoster({ bundles: [bad] }, CATALOGUE);
  assert.equal(errs.length, 1);
  assert.match(errs[0], /Unscented/);
});

test('lotion outside the two-scent rule is rejected', () => {
  const bad = bundle({ variants: [{ ...bundle().variants[0],
    components: [{ product: 'coconut-lotion', variant: 'Calming Lavender', qty: 1 }] }] });
  const errs = validateRoster({ bundles: [bad] }, CATALOGUE);
  assert.equal(errs.length, 1);
  assert.match(errs[0], /two-scent rule/);
});

test('a variant whose options do not match the declared option values is rejected', () => {
  const bad = bundle({ variants: [{ ...bundle().variants[0], options: { Kit: 'Bold' } }] });
  const errs = validateRoster({ bundles: [bad] }, CATALOGUE);
  assert.equal(errs.length, 1);
  assert.match(errs[0], /Bold/);
});

test('duplicate handles are rejected', () => {
  const errs = validateRoster({ bundles: [bundle(), bundle()] }, CATALOGUE);
  assert.ok(errs.some(e => /duplicate handle/i.test(e)));
});

test('every component handle maps to a known SKU key', () => {
  for (const key of Object.values(SKU_BY_HANDLE)) {
    assert.ok(typeof key === 'string' && key.length, `bad SKU key: ${key}`);
  }
  assert.equal(SKU_BY_HANDLE['organic-foaming-hand-soap'], 'pump');
  assert.equal(SKU_BY_HANDLE['coconut-soap'], 'barsoap');
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `node --test tests/lib/bundle-roster.test.js`
Expected: FAIL — `Cannot find module '../../lib/bundle-roster.js'`.

- [ ] **Step 3: Write `lib/bundle-roster.js`**

```javascript
/**
 * The bundle roster — `config/bundles.json` — and the pure logic over it.
 *
 * WHY THIS FILE EXISTS
 *   A bundle's component mapping used to live in three places that could
 *   disagree: Shopify's variant relationships, the hardcoded `items` counts in
 *   scripts/bundle-economics.mjs, and prose in docs/bundle-marketing-plan.md.
 *   Disagreement there is not cosmetic — it means the financial model is
 *   describing a box we do not ship, and no demand forecast built on it can be
 *   trusted. This is the one place a bundle is defined.
 *
 *   Validation is the half that makes it authoritative. A typo'd variant title
 *   is not a cosmetic error: it silently ships the wrong scent. That has
 *   happened — a "Gentle" kit shipped cinnamon-clove toothpaste while its copy
 *   promised Fresh Mint.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Shopify product handle -> SKU key in scripts/bundle-economics.mjs. */
export const SKU_BY_HANDLE = {
  'coconut-lotion': 'lotion',
  'coconut-moisturizer': 'cream',
  'foam-soap-refill-32oz': 'refill',
  'coconut-oil-lip-balm': 'lipbalm',
  'coconut-oil-deodorant': 'deo',
  'coconut-oil-toothpaste': 'toothpaste',
  'organic-foaming-hand-soap': 'pump',
  'coconut-soap': 'barsoap',
};

/**
 * Body lotion and cream ship exactly two scents until a bundle proves demand.
 * A merchandising decision, not a stock one — `coconut-lotion` has a Calming
 * Lavender variant that is deliberately unused.
 */
const TWO_SCENT_PRODUCTS = new Set(['coconut-lotion', 'coconut-moisturizer']);
const ALLOWED_SCENTS = new Set(['Pure Unscented', 'Coconut Breeze']);

export function loadRoster(path = join(ROOT, 'config', 'bundles.json')) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/**
 * Validate a roster against the live catalogue.
 * `catalogue` maps a product handle to the list of its variant titles.
 * Returns human-readable errors; empty array means valid.
 */
export function validateRoster(roster, catalogue) {
  const errors = [];
  const seen = new Set();

  for (const b of roster.bundles) {
    const where = `${b.handle}`;

    if (seen.has(b.handle)) errors.push(`${where}: duplicate handle in roster`);
    seen.add(b.handle);

    if (b.packaging != null && b.packaging < 0) errors.push(`${where}: negative packaging cost`);

    const optionValues = Object.fromEntries((b.options ?? []).map(o => [o.name, new Set(o.values)]));

    for (const v of b.variants ?? []) {
      const vWhere = `${where} / ${Object.values(v.options ?? {}).join(' ')}`;

      for (const [name, value] of Object.entries(v.options ?? {})) {
        if (!optionValues[name]) errors.push(`${vWhere}: option "${name}" is not declared on the bundle`);
        else if (!optionValues[name].has(value)) errors.push(`${vWhere}: "${value}" is not a declared value of option "${name}"`);
      }

      for (const c of v.components ?? []) {
        const variants = catalogue[c.product];
        if (!variants) { errors.push(`${vWhere}: unknown component product "${c.product}"`); continue; }
        if (!variants.includes(c.variant)) {
          errors.push(`${vWhere}: "${c.product}" has no variant "${c.variant}" (has: ${variants.join(', ')})`);
        }
        if (TWO_SCENT_PRODUCTS.has(c.product) && !ALLOWED_SCENTS.has(c.variant)) {
          errors.push(`${vWhere}: "${c.product}" / "${c.variant}" breaks the two-scent rule (Pure Unscented or Coconut Breeze only)`);
        }
        if (!SKU_BY_HANDLE[c.product]) errors.push(`${vWhere}: "${c.product}" has no SKU mapping in SKU_BY_HANDLE`);
        if (!Number.isInteger(c.qty) || c.qty < 1) errors.push(`${vWhere}: qty must be a positive integer, got ${c.qty}`);
      }
    }
  }
  return errors;
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `node --test tests/lib/bundle-roster.test.js`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/bundle-roster.js tests/lib/bundle-roster.test.js
git commit -m "feat(bundles): roster library with validation

Validation is what makes config/bundles.json authoritative rather than
aspirational. A typo'd variant title silently ships the wrong scent - that
has happened once already."
```

---

### Task 3: Derive economics rows from the roster

The financial model stops asserting what a bundle contains and computes it. One economics row per *distinct component signature*: the Clean Swap's three kits all hold one of each SKU so they collapse to a single row, while the Hand Soap Set's three configurations are genuinely different baskets and produce three.

**Files:**
- Modify: `lib/bundle-roster.js`
- Test: `tests/lib/bundle-roster.test.js`

**Interfaces:**
- Consumes: `SKU_BY_HANDLE` from Task 2
- Produces: `economicsRows(bundle) -> Array<{ name, status, price, packaging, items, story }>` — shaped exactly as `evaluate()` in `scripts/bundle-economics.mjs` expects

- [ ] **Step 1: Write the failing tests**

Append to `tests/lib/bundle-roster.test.js`:

```javascript
import { economicsRows } from '../../lib/bundle-roster.js';

const CLEAN_SWAP = {
  handle: 'clean-swap', title: 'The Clean Swap', status: 'live', price: 59, packaging: 0,
  story: 'Entry version of the 90-day.',
  options: [{ name: 'Kit', values: ['Gentle', 'Calm'] }],
  variants: [
    { options: { Kit: 'Gentle' }, price: 59, components: [
      { product: 'coconut-lotion', variant: 'Pure Unscented', qty: 1 },
      { product: 'coconut-soap', variant: 'Pure Unscented', qty: 1 }] },
    { options: { Kit: 'Calm' }, price: 59, components: [
      { product: 'coconut-lotion', variant: 'Pure Unscented', qty: 1 },
      { product: 'coconut-soap', variant: 'Calming Lavender', qty: 1 }] },
  ],
};

test('kits with the same basket collapse to one economics row', () => {
  const rows = economicsRows(CLEAN_SWAP);
  assert.equal(rows.length, 1, 'Gentle and Calm differ only by scent, not by basket');
  assert.equal(rows[0].name, 'The Clean Swap');
  assert.deepEqual(rows[0].items, { lotion: 1, barsoap: 1 });
  assert.equal(rows[0].price, 59);
});

test('genuinely different baskets produce a row each, named by configuration', () => {
  const handSoap = {
    handle: 'hand-soap-set', title: 'Hand Soap Set', status: 'live', packaging: 0, story: 'Pumps.',
    options: [
      { name: 'Configuration', values: ['4 pumps', '4 pumps + body lotion'] },
      { name: 'Scent', values: ['Pure Unscented'] },
    ],
    variants: [
      { options: { Configuration: '4 pumps', Scent: 'Pure Unscented' }, price: 44,
        components: [{ product: 'organic-foaming-hand-soap', variant: 'Pure Unscented', qty: 4 }] },
      { options: { Configuration: '4 pumps + body lotion', Scent: 'Pure Unscented' }, price: 72,
        components: [
          { product: 'organic-foaming-hand-soap', variant: 'Pure Unscented', qty: 4 },
          { product: 'coconut-lotion', variant: 'Pure Unscented', qty: 1 }] },
    ],
  };
  const rows = economicsRows(handSoap);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(r => r.name),
    ['Hand Soap Set — 4 pumps', 'Hand Soap Set — 4 pumps + body lotion']);
  assert.deepEqual(rows[0].items, { pump: 4 });
  assert.deepEqual(rows[1].items, { pump: 4, lotion: 1 });
  assert.equal(rows[1].price, 72);
});

test('packaging and status carry onto every row', () => {
  const rows = economicsRows({ ...CLEAN_SWAP, packaging: 1.0, status: 'proposed' });
  assert.equal(rows[0].packaging, 1.0);
  assert.equal(rows[0].status, 'proposed');
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `node --test tests/lib/bundle-roster.test.js`
Expected: FAIL — `economicsRows is not a function`.

- [ ] **Step 3: Implement `economicsRows`**

Append to `lib/bundle-roster.js`:

```javascript
/** Aggregate one variant's components into `{ skuKey: qty }`. */
function itemsOf(variant) {
  const items = {};
  for (const c of variant.components) {
    const key = SKU_BY_HANDLE[c.product];
    items[key] = (items[key] ?? 0) + c.qty;
  }
  return items;
}

/** Stable signature for an item basket, so equal baskets collapse. */
const signature = items => Object.keys(items).sort().map(k => `${k}:${items[k]}`).join('|');

/**
 * Economics rows for one bundle, shaped for `evaluate()` in
 * scripts/bundle-economics.mjs.
 *
 * One row per DISTINCT basket, not per variant. The Clean Swap's three kits
 * hold one of each SKU and differ only by scent, so they are one row. The Hand
 * Soap Set's configurations are different baskets at different prices, so they
 * are three — and the row name carries the configuration to keep them apart.
 */
export function economicsRows(bundle) {
  const configOption = (bundle.options ?? []).find(o => o.name === 'Configuration');
  const bySignature = new Map();

  for (const v of bundle.variants) {
    const items = itemsOf(v);
    const sig = signature(items);
    if (bySignature.has(sig)) continue;
    bySignature.set(sig, {
      items,
      price: v.price,
      config: configOption ? v.options[configOption.name] : null,
    });
  }

  const multiple = bySignature.size > 1;
  const rows = [];
  for (const { items, price, config } of bySignature.values()) {
    rows.push({
      name: multiple && config ? `${bundle.title} — ${config}` : bundle.title,
      status: bundle.status,
      price,
      packaging: bundle.packaging ?? 0,
      items,
      story: bundle.story,
    });
  }

  // Order by the declared Configuration values so the report reads as a ladder.
  if (multiple && configOption) {
    const order = configOption.values;
    rows.sort((a, b) =>
      order.findIndex(c => a.name.endsWith(c)) - order.findIndex(c => b.name.endsWith(c)));
  }
  return rows;
}
```

- [ ] **Step 4: Run and confirm pass**

Run: `node --test tests/lib/bundle-roster.test.js`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/bundle-roster.js tests/lib/bundle-roster.test.js
git commit -m "feat(bundles): derive economics rows from the roster

One row per distinct basket, not per variant - kits that differ only by
scent collapse; configurations at different prices stay separate."
```

---

### Task 4: Author `config/bundles.json`

The three new bundles, written by hand so the file is greppable and diffable, plus the five live bundles backfilled from Shopify so the roster describes the whole catalogue.

**Files:**
- Create: `config/bundles.json`
- Create: `scripts/roster-from-shopify.mjs`
- Test: `tests/lib/bundle-roster.test.js`

**Interfaces:**
- Consumes: `validateRoster`, `loadRoster` (Task 2)
- Produces: `config/bundles.json` containing 8 bundles

- [ ] **Step 1: Write the generator for the five live bundles**

Create `scripts/roster-from-shopify.mjs`:

```javascript
/**
 * Emit roster entries for bundles that already exist in Shopify.
 *
 *   node scripts/roster-from-shopify.mjs [handle …]
 *
 * Read-only. Prints JSON to stdout for pasting into config/bundles.json, so the
 * five live bundles are described by what they actually ship rather than by
 * what anyone remembers. Editorial fields (story, lander) come out empty and
 * are filled by hand.
 */

import { shopifyGraphQL } from '../lib/shopify.js';

const only = process.argv.slice(2);

const q = `{
  products(first: 50, query: "tag:bundle") {
    nodes {
      handle title status templateSuffix tags
      variants(first: 50) {
        nodes {
          title price compareAtPrice
          selectedOptions { name value }
          metafield(namespace: "bundle", key: "contents") { value }
          productVariantComponents(first: 20) {
            nodes { quantity productVariant { title product { handle } } }
          }
        }
      }
      options { name values }
    }
  }
}`;

const { products } = await shopifyGraphQL(q);
const bundles = products.nodes
  .filter(p => p.variants.nodes.some(v => v.productVariantComponents.nodes.length))
  .filter(p => !only.length || only.includes(p.handle))
  .map(p => ({
    handle: p.handle,
    title: p.title,
    status: p.status === 'ACTIVE' ? 'live' : 'draft',
    templateSuffix: p.templateSuffix || null,
    packaging: 0,
    tags: p.tags,
    collections: [],
    story: '',
    options: p.options.map(o => ({ name: o.name, values: o.values })),
    variants: p.variants.nodes.map(v => ({
      options: Object.fromEntries(v.selectedOptions.map(o => [o.name, o.value])),
      price: Number(v.price),
      compareAtPrice: v.compareAtPrice ? Number(v.compareAtPrice) : null,
      contents: v.metafield?.value ?? '',
      components: v.productVariantComponents.nodes.map(c => ({
        product: c.productVariant.product.handle,
        variant: c.productVariant.title,
        qty: c.quantity,
      })),
    })),
  }));

console.log(JSON.stringify({ bundles }, null, 2));
```

- [ ] **Step 2: Generate the live entries**

```bash
node scripts/roster-from-shopify.mjs > /tmp/live-bundles.json
cat /tmp/live-bundles.json
```

Expected: JSON for 5 bundles — `sensitive-skin-starter-set`, `99-coconut-reset-digital`, `coconut-bar-soap-4-pack`, `90-day-clean-swap`, `head-to-toe`.

- [ ] **Step 3: Write `config/bundles.json`**

Start from the generated live entries, then hand-add the three new bundles. Fill each live bundle's `story` from the matching entry in `scripts/bundle-economics.mjs`'s `BUNDLES` array. The three new bundles:

**Hand Soap Set** — `options`: `Configuration` = `["4 pumps", "3 pumps + body lotion", "4 pumps + body lotion"]`, `Scent` = `["Variety", "Calming Lavender", "Orange Zest", "Coconut Breeze", "Pure Unscented"]`. 15 variants. Prices: 4 pumps `44`/compare `52`; 3 pumps + lotion `59`/`69`; 4 pumps + lotion `72`/`82`.

Pump components use `organic-foaming-hand-soap`. Per scent:
- `Variety` on a 4-pump config = 1 each of `Orange Zest`, `Coconut Breeze`, `Calming Lavender`, `Pure Unscented`
- `Variety` on the 3-pump config = 1 each of `Orange Zest`, `Coconut Breeze`, `Calming Lavender`
- any named scent = `qty: 4` (4-pump configs) or `qty: 3` (3-pump config) of that one variant

Lotion (`coconut-lotion`, `qty: 1`) is added only on the two `+ body lotion` configurations, paired: `Coconut Breeze` → `Coconut Breeze`; every other scent → `Pure Unscented`.

**The Clean Swap** — `options`: `Kit` = `["Gentle", "Calm", "Fresh"]`. 3 variants, price `59`, compare `69`. Components, all `qty: 1`:

| Kit | `coconut-lotion` | `coconut-oil-deodorant` | `coconut-oil-toothpaste` | `coconut-soap` |
|---|---|---|---|---|
| Gentle | Pure Unscented | Calming Lavender | Fresh Mint | Pure Unscented |
| Calm | Pure Unscented | Calming Lavender | Fresh Mint | Calming Lavender |
| Fresh | Coconut Breeze | Geranium Flower | Fresh Mint | Nourishing Tea Tree |

**Gift Box** — `options`: `Kit` = `["Gentle", "Calm", "Fresh"]`. 3 variants, price `62`, compare `71`, `packaging: 1.00`. Components, all `qty: 1`:

| Kit | `coconut-lotion` | `coconut-oil-lip-balm` | `coconut-soap` | `coconut-oil-deodorant` |
|---|---|---|---|---|
| Gentle | Pure Unscented | Pure Unscented | Pure Unscented | Calming Lavender |
| Calm | Pure Unscented | Vanilla Dream | Calming Lavender | Calming Lavender |
| Fresh | Coconut Breeze | Sweet Tangerine | Nourishing Tea Tree | Geranium Flower |

Every new bundle gets `"templateSuffix": "bundle-landing"`, `"collections": []`, `"status": "live"`, and a `contents` string per variant listing what is in the box, one line per component, in the house format already used by the Bar Soap 4-Pack: `4 × Calming Lavender (lavender)`.

- [ ] **Step 4: Write the roster test**

Append to `tests/lib/bundle-roster.test.js`:

```javascript
import { loadRoster } from '../../lib/bundle-roster.js';

test('the real roster has all eight bundles', () => {
  const handles = loadRoster().bundles.map(b => b.handle);
  for (const h of ['hand-soap-set', 'clean-swap', 'gift-box', '90-day-clean-swap',
                   'head-to-toe', '99-coconut-reset-digital', 'coconut-bar-soap-4-pack',
                   'sensitive-skin-starter-set']) {
    assert.ok(handles.includes(h), `roster is missing ${h}`);
  }
});

test('the Hand Soap Set grid is complete and lotion is paired correctly', () => {
  const b = loadRoster().bundles.find(x => x.handle === 'hand-soap-set');
  assert.equal(b.variants.length, 15, 'three configurations by five scents');

  for (const v of b.variants) {
    const config = v.options.Configuration;
    const pumps = v.components.filter(c => c.product === 'organic-foaming-hand-soap');
    const total = pumps.reduce((s, c) => s + c.qty, 0);
    assert.equal(total, config.startsWith('3 pumps') ? 3 : 4,
      `${config} / ${v.options.Scent} must contain the right number of pumps`);

    const lotion = v.components.filter(c => c.product === 'coconut-lotion');
    if (config.includes('body lotion')) {
      assert.equal(lotion.length, 1, `${config} must carry a lotion`);
      const expected = v.options.Scent === 'Coconut Breeze' ? 'Coconut Breeze' : 'Pure Unscented';
      assert.equal(lotion[0].variant, expected,
        `${v.options.Scent} must pair with ${expected} lotion`);
    } else {
      assert.equal(lotion.length, 0, `${config} must not carry a lotion`);
    }
  }
});

test('the Gift Box carries the $1 custom box', () => {
  const b = loadRoster().bundles.find(x => x.handle === 'gift-box');
  assert.equal(b.packaging, 1.0);
});
```

- [ ] **Step 5: Validate the roster against the live catalogue**

Create a temporary check and run it:

```bash
node -e "
import('./lib/bundle-roster.js').then(async ({ loadRoster, validateRoster }) => {
  const { shopifyGraphQL } = await import('./lib/shopify.js');
  const r = await shopifyGraphQL('{ products(first:50){nodes{ handle variants(first:50){nodes{title}} }} }');
  const catalogue = Object.fromEntries(r.products.nodes.map(p => [p.handle, p.variants.nodes.map(v => v.title)]));
  const errs = validateRoster(loadRoster(), catalogue);
  console.log(errs.length ? errs.join('\n') : 'roster valid');
  process.exit(errs.length ? 1 : 0);
});"
```

Expected: `roster valid`. Any error names the exact bundle, variant and bad reference — fix the JSON and re-run until clean.

- [ ] **Step 6: Run the tests**

Run: `node --test tests/lib/bundle-roster.test.js`
Expected: PASS, 13 tests.

- [ ] **Step 7: Commit**

```bash
git add config/bundles.json scripts/roster-from-shopify.mjs tests/lib/bundle-roster.test.js
git commit -m "feat(bundles): author the roster — 8 bundles, one source of truth

Five live bundles backfilled from Shopify so the roster describes what
actually ships, plus the three new ones hand-written."
```

---

### Task 5: Point `bundle-economics.mjs` at the roster

**Files:**
- Modify: `scripts/bundle-economics.mjs`
- Test: `tests/scripts/bundle-economics.test.js`

**Interfaces:**
- Consumes: `loadRoster`, `economicsRows` (Tasks 2-3)
- Produces: `BUNDLES` is assembled from the roster plus the non-bundle editorial rows

- [ ] **Step 1: Write the failing test**

Append to `tests/scripts/bundle-economics.test.js`:

```javascript
test('roster-derived bundles reproduce the known contributions', () => {
  const byName = Object.fromEntries(BUNDLES.map(b => [b.name, b]));

  const cleanSwap90 = ev(byName['The 90-Day Clean Swap']);
  assert.equal(cleanSwap90.contrib, 100.85, '90-Day Clean Swap must still be $100.85');

  const giftBox = ev(byName['Gift Box']);
  assert.equal(giftBox.packaging, 1.0);
  assert.equal(giftBox.contrib, 34.32, 'Gift Box after its $1 box');
});

test('the Hand Soap Set produces three ladder rows', () => {
  const rows = BUNDLES.filter(b => b.name.startsWith('Hand Soap Set'));
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map(r => r.price), [44, 59, 72], 'rows must read as a ladder');
  assert.deepEqual(ev(rows[2]).items, { pump: 4, lotion: 1 });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `node --test tests/scripts/bundle-economics.test.js`
Expected: FAIL — `The 90-Day Clean Swap` is absent (the hardcoded name is `90-Day Clean Swap`) and no `Hand Soap Set` rows exist.

- [ ] **Step 3: Replace the hardcoded bundle rows**

In `scripts/bundle-economics.mjs`, replace the `BUNDLES` array. Keep only the rows that are not real bundles — the reference SKU and the rejected/retired records, which have no Shopify product to derive from — and derive the rest:

```javascript
import { loadRoster, economicsRows } from '../lib/bundle-roster.js';

/**
 * Rows with no Shopify product behind them: a reference SKU, and records of
 * bundles we decided against. Kept because the row IS the record of why —
 * deleting it invites someone to re-propose it next quarter.
 */
const EDITORIAL = [
  { name: 'Pump + Refill', status: 'rejected', price: 34,
    items: { pump: 1, refill: 1 }, story: 'Loses money: the refill forces a $21.31 box.' },
  { name: 'Two-Step Dry Skin Starter Set', status: 'retired', price: 39.99,
    items: { lotion: 1, cream: 1 },
    story: 'Deleted 2026-07-26. Same contents as the hero at a deeper discount.' },
  { name: 'Foam Soap Bundle', status: 'retired', price: 20.02,
    items: { pump: 2, refill: 1 },
    story: 'Deleted 2026-07-26 without ever being published — lost ~$19/order.' },
  { name: 'Single lotion (reference)', status: 'live', price: 30,
    items: { lotion: 1 }, story: 'Reference point, not an offer. Anchor for the $99 bundle.' },
];

export const BUNDLES = [
  ...loadRoster().bundles.flatMap(economicsRows),
  ...EDITORIAL,
];
```

- [ ] **Step 4: Run and confirm pass**

Run: `node --test tests/scripts/bundle-economics.test.js`
Expected: PASS. If a contribution moved, the roster and the old hardcoded counts disagree — **inspect both before changing either.** A mismatch means one of them was describing a box we do not ship, which is exactly what this task exists to surface.

- [ ] **Step 5: Regenerate and review the doc**

```bash
node scripts/bundle-economics.mjs --write
git diff docs/bundle-economics.md
```

Expected: three new `Hand Soap Set — …` rows, `The Clean Swap` and `Gift Box` now priced from the roster, existing contributions unchanged apart from the Gift Box's $1.

- [ ] **Step 6: Commit**

```bash
git add scripts/bundle-economics.mjs tests/scripts/bundle-economics.test.js docs/bundle-economics.md
git commit -m "refactor(bundles): derive economics from the roster

The model no longer asserts what a bundle contains - it computes it from
the same file Shopify is built from, so the two cannot disagree."
```

---

### Task 6: `scripts/build-bundle.mjs`

**Files:**
- Create: `scripts/build-bundle.mjs`

**Interfaces:**
- Consumes: `loadRoster`, `validateRoster` (Task 2); `shopifyGraphQL` from `lib/shopify.js`
- Produces: CLI only

- [ ] **Step 1: Write the script**

Create `scripts/build-bundle.mjs`:

```javascript
/**
 * Reconcile a bundle in Shopify against config/bundles.json.
 *
 *   node scripts/build-bundle.mjs <handle> [--apply]
 *   node scripts/build-bundle.mjs --all [--apply]
 *
 * Idempotent: every step reads current state and skips when already correct, so
 * a partial failure is repaired by running it again.
 *
 * ORDER MATTERS. Componentizing OVERWRITES the variant price with the sum of
 * its components, so prices are re-asserted afterwards in their own step. That
 * has shipped a wrong price to production twice.
 *
 * Channels: only Online Store and Shop accept componentized bundles. Google,
 * Meta, Pinterest, TikTok and Buy Button all refuse them, so channels are
 * published one at a time and refusals are reported, not fatal.
 */

import { shopifyGraphQL } from '../lib/shopify.js';
import { loadRoster, validateRoster } from '../lib/bundle-roster.js';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const ALL = args.includes('--all');
const handles = args.filter(a => !a.startsWith('--'));

const PUBLICATIONS = [
  ['gid://shopify/Publication/41249308707', 'Online Store'],
  ['gid://shopify/Publication/90546471082', 'Shop'],
];

const log = (...a) => console.log(...a);

async function gql(query, variables = {}) {
  const data = await shopifyGraphQL(query, variables);
  for (const v of Object.values(data ?? {})) {
    const errs = v?.userErrors ?? v?.mediaUserErrors;
    if (errs?.length) throw new Error(errs.map(e => `${(e.field ?? []).join('.')}: ${e.message}`).join('; '));
  }
  return data;
}

/** handle -> { id, variants: { [title]: id } } for every component product. */
async function loadCatalogue() {
  const d = await shopifyGraphQL(
    `{ products(first: 50) { nodes { id handle variants(first: 50) { nodes { id title } } } } }`
  );
  const byHandle = {};
  for (const p of d.products.nodes) {
    byHandle[p.handle] = {
      id: p.id,
      variants: Object.fromEntries(p.variants.nodes.map(v => [v.title, v.id])),
    };
  }
  return byHandle;
}

async function getProduct(handle) {
  const d = await shopifyGraphQL(`{
    productByHandle(handle: "${handle}") {
      id status templateSuffix
      options { id name values }
      variants(first: 50) {
        nodes { id title price selectedOptions { name value }
          productVariantComponents(first: 20) { nodes { quantity productVariant { id } } } }
      }
      resourcePublications(first: 20) { nodes { publication { id name } isPublished } }
    }
  }`);
  return d.productByHandle;
}

const optionKey = opts => Object.entries(opts).sort(([a], [b]) => a.localeCompare(b))
  .map(([k, v]) => `${k}=${v}`).join('|');

async function buildBundle(bundle, catalogue) {
  log(`\n=== ${bundle.handle}`);
  let product = await getProduct(bundle.handle);

  // 1 — product shell
  const input = {
    title: bundle.title,
    handle: bundle.handle,
    descriptionHtml: bundle.descriptionHtml ?? '',
    templateSuffix: bundle.templateSuffix ?? null,
    tags: bundle.tags ?? [],
    status: 'ACTIVE',
    ...(bundle.seo ? { seo: bundle.seo } : {}),
  };

  if (!product) {
    log('  creating product');
    if (!APPLY) return log('  (dry run — stopping here; nothing else can be planned without an id)');
    const d = await gql(
      `mutation ($input: ProductInput!) { productCreate(input: $input) { product { id } userErrors { field message } } }`,
      { input: { ...input, productOptions: bundle.options.map(o => ({ name: o.name, values: o.values.map(v => ({ name: v })) })) } }
    );
    product = await getProduct(bundle.handle);
    log(`  created ${d.productCreate.product.id}`);
  } else if (APPLY) {
    await gql(
      `mutation ($input: ProductInput!) { productUpdate(input: $input) { product { id } userErrors { field message } } }`,
      { input: { ...input, id: product.id } }
    );
    log('  product updated');
  }

  // 2 — variants
  const existing = new Map(product.variants.nodes.map(v =>
    [optionKey(Object.fromEntries(v.selectedOptions.map(o => [o.name, o.value]))), v]));

  const missing = bundle.variants.filter(v => !existing.has(optionKey(v.options)));
  if (missing.length) {
    log(`  creating ${missing.length} variants`);
    if (APPLY) {
      await gql(
        `mutation ($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
          productVariantsBulkCreate(productId: $productId, variants: $variants) {
            productVariants { id } userErrors { field message } } }`,
        {
          productId: product.id,
          variants: missing.map(v => ({
            optionValues: Object.entries(v.options).map(([name, value]) => ({ optionName: name, name: value })),
            price: String(v.price),
            ...(v.compareAtPrice ? { compareAtPrice: String(v.compareAtPrice) } : {}),
          })),
        }
      );
      product = await getProduct(bundle.handle);
    }
  }

  if (!APPLY) return log('  (dry run — stopping before componentization)');

  const live = new Map(product.variants.nodes.map(v =>
    [optionKey(Object.fromEntries(v.selectedOptions.map(o => [o.name, o.value]))), v]));

  // 3 — components
  const relationships = bundle.variants.map(v => {
    const target = live.get(optionKey(v.options));
    return {
      parentProductVariantId: target.id,
      productVariantRelationshipsToUpdate: v.components.map(c => {
        const id = catalogue[c.product]?.variants[c.variant];
        if (!id) throw new Error(`no variant id for ${c.product} / ${c.variant}`);
        return { id, quantity: c.qty };
      }),
    };
  });

  await gql(
    `mutation ($input: [ProductVariantRelationshipUpdateInput!]!) {
      productVariantRelationshipBulkUpdate(input: $input) {
        parentProductVariants { id } userErrors { field message } } }`,
    { input: relationships }
  );
  log(`  componentized ${relationships.length} variants`);

  // 4 — RE-ASSERT PRICES. Componentizing just overwrote them with the component sum.
  await gql(
    `mutation ($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkUpdate(productId: $productId, variants: $variants) {
        productVariants { id price } userErrors { field message } } }`,
    {
      productId: product.id,
      variants: bundle.variants.map(v => ({
        id: live.get(optionKey(v.options)).id,
        price: String(v.price),
        ...(v.compareAtPrice ? { compareAtPrice: String(v.compareAtPrice) } : {}),
      })),
    }
  );
  log('  prices re-asserted after componentization');

  // 5 — metafields
  const componentHandles = [...new Set(bundle.variants.flatMap(v => v.components.map(c => c.product)))];
  const qtyByHandle = componentHandles.map(h => {
    const first = bundle.variants[0].components.filter(c => c.product === h);
    return first.reduce((s, c) => s + c.qty, 0);
  });

  const metafields = [
    { ownerId: product.id, namespace: 'bundle', key: 'components', type: 'list.product_reference',
      value: JSON.stringify(componentHandles.map(h => catalogue[h].id)) },
    { ownerId: product.id, namespace: 'bundle', key: 'component_qty', type: 'list.number_integer',
      value: JSON.stringify(qtyByHandle) },
    ...bundle.variants
      .filter(v => v.contents)
      .map(v => ({ ownerId: live.get(optionKey(v.options)).id, namespace: 'bundle', key: 'contents',
        type: 'multi_line_text_field', value: v.contents })),
  ];

  await gql(
    `mutation ($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) { metafields { id } userErrors { field message } } }`,
    { metafields }
  );
  log(`  wrote ${metafields.length} metafields`);

  // 6 — collections
  for (const gid of bundle.collections ?? []) {
    await gql(
      `mutation ($id: ID!, $productIds: [ID!]!) {
        collectionAddProducts(id: $id, productIds: $productIds) { collection { handle } userErrors { field message } } }`,
      { id: gid, productIds: [product.id] }
    );
  }

  // 7 — publish, channel by channel
  for (const [publicationId, name] of PUBLICATIONS) {
    try {
      await gql(
        `mutation ($id: ID!, $input: [PublicationInput!]!) {
          publishablePublish(id: $id, input: $input) { publishable { availablePublicationsCount { count } } userErrors { field message } } }`,
        { id: product.id, input: [{ publicationId }] }
      );
      log(`  ✓ ${name}`);
    } catch (err) {
      log(`  ✗ ${name} — ${err.message}`);
    }
  }

  log(`  done — https://www.realskincare.com/products/${bundle.handle}`);
}

// ── main ───────────────────────────────────────────────────────────────────

const roster = loadRoster();
const catalogue = await loadCatalogue();

const errors = validateRoster(roster,
  Object.fromEntries(Object.entries(catalogue).map(([h, p]) => [h, Object.keys(p.variants)])));
if (errors.length) {
  console.error('Roster is invalid — refusing to build:\n  ' + errors.join('\n  '));
  process.exit(1);
}

const targets = ALL ? roster.bundles : roster.bundles.filter(b => handles.includes(b.handle));
if (!targets.length) {
  console.error(`No bundle matched. Available: ${roster.bundles.map(b => b.handle).join(', ')}`);
  process.exit(1);
}

if (!APPLY) log('DRY RUN — re-run with --apply to write.\n');
for (const b of targets) await buildBundle(b, catalogue);
```

- [ ] **Step 2: Dry-run against an existing bundle to prove it reads correctly**

Run: `node scripts/build-bundle.mjs 90-day-clean-swap`
Expected: reports the existing product, `0` missing variants, and stops before componentization. **No writes.**

- [ ] **Step 3: Commit**

```bash
git add scripts/build-bundle.mjs
git commit -m "feat(bundles): idempotent builder driven by the roster

Prices are re-asserted after componentization because componentizing
overwrites them with the component sum - that has shipped a wrong price
twice. Channels publish one at a time; only Online Store and Shop accept
a componentized bundle."
```

---

### Task 7: Verification checks

**Files:**
- Modify: `scripts/verify-bundle-contents.mjs`

**Interfaces:**
- Consumes: `loadRoster`, `SKU_BY_HANDLE` (Task 2)
- Produces: CLI exit code `1` when any bundle drifts from the roster

- [ ] **Step 1: Add the spec↔Shopify check**

In `scripts/verify-bundle-contents.mjs`, after the existing per-variant checks, add:

```javascript
import { loadRoster } from '../lib/bundle-roster.js';

// ── spec ↔ Shopify ─────────────────────────────────────────────────────────
// The roster is only a source of truth if drift from it is an error. Without
// this, config/bundles.json is documentation that rots.

const roster = loadRoster();
let drift = 0;

for (const spec of roster.bundles) {
  const live = products.find(p => p.handle === spec.handle);
  if (!live) { console.log(`\n${spec.handle}: in the roster but not live`); drift++; continue; }

  for (const sv of spec.variants) {
    const wanted = Object.values(sv.options).join(' / ');
    const lv = live.variants.nodes.find(v =>
      Object.values(sv.options).every(val => v.title.includes(val)));
    if (!lv) { console.log(`\n${spec.handle} / ${wanted}: variant missing in Shopify`); drift++; continue; }

    const liveSet = new Set(lv.productVariantComponents.nodes
      .map(c => `${c.productVariant.product.handle}/${c.productVariant.title}×${c.quantity}`));
    const specSet = new Set(sv.components.map(c => `${c.product}/${c.variant}×${c.qty}`));

    for (const s of specSet) if (!liveSet.has(s)) { console.log(`\n${spec.handle} / ${wanted}: roster expects ${s}, Shopify does not ship it`); drift++; }
    for (const l of liveSet) if (!specSet.has(l)) { console.log(`\n${spec.handle} / ${wanted}: Shopify ships ${l}, roster does not list it`); drift++; }
  }
}

console.log(drift ? `\n${drift} drift(s) between config/bundles.json and Shopify.` : '\nRoster matches Shopify.');
if (drift) process.exitCode = 1;
```

- [ ] **Step 2: Run it**

Run: `npm run verify-bundle-contents`
Expected: `All bundle copy matches components.` followed by `Roster matches Shopify.` Any drift names the exact bundle, variant and component.

- [ ] **Step 3: Commit**

```bash
git add scripts/verify-bundle-contents.mjs
git commit -m "test(bundles): fail when Shopify drifts from the roster

A source of truth that drift does not break is just documentation."
```

---

### Task 8: Build the three bundles live

**Files:** none — this task runs the tooling from Tasks 4-7.

- [ ] **Step 1: Dry-run all three**

```bash
node scripts/build-bundle.mjs hand-soap-set
node scripts/build-bundle.mjs clean-swap
node scripts/build-bundle.mjs gift-box
```

Expected: each reports `creating product` and stops. No writes.

- [ ] **Step 2: Build the Clean Swap first — the simplest, 3 variants**

```bash
node scripts/build-bundle.mjs clean-swap --apply
```

Expected: product created, 3 variants, componentized, prices re-asserted, metafields written, `✓ Online Store`, `✓ Shop`.

- [ ] **Step 3: Verify it before building the others**

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://www.realskincare.com/products/clean-swap
npm run verify-bundle-contents clean-swap
node -e "
import('./lib/shopify.js').then(async m => {
  const r = await m.shopifyGraphQL('{ productByHandle(handle:\"clean-swap\"){ variants(first:10){nodes{title price}} } }');
  console.log(r.productByHandle.variants.nodes.map(v => v.title + ' \$' + v.price).join('\n'));
});"
```

Expected: `200`; contents match components; **every variant reads `$59.00`, not the $69 component sum.** A $69 here means step 4 of the builder did not run — stop and fix before touching the other two.

- [ ] **Step 4: Build the Gift Box and the Hand Soap Set**

```bash
node scripts/build-bundle.mjs gift-box --apply
node scripts/build-bundle.mjs hand-soap-set --apply
```

- [ ] **Step 5: Full verification**

```bash
npm run verify-bundle-contents
node --test tests/lib/bundle-roster.test.js tests/scripts/bundle-economics.test.js tests/lib/shipping-costs.test.js
for h in clean-swap gift-box hand-soap-set; do
  echo -n "$h "; curl -s -o /tmp/$h.html -w "%{http_code}" https://www.realskincare.com/products/$h
  echo -n " tokens:"; grep -c '\[\[TOTAL\]\]\|\[\[PRICE\]\]\|\[\[SAVINGS\]\]' /tmp/$h.html || true
done
```

Expected: roster matches Shopify; all tests pass; three `200`s; **token count `0` on each** — a non-zero count means the lander is rendering raw `[[TOTAL]]` placeholders to customers.

- [ ] **Step 6: Confirm the Hand Soap Set grid is right**

```bash
node -e "
import('./lib/shopify.js').then(async m => {
  const r = await m.shopifyGraphQL('{ productByHandle(handle:\"hand-soap-set\"){ variants(first:50){nodes{ title price productVariantComponents(first:10){nodes{quantity productVariant{title product{handle}}}} }} } }');
  for (const v of r.productByHandle.variants.nodes)
    console.log(v.title.padEnd(42), '\$' + v.price, '|', v.productVariantComponents.nodes.map(c => c.quantity + 'x' + c.productVariant.product.handle + '/' + c.productVariant.title).join(' + '));
});"
```

Expected: 15 rows. Every `3 pumps` row totals 3 pumps, every `4 pumps` row totals 4. Only `+ body lotion` rows carry a lotion, and only the Coconut Breeze ones carry Coconut Breeze lotion.

- [ ] **Step 7: Regenerate economics and commit**

```bash
node scripts/bundle-economics.mjs --write
git add docs/bundle-economics.md
git commit -m "data(bundles): three new bundles live — Hand Soap Set, Clean Swap \$59, Gift Box

21 new variants, all componentized and price-verified. Nothing links to
them yet; funnels are sub-project B."
```

- [ ] **Step 8: Update the marketing plan's build order**

In `docs/bundle-marketing-plan.md` §2, change rows 6-10 to reflect that Pump 4-pack + Lotion, The Clean Swap, Pump 3-pack + Lotion, Pump 4-pack and Gift Box are now built — the three pump rows now being configurations of the single Hand Soap Set product rather than separate bundles. Commit.

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| §2.1 Hand Soap Set, 15 variants, lotion pairing | 4 (authoring), 8 (build + grid check) |
| §2.2 The Clean Swap $59 | 4, 8 |
| §2.3 Gift Box + $1 packaging | 1 (model), 4, 8 |
| §2.4 Empty collections | 4 — `collections: []` |
| §3.1 `config/bundles.json` | 4 |
| §3.2 Three consumers | 5 (economics), 7 (verify), D is out of scope |
| §3.3 `build-bundle.mjs` 8-step sequence | 6 |
| §4 Verification | 7, 8 |
| §5 Testing | 2, 3, 4 |
| §6 Traps | Global Constraints; price re-assertion is Task 6 step 4 and checked in Task 8 step 3 |

**One deliberate deviation from the spec.** §5 called for a *generator* for the Hand Soap Set variant grid. The plan hand-writes the 15 variants in `config/bundles.json` and tests the resulting data instead (Task 4 step 4). A generator would be a second code path to test, and the roster is meant to be greppable and diffable — reading the actual box a customer receives should not require executing code. The test asserts exactly what the generator would have guaranteed: pump counts per configuration and correct lotion pairing.

**Placeholder scan:** clean. Every code step carries real code; every verification step names the expected output and what a wrong result means.

**Type consistency:** `validateRoster(roster, catalogue)` takes `Record<handle, string[]>` in Tasks 2 and 4; `build-bundle.mjs` builds a richer catalogue (with ids) and narrows it to that shape before calling. `economicsRows(bundle)` returns objects with exactly the fields `evaluate()` reads: `name`, `status`, `price`, `packaging`, `items`, `story`.
