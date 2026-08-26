# Quantity Ladders Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put a one-click quantity ladder on each consumable's PDP — soap 1/4/12, deodorant 1/4, toothpaste 1/3 — so a buyer who does not want the biggest pack can step down without leaving the page.

**Architecture:** A `custom_liquid` block in each base product's existing `landing-page-*` template renders tier cards bound to real products. Selecting a tier swaps which variant the ladder's own form posts to `/cart/add.js`. Tier structure (handles, unit counts) is baked in from `config/bundles.json` by a build script; **prices are read live from `all_products` at render time and are never baked**. `sections/main-product.liquid` is never edited.

**Tech Stack:** Node 22 LTS (`nvm use` — the server runs 22.x), `node --test`, Shopify Liquid, Shopify Admin GraphQL `2026-07` via `lib/shopify-api-version.js`, vanilla JS in the block (no framework, no CDN).

**Spec:** `docs/superpowers/specs/2026-08-25-soap-quantity-ladder-design.md`

## Global Constraints

- **Work on a branch, in a worktree, merge via PR.** `scripts/new-worktree.sh <name> [branch]`. Never commit to `main`, never work in the main checkout.
- **Node 22.** Run `nvm use` before any test. When reading `node --test` output, check the **cancelled** count, not just fail — a cancelled test prints alongside `# fail 0` and reads like a pass.
- **Nothing is a literal, and no total is ever asserted — it is summed.** (`docs/bundle-landing-architecture.md`.) Prices come from Shopify at render time. Unit counts come from componentization in `config/bundles.json`. Copy that states a number must derive it.
- **`sections/main-product.liquid` is never modified.** It is 157 KB and shared by every PDP.
- **Theme is not deployed by `git pull`.** Push theme assets with `scripts/update-theme-asset.mjs put <key> <file> --apply`, which backs up the live copy to `theme/backup/<key>` first. Always fetch the rendered page afterward — a success log is not proof.
- **Never change `hide_variants` on a template without checking `#` alt tokens first.** All three base products were verified 0-gang on 2026-08-25 and none of their templates change here. The tier-target product `coconut-deodorant-4-pack` is 100% gang-scoped and must stay on `scoped-gallery`.
- **Supply claims are floors, never ceilings.** `config/consumption-rates.json`: soap 25 days/bar, deodorant 42 days, toothpaste 61 days. Overstating supply is the documented cause of subscriber churn. When uncertain, claim short.
- **Ship soap first.** Deodorant and toothpaste templates are not touched until soap is verified live end-to-end.

---

### Task 1: Fix the stale per-day supply claim on the bar soap PDP

Independent of the ladder and shipped first because it is a live copy error. The `per-day-anchor` block currently reads *"A bar lasts about 6 weeks of daily use — roughly $0.16 per day."* Both numbers are wrong and they contradict each other: 6 weeks is 42 days against the merchant's 25, and $0.16 × 42 = $6.72 against an $11 bar. The honest figure is 25 days at $0.44/day.

**Files:**
- Modify: live theme `templates/product.landing-page-bar-soap.json`, block `per-day-anchor`
- Create: `theme/blocks/bar-soap-per-day-anchor.liquid` (the committed source of that block)

**Interfaces:**
- Consumes: nothing
- Produces: nothing — no later task depends on this

- [ ] **Step 1: Pull the live template and confirm the wrong copy is still there**

```bash
cd "$(git rev-parse --show-toplevel)" && nvm use
node scripts/update-theme-asset.mjs get templates/product.landing-page-bar-soap.json /tmp/bar-soap.json
python3 -c "
import json; d=json.load(open('/tmp/bar-soap.json'))
print(d['sections']['main']['blocks']['per-day-anchor']['settings']['custom_liquid'])
"
```

Expected: the string containing `6 weeks` and `\$0.16 per day`. If it differs, someone has already changed it — stop and re-read before editing.

- [ ] **Step 2: Write the corrected block source**

Create `theme/blocks/bar-soap-per-day-anchor.liquid`:

```liquid
{%- comment -%}
  Per-day anchor for the bar soap PDP.

  25 days is the merchant's own figure (config/consumption-rates.json,
  "A bar of soap is lasting between 20 and 30 days in the shower"), which
  SUPERSEDES the 47-day median reorder gap — a reorder gap measures when
  somebody got round to buying again, not how long the bar lasted.

  This block previously claimed "about 6 weeks" and "$0.16 per day". Both were
  wrong and mutually inconsistent: 6 weeks is 42 days against a 25-day figure,
  and $0.16 x 42 = $6.72 against an $11 bar. Overstating supply is the
  documented reason RSC subscribers churned, so the claim is stated at the
  SHORT end of the merchant's 20-30 day range.

  The per-day figure divides by 20, not 25, for the same reason: it is the
  conservative end, and it is derived from live price so it cannot drift.
{%- endcomment -%}
<p style="font-size:16px;color:#4a8b3c;font-weight:600;margin:6px 0 14px 0;">
  A bar lasts about 3 weeks of daily use — roughly {{ product.price | divided_by: 20 | money }} per day.
</p>
```

- [ ] **Step 3: Verify the arithmetic renders as expected**

`product.price` is in cents (1100). `1100 | divided_by: 20` = 55 → `money` → `$0.55`. Confirm by hand that $0.55 × 20 days = $11.00 exactly. The claim is now internally consistent, which the old one was not.

- [ ] **Step 4: Write the corrected block into the template JSON and push**

```bash
python3 -c "
import json
d=json.load(open('/tmp/bar-soap.json'))
d['sections']['main']['blocks']['per-day-anchor']['settings']['custom_liquid'] = open('theme/blocks/bar-soap-per-day-anchor.liquid').read()
json.dump(d, open('/tmp/bar-soap-new.json','w'), indent=2, ensure_ascii=False)
"
node scripts/update-theme-asset.mjs put templates/product.landing-page-bar-soap.json /tmp/bar-soap-new.json
```

Review the printed diff. It must touch **only** the `per-day-anchor` block. If anything else moved, stop.

- [ ] **Step 5: Apply and verify on the rendered page**

```bash
node scripts/update-theme-asset.mjs put templates/product.landing-page-bar-soap.json /tmp/bar-soap-new.json --apply
sleep 3
curl -s https://www.realskincare.com/products/coconut-soap | grep -o '3 weeks of daily use[^<]*'
```

Expected: `3 weeks of daily use — roughly $0.55 per day`. Expected absent: any occurrence of `6 weeks` or `$0.16`.

- [ ] **Step 6: Commit**

```bash
git add theme/blocks/bar-soap-per-day-anchor.liquid
git commit -m "fix(theme): correct the bar soap per-day supply claim

Claimed 'about 6 weeks' and '\$0.16 per day'. Both wrong, and inconsistent
with each other: 6 weeks is 42 days against the merchant's 25-day figure,
and \$0.16 x 42 = \$6.72 against an \$11 bar.

Now states 3 weeks and derives the per-day figure from live price by
dividing by 20 — the short end of the merchant's 20-30 day range.
Overstating supply is the documented cause of subscriber churn, so the
claim is deliberately conservative and can no longer drift from price."
```

---

### Task 2: `lib/quantity-ladder.js` — pure tier resolution and validation

**Files:**
- Create: `lib/quantity-ladder.js`
- Test: `tests/lib/quantity-ladder.test.js`

**Interfaces:**
- Consumes: `loadRoster()` shape from `lib/bundle-roster.js` (`{ bundles: [{handle, status, variants:[{components:[{product,variant,qty}]}]}] }`)
- Produces:
  - `tierUnits(bundle) -> number` — units in one purchase of that bundle
  - `resolveTiers(roster, ladder) -> [{handle, units, isBase}]`
  - `freeUnitFraming({tierPrice, baseUnitPrice, units}) -> {kind:'free-units', paid, free} | {kind:'savings'}`
  - `validateLadder(ladder, roster, catalogue) -> string[]`

- [ ] **Step 1: Write the failing test**

Create `tests/lib/quantity-ladder.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tierUnits, resolveTiers, freeUnitFraming, validateLadder } from '../../lib/quantity-ladder.js';

const bundle = (handle, qtys, status = 'live') => ({
  handle, status,
  variants: [{ components: qtys.map((q, i) => ({ product: 'coconut-soap', variant: `v${i}`, qty: q })) }],
});

const ROSTER = { bundles: [bundle('coconut-bar-soap-4-pack', [1, 1, 1, 1]), bundle('coconut-bar-soap-12-pack', [12])] };
const LADDER = {
  base: 'coconut-soap',
  tiers: ['coconut-soap', 'coconut-bar-soap-4-pack', 'coconut-bar-soap-12-pack'],
  default: 'coconut-bar-soap-12-pack',
};
const CATALOGUE = {
  'coconut-soap': { status: 'ACTIVE' },
  'coconut-bar-soap-4-pack': { status: 'ACTIVE' },
  'coconut-bar-soap-12-pack': { status: 'ACTIVE' },
};

test('tierUnits sums component quantities, never variant count', () => {
  assert.equal(tierUnits(bundle('x', [1, 1, 1, 1])), 4);
  assert.equal(tierUnits(bundle('x', [12])), 12);
  assert.equal(tierUnits(bundle('x', [3, 3, 3, 3])), 12);
});

test('resolveTiers returns tiers in declared order with the base at 1 unit', () => {
  assert.deepEqual(resolveTiers(ROSTER, LADDER), [
    { handle: 'coconut-soap', units: 1, isBase: true },
    { handle: 'coconut-bar-soap-4-pack', units: 4, isBase: false },
    { handle: 'coconut-bar-soap-12-pack', units: 12, isBase: false },
  ]);
});

test('free-unit framing applies only when paid units are whole', () => {
  // 88 / 11 = 8 exactly -> buy 8 get 4 free
  assert.deepEqual(freeUnitFraming({ tierPrice: 8800, baseUnitPrice: 1100, units: 12 }),
    { kind: 'free-units', paid: 8, free: 4 });
});

test('fractional paid units fall back to a savings label', () => {
  // every other multipack in the catalogue: 39/11, 53/15, 34/13
  assert.equal(freeUnitFraming({ tierPrice: 3900, baseUnitPrice: 1100, units: 4 }).kind, 'savings');
  assert.equal(freeUnitFraming({ tierPrice: 5300, baseUnitPrice: 1500, units: 4 }).kind, 'savings');
  assert.equal(freeUnitFraming({ tierPrice: 3400, baseUnitPrice: 1300, units: 3 }).kind, 'savings');
});

test('the base tier never gets free-unit framing', () => {
  // paid == units means nothing is free; must not render "buy 1 get 0 free"
  assert.equal(freeUnitFraming({ tierPrice: 1100, baseUnitPrice: 1100, units: 1 }).kind, 'savings');
});

test('validateLadder accepts a coherent ladder', () => {
  assert.deepEqual(validateLadder(LADDER, ROSTER, CATALOGUE), []);
});

test('validateLadder rejects a tier missing from the catalogue', () => {
  const errs = validateLadder(LADDER, ROSTER, { 'coconut-soap': { status: 'ACTIVE' } });
  assert.equal(errs.length, 2);
  assert.match(errs[0], /coconut-bar-soap-4-pack.*not in the catalogue/);
});

test('validateLadder rejects an unpublished tier', () => {
  // This is the exact 2026-08-25 failure: roster-live, Shopify DRAFT, 404.
  const errs = validateLadder(LADDER, ROSTER, { ...CATALOGUE, 'coconut-bar-soap-4-pack': { status: 'DRAFT' } });
  assert.equal(errs.length, 1);
  assert.match(errs[0], /coconut-bar-soap-4-pack.*DRAFT/);
});

test('validateLadder rejects non-increasing unit counts', () => {
  const bad = { ...LADDER, tiers: ['coconut-soap', 'coconut-bar-soap-12-pack', 'coconut-bar-soap-4-pack'] };
  const errs = validateLadder(bad, ROSTER, CATALOGUE);
  assert.equal(errs.length, 1);
  assert.match(errs[0], /units must increase/);
});

test('validateLadder rejects a default that is not one of the tiers', () => {
  const errs = validateLadder({ ...LADDER, default: 'nope' }, ROSTER, CATALOGUE);
  assert.equal(errs.length, 1);
  assert.match(errs[0], /default "nope" is not one of the tiers/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `nvm use && node --test tests/lib/quantity-ladder.test.js`
Expected: FAIL — `Cannot find module '../../lib/quantity-ladder.js'`

- [ ] **Step 3: Write the implementation**

Create `lib/quantity-ladder.js`:

```js
/**
 * Quantity ladders — the pure logic behind the tier selector on a PDP.
 *
 * A ladder spans a single-unit product and its multipacks, which is why it is
 * configured at the TOP LEVEL of config/bundles.json rather than on a bundle
 * entry: the base product is a *component*, and components have no entry in
 * bundles[] at all.
 *
 * Prices never appear here. Unit counts come from componentization; prices are
 * read live from Shopify at render time (docs/bundle-landing-architecture.md:
 * "Nothing is a literal, and no total is ever asserted — it is summed").
 */

/** Units in one purchase of a bundle: the sum of its component quantities. */
export function tierUnits(bundle) {
  const variant = bundle?.variants?.[0];
  if (!variant) return 0;
  return (variant.components ?? []).reduce((n, c) => n + (c.qty ?? 0), 0);
}

/**
 * Ordered tier descriptors. The base product is not in the roster (it is a
 * component, not a bundle), so it is always 1 unit by definition.
 */
export function resolveTiers(roster, ladder) {
  const byHandle = Object.fromEntries((roster?.bundles ?? []).map((b) => [b.handle, b]));
  return (ladder?.tiers ?? []).map((handle) => {
    const isBase = handle === ladder.base;
    return { handle, units: isBase ? 1 : tierUnits(byHandle[handle]), isBase };
  });
}

/**
 * Which framing a tier earns.
 *
 * "Buy 8, get 4 free" is only honest when the price divides into a whole number
 * of single units. Across the live catalogue exactly ONE tier qualifies — the
 * soap 12-pack at 8800/1100 = 8. The others (39/11, 53/15, 34/13) are
 * percentage discounts, and rendering them as free units prints "buy 3.5, get
 * 0.5 free". The savings label is the normal path.
 */
export function freeUnitFraming({ tierPrice, baseUnitPrice, units, tolerance = 0.01 }) {
  if (!baseUnitPrice || !units) return { kind: 'savings' };
  const paidExact = tierPrice / baseUnitPrice;
  const paid = Math.round(paidExact);
  const whole = Math.abs(paidExact - paid) <= tolerance;
  if (!whole || paid <= 0 || paid >= units) return { kind: 'savings' };
  return { kind: 'free-units', paid, free: units - paid };
}

/** Human-readable errors; empty array means the ladder is coherent. */
export function validateLadder(ladder, roster, catalogue) {
  const errors = [];
  const cat = catalogue ?? {};
  const tiers = resolveTiers(roster, ladder);

  if (!tiers.some((t) => t.handle === ladder?.default)) {
    errors.push(`${ladder?.base}: default "${ladder?.default}" is not one of the tiers`);
  }

  let previousUnits = 0;
  for (const t of tiers) {
    const p = cat[t.handle];
    if (!p) {
      errors.push(`${ladder.base}: tier "${t.handle}" is not in the catalogue`);
      continue;
    }
    // The 2026-08-25 failure mode: roster says live, Shopify serves a draft, the
    // tier 404s and the ladder would add an unbuyable variant to the cart.
    if (p.status !== 'ACTIVE') {
      errors.push(`${ladder.base}: tier "${t.handle}" is ${p.status}, not ACTIVE — it would 404`);
      continue;
    }
    if (!Number.isInteger(t.units) || t.units < 1) {
      errors.push(`${ladder.base}: tier "${t.handle}" has non-positive units (${t.units})`);
      continue;
    }
    if (t.units <= previousUnits) {
      errors.push(`${ladder.base}: tier "${t.handle}" units must increase along the ladder (${t.units} after ${previousUnits})`);
    }
    previousUnits = Math.max(previousUnits, t.units);
  }
  return errors;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `nvm use && node --test tests/lib/quantity-ladder.test.js`
Expected: `# pass 10`, `# fail 0`, `# cancelled 0`

- [ ] **Step 5: Commit**

```bash
git add lib/quantity-ladder.js tests/lib/quantity-ladder.test.js
git commit -m "feat(quantity-ladder): pure tier resolution and validation

Unit counts derive from componentization, never typed. Free-unit framing
applies only where price divides into whole single units -- across the live
catalogue exactly one tier qualifies (soap 12-pack, 8800/1100=8); the rest
fall back to a savings label rather than printing 'buy 3.5, get 0.5 free'.

validateLadder treats a non-ACTIVE tier as an error: that is the 2026-08-25
failure where eight roster-live bundles served 404s."
```

---

### Task 3: Declare the ladders in `config/bundles.json`

**Files:**
- Modify: `config/bundles.json` (add top-level `ladders`)
- Modify: `lib/bundle-roster.js` (validate `ladders` alongside `bundles`)
- Test: `tests/lib/bundle-roster.test.js`

**Interfaces:**
- Consumes: `validateLadder` from Task 2
- Produces: `roster.ladders` — an array read by Task 4's build script

- [ ] **Step 1: Write the failing test**

Append to `tests/lib/bundle-roster.test.js`:

```js
test('validateRoster surfaces ladder errors alongside bundle errors', () => {
  const roster = {
    bundles: [{ handle: 'p4', status: 'live', variants: [{ components: [{ product: 'coconut-soap', variant: 'a', qty: 4 }] }] }],
    ladders: [{ base: 'coconut-soap', tiers: ['coconut-soap', 'p4'], default: 'nope' }],
  };
  const errors = validateRoster(roster, { 'coconut-soap': ['a'] }, { 'coconut-soap': { status: 'ACTIVE' }, p4: { status: 'ACTIVE' } });
  assert.ok(errors.some((e) => /default "nope" is not one of the tiers/.test(e)));
});

test('a roster with no ladders key is still valid', () => {
  const roster = { bundles: [] };
  assert.deepEqual(validateRoster(roster, {}, {}), []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `nvm use && node --test tests/lib/bundle-roster.test.js`
Expected: FAIL — `validateRoster` ignores the third argument and returns `[]`

- [ ] **Step 3: Add the `ladders` config**

In `config/bundles.json`, add a top-level `ladders` key as a sibling of `bundles`. Preserve formatting with `json.dumps(d, indent=2, ensure_ascii=False) + "\n"` — a round-trip is byte-identical, verified 2026-08-25.

```json
"ladders": [
  {
    "base": "coconut-soap",
    "tiers": ["coconut-soap", "coconut-bar-soap-4-pack", "coconut-bar-soap-12-pack"],
    "default": "coconut-bar-soap-12-pack",
    "template": "product.landing-page-bar-soap.json",
    "block_id": "quantity-ladder"
  },
  {
    "base": "coconut-oil-deodorant",
    "tiers": ["coconut-oil-deodorant", "coconut-deodorant-4-pack"],
    "default": "coconut-deodorant-4-pack",
    "template": "product.landing-page-deodorant.json",
    "block_id": "quantity-ladder"
  },
  {
    "base": "coconut-oil-toothpaste",
    "tiers": ["coconut-oil-toothpaste", "coconut-toothpaste-3-pack"],
    "default": "coconut-toothpaste-3-pack",
    "template": "product.landing-page-toothpaste.json",
    "block_id": "quantity-ladder"
  }
]
```

- [ ] **Step 4: Wire ladder validation into `validateRoster`**

In `lib/bundle-roster.js`, import `validateLadder` and extend the signature. The third parameter is optional so the ~6 existing callers that pass two arguments keep working unchanged.

```js
import { validateLadder } from './quantity-ladder.js';

// ...inside validateRoster, after the existing bundle loop, before `return errors`:
  for (const ladder of roster.ladders ?? []) {
    errors.push(...validateLadder(ladder, roster, productStatuses ?? {}));
  }
```

Change the signature to `export function validateRoster(roster, catalogue, productStatuses)`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `nvm use && node --test tests/lib/bundle-roster.test.js tests/lib/quantity-ladder.test.js tests/scripts/bundle-economics.test.js`
Expected: all pass, `# fail 0`, `# cancelled 0`. The economics suite must be unaffected — it calls `validateRoster` with two arguments.

- [ ] **Step 6: Commit**

```bash
git add config/bundles.json lib/bundle-roster.js tests/lib/bundle-roster.test.js
git commit -m "feat(bundles): declare quantity ladders in the roster

Top-level 'ladders', not nested under a bundle entry: a ladder spans a
component (the single-unit product, which has no bundles[] entry) and its
multipacks, so it belongs to neither list.

validateRoster takes an optional third argument of product statuses and
folds ladder validation in. Optional so existing two-argument callers are
unaffected."
```

---

### Task 4: Build script and Liquid block

**Files:**
- Create: `theme/blocks/quantity-ladder.liquid`
- Create: `scripts/build-quantity-ladder.mjs`
- Test: `tests/scripts/build-quantity-ladder.test.js`

**Interfaces:**
- Consumes: `resolveTiers`, `validateLadder` (Task 2); `roster.ladders` (Task 3)
- Produces: `renderLadderPreamble(tiers, ladder) -> string` — the Liquid assign lines the block reads

- [ ] **Step 1: Write the failing test**

Create `tests/scripts/build-quantity-ladder.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderLadderPreamble } from '../../scripts/build-quantity-ladder.mjs';

const TIERS = [
  { handle: 'coconut-soap', units: 1, isBase: true },
  { handle: 'coconut-bar-soap-4-pack', units: 4, isBase: false },
  { handle: 'coconut-bar-soap-12-pack', units: 12, isBase: false },
];
const LADDER = { base: 'coconut-soap', default: 'coconut-bar-soap-12-pack' };

test('the preamble bakes handles and units but never a price', () => {
  const out = renderLadderPreamble(TIERS, LADDER);
  assert.match(out, /assign ladder_handles = "coconut-soap,coconut-bar-soap-4-pack,coconut-bar-soap-12-pack"/);
  assert.match(out, /assign ladder_units = "1,4,12"/);
  assert.match(out, /assign ladder_default = "coconut-bar-soap-12-pack"/);
  assert.match(out, /assign ladder_base = "coconut-soap"/);
});

test('no price, money filter, or currency symbol is ever baked in', () => {
  // Prices must come from all_products at render time. A baked price is the
  // exact drift the lander architecture exists to prevent.
  const out = renderLadderPreamble(TIERS, LADDER);
  assert.doesNotMatch(out, /\$\d/);
  assert.doesNotMatch(out, /\d{3,}/); // no cent-denominated amounts
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `nvm use && node --test tests/scripts/build-quantity-ladder.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Write the build script**

Create `scripts/build-quantity-ladder.mjs`:

```js
#!/usr/bin/env node
/**
 * Render the quantity-ladder custom_liquid block and write it into a base
 * product's template.
 *
 *   node scripts/build-quantity-ladder.mjs <base-handle> [--apply]
 *
 * Structure (which handles, how many units) is baked from config/bundles.json.
 * PRICES ARE NEVER BAKED — the block reads all_products at render time, so a
 * reprice cannot leave a stale number on the page.
 *
 * Refuses to write when validateLadder reports anything, which includes a tier
 * that is not ACTIVE on Shopify. That is the 2026-08-25 failure: a roster-live
 * tier serving a 404 would put an unbuyable variant behind a tier card.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRoster } from '../lib/bundle-roster.js';
import { resolveTiers, validateLadder } from '../lib/quantity-ladder.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The Liquid assigns the block body reads. Structure only, never prices. */
export function renderLadderPreamble(tiers, ladder) {
  return [
    `{%- assign ladder_base = "${ladder.base}" -%}`,
    `{%- assign ladder_default = "${ladder.default}" -%}`,
    `{%- assign ladder_handles = "${tiers.map((t) => t.handle).join(',')}" | split: "," -%}`,
    `{%- assign ladder_units = "${tiers.map((t) => t.units).join(',')}" | split: "," -%}`,
  ].join('\n');
}

export function renderBlock(tiers, ladder) {
  const body = readFileSync(join(ROOT, 'theme', 'blocks', 'quantity-ladder.liquid'), 'utf8');
  return `${renderLadderPreamble(tiers, ladder)}\n${body}`;
}

// Direct-run guard: this module is imported by its test, and an agent that runs
// on import is the failure mode reference_agents_run_on_import documents.
const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectRun) {
  const { shopifyGraphQL } = await import('../lib/shopify.js');
  const APPLY = process.argv.includes('--apply');
  const base = process.argv.slice(2).find((a) => !a.startsWith('--'));
  if (!base) { console.error('usage: build-quantity-ladder.mjs <base-handle> [--apply]'); process.exit(2); }

  const roster = loadRoster();
  const ladder = (roster.ladders ?? []).find((l) => l.base === base);
  if (!ladder) { console.error(`no ladder configured for base "${base}"`); process.exit(2); }

  const d = await shopifyGraphQL('{ products(first: 250) { nodes { handle status } } }');
  const statuses = Object.fromEntries(d.products.nodes.map((p) => [p.handle, { status: p.status }]));

  const errors = validateLadder(ladder, roster, statuses);
  if (errors.length) {
    console.error('Ladder is invalid — refusing to build:\n  ' + errors.join('\n  '));
    process.exit(1);
  }

  const tiers = resolveTiers(roster, ladder);
  const block = renderBlock(tiers, ladder);
  console.log(`${base}: ${tiers.length} tiers (${tiers.map((t) => t.units).join('/')} units), ${block.length} bytes`);
  writeFileSync(join(ROOT, 'data', `ladder-${base}.liquid`), block);
  console.log(`wrote data/ladder-${base}.liquid — install with update-theme-asset.mjs${APPLY ? '' : ' (dry run)'}`);
}
```

- [ ] **Step 4: Write the Liquid block body**

Create `theme/blocks/quantity-ladder.liquid`. The preamble from Step 3 is prepended at build time, so `ladder_handles`, `ladder_units`, `ladder_base` and `ladder_default` are already assigned.

```liquid
{%- comment -%}
  Quantity ladder. Tier structure is baked; every price below is read live from
  all_products, so a reprice cannot leave a stale number here.

  The option axis is NOT always called "Scent" — toothpaste uses "Flavor" — so
  the option name is read off each product rather than assumed.
{%- endcomment -%}

{%- assign base_product = all_products[ladder_base] -%}
{%- assign base_unit_price = base_product.price -%}

<div class="qty-ladder" data-qty-ladder>
  <div class="qty-ladder__tiers" role="radiogroup" aria-label="Choose your pack size">
    {%- for handle in ladder_handles -%}
      {%- assign p = all_products[handle] -%}
      {%- assign units = ladder_units[forloop.index0] | plus: 0 -%}
      {%- if p == blank or p.available == false -%}{%- continue -%}{%- endif -%}

      {%- assign per_unit = p.price | divided_by: units -%}
      {%- assign paid_exact = p.price | divided_by: base_unit_price -%}
      {%- assign paid_remainder = p.price | modulo: base_unit_price -%}

      <label class="qty-ladder__tier{% if handle == ladder_default %} is-selected{% endif %}">
        <input type="radio" name="qty-tier" value="{{ handle }}"
               {% if handle == ladder_default %}checked{% endif %}>
        <span class="qty-ladder__qty">{{ units }} {% if units == 1 %}{{ 'bar' }}{% else %}pack{% endif %}</span>
        <span class="qty-ladder__price">{{ p.price | money }}</span>
        <span class="qty-ladder__unit">{{ per_unit | money }} each</span>

        {%- comment -%}
          Free-unit framing only when the price divides into whole single units.
          Across this catalogue exactly one tier qualifies; the rest show savings,
          because "buy 3.5, get 0.5 free" is what the naive version prints.
        {%- endcomment -%}
        {%- if paid_remainder == 0 and paid_exact > 0 and paid_exact < units -%}
          {%- assign free_units = units | minus: paid_exact -%}
          <span class="qty-ladder__badge">Buy {{ paid_exact }}, get {{ free_units }} free</span>
        {%- elsif p.compare_at_price > p.price -%}
          {%- assign saved = p.compare_at_price | minus: p.price -%}
          <span class="qty-ladder__badge">Save {{ saved | money }}</span>
        {%- endif -%}
      </label>
    {%- endfor -%}
  </div>

  <div class="qty-ladder__options" data-qty-options></div>

  <button type="button" class="qty-ladder__cta" data-qty-cta>Add to cart</button>
  <p class="qty-ladder__error" data-qty-error hidden></p>

  {%- comment -%} Variant data per tier, for the option selector. {%- endcomment -%}
  <script type="application/json" data-qty-data>
    {
      {%- for handle in ladder_handles -%}
        {%- assign p = all_products[handle] -%}
        {%- if p != blank -%}
        "{{ handle }}": {
          "optionName": {{ p.options.first | json }},
          "variants": [
            {%- for v in p.variants -%}
            {"id": {{ v.id }}, "title": {{ v.title | json }}, "available": {{ v.available }}}{%- unless forloop.last -%},{%- endunless -%}
            {%- endfor -%}
          ]
        }{%- unless forloop.last -%},{%- endunless -%}
        {%- endif -%}
      {%- endfor -%}
    }
  </script>
</div>

<style>
  .qty-ladder__tiers{display:grid;gap:8px;margin:12px 0}
  .qty-ladder__tier{display:grid;grid-template-columns:auto 1fr auto;gap:10px;align-items:center;
    border:1px solid #e0ded8;border-radius:8px;padding:12px 14px;cursor:pointer;background:#faf8f4}
  .qty-ladder__tier.is-selected{border-color:#4a8b3c;box-shadow:0 0 0 1px #4a8b3c}
  .qty-ladder__qty{font-weight:700}
  .qty-ladder__price{font-variant-numeric:tabular-nums;font-weight:700;text-align:right}
  .qty-ladder__unit{grid-column:2;font-size:.85em;color:#6d7175}
  .qty-ladder__badge{grid-column:1/-1;justify-self:start;background:#4a8b3c;color:#fff;
    border-radius:4px;padding:3px 9px;font-size:.85em;font-weight:700}
  .qty-ladder__cta{width:100%;padding:14px;border:0;border-radius:8px;background:#1a1b18;color:#fff;
    font-weight:700;font-size:1rem;cursor:pointer}
  .qty-ladder__cta[disabled]{opacity:.5;cursor:not-allowed}
  .qty-ladder__error{color:#b3261e;font-size:.9em;margin:8px 0 0}
</style>

<script>
(function () {
  var root = document.querySelector('[data-qty-ladder]');
  if (!root) return;
  var data = JSON.parse(root.querySelector('[data-qty-data]').textContent);
  var optionsEl = root.querySelector('[data-qty-options]');
  var cta = root.querySelector('[data-qty-cta]');
  var errorEl = root.querySelector('[data-qty-error]');
  var chosenOption = null;

  function currentTier() {
    var checked = root.querySelector('input[name="qty-tier"]:checked');
    return checked ? checked.value : null;
  }

  function renderOptions() {
    var tier = currentTier();
    var info = data[tier];
    optionsEl.innerHTML = '';
    if (!info) return;

    var label = document.createElement('label');
    label.textContent = info.optionName;
    label.style.cssText = 'display:block;font-size:.9em;margin:10px 0 4px';
    var select = document.createElement('select');
    select.style.cssText = 'width:100%;padding:10px;border:1px solid #e0ded8;border-radius:6px';

    info.variants.forEach(function (v) {
      var opt = document.createElement('option');
      opt.value = v.id;
      opt.textContent = v.title + (v.available ? '' : ' — sold out');
      opt.disabled = !v.available;
      // Keep the shopper's choice across a tier change when the new tier offers
      // it; otherwise fall back to the first available option.
      if (chosenOption && v.title === chosenOption) opt.selected = true;
      select.appendChild(opt);
    });

    select.addEventListener('change', function () {
      chosenOption = select.options[select.selectedIndex].textContent.replace(' — sold out', '');
      syncCta();
    });
    optionsEl.appendChild(label);
    optionsEl.appendChild(select);
    syncCta();
  }

  function selectedVariant() {
    var select = optionsEl.querySelector('select');
    if (!select) return null;
    var info = data[currentTier()];
    return info.variants.find(function (v) { return String(v.id) === select.value; }) || null;
  }

  function syncCta() {
    var v = selectedVariant();
    cta.disabled = !v || !v.available;
    cta.textContent = v && !v.available ? 'Sold out' : 'Add to cart';
  }

  root.querySelectorAll('input[name="qty-tier"]').forEach(function (input) {
    input.addEventListener('change', function () {
      root.querySelectorAll('.qty-ladder__tier').forEach(function (el) {
        el.classList.toggle('is-selected', el.contains(input) && input.checked);
      });
      renderOptions();
    });
  });

  cta.addEventListener('click', function () {
    var v = selectedVariant();
    if (!v) return;
    errorEl.hidden = true;
    cta.disabled = true;
    fetch('/cart/add.js', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: [{ id: v.id, quantity: 1 }] }),
    })
      .then(function (r) { if (!r.ok) throw new Error('Could not add to cart'); return r.json(); })
      .then(function () { window.location.href = '/cart'; })
      .catch(function (err) {
        errorEl.textContent = err.message + '. Please try again.';
        errorEl.hidden = false;
        cta.disabled = false;
      });
  });

  renderOptions();
})();
</script>

<noscript>
  {%- comment -%} Without JS the default tier is still buyable. {%- endcomment -%}
  {%- assign default_product = all_products[ladder_default] -%}
  {%- form 'product', default_product -%}
    <input type="hidden" name="id" value="{{ default_product.selected_or_first_available_variant.id }}">
    <button type="submit" class="qty-ladder__cta">Add {{ default_product.title }} to cart</button>
  {%- endform -%}
</noscript>
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `nvm use && node --test tests/scripts/build-quantity-ladder.test.js`
Expected: `# pass 2`, `# fail 0`, `# cancelled 0`

- [ ] **Step 6: Commit**

```bash
git add theme/blocks/quantity-ladder.liquid scripts/build-quantity-ladder.mjs tests/scripts/build-quantity-ladder.test.js
git commit -m "feat(quantity-ladder): Liquid block and build script

Structure is baked from the roster; every price is read from all_products
at render time, and a test asserts no price or currency amount appears in
the generated preamble.

The block reads the option name off each product rather than assuming
'Scent' -- toothpaste uses 'Flavor', and assuming would make that ladder
silently match nothing. Ships with a noscript fallback so the default tier
stays buyable without JS."
```

---

### Task 5: Install the soap ladder and verify it live

**Files:**
- Modify: live theme `templates/product.landing-page-bar-soap.json`

**Interfaces:**
- Consumes: `scripts/build-quantity-ladder.mjs` (Task 4)
- Produces: a working ladder on `/products/coconut-soap`

- [ ] **Step 1: Build the block and confirm validation passes against live Shopify**

```bash
nvm use && node scripts/build-quantity-ladder.mjs coconut-soap
```

Expected: `coconut-soap: 3 tiers (1/4/12 units), NNNN bytes`. If it exits 1 with ladder errors, a tier is not ACTIVE — fix that before going further; do not bypass the check.

- [ ] **Step 2: Insert the block into the template and hide the three theme blocks it replaces**

```bash
node scripts/update-theme-asset.mjs get templates/product.landing-page-bar-soap.json /tmp/soap-tpl.json
python3 - <<'PY'
import json
d = json.load(open('/tmp/soap-tpl.json'))
m = d['sections']['main']
m['blocks']['quantity-ladder'] = {
    'type': 'custom_liquid',
    'settings': {'custom_liquid': open('data/ladder-coconut-soap.liquid').read()},
}
order = [b for b in m['block_order'] if b not in ('variant_picker', 'buy_buttons', 'sticky_cart')]
order.insert(order.index('discount-callout') + 1, 'quantity-ladder')
m['block_order'] = order
json.dump(d, open('/tmp/soap-tpl-new.json', 'w'), indent=2, ensure_ascii=False)
print('block_order:', m['block_order'])
PY
```

Blocks are hidden by removing their IDs from `block_order`; their definitions stay in `blocks`, so restoring one is re-adding its ID. Expected output: `quantity-ladder` present, `variant_picker` / `buy_buttons` / `sticky_cart` absent.

- [ ] **Step 3: Review the diff, then apply**

```bash
node scripts/update-theme-asset.mjs put templates/product.landing-page-bar-soap.json /tmp/soap-tpl-new.json
node scripts/update-theme-asset.mjs put templates/product.landing-page-bar-soap.json /tmp/soap-tpl-new.json --apply
```

- [ ] **Step 4: Verify the rendered page**

```bash
sleep 3
curl -s -o /tmp/soap.html -w 'HTTP %{http_code}\n' https://www.realskincare.com/products/coconut-soap
grep -c 'data-qty-ladder' /tmp/soap.html          # expect 1
grep -o '\$11\.00\|\$39\.00\|\$88\.00' /tmp/soap.html | sort -u   # expect all three
grep -o 'Buy 8, get 4 free' /tmp/soap.html         # expect exactly this, once
grep -c 'product-form__submit' /tmp/soap.html      # expect 0 — theme buy box gone
```

- [ ] **Step 5: Verify all 14 tier×option combinations add the right thing to a cart**

```bash
for id in $(python3 -c "
import json,re
h=open('/tmp/soap.html').read()
d=json.loads(re.search(r'data-qty-data>(.*?)</script>', h, re.S).group(1))
print(' '.join(str(v['id']) for t in d.values() for v in t['variants']))
"); do
  code=$(curl -s -o /dev/null -w '%{http_code}' -X POST https://www.realskincare.com/cart/add.js \
    -H 'Content-Type: application/json' -d "{\"items\":[{\"id\":$id,\"quantity\":1}]}")
  echo "$code  $id"
done
```

Expected: `200` for all 14. Any non-200 is an unbuyable tier×option pair — fix before proceeding.

- [ ] **Step 6: Commit**

```bash
git add theme/blocks/quantity-ladder.liquid
git commit -m "feat(theme): install the soap quantity ladder

Live on /products/coconut-soap: 1/4/12 tiers, theme variant_picker,
buy_buttons and sticky_cart hidden by removal from block_order (their
definitions stay, so restoring one is re-adding its ID).

Verified: page 200, all three tier prices render, 'Buy 8, get 4 free'
appears once and only on the 12-pack, theme buy box absent, and all 14
tier x option variants return 200 from /cart/add.js."
```

---

### Task 6: Keep the tier-target products out of the index

**Files:**
- Modify: live theme `templates/product.scoped-gallery.json` and the default `templates/product.json` (add a `noindex` custom_liquid block gated on a product tag)
- Modify: `config/bundles.json` (tag tier-target products `ladder-tier`)

**Interfaces:**
- Consumes: `roster.ladders` (Task 3)
- Produces: nothing later depends on this

- [ ] **Step 0: Confirm the tier targets are already out of every collection**

The spec requires tier targets to be excluded from collections *and* noindexed. Every bundle in the roster already carries `"collections": []`, so the first half should need no work — verify rather than assume:

```bash
nvm use && node -e "
import('./lib/shopify.js').then(async ({shopifyGraphQL}) => {
  for (const h of ['coconut-bar-soap-4-pack','coconut-bar-soap-12-pack','coconut-deodorant-4-pack','coconut-toothpaste-3-pack']) {
    const d = await shopifyGraphQL('{ productByHandle(handle:\"'+h+'\"){ collections(first:20){nodes{handle}} } }');
    const c = d.productByHandle.collections.nodes.map(n=>n.handle);
    console.log(h, '->', c.length ? c.join(', ') : '(none)');
  }
});"
```

Expected: `(none)` for all four. If any product is in a collection, remove it there before continuing — a noindexed page still sitting in a collection is reachable by crawl and defeats the purpose.

- [ ] **Step 1: Tag every non-base tier product**

```bash
python3 - <<'PY'
import json
p = 'config/bundles.json'
d = json.load(open(p))
targets = {h for l in d['ladders'] for h in l['tiers'] if h != l['base']}
for b in d['bundles']:
    if b['handle'] in targets and 'ladder-tier' not in b['tags']:
        b['tags'].append('ladder-tier')
        b['tags'].sort()
open(p, 'w').write(json.dumps(d, indent=2, ensure_ascii=False) + '\n')
print('tagged:', sorted(targets))
PY
```

Expected: `['coconut-bar-soap-12-pack', 'coconut-bar-soap-4-pack', 'coconut-deodorant-4-pack', 'coconut-toothpaste-3-pack']`

- [ ] **Step 2: Push the tags to Shopify**

```bash
nvm use && node scripts/build-bundle.mjs --all
```

Review the dry-run output. It must show tag changes only. **If it proposes any `template:` change, stop** — that is the path that would have unscoped `coconut-deodorant-4-pack`'s gallery on 2026-08-25. Then:

```bash
node scripts/build-bundle.mjs --all --apply
```

- [ ] **Step 3: Add the noindex block to both templates that serve tier targets**

The block is tag-gated, so it is inert on every other product using those templates.

```liquid
{%- comment -%}
  Tier-target products must stay purchasable (the ladder adds their variants to
  the cart) but must not compete with the base product's PDP for the same query.
  One page accumulating signal, not several splitting it.
{%- endcomment -%}
{%- if product.tags contains 'ladder-tier' -%}
  <meta name="robots" content="noindex,follow">
{%- endif -%}
```

Save as `theme/blocks/ladder-tier-noindex.liquid` and install into `templates/product.scoped-gallery.json` (serves `coconut-deodorant-4-pack`) and `templates/product.json` (serves `coconut-bar-soap-4-pack`, `coconut-bar-soap-12-pack`, `coconut-toothpaste-3-pack`) as a `custom_liquid` block with id `ladder-tier-noindex`, appended to `block_order`.

- [ ] **Step 4: Verify noindex is present on tier targets and absent elsewhere**

```bash
for h in coconut-bar-soap-12-pack coconut-bar-soap-4-pack coconut-deodorant-4-pack coconut-toothpaste-3-pack; do
  echo "$h: $(curl -s https://www.realskincare.com/products/$h | grep -c 'noindex')"
done
for h in coconut-soap coconut-oil-deodorant coconut-oil-toothpaste sensitive-skin-starter-set; do
  echo "$h (must be 0): $(curl -s https://www.realskincare.com/products/$h | grep -c 'noindex')"
done
```

Expected: 1 for each tier target, **0** for every base product and unrelated bundle.

- [ ] **Step 5: Commit**

```bash
git add config/bundles.json theme/blocks/ladder-tier-noindex.liquid
git commit -m "feat(seo): noindex the ladder tier-target products

Tier targets stay published -- the ladder adds their variants to the cart --
but are kept out of the index so each base product's PDP is the single URL
accumulating signal for its query, per the collection-architecture rule.

Gated on a 'ladder-tier' product tag so the block is inert on every other
product sharing those templates."
```

---

### Task 7: Deodorant ladder

Only start this once Task 5 is verified live. Same mechanics; the differences are two tiers instead of three and a savings badge instead of free-unit framing (`53/15 = 3.53`, not whole).

**Files:**
- Modify: live theme `templates/product.landing-page-deodorant.json`

**Interfaces:**
- Consumes: everything from Tasks 2–4
- Produces: a working ladder on `/products/coconut-oil-deodorant`

- [ ] **Step 1: Confirm the base product's gallery is not gang-scoped**

```bash
nvm use && node -e "
import('./lib/shopify.js').then(async ({shopifyGraphQL}) => {
  const d = await shopifyGraphQL('{ productByHandle(handle:\"coconut-oil-deodorant\"){ templateSuffix media(first:30){nodes{... on MediaImage{alt}}} } }');
  const alts = d.productByHandle.media.nodes.map(m=>m.alt||'');
  console.log('template:', d.productByHandle.templateSuffix, '| gang-scoped:', alts.filter(a=>a.includes('#')).length, '/', alts.length);
});"
```

Expected: `landing-page-deodorant | gang-scoped: 0 / 9`. **If gang-scoped is non-zero, stop** — hiding `variant_picker` on a gang-scoped product needs its own analysis.

- [ ] **Step 2: Build and inspect the block**

```bash
node scripts/build-quantity-ladder.mjs coconut-oil-deodorant
grep -c 'Buy .*, get .* free' data/ladder-coconut-oil-deodorant.liquid || true
```

Expected: `coconut-oil-deodorant: 2 tiers (1/4 units)`. The free-unit branch exists in the template but must not fire at render — verified on the live page in Step 4.

- [ ] **Step 3: Install into the template**

```bash
node scripts/update-theme-asset.mjs get templates/product.landing-page-deodorant.json /tmp/deo-tpl.json
python3 - <<'PY'
import json
d = json.load(open('/tmp/deo-tpl.json'))
m = d['sections']['main']
m['blocks']['quantity-ladder'] = {
    'type': 'custom_liquid',
    'settings': {'custom_liquid': open('data/ladder-coconut-oil-deodorant.liquid').read()},
}
order = [b for b in m['block_order'] if b not in ('variant_picker', 'buy_buttons', 'sticky_cart')]
insert_at = order.index('price') + 1 if 'price' in order else len(order)
order.insert(insert_at, 'quantity-ladder')
m['block_order'] = order
json.dump(d, open('/tmp/deo-tpl-new.json', 'w'), indent=2, ensure_ascii=False)
print('block_order:', m['block_order'])
PY
node scripts/update-theme-asset.mjs put templates/product.landing-page-deodorant.json /tmp/deo-tpl-new.json
node scripts/update-theme-asset.mjs put templates/product.landing-page-deodorant.json /tmp/deo-tpl-new.json --apply
```

- [ ] **Step 4: Verify live, including that free-unit framing does NOT appear**

```bash
sleep 3
curl -s -o /tmp/deo.html -w 'HTTP %{http_code}\n' https://www.realskincare.com/products/coconut-oil-deodorant
grep -c 'data-qty-ladder' /tmp/deo.html        # expect 1
grep -o '\$15\.00\|\$53\.00' /tmp/deo.html | sort -u    # expect both
grep -c 'get .* free' /tmp/deo.html            # expect 0 — 53/15 is not whole
grep -o 'Save \$[0-9.]*' /tmp/deo.html         # expect Save $7.00
```

- [ ] **Step 5: Verify all 9 tier×scent combinations add to cart**

```bash
for id in $(python3 -c "
import json,re
h=open('/tmp/deo.html').read()
d=json.loads(re.search(r'data-qty-data>(.*?)</script>', h, re.S).group(1))
print(' '.join(str(v['id']) for t in d.values() for v in t['variants']))
"); do
  echo "$(curl -s -o /dev/null -w '%{http_code}' -X POST https://www.realskincare.com/cart/add.js \
    -H 'Content-Type: application/json' -d "{\"items\":[{\"id\":$id,\"quantity\":1}]}")  $id"
done
```

Expected: `200` ×9.

- [ ] **Step 6: Commit**

```bash
git commit --allow-empty -m "feat(theme): install the deodorant quantity ladder

1/4 tiers on /products/coconut-oil-deodorant. Verified the free-unit
badge does NOT render -- 53/15 = 3.53 is not whole, so it correctly falls
back to 'Save \$7.00' -- and all 9 tier x scent variants return 200."
```

---

### Task 8: Toothpaste ladder

The riskiest of the three, because its option axis is **Flavor**, not Scent. If the block ever hardcoded "Scent" this is where it silently renders an empty selector.

**Files:**
- Modify: live theme `templates/product.landing-page-toothpaste.json`

**Interfaces:**
- Consumes: everything from Tasks 2–4
- Produces: a working ladder on `/products/coconut-oil-toothpaste`

- [ ] **Step 1: Confirm the option name and gallery scoping**

```bash
nvm use && node -e "
import('./lib/shopify.js').then(async ({shopifyGraphQL}) => {
  for (const h of ['coconut-oil-toothpaste','coconut-toothpaste-3-pack']) {
    const d = await shopifyGraphQL('{ productByHandle(handle:\"'+h+'\"){ templateSuffix options{name} media(first:30){nodes{... on MediaImage{alt}}} } }');
    const p = d.productByHandle;
    const alts = p.media.nodes.map(m=>m.alt||'');
    console.log(h, '| options:', p.options.map(o=>o.name).join(','), '| gang:', alts.filter(a=>a.includes('#')).length, '/', alts.length);
  }
});"
```

Expected: both report `options: Flavor` (or `Flavour`) and `gang: 0`. Note the exact spelling — the block reads it from the product, so either works, but Step 4 greps for it.

- [ ] **Step 2: Build the block**

```bash
node scripts/build-quantity-ladder.mjs coconut-oil-toothpaste
```

Expected: `coconut-oil-toothpaste: 2 tiers (1/3 units)`

- [ ] **Step 3: Install into the template**

```bash
node scripts/update-theme-asset.mjs get templates/product.landing-page-toothpaste.json /tmp/tp-tpl.json
python3 - <<'PY'
import json
d = json.load(open('/tmp/tp-tpl.json'))
m = d['sections']['main']
m['blocks']['quantity-ladder'] = {
    'type': 'custom_liquid',
    'settings': {'custom_liquid': open('data/ladder-coconut-oil-toothpaste.liquid').read()},
}
order = [b for b in m['block_order'] if b not in ('variant_picker', 'buy_buttons', 'sticky_cart')]
insert_at = order.index('price') + 1 if 'price' in order else len(order)
order.insert(insert_at, 'quantity-ladder')
m['block_order'] = order
json.dump(d, open('/tmp/tp-tpl-new.json', 'w'), indent=2, ensure_ascii=False)
print('block_order:', m['block_order'])
PY
node scripts/update-theme-asset.mjs put templates/product.landing-page-toothpaste.json /tmp/tp-tpl-new.json
node scripts/update-theme-asset.mjs put templates/product.landing-page-toothpaste.json /tmp/tp-tpl-new.json --apply
```

- [ ] **Step 4: Verify live — especially that the Flavor selector is populated**

```bash
sleep 3
curl -s -o /tmp/tp.html -w 'HTTP %{http_code}\n' https://www.realskincare.com/products/coconut-oil-toothpaste
grep -c 'data-qty-ladder' /tmp/tp.html                    # expect 1
grep -o '"optionName":"Flavou\?r"' /tmp/tp.html | head    # expect a match — NOT "Scent"
python3 -c "
import json,re
d=json.loads(re.search(r'data-qty-data>(.*?)</script>', open('/tmp/tp.html').read(), re.S).group(1))
for h,t in d.items(): print(h, t['optionName'], len(t['variants']), 'variants')
"
```

Expected: `coconut-oil-toothpaste Flavor 3 variants` and `coconut-toothpaste-3-pack Flavor 4 variants`. **A zero-variant tier means the option name was mismatched** — the failure this task exists to catch.

- [ ] **Step 5: Verify all 7 tier×flavour combinations add to cart**

```bash
for id in $(python3 -c "
import json,re
d=json.loads(re.search(r'data-qty-data>(.*?)</script>', open('/tmp/tp.html').read(), re.S).group(1))
print(' '.join(str(v['id']) for t in d.values() for v in t['variants']))
"); do
  echo "$(curl -s -o /dev/null -w '%{http_code}' -X POST https://www.realskincare.com/cart/add.js \
    -H 'Content-Type: application/json' -d "{\"items\":[{\"id\":$id,\"quantity\":1}]}")  $id"
done
```

Expected: `200` ×7.

- [ ] **Step 6: Commit and open the PR**

```bash
git commit --allow-empty -m "feat(theme): install the toothpaste quantity ladder

1/3 tiers on /products/coconut-oil-toothpaste. This is the ladder whose
option axis is Flavor, not Scent -- verified the selector is populated with
3 and 4 variants rather than silently empty, which is what a hardcoded
'Scent' would have produced."
gh pr create --title "feat: quantity ladders on the three consumable PDPs" --body "See docs/superpowers/plans/2026-08-25-quantity-ladders.md"
```

---

## Verification summary

| Check | Where | Expected |
|---|---|--:|
| Unit tests | `lib/quantity-ladder.js` | 10 pass, 0 cancelled |
| Roster ladder validation | `lib/bundle-roster.js` | 2 pass |
| No baked prices | `scripts/build-quantity-ladder.mjs` | 2 pass |
| Soap page live | `/products/coconut-soap` | 200, 3 tiers, 1 free-unit badge |
| Deodorant page live | `/products/coconut-oil-deodorant` | 200, 2 tiers, **0** free-unit badges |
| Toothpaste page live | `/products/coconut-oil-toothpaste` | 200, 2 tiers, Flavor populated |
| Cart adds | all three | 30 variants, all 200 |
| noindex | 4 tier targets | present; absent on all 3 base products |
