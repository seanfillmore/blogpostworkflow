# Coconut Reset Offer + Lander Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the live $208/$87-vs-$174 value contradiction on the 90-Day Coconut Reset, and add seven data-driven modules to the shared bundle lander so the page actually sells.

**Architecture:** `product.bundle-landing.json` is one template shared by five bundles; per-product copy comes from a `bundle_lander` metaobject and numbers are summed from a variant-level `bundle.value_stack` metafield. New modules are `custom_liquid` sections reading new metaobject fields, each self-suppressing when its field is empty — so the four other bundles render unchanged until someone writes their copy. Shopify evaluates Liquid **only** inside `custom_liquid` settings, which is why no native section type is used.

**Tech Stack:** Node 22, `node --test`, Shopify Admin REST + GraphQL via `lib/shopify.js`, Liquid.

**Spec:** `docs/superpowers/specs/2026-08-04-coconut-reset-offer-lander-design.md`

## Global Constraints

- **Node 22.** Run `nvm use` before any command. Node 25 hides a class of dead test (`AbortSignal.timeout` unref'd timers report `cancelled`, which prints beside `# fail 0`). When reading test output, check the **cancelled** count, not just fail.
- **The live theme is the source of truth for template JSON.** `origin/main` in `realskincare-theme` does not contain `product.bundle-landing.json` at all. Always `getThemeAsset` → modify → `updateThemeAsset`. Never push a repo copy over a live asset without pulling first.
- **`product.bundle-landing.json` is shared by 5 active bundles:** `99-coconut-reset-digital`, `90-day-clean-swap`, `head-to-toe`, `clean-swap`, `gift-box`. Only the Reset's rendered output may change.
- **Every new section self-suppresses** when its backing metaobject field is blank. No empty boxes.
- **Dry-run by default.** Every mutating script requires an explicit `--apply` flag.
- **All copy derives from `data/context/voice-of-customer.md`.** Do not invent objections or paraphrase proof quotes — golden-nugget phrases are used verbatim.
- **No photographic before/after claims.** No process photography exists. The timeline is an illustrated expectation map only.
- **No accordions for decision-relevant content.** Only reference material (full ingredient list, shipping/returns) stays collapsed.
- **Hero angle is fixed** and binding on the later Meta work: *you keep running out, and you have already spent more than this on lotions that did not work.* Savings is a supporting line, never the lead.
- **Never commit to `main`.** Claude repo work is in worktree `.claude/worktrees/coconut-reset-offer` on `feature/coconut-reset-offer`. Theme repo work branches from `origin/main`, **not** from `feat/coconut-reset-lander` where that checkout currently sits.
- Run tests with `npm test`.

## File Structure

| File | Responsibility |
|---|---|
| `lib/bundle-lander.js` | **Create.** Pure functions: the digital-row exclusion rule, and Liquid builders for each new section. Network-free, fully testable. |
| `tests/lib/bundle-lander.test.js` | **Create.** Tests for the above. |
| `scripts/build-bundle-lander-sections.mjs` | **Create.** Pulls the live template, applies the value-stack rule and injects sections in spec order, pushes with `--apply`. |
| `scripts/update-reset-lander-content.mjs` | **Create.** Adds metaobject field definitions, writes the Reset's copy, fixes `rating_caption`, populates `product.description`. |
| `scripts/verify-bundle-landers.mjs` | **Create.** Captures baselines and asserts post-change state against all five rendered bundle pages. |
| `templates/product.bundle-landing.json` (live theme) | **Modify.** Value-stack Liquid + 7 new sections. |
| `templates/index.json` (live theme) | **Modify.** Homepage banner section. |

---

### Task 1: Baseline capture and the digital-row exclusion rule

The live page sums all four `value_stack` rows to $208 and prints "You save $87" beside a $174 compare-at. This task encodes the rule that fixes it, and captures the before-state every later task verifies against.

**Files:**
- Create: `lib/bundle-lander.js`
- Create: `tests/lib/bundle-lander.test.js`
- Create: `scripts/verify-bundle-landers.mjs`

**Interfaces:**
- Produces: `computeStackTotals(stack, priceCents) → { priced, included, total, price, savings }` — consumed by Task 2's Liquid (which mirrors it) and Task 8's assertions.
- Produces: `scripts/verify-bundle-landers.mjs --capture` writing `data/reports/bundle-landers/baseline-<handle>.txt`.

- [ ] **Step 1: Write the failing test**

Create `tests/lib/bundle-lander.test.js`:

```js
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { computeStackTotals } from '../../lib/bundle-lander.js';

// The Reset's actual live variant-level bundle.value_stack, both variants.
const RESET_STACK = [
  { label: 'Body Lotion (8oz)', qty: 3, amount: 90, img: 'component-lotion.webp' },
  { label: 'Body Cream (4oz)', qty: 3, amount: 84, img: 'component-cream.webp' },
  { label: '90-Day Routine & Tracker', amount: 19, digital: true },
  { label: 'Coconut Skincare Field Guide', amount: 15, digital: true },
];

test('digital rows are excluded from the total', () => {
  const r = computeStackTotals(RESET_STACK, 12100);
  assert.equal(r.total, 174, 'total must be product-only, matching the $174 compare-at');
  assert.equal(r.price, 121);
  assert.equal(r.savings, 53);
});

test('digital rows are returned separately so they can render unpriced', () => {
  const r = computeStackTotals(RESET_STACK, 12100);
  assert.equal(r.priced.length, 2);
  assert.equal(r.included.length, 2);
  assert.deepEqual(r.included.map((x) => x.label), [
    '90-Day Routine & Tracker',
    'Coconut Skincare Field Guide',
  ]);
});

test('the pre-fix behaviour is what we are removing', () => {
  // Summing every row is what produces the live $208/$87 contradiction.
  const naive = RESET_STACK.reduce((s, r) => s + r.amount, 0);
  assert.equal(naive, 208);
  assert.notEqual(computeStackTotals(RESET_STACK, 12100).total, naive);
});

test('a stack with no digital rows is unchanged — the other four bundles', () => {
  const cleanSwap = [
    { label: 'Body Lotion (8oz)', amount: 30 },
    { label: 'Natural Deodorant', amount: 15 },
    { label: 'Coconut Toothpaste', amount: 13 },
    { label: 'Coconut Bar Soap', amount: 11 },
  ];
  const r = computeStackTotals(cleanSwap, 5900);
  assert.equal(r.total, 69);
  assert.equal(r.savings, 10);
  assert.equal(r.included.length, 0);
});

test('missing or malformed stack does not throw', () => {
  assert.deepEqual(computeStackTotals(null, 0), {
    priced: [], included: [], total: 0, price: 0, savings: 0,
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
nvm use && npx node --test tests/lib/bundle-lander.test.js
```

Expected: FAIL — `Cannot find module '../../lib/bundle-lander.js'`.

- [ ] **Step 3: Write minimal implementation**

Create `lib/bundle-lander.js`:

```js
/**
 * Bundle lander — pure helpers for the shared product.bundle-landing template.
 *
 * The value stack sums the components a bundle contains. Digital bonuses are
 * listed as contents but MUST NOT count toward the total: the total is shown
 * beside `compareAtPrice`, which is set from physical goods only. Summing the
 * digital rows too is what put "Total value $208 / You save $87" next to a
 * $174 strikethrough on the live Reset page.
 *
 * This mirrors the Liquid in the `value-stack` block. Change both together.
 */

export function computeStackTotals(stack, priceCents) {
  const rows = Array.isArray(stack) ? stack : [];
  const priced = rows.filter((r) => !r.digital);
  const included = rows.filter((r) => r.digital);
  const total = priced.reduce((s, r) => s + Number(r.amount || 0), 0);
  const price = Math.round(Number(priceCents || 0) / 100);
  return { priced, included, total, price, savings: total - price };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
nvm use && npx node --test tests/lib/bundle-lander.test.js
```

Expected: PASS, 5 tests. Confirm `# cancelled 0`.

- [ ] **Step 5: Write the baseline capture script**

Create `scripts/verify-bundle-landers.mjs`:

```js
/**
 * Bundle lander verification.
 *
 *   node scripts/verify-bundle-landers.mjs --capture   # before any change
 *   node scripts/verify-bundle-landers.mjs --check     # after
 *
 * The four non-Reset bundles share the template being edited. Their rendered
 * pages must not change. Byte comparison is too strict — Shopify varies script
 * nonces and session tokens per request — so this compares NORMALIZED VISIBLE
 * TEXT, which is what "no visible change" actually means.
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const BUNDLES = [
  '99-coconut-reset-digital',
  '90-day-clean-swap',
  'head-to-toe',
  'clean-swap',
  'gift-box',
];
const DIR = 'data/reports/bundle-landers';
const BASE = 'https://www.realskincare.com/products/';

export function normalize(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function sectionKeys(html) {
  const m = html.match(/shopify-section-template--\d+__([a-zA-Z0-9_-]+)/g) || [];
  return [...new Set(m.map((s) => s.split('__')[1]))].sort();
}

async function fetchPage(handle) {
  const res = await fetch(BASE + handle, { headers: { 'cache-control': 'no-cache' } });
  if (!res.ok) throw new Error(`${handle}: HTTP ${res.status}`);
  return res.text();
}

async function main() {
  const mode = process.argv.includes('--check') ? 'check' : 'capture';
  mkdirSync(DIR, { recursive: true });
  let failures = 0;

  for (const handle of BUNDLES) {
    const html = await fetchPage(handle);
    const file = join(DIR, `baseline-${handle}.txt`);

    if (mode === 'capture') {
      writeFileSync(file, normalize(html));
      console.log(`captured ${handle} (${sectionKeys(html).length} sections)`);
      continue;
    }

    if (handle === '99-coconut-reset-digital') {
      const text = normalize(html);
      const must = ['Total value $174', 'You save $53'];
      const mustNot = ['$208', '$87'];
      for (const s of must) {
        if (!text.includes(s)) { console.error(`FAIL ${handle}: missing "${s}"`); failures++; }
      }
      for (const s of mustNot) {
        if (text.includes(s)) { console.error(`FAIL ${handle}: still shows "${s}"`); failures++; }
      }
      console.log(`sections: ${sectionKeys(html).join(', ')}`);
      continue;
    }

    if (!existsSync(file)) { console.error(`FAIL ${handle}: no baseline captured`); failures++; continue; }
    if (readFileSync(file, 'utf8') !== normalize(html)) {
      console.error(`FAIL ${handle}: visible text changed — this bundle must be untouched`);
      failures++;
    } else {
      console.log(`ok   ${handle} unchanged`);
    }
  }

  console.log(failures ? `\n${failures} failure(s)` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
```

- [ ] **Step 6: Capture the baselines**

```bash
nvm use && node scripts/verify-bundle-landers.mjs --capture
```

Expected: five `captured <handle>` lines. These files are the before-state for Task 8. **This must run before any mutation.**

- [ ] **Step 7: Commit**

```bash
git add lib/bundle-lander.js tests/lib/bundle-lander.test.js scripts/verify-bundle-landers.mjs data/reports/bundle-landers/
git commit -m "feat(bundle): exclude digital rows from the value-stack total

Summing digital bonus rows put 'Total value \$208 / You save \$87' beside a
\$174 compare-at on the live Reset page. Encodes the rule and captures
pre-change baselines for the four bundles that must not move."
```

---

### Task 2: Apply the value-stack rule to the live template

**Files:**
- Create: `scripts/build-bundle-lander-sections.mjs`
- Modify: `templates/product.bundle-landing.json` (live theme, via Admin API)

**Interfaces:**
- Consumes: nothing from Task 1 at runtime — the Liquid mirrors `computeStackTotals` rather than importing it (Liquid runs on Shopify's servers).
- Produces: `--value-stack` mode. Task 5 adds `--sections` to the same script.

- [ ] **Step 1: Write the script**

Create `scripts/build-bundle-lander-sections.mjs`:

```js
/**
 * Edit the shared bundle landing template.
 *
 *   node scripts/build-bundle-lander-sections.mjs --value-stack [--apply]
 *   node scripts/build-bundle-lander-sections.mjs --sections    [--apply]
 *
 * FIVE bundles share templates/product.bundle-landing.json. Everything written
 * here must be per-product data-driven, or it leaks one bundle's content onto
 * the other four. Sections self-suppress on blank fields for exactly that
 * reason.
 *
 * The live theme is the source of truth: pull, modify, push. Dry-run default.
 */
import { getMainThemeId, getThemeAsset, updateThemeAsset } from '../lib/shopify.js';

const KEY = 'templates/product.bundle-landing.json';
const APPLY = process.argv.includes('--apply');

// Mirrors computeStackTotals() in lib/bundle-lander.js. Change both together.
const VALUE_STACK_LOGIC = `{%- liquid
  assign total = 0
  assign has_digital = false
  for row in stack
    if row.digital
      assign has_digital = true
    else
      assign total = total | plus: row.amount
    endif
  endfor
  assign price_dollars = v.price | divided_by: 100
  assign savings = total | minus: price_dollars
-%}`;

function patchValueStack(liquid) {
  // Replace the naive sum with the digital-aware one.
  const naive = /\{%-\s*liquid\s+assign total = 0\s+for row in stack\s+assign total = total \| plus: row\.amount\s+endfor\s+assign price_dollars = v\.price \| divided_by: 100\s+assign savings = total \| minus: price_dollars\s*-%\}/;
  if (!naive.test(liquid)) throw new Error('value-stack: expected naive-sum block not found — inspect before proceeding');
  let out = liquid.replace(naive, VALUE_STACK_LOGIC);

  // Priced rows only in the priced list.
  const rowLoop = '{%- for row in stack -%}<div class="crx-vs__row">';
  if (!out.includes(rowLoop)) throw new Error('value-stack: row loop not found');
  out = out.replace(rowLoop, '{%- for row in stack -%}{%- unless row.digital -%}<div class="crx-vs__row">');
  const rowEnd = '<span class="crx-vs__price">${{ row.amount }}</span></div>{%- endfor -%}';
  if (!out.includes(rowEnd)) throw new Error('value-stack: row loop end not found');
  out = out.replace(rowEnd,
    '<span class="crx-vs__price">${{ row.amount }}</span></div>{%- endunless -%}{%- endfor -%}' +
    '{%- if has_digital -%}<div class="crx-vs__incl"><p class="crx-vs__incl-t">Also included, free</p>' +
    '{%- for row in stack -%}{%- if row.digital -%}<div class="crx-vs__incl-r">{{ row.label }}</div>{%- endif -%}{%- endfor -%}' +
    '</div>{%- endif -%}');

  // Styles for the new group.
  out = out.replace('</style>',
    '.crx-vs__incl{margin-top:12px;padding-top:12px;border-top:1px dashed #cbd8c0;}' +
    '.crx-vs__incl-t{margin:0 0 6px;font-size:12.5px;font-weight:700;color:#4a8b3c;letter-spacing:.02em;}' +
    '.crx-vs__incl-r{font-size:13.5px;color:#4a4a4a;line-height:1.5;}' +
    '.crx-vs__incl-r:before{content:"+ ";color:#4a8b3c;font-weight:700;}</style>');
  return out;
}

async function main() {
  const themeId = await getMainThemeId();
  const raw = await getThemeAsset(themeId, KEY);
  if (!raw) throw new Error(`${KEY} not found on theme ${themeId}`);
  const j = JSON.parse(raw);

  if (process.argv.includes('--value-stack')) {
    const block = j.sections.main.blocks['value-stack'];
    if (!block) throw new Error('value-stack block missing');
    const before = block.settings.custom_liquid;
    const after = patchValueStack(before);
    if (before === after) { console.log('value-stack already patched.'); return; }
    block.settings.custom_liquid = after;
    console.log('value-stack: digital rows excluded from total, rendered as "Also included, free"');
    if (!APPLY) { console.log('\ndry run — re-run with --apply to push.'); return; }
    await updateThemeAsset(themeId, KEY, JSON.stringify(j, null, 2));
    console.log(`pushed ${KEY} to theme ${themeId}`);
    return;
  }

  console.error('specify --value-stack or --sections');
  process.exit(1);
}

await main();
```

- [ ] **Step 2: Dry-run**

```bash
nvm use && node scripts/build-bundle-lander-sections.mjs --value-stack
```

Expected: the "digital rows excluded" line, then `dry run`. If either `throw` fires, stop — the live template differs from what this plan inspected.

- [ ] **Step 3: Apply**

```bash
node scripts/build-bundle-lander-sections.mjs --value-stack --apply
```

Expected: `pushed templates/product.bundle-landing.json`.

- [ ] **Step 4: Verify against the rendered page**

```bash
node scripts/verify-bundle-landers.mjs --check
```

Expected: Reset shows `Total value $174` and `You save $53`, with `$208`/`$87` gone; the other four report `unchanged`.

- [ ] **Step 5: Commit**

```bash
git add scripts/build-bundle-lander-sections.mjs
git commit -m "fix(bundle): value stack totals goods only, guides listed unpriced

Live Reset page asserted \$208 total and \$87 savings against a \$174
compare-at. Digital rows now render under 'Also included, free'."
```

---

### Task 3: Add the metaobject field definitions

Six new metaobject fields back the new sections (the seventh module, the compare table, reads a product metafield instead — see the note in the code). Adding a definition is inert: every field is blank on all six landers until Task 6 writes content, and every section self-suppresses on blank.

**Files:**
- Create: `scripts/update-reset-lander-content.mjs`

**Interfaces:**
- Produces: fields `hook`, `ingredient_cards`, `stats`, `mechanism`, `timeline`, `founder_note` on metaobject definition `bundle_lander`. Task 4's Liquid reads these exact keys; Task 6 populates them. `bundle.comparison_rows` is a product metafield and needs no definition step.

- [ ] **Step 1: Write the definitions half of the script**

Create `scripts/update-reset-lander-content.mjs`:

```js
/**
 * Reset lander content.
 *
 *   node scripts/update-reset-lander-content.mjs --definitions [--apply]
 *   node scripts/update-reset-lander-content.mjs --content     [--apply]
 *
 * Definitions are inert: sections self-suppress until content exists, so this
 * can ship ahead of the copy without touching any live page.
 */
import { shopifyGraphQL } from '../lib/shopify.js';

const APPLY = process.argv.includes('--apply');

// NOTE: `comparison_rows` is deliberately NOT here. It is a PRODUCT metafield
// (`bundle.comparison_rows`), per the schema in docs/bundle-landing-architecture.md,
// created by metafieldsSet in Task 6. Liquid reads product metafields without a
// definition, the same way bundle.value_stack and bundle.lander are read today.
const NEW_FIELDS = [
  { key: 'hook',            name: 'Hook',             type: 'multi_line_text_field' },
  { key: 'ingredient_cards',name: 'Ingredient cards', type: 'json' },
  { key: 'stats',           name: 'Stats',            type: 'json' },
  { key: 'mechanism',       name: 'Mechanism',        type: 'json' },
  { key: 'timeline',        name: 'Timeline',         type: 'json' },
  { key: 'founder_note',    name: 'Founder note',     type: 'multi_line_text_field' },
];

async function definitions() {
  const cur = await shopifyGraphQL(`{
    metaobjectDefinitionByType(type:"bundle_lander"){ id fieldDefinitions { key } } }`);
  const def = cur.metaobjectDefinitionByType;
  if (!def) throw new Error('bundle_lander definition not found');
  const have = new Set(def.fieldDefinitions.map((f) => f.key));
  const missing = NEW_FIELDS.filter((f) => !have.has(f.key));

  if (!missing.length) { console.log('all fields already defined.'); return; }
  console.log('will add:', missing.map((f) => `${f.key} (${f.type})`).join(', '));
  if (!APPLY) { console.log('\ndry run — re-run with --apply.'); return; }

  const res = await shopifyGraphQL(
    `mutation($id:ID!, $ops:[MetaobjectFieldDefinitionOperationInput!]!){
       metaobjectDefinitionUpdate(id:$id, definition:{ fieldDefinitions:$ops }){
         userErrors{ field message } } }`,
    { id: def.id, ops: missing.map((f) => ({ create: { key: f.key, name: f.name, type: f.type } })) },
  );
  const errs = res.metaobjectDefinitionUpdate.userErrors;
  if (errs.length) throw new Error(JSON.stringify(errs));
  console.log(`added ${missing.length} field definition(s)`);
}

async function main() {
  if (process.argv.includes('--definitions')) return definitions();
  console.error('specify --definitions or --content');
  process.exit(1);
}

await main();
```

- [ ] **Step 2: Dry-run**

```bash
nvm use && node scripts/update-reset-lander-content.mjs --definitions
```

Expected: `will add: hook (multi_line_text_field), ingredient_cards (json), …` — **six** fields. `comparison_rows` is not among them; it is a product metafield written in Task 6.

- [ ] **Step 3: Apply**

```bash
node scripts/update-reset-lander-content.mjs --definitions --apply
```

Expected: `added 6 field definition(s)`.

- [ ] **Step 4: Confirm no page changed**

```bash
node scripts/verify-bundle-landers.mjs --check
```

Expected: all five as before — definitions alone render nothing.

- [ ] **Step 5: Commit**

```bash
git add scripts/update-reset-lander-content.mjs
git commit -m "feat(bundle): add metaobject fields backing the new lander modules"
```

---

### Task 4: Section Liquid builders

**Files:**
- Modify: `lib/bundle-lander.js`
- Modify: `tests/lib/bundle-lander.test.js`

**Interfaces:**
- Produces: `SECTIONS` — an array of `{ key, type, settings }` objects in spec render order, consumed by Task 5.
- Every builder guards on its field being non-blank.

- [ ] **Step 1: Write the failing tests**

Append to `tests/lib/bundle-lander.test.js`:

```js
import { SECTIONS } from '../../lib/bundle-lander.js';

test('every new section is custom-liquid — native sections cannot evaluate Liquid', () => {
  for (const s of SECTIONS) assert.equal(s.type, 'custom-liquid', `${s.key} must be custom-liquid`);
});

test('every new section self-suppresses on a blank field', () => {
  for (const s of SECTIONS) {
    const l = s.settings.custom_liquid;
    assert.match(l, /!= blank|\.size > 0/, `${s.key} has no blank guard — would render an empty box`);
  }
});

test('every new section reads the bundle_lander metaobject, never a literal', () => {
  for (const s of SECTIONS) {
    assert.match(s.settings.custom_liquid, /product\.metafields\.bundle\./,
      `${s.key} must read product data`);
  }
});

test('sections are in the decision-relevance order the spec fixes', () => {
  assert.deepEqual(SECTIONS.map((s) => s.key), [
    'hook', 'timeline', 'mechanism', 'ingredient-cards', 'stats', 'compare-rows', 'founder-note',
  ]);
});

test('no section hides decision-relevant content behind an accordion', () => {
  for (const s of SECTIONS) {
    assert.doesNotMatch(s.settings.custom_liquid, /<details/,
      `${s.key} uses <details> — skimmers do not open accordions`);
  }
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
nvm use && npx node --test tests/lib/bundle-lander.test.js
```

Expected: FAIL — `SECTIONS` is not exported.

- [ ] **Step 3: Implement the builders**

Append to `lib/bundle-lander.js`:

```js
const L = 'product.metafields.bundle.lander.value';

const css = (s) => `<style>${s}</style>`;

/** Sections added to the shared bundle-landing template, in render order. */
export const SECTIONS = [
  {
    key: 'hook',
    type: 'custom-liquid',
    settings: {
      custom_liquid:
        css('.bhook{max-width:760px;margin:0 auto;padding:44px 18px;text-align:center}.bhook p{font-size:clamp(19px,2.4vw,25px);line-height:1.45;color:#1a1b18;font-weight:600;margin:0}') +
        `{%- assign hook = ${L}.hook -%}{%- if hook != blank -%}` +
        `<div class="bhook"><p>{{ hook | newline_to_br }}</p></div>{%- endif -%}`,
    },
  },
  {
    key: 'timeline',
    type: 'custom-liquid',
    settings: {
      custom_liquid:
        css('.btl{max-width:960px;margin:0 auto;padding:52px 18px}.btl__h{text-align:center;font-size:clamp(22px,3vw,30px);font-weight:700;margin:0 0 8px;color:#1a1b18}.btl__s{text-align:center;color:#6d7175;margin:0 0 30px;font-size:15px}.btl__g{display:grid;gap:18px;grid-template-columns:repeat(auto-fit,minmax(210px,1fr))}.btl__c{background:#f6f8f3;border-radius:14px;padding:22px 20px;border:1px solid #e2ead9}.btl__w{font-size:12.5px;font-weight:700;color:#4a8b3c;letter-spacing:.06em;text-transform:uppercase;margin:0 0 8px}.btl__t{font-size:16.5px;font-weight:700;color:#1a1b18;margin:0 0 6px;line-height:1.3}.btl__b{font-size:14px;color:#4a4a4a;line-height:1.6;margin:0}') +
        `{%- assign tl = ${L}.timeline.value -%}{%- if tl != blank and tl.size > 0 -%}` +
        '<div class="btl"><h2 class="btl__h">What to expect</h2>' +
        '<p class="btl__s">No before-and-after photos — just what you use, and when.</p><div class="btl__g">' +
        '{%- for step in tl -%}<div class="btl__c"><p class="btl__w">{{ step.when }}</p>' +
        '<p class="btl__t">{{ step.title }}</p><p class="btl__b">{{ step.body }}</p></div>{%- endfor -%}' +
        '</div></div>{%- endif -%}',
    },
  },
  {
    key: 'mechanism',
    type: 'custom-liquid',
    settings: {
      custom_liquid:
        css('.bmec{max-width:900px;margin:0 auto;padding:48px 18px}.bmec__h{text-align:center;font-size:clamp(22px,3vw,30px);font-weight:700;margin:0 0 26px;color:#1a1b18}.bmec__g{display:grid;gap:20px;grid-template-columns:repeat(auto-fit,minmax(250px,1fr))}.bmec__t{font-size:16px;font-weight:700;margin:0 0 6px;color:#1a1b18}.bmec__b{font-size:14.5px;color:#4a4a4a;line-height:1.6;margin:0}') +
        `{%- assign me = ${L}.mechanism.value -%}{%- if me != blank and me.size > 0 -%}` +
        '<div class="bmec"><h2 class="bmec__h">Two formulas, one routine</h2><div class="bmec__g">' +
        '{%- for m in me -%}<div><p class="bmec__t">{{ m.title }}</p><p class="bmec__b">{{ m.body }}</p></div>{%- endfor -%}' +
        '</div></div>{%- endif -%}',
    },
  },
  {
    key: 'ingredient-cards',
    type: 'custom-liquid',
    settings: {
      custom_liquid:
        css('.bing{max-width:900px;margin:0 auto;padding:48px 18px}.bing__h{text-align:center;font-size:clamp(22px,3vw,30px);font-weight:700;margin:0 0 26px;color:#1a1b18}.bing__g{display:grid;gap:16px;grid-template-columns:repeat(auto-fit,minmax(190px,1fr))}.bing__c{border:1px solid #e2ead9;border-radius:12px;padding:18px}.bing__n{font-size:15px;font-weight:700;margin:0 0 4px;color:#1a1b18}.bing__d{font-size:13.5px;color:#4a4a4a;line-height:1.55;margin:0}') +
        `{%- assign ic = ${L}.ingredient_cards.value -%}{%- if ic != blank and ic.size > 0 -%}` +
        '<div class="bing"><h2 class="bing__h">Everything that\'s in it</h2><div class="bing__g">' +
        '{%- for c in ic -%}<div class="bing__c"><p class="bing__n">{{ c.name }}</p><p class="bing__d">{{ c.role }}</p></div>{%- endfor -%}' +
        '</div></div>{%- endif -%}',
    },
  },
  {
    key: 'stats',
    type: 'custom-liquid',
    settings: {
      custom_liquid:
        css('.bstat{background:#f6f8f3;padding:38px 18px}.bstat__g{max-width:900px;margin:0 auto;display:grid;gap:20px;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));text-align:center}.bstat__v{font-size:clamp(24px,3.4vw,34px);font-weight:800;color:#4a8b3c;margin:0;line-height:1.1}.bstat__l{font-size:13.5px;color:#4a4a4a;margin:6px 0 0;line-height:1.4}') +
        `{%- assign st = ${L}.stats.value -%}{%- if st != blank and st.size > 0 -%}` +
        '<div class="bstat"><div class="bstat__g">' +
        '{%- for s in st -%}<div><p class="bstat__v">{{ s.value }}</p><p class="bstat__l">{{ s.label }}</p></div>{%- endfor -%}' +
        '</div></div>{%- endif -%}',
    },
  },
  {
    key: 'compare-rows',
    type: 'custom-liquid',
    settings: {
      custom_liquid:
        css('.bcmp{max-width:820px;margin:0 auto;padding:48px 18px}.bcmp__h{text-align:center;font-size:clamp(22px,3vw,30px);font-weight:700;margin:0 0 8px;color:#1a1b18}.bcmp__s{text-align:center;color:#6d7175;margin:0 0 24px;font-size:15px}.bcmp__r{display:grid;grid-template-columns:1fr auto auto;gap:12px;align-items:center;padding:13px 4px;border-bottom:1px solid #e3e3e3;font-size:14.5px}.bcmp__hd{font-weight:700;color:#6d7175;font-size:12.5px;text-transform:uppercase;letter-spacing:.04em}.bcmp__y{color:#4a8b3c;font-weight:700}.bcmp__n{color:#b23c3c}') +
        '{%- assign cr = product.metafields.bundle.comparison_rows.value -%}{%- if cr != blank and cr.size > 0 -%}' +
        '<div class="bcmp"><h2 class="bcmp__h">How this compares</h2>' +
        '<p class="bcmp__s">Against the drugstore brands most often recommended for sensitive skin.</p>' +
        '<div class="bcmp__r bcmp__hd"><span>&nbsp;</span><span>Us</span><span>Them</span></div>' +
        '{%- for r in cr -%}<div class="bcmp__r"><span>{{ r.attribute }}</span>' +
        '<span class="bcmp__y">{{ r.us }}</span><span class="bcmp__n">{{ r.them }}</span></div>{%- endfor -%}' +
        '</div>{%- endif -%}',
    },
  },
  {
    key: 'founder-note',
    type: 'custom-liquid',
    settings: {
      custom_liquid:
        css('.bfnd{max-width:720px;margin:0 auto;padding:48px 18px;text-align:center}.bfnd__b{font-size:16px;line-height:1.7;color:#33352f;margin:0 0 14px;font-style:italic}.bfnd__n{font-size:14px;font-weight:700;color:#1a1b18;margin:0}') +
        `{%- assign fn = ${L}.founder_note -%}{%- if fn != blank -%}` +
        '<div class="bfnd"><p class="bfnd__b">{{ fn | newline_to_br }}</p>' +
        '<p class="bfnd__n">— Sean Fillmore, founder</p></div>{%- endif -%}',
    },
  },
];
```

- [ ] **Step 4: Run tests**

```bash
nvm use && npm test
```

Expected: PASS, all suites. Confirm `# cancelled 0`.

- [ ] **Step 5: Commit**

```bash
git add lib/bundle-lander.js tests/lib/bundle-lander.test.js
git commit -m "feat(bundle): Liquid builders for the seven new lander modules

All custom-liquid (native sections cannot evaluate Liquid), all guarded on
blank fields so the other four bundles render unchanged, none using
<details> — skimmers do not open accordions."
```

---

### Task 5: Inject the sections into the shared template

**Files:**
- Modify: `scripts/build-bundle-lander-sections.mjs`
- Modify: `templates/product.bundle-landing.json` (live theme)

**Interfaces:**
- Consumes: `SECTIONS` from `lib/bundle-lander.js`.

Target order, existing sections in **bold**: **hero**, hook, **main**, **whats-in-it**, timeline, mechanism, ingredient-cards, stats, compare-rows, **judgeme_section_review_widget_f881**, founder-note, **free-from-block**, **collapsible-content**, **final-cta-strip**.

- [ ] **Step 1: Add the `--sections` mode**

In `scripts/build-bundle-lander-sections.mjs`, add the import and the branch:

```js
import { SECTIONS } from '../lib/bundle-lander.js';

const ORDER = [
  'hero', 'hook', 'main', 'whats-in-it', 'timeline', 'mechanism',
  'ingredient-cards', 'stats', 'compare-rows',
  'judgeme_section_review_widget_f881', 'founder-note',
  'free-from-block', 'collapsible-content', 'final-cta-strip',
];

function injectSections(j) {
  let added = 0;
  for (const s of SECTIONS) {
    if (j.sections[s.key]) { console.log(`  ok    ${s.key} already present`); continue; }
    j.sections[s.key] = { type: s.type, settings: s.settings };
    console.log(`  ADD   ${s.key}`);
    added++;
  }
  const present = ORDER.filter((k) => j.sections[k]);
  const extras = Object.keys(j.sections).filter((k) => !present.includes(k));
  if (extras.length) throw new Error(`unexpected sections not in ORDER: ${extras.join(', ')}`);
  j.order = present;
  return added;
}
```

Then inside `main()`, before the final `console.error`:

```js
  if (process.argv.includes('--sections')) {
    const added = injectSections(j);
    console.log(`\norder: ${j.order.join(' → ')}`);
    if (!added) { console.log('nothing to add.'); return; }
    if (!APPLY) { console.log('\ndry run — re-run with --apply to push.'); return; }
    await updateThemeAsset(themeId, KEY, JSON.stringify(j, null, 2));
    console.log(`pushed ${KEY} to theme ${themeId}`);
    return;
  }
```

- [ ] **Step 2: Dry-run**

```bash
nvm use && node scripts/build-bundle-lander-sections.mjs --sections
```

Expected: seven `ADD` lines and the 14-section order. If the `unexpected sections` error fires, the live template gained a section since this plan was written — reconcile `ORDER` before proceeding.

- [ ] **Step 3: Apply**

```bash
node scripts/build-bundle-lander-sections.mjs --sections --apply
```

- [ ] **Step 4: Verify nothing rendered yet**

```bash
node scripts/verify-bundle-landers.mjs --check
```

Expected: **all five unchanged**, including the Reset's `$174`/`$53` from Task 2. The fields are still blank, so every new section self-suppresses. This step is the real test of the blank guards — if any bundle reports changed, a guard is missing.

- [ ] **Step 5: Commit**

```bash
git add scripts/build-bundle-lander-sections.mjs
git commit -m "feat(bundle): inject the seven modules into the shared lander

Sections are inert until content exists — all five bundles verify unchanged
after this, which is what proves the blank guards work."
```

---

### Task 6: Author the Reset's content

Copy comes from `data/context/voice-of-customer.md`. Objection mention-counts are cited so later editors know what each line is load-bearing for.

**Files:**
- Modify: `scripts/update-reset-lander-content.mjs`

- [ ] **Step 1: Add the `--content` mode**

Append to `scripts/update-reset-lander-content.mjs`:

```js
const METAOBJECT_ID = 'gid://shopify/Metaobject/220166586538'; // 99-coconut-reset-digital
const PRODUCT_ID = 'gid://shopify/Product/8566372303018';

// Hero angle (spec-fixed, binding on Meta ads): you keep running out, and you
// have already spent more than this on lotions that did not work.
// Sources: "runs out faster than they expect" (4), "$15 ceiling" (4),
// "sunk-cost fatigue after spending hundreds" (3).
const CONTENT = {
  hook:
    "You have bought the small bottle before. It ran out in a few weeks, right about the time your skin " +
    "started behaving.\nThis is ninety days of both formulas — about $1.34 a day — so you find out what " +
    "your skin does when it never runs out.",

  timeline: JSON.stringify([
    { when: 'Month 1', title: 'Twice a day, every day',
      body: 'Lotion in the morning, cream at night. The first month is about not skipping — dry skin comes back fastest when the routine is occasional.' },
    { when: 'Month 2', title: 'You stop thinking about it',
      body: 'Most people are through their second lotion here. This is usually where the small bottle would have run out.' },
    { when: 'Month 3', title: 'The part you never reach',
      body: 'Third lotion, third jar. Ninety days is long enough to know whether something works, rather than guessing after two weeks.' },
  ]),

  mechanism: JSON.stringify([
    { title: 'Lotion — daily, absorbs fast',
      body: 'Lighter, for everyday use over large areas. "Dude as soon as you put it on it just ABSORBS." Answers the "natural oils sit on top like a greasy baked good" objection (5 mentions).' },
    { title: 'Cream — overnight, concentrated',
      body: 'Thicker, for heels, elbows and cracked hands while you sleep. "It may be a tiny 4oz jar but has the power of a big bottle of lotion."' },
  ]),

  ingredient_cards: JSON.stringify([
    { name: 'Organic virgin coconut oil', role: 'Cold-pressed. The base of both formulas.' },
    { name: 'Organic jojoba', role: 'Closest plant oil to skin\'s own sebum.' },
    { name: 'Purified spring water', role: 'What makes the lotion a lotion, not an oil.' },
    { name: 'Plant-based emulsifying wax', role: 'Holds oil and water together. No petroleum.' },
    { name: 'Grapefruit seed extract', role: 'The preservative — instead of parabens or phenoxyethanol.' },
    { name: 'Beeswax', role: 'The barrier that keeps moisture in overnight.' },
  ]),

  stats: JSON.stringify([
    { value: '6', label: 'ingredients you can pronounce' },
    { value: '90', label: 'days of both formulas' },
    { value: '4.84★', label: 'from 135 reviews' },
    { value: '$1.34', label: 'per day' },
  ]),

  founder_note:
    "I made this because my own family kept running out. The small bottle is the one everybody buys first, " +
    "and it is the one that ends before you know whether it worked.\nThree of each is what ninety days " +
    "actually takes. Nothing else changed — same six ingredients, same batch sizes.",

  rating_caption: 'Rated 4.84 from 135 reviews',
};

// Objection: "CeraVe, Vanicream, Cetaphil are the default recommendation
// for sensitive and eczema skin" — 6 mentions, the entrenched habit to displace.
const COMPARISON_ROWS = JSON.stringify([
  { attribute: 'Ingredient count', us: '6', them: '20+' },
  { attribute: 'Preservative', us: 'Grapefruit seed', them: 'Parabens / phenoxyethanol' },
  { attribute: 'Fragrance', us: 'Essential oil or none', them: 'Synthetic "fragrance"' },
  { attribute: 'Mineral oil', us: 'None', them: 'Common' },
  { attribute: 'Made in', us: 'USA, small batch', them: 'Contract manufactured' },
]);

const DESCRIPTION = `<p>Ninety days of the two formulas that do the work: three 8oz Body Lotions for
every day, and three 4oz Body Creams for overnight. Both are made from the same six ingredients —
organic virgin coconut oil, organic jojoba, purified spring water, plant-based emulsifying wax,
grapefruit seed extract and beeswax.</p>
<p>Most people buy the small bottle, run out in a few weeks, and never find out what their skin does
with a routine it can rely on. This is the size that answers that. Works out to about $1.34 a day.</p>
<p>Made for your body, not your face. Includes the 90-Day Routine &amp; Tracker and the Coconut
Skincare Field Guide, emailed within minutes of ordering. 30-day no-questions-asked money-back
guarantee.</p>`;

async function content() {
  const fields = [
    { key: 'hook', value: CONTENT.hook },
    { key: 'timeline', value: CONTENT.timeline },
    { key: 'mechanism', value: CONTENT.mechanism },
    { key: 'ingredient_cards', value: CONTENT.ingredient_cards },
    { key: 'stats', value: CONTENT.stats },
    { key: 'founder_note', value: CONTENT.founder_note },
    { key: 'rating_caption', value: CONTENT.rating_caption },
  ];
  console.log('metaobject fields:', fields.map((f) => f.key).join(', '));
  console.log('product metafield: bundle.comparison_rows');
  console.log('product.descriptionHtml:', DESCRIPTION.length, 'chars');
  if (!APPLY) { console.log('\ndry run — re-run with --apply.'); return; }

  const mo = await shopifyGraphQL(
    `mutation($id:ID!,$f:[MetaobjectFieldInput!]!){
       metaobjectUpdate(id:$id, metaobject:{fields:$f}){ userErrors{ field message } } }`,
    { id: METAOBJECT_ID, f: fields },
  );
  if (mo.metaobjectUpdate.userErrors.length) throw new Error(JSON.stringify(mo.metaobjectUpdate.userErrors));

  const mf = await shopifyGraphQL(
    `mutation($m:[MetafieldsSetInput!]!){ metafieldsSet(metafields:$m){ userErrors{ field message } } }`,
    { m: [{ ownerId: PRODUCT_ID, namespace: 'bundle', key: 'comparison_rows', type: 'json', value: COMPARISON_ROWS }] },
  );
  if (mf.metafieldsSet.userErrors.length) throw new Error(JSON.stringify(mf.metafieldsSet.userErrors));

  const pr = await shopifyGraphQL(
    `mutation($p:ProductInput!){ productUpdate(product:$p){ userErrors{ field message } } }`,
    { p: { id: PRODUCT_ID, descriptionHtml: DESCRIPTION } },
  );
  if (pr.productUpdate.userErrors.length) throw new Error(JSON.stringify(pr.productUpdate.userErrors));

  console.log('content written.');
}
```

And extend `main()`:

```js
  if (process.argv.includes('--content')) return content();
```

- [ ] **Step 2: Dry-run**

```bash
nvm use && node scripts/update-reset-lander-content.mjs --content
```

- [ ] **Step 3: Apply**

```bash
node scripts/update-reset-lander-content.mjs --content --apply
```

Expected: `content written.`

- [ ] **Step 4: Verify**

```bash
node scripts/verify-bundle-landers.mjs --check
```

Expected: the Reset now differs (all seven sections rendering) and still shows `$174`/`$53`; **the other four still report unchanged.**

- [ ] **Step 5: Confirm the description landed**

```bash
curl -s https://www.realskincare.com/products/99-coconut-reset-digital.js | node -e "
let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
const p=JSON.parse(s);console.log('description chars:', (p.description||'').length);});"
```

Expected: a non-zero count (~700).

- [ ] **Step 6: Commit**

```bash
git add scripts/update-reset-lander-content.mjs
git commit -m "feat(bundle): author Reset lander copy from voice-of-customer research

Hero angle per spec: you keep running out, and you have already spent more
than this on lotions that did not work. Answers the \$15 price ceiling (4
mentions) above the fold. Fixes rating_caption 4.9 -> 4.84/135 and fills
the empty product.description so the offer finally syndicates."
```

---

### Task 7: Homepage banner

**Files:**
- Modify: `templates/index.json` (live theme)
- Modify: `scripts/build-bundle-lander-sections.mjs`

- [ ] **Step 1: Add the `--homepage` mode**

Append to `scripts/build-bundle-lander-sections.mjs`:

```js
const HOME_KEY = 'templates/index.json';
const BANNER_KEY = 'reset-banner';
const BANNER = {
  type: 'custom-liquid',
  settings: {
    custom_liquid:
      '<style>.rbn{background:#f6f8f3;border-top:1px solid #e2ead9;border-bottom:1px solid #e2ead9;padding:26px 18px}' +
      '.rbn__i{max-width:900px;margin:0 auto;display:flex;gap:18px;align-items:center;justify-content:space-between;flex-wrap:wrap}' +
      '.rbn__t{margin:0;font-size:clamp(17px,2.2vw,21px);font-weight:700;color:#1a1b18;line-height:1.35}' +
      '.rbn__s{margin:5px 0 0;font-size:14px;color:#4a4a4a}' +
      '.rbn__c{background:#4a8b3c;color:#fff;text-decoration:none;font-weight:700;font-size:15px;padding:12px 22px;border-radius:8px;white-space:nowrap}</style>' +
      '<div class="rbn"><div class="rbn__i"><div>' +
      '<p class="rbn__t">Tired of running out? Get ninety days of both formulas.</p>' +
      '<p class="rbn__s">3 Body Lotions + 3 Body Creams — about $1.34 a day.</p></div>' +
      '<a class="rbn__c" href="/products/99-coconut-reset-digital">See the 90-Day Reset</a>' +
      '</div></div>',
  },
};
```

And the branch in `main()`:

```js
  if (process.argv.includes('--homepage')) {
    const rawH = await getThemeAsset(themeId, HOME_KEY);
    const h = JSON.parse(rawH);
    if (h.sections[BANNER_KEY]) { console.log('banner already present.'); return; }
    const at = h.order.indexOf('thesis');
    if (at === -1) throw new Error('homepage "thesis" section not found — inspect index.json');
    h.sections[BANNER_KEY] = BANNER;
    h.order.splice(at, 0, BANNER_KEY);
    console.log(`inserted ${BANNER_KEY} before "thesis"`);
    console.log(`order: ${h.order.join(' → ')}`);
    if (!APPLY) { console.log('\ndry run — re-run with --apply to push.'); return; }
    await updateThemeAsset(themeId, HOME_KEY, JSON.stringify(h, null, 2));
    console.log(`pushed ${HOME_KEY}`);
    return;
  }
```

- [ ] **Step 2: Dry-run, then apply**

```bash
nvm use && node scripts/build-bundle-lander-sections.mjs --homepage
node scripts/build-bundle-lander-sections.mjs --homepage --apply
```

- [ ] **Step 3: Verify the homepage links to the lander**

```bash
curl -s https://www.realskincare.com/ | grep -c '99-coconut-reset-digital'
```

Expected: at least `1`. It was `0` before this task.

- [ ] **Step 4: Commit**

```bash
git add scripts/build-bundle-lander-sections.mjs
git commit -m "feat(home): banner linking the 90-Day Reset

The lander had zero entry points -- no homepage placement, no nav link, and
the Shopping campaign lands on the lotion PDP."
```

---

### Task 8: Full verification and theme-repo record

**Files:**
- Create: `templates/product.bundle-landing.json` in `realskincare-theme`
- Modify: `templates/index.json` in `realskincare-theme`

- [ ] **Step 1: Run the whole suite**

```bash
nvm use && npm test
```

Expected: PASS. Confirm `# cancelled 0` — a cancelled test prints beside `# fail 0` and reads like a pass on Node 22.

- [ ] **Step 2: Full rendered verification**

```bash
node scripts/verify-bundle-landers.mjs --check
```

Expected: Reset shows `$174`/`$53`, no `$208`/`$87`; other four `unchanged`.

- [ ] **Step 3: Confirm the shared-template guard still refuses**

```bash
node scripts/build-bundle-landing.mjs 99-coconut-reset-digital
```

Expected: `REFUSING: template "bundle-landing" is shared with 4 other product(s)`. This guard must never start passing — if it does, a product was given its own template and the data-not-literals rule has been broken.

- [ ] **Step 4: Confirm every new section renders on the Reset**

```bash
curl -s https://www.realskincare.com/products/99-coconut-reset-digital \
  | grep -oE 'shopify-section-template--[0-9]+__[a-zA-Z0-9_-]+' \
  | sed 's/.*__//' | sort -u
```

Expected to include: `hook`, `timeline`, `mechanism`, `ingredient-cards`, `stats`, `compare-rows`, `founder-note`.

- [ ] **Step 5: Record the live templates in the theme repo**

Branch from `origin/main`, **not** from `feat/coconut-reset-lander`:

```bash
cd /Users/seanfillmore/Code/realskincare-theme
git fetch origin && git checkout -b feature/coconut-reset-lander-modules origin/main
```

Then write both live assets into the repo:

```bash
cd /Users/seanfillmore/Code/Claude
nvm use && node -e "
import('./lib/shopify.js').then(async ({getMainThemeId,getThemeAsset})=>{
  const fs=await import('node:fs');
  const t=await getMainThemeId();
  for (const k of ['templates/product.bundle-landing.json','templates/index.json']) {
    fs.writeFileSync('/Users/seanfillmore/Code/realskincare-theme/'+k, await getThemeAsset(t,k));
    console.log('wrote', k);
  }
});"
```

- [ ] **Step 6: Commit and open both PRs**

```bash
cd /Users/seanfillmore/Code/realskincare-theme
git add templates/product.bundle-landing.json templates/index.json
git commit -m "feat(bundle): seven data-driven modules + homepage Reset banner"
git push -u origin feature/coconut-reset-lander-modules
gh pr create --fill

cd /Users/seanfillmore/Code/Claude/.claude/worktrees/coconut-reset-offer
git push -u origin feature/coconut-reset-offer
gh pr create --fill
```

---

## Self-Review

**Spec coverage.** Offer reframe → Tasks 1–2. Module enrichment (7 modules) → Tasks 3–5. Copy from voice-of-customer → Task 6. Timeline non-photographic → Task 4 builder + Task 6 content, with the "no before-and-after photos" line rendered on the page. Skim rule → enforced by a test asserting no `<details>`. Decision-relevance order → `ORDER` in Task 5 and a test pinning it. Data corrections (`rating_caption`, `description`) → Task 6. Orphan `reset-90-day` metaobject → flagged in the spec, deliberately untouched. Homepage banner → Task 7. Verification → Task 1 capture, Task 8 check. Message-match contract → recorded as a Global Constraint, binding on the later Meta spec.

**Deliberate deviation from the spec.** The spec says the four other bundle pages must verify **byte-identical**. Shopify varies script nonces and session tokens per request, so byte comparison would fail on unchanged pages. `verify-bundle-landers.mjs` compares **normalized visible text** instead, which is what "no visible change" means in practice. Recorded here rather than silently substituted.

**Placeholder scan.** No TBD/TODO. Every code step carries the literal content. Copy is written out in full rather than described.

**Type consistency.** `computeStackTotals` returns `{ priced, included, total, price, savings }` — used under those names in Task 1 tests only; the Liquid mirrors it rather than importing it, and Task 2's comment says so. `SECTIONS` entries are `{ key, type, settings }` in Task 4 and consumed as such in Task 5. Section keys in `SECTIONS`, in `ORDER`, in the Task 4 order test, and in Task 8's grep all match: `hook`, `timeline`, `mechanism`, `ingredient-cards`, `stats`, `compare-rows`, `founder-note`.

**One bug found and fixed during this review.** The first draft added `comparison_rows` to the `bundle_lander` **metaobject** definition in Task 3, while Task 4's Liquid reads `product.metafields.bundle.comparison_rows` and Task 6 writes it via `metafieldsSet` — a product metafield. The metaobject field would have sat unread forever and the compare table would have rendered empty on every bundle, silently, because the section self-suppresses. Task 3 now defines six fields, not seven, with a comment explaining why the seventh is absent. This is exactly the class of mismatch the type-consistency check exists to catch.
