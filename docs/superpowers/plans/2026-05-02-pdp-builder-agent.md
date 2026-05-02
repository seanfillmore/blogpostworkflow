# PDP Builder Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `agents/pdp-builder/` agent core (foundation loader, validators, prompt builder, cluster + product assemblers, CLI dispatcher, queue writer). Produces a working agent that, given foundation content, generates queue items for Shopify product page redesigns.

**Architecture:** Foundation-driven content assembly. Reads `data/brand/*` + `config/ingredients.json` to build a `Foundation` object. Two operating modes (cluster / product) each call Claude with a foundation-grounded system prompt and produce structured JSON. Validators reject fabricated ingredients, off-voice copy, branded/competitor/generic keywords, and out-of-bounds lengths before queueing. All output goes to `data/performance-queue/` for human review; nothing publishes from this agent.

**Tech Stack:** Node.js (ESM, project uses `"type": "module"`), `node:test` runner (per `npm test`), `@anthropic-ai/sdk` (already in package.json), existing `lib/posts.js` and `lib/notify.js` patterns.

**Spec:** [`docs/superpowers/specs/2026-05-02-pdp-builder-design.md`](../specs/2026-05-02-pdp-builder-design.md)

**Out of scope (separate plans):**
- Plan 2: Real foundation content (voice-and-pov.md, real cluster POVs, real ingredient stories) — this plan creates STUBS only.
- Plan 3: Theme refactor in `~/Code/realskincare-theme/`.
- Plan 4: Dashboard `/pdp-review` UI.
- Plan 5: Pilot end-to-end integration.
- Plan 6: Propagation to remaining clusters.

---

## File Structure

```
agents/pdp-builder/
├── index.js                              CLI entry, mode dispatcher (cluster|product), reads CLI args, calls assembler, writes queue item
└── lib/
    ├── load-foundation.js                Reads data/brand/* + config/ingredients.json. Returns Foundation object. Throws on missing/malformed files.
    ├── prompt-builder.js                 Two functions: buildClusterSystemPrompt(foundation, clusterName), buildProductSystemPrompt(foundation, clusterName, product).
    ├── assemble-cluster.js               Cluster mode: takes Foundation + cluster name, calls Claude (injectable client), returns structured JSON {hookLine, ingredientCards, mechanism, founder, freeFrom, faq, badges, guarantees, testimonials}.
    ├── assemble-product.js               Product mode: takes Foundation + cluster + product, calls Claude, returns {seoTitle, metaDescription, bodyHtml, metafieldOverrides}.
    └── validators.js                     Pre-queue checks: ingredient presence, length bounds, brand/competitor/generic exclusion.

tests/agents/pdp-builder/
├── load-foundation.test.js
├── validators.test.js
├── prompt-builder.test.js
├── assemble-cluster.test.js              (Claude client mocked)
├── assemble-product.test.js              (Claude client mocked)
└── integration.test.js                   End-to-end with mocked Claude.

data/brand/                                STUB CONTENT — replaced by real content in Plan 2
├── voice-and-pov.md
├── cluster-povs.md
├── ingredient-stories.json
├── comparison-framework.md
└── founder-narrative.md
```

---

## Task 1: Create directory structure + commit on a feature branch

**Files:**
- Create directory: `agents/pdp-builder/lib/`
- Create directory: `tests/agents/pdp-builder/`
- Create directory: `data/brand/`

- [ ] **Step 1: Create the feature branch**

```bash
git checkout main
git pull
git checkout -b feat/pdp-builder-agent
```

- [ ] **Step 2: Create directories**

```bash
mkdir -p agents/pdp-builder/lib
mkdir -p tests/agents/pdp-builder
mkdir -p data/brand
```

- [ ] **Step 3: Verify directories exist**

```bash
ls -la agents/pdp-builder/lib tests/agents/pdp-builder data/brand
```
Expected: each directory listed (empty).

- [ ] **Step 4: Commit (will use a placeholder file once we add the first real one)**

(no commit yet — Task 2 adds stub content and commits.)

---

## Task 2: Stub data/brand/ content (toothpaste-flavored, just enough to pass loader tests)

**Files:**
- Create: `data/brand/voice-and-pov.md`
- Create: `data/brand/cluster-povs.md`
- Create: `data/brand/ingredient-stories.json`
- Create: `data/brand/comparison-framework.md`
- Create: `data/brand/founder-narrative.md`

These are placeholders for testing the agent. Plan 2 replaces every word.

- [ ] **Step 1: Create `data/brand/voice-and-pov.md`**

```markdown
# Real Skin Care — Voice and POV (STUB)

> This is a STUB. Plan 2 replaces it with the real voice doc.

**Voice:** Clinical-confident, accessible. Mechanism-forward — explain *why* ingredients work, not just that they do. Authority without jargon.

**Positioning hooks:**
1. Made for reactive skin that other brands trigger.
2. Each ingredient was selected by what it does, not what it costs.
3. Here's the science, plainly explained.

**We say:** "selected for what it does," "sensitive-skin-tested," "cold-pressed virgin," "wildcrafted," "no synthetic foaming agents."
**We don't say:** "all-natural" (vague), "chemical-free" (false), "miracle," "revolutionary," "best-in-class."
```

- [ ] **Step 2: Create `data/brand/cluster-povs.md`**

```markdown
# Cluster Worldviews (STUB)

> STUB — Plan 2 replaces.

## toothpaste

We chose fluoride-free because for sensitive teeth and gums, less is more. Our base is organic virgin coconut oil — its lauric acid does antimicrobial work that synthetic foaming agents only mimic. Baking soda balances pH; wildcrafted myrrh has been used in oral care for centuries. No SLS (it triggers canker sores in people prone to them), no synthetic sweeteners, no glycerin coating.
```

- [ ] **Step 3: Create `data/brand/ingredient-stories.json`**

```json
{
  "organic_virgin_coconut_oil": {
    "name": "Organic Virgin Coconut Oil",
    "role": "antimicrobial base",
    "mechanism": "Cold-pressed virgin coconut oil retains its full lauric acid content (around 50% of the fatty acid profile). Lauric acid disrupts the lipid membrane of odor- and decay-causing bacteria.",
    "sourcing": "Cold-pressed and unrefined from organic coconuts. Never deodorized.",
    "why_we_chose_it": "Refined coconut oil is cheaper to formulate with — it's neutral, shelf-stable, and won't shift consistency at room temp. We pay more for cold-pressed virgin because the lauric acid is what does the work.",
    "what_cheap_alternatives_look_like": "Refined or fractionated coconut oil. Lab-deodorized. Lauric acid largely stripped. Listed as 'coconut oil' on the back panel — looks identical to a customer reading the label.",
    "citations": []
  },
  "baking_soda": {
    "name": "Baking Soda",
    "role": "pH balancer / gentle abrasive",
    "mechanism": "Sodium bicarbonate neutralizes oral acid and provides extremely fine micro-abrasion that lifts stains without scratching enamel.",
    "sourcing": "Food-grade aluminum-free baking soda.",
    "why_we_chose_it": "Hydrated silica is the cheap, common abrasive in mass-market toothpaste — it's harder than enamel and over time can wear down sensitive teeth. Baking soda is gentler and adds the pH benefit.",
    "what_cheap_alternatives_look_like": "Hydrated silica, calcium carbonate, dicalcium phosphate dihydrate. Cheaper to source, harder on enamel.",
    "citations": []
  },
  "wildcrafted_myrrh": {
    "name": "Wildcrafted Myrrh",
    "role": "anti-inflammatory",
    "mechanism": "Myrrh resin contains sesquiterpenes with documented anti-inflammatory and antimicrobial activity. Used in oral care for thousands of years.",
    "sourcing": "Wildcrafted (sustainably foraged from naturally occurring trees, not factory-farmed).",
    "why_we_chose_it": "Most natural toothpastes skip myrrh entirely because it's expensive and adds complexity. We use it because it's traditional oral medicine that actually works for irritated gums.",
    "what_cheap_alternatives_look_like": "No myrrh; replaced with synthetic anti-microbial like cetylpyridinium chloride or stannous fluoride.",
    "citations": []
  },
  "xanthan_gum": {
    "name": "Xanthan Gum",
    "role": "natural thickener",
    "mechanism": "Polysaccharide produced by fermentation. Provides paste consistency without coating teeth.",
    "sourcing": "Non-GMO fermentation byproduct.",
    "why_we_chose_it": "Glycerin and sorbitol are the cheap thickeners — they coat teeth and may interfere with remineralization. Xanthan gum gives paste structure without the coating.",
    "what_cheap_alternatives_look_like": "Glycerin, sorbitol, propylene glycol. Sweet, cheap, and effective at thickening — but they coat enamel.",
    "citations": []
  },
  "stevia": {
    "name": "Stevia",
    "role": "natural sweetener",
    "mechanism": "Plant-derived sweetness without sugar or sugar alcohols. Non-cariogenic.",
    "sourcing": "Organic stevia leaf extract.",
    "why_we_chose_it": "Sodium saccharin and aspartame are dirt-cheap and shelf-stable but artificial. Xylitol is excellent but most natural toothpastes use it as a sole sweetener — we prefer stevia for taste.",
    "what_cheap_alternatives_look_like": "Sodium saccharin, sucralose, aspartame. Cheap, shelf-stable, artificial.",
    "citations": []
  }
}
```

- [ ] **Step 4: Create `data/brand/comparison-framework.md`**

```markdown
# Comparison Framework (STUB)

> STUB — Plan 2 replaces.

## Axes we differentiate on

- **SLS:** mass-market includes; we exclude (canker-sore trigger).
- **Aluminum (deodorant):** mass-market includes; we exclude.
- **Fluoride (toothpaste):** mass-market includes; we exclude (sensitive-tooth/-gum customers prefer to avoid).
- **Synthetic fragrance:** mass-market includes; we use organic essential oils only.
- **Refined vs. virgin oils:** mass-market uses refined (cheap, neutral); we use cold-pressed virgin (lauric acid intact).
- **Glycerin/sorbitol coating (toothpaste):** mass-market uses; we use xanthan gum.
- **Synthetic sweeteners:** mass-market uses; we use stevia.
- **Synthetic abrasives:** mass-market uses hydrated silica; we use baking soda.

## Voice rules for comparisons

- Never name a competitor brand directly in product copy.
- Use "mass-market" or "conventional" or "the industry standard" as the contrast term.
- State the trade-off plainly: "they pay less, you pay more, here's what the difference does."
```

- [ ] **Step 5: Create `data/brand/founder-narrative.md`**

```markdown
# Founder Narrative (STUB)

> STUB — Plan 2 replaces with Sean's actual voice. The agent uses this as an exemplar for tone in the per-template "From Sean" block.

I started Real Skin Care because my own skin reacted to almost everything on the shelf. The shorter the ingredient list and the more legible the sourcing, the better my skin behaved. Every formula here is built around that principle: select ingredients for what they do, not what they cost. If a cheaper substitute would do the same job, we'd use it. None of them do.

— Sean
```

- [ ] **Step 6: Verify all 5 files exist**

```bash
ls -la data/brand/
```
Expected: voice-and-pov.md, cluster-povs.md, ingredient-stories.json, comparison-framework.md, founder-narrative.md.

- [ ] **Step 7: Verify ingredient-stories.json parses**

```bash
node -e "console.log(Object.keys(JSON.parse(require('fs').readFileSync('data/brand/ingredient-stories.json','utf8'))).length, 'ingredients')"
```
Expected: `5 ingredients`

- [ ] **Step 8: Commit**

```bash
git add data/brand/
git commit -m "feat(pdp-builder): stub foundation content for testing

Five files in data/brand/ with toothpaste-relevant placeholder content.
Plan 2 will replace every word with the real foundation. These stubs
exist purely so the loader and validators have something to read in
tests."
```

---

## Task 3: Write failing test for `load-foundation.js`

**Files:**
- Create: `tests/agents/pdp-builder/load-foundation.test.js`

- [ ] **Step 1: Create the test file**

```javascript
// tests/agents/pdp-builder/load-foundation.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadFoundation } from '../../../agents/pdp-builder/lib/load-foundation.js';

const REPO_ROOT = process.cwd();

test('loadFoundation: returns object with all required keys when files present', () => {
  const f = loadFoundation({ root: REPO_ROOT });
  assert.equal(typeof f.voice, 'string', 'voice is a string');
  assert.ok(f.voice.length > 0, 'voice is non-empty');
  assert.equal(typeof f.clusterPOVs, 'string', 'clusterPOVs is a string');
  assert.equal(typeof f.comparisonFramework, 'string', 'comparisonFramework is a string');
  assert.equal(typeof f.founderNarrative, 'string', 'founderNarrative is a string');
  assert.equal(typeof f.ingredientStories, 'object', 'ingredientStories is an object');
  assert.ok(f.ingredientStories.organic_virgin_coconut_oil, 'has known stub ingredient key');
  assert.equal(typeof f.ingredientsByCluster, 'object', 'ingredientsByCluster is an object');
  assert.ok(f.ingredientsByCluster.toothpaste, 'has toothpaste cluster from config/ingredients.json');
});

test('loadFoundation: throws when data/brand/voice-and-pov.md missing', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'pdp-foundation-'));
  // Set up a fake repo root with everything EXCEPT voice-and-pov.md
  mkdirSync(join(tmp, 'data', 'brand'), { recursive: true });
  mkdirSync(join(tmp, 'config'), { recursive: true });
  writeFileSync(join(tmp, 'data', 'brand', 'cluster-povs.md'), 'stub');
  writeFileSync(join(tmp, 'data', 'brand', 'ingredient-stories.json'), '{}');
  writeFileSync(join(tmp, 'data', 'brand', 'comparison-framework.md'), 'stub');
  writeFileSync(join(tmp, 'data', 'brand', 'founder-narrative.md'), 'stub');
  copyFileSync(join(REPO_ROOT, 'config', 'ingredients.json'), join(tmp, 'config', 'ingredients.json'));

  assert.throws(
    () => loadFoundation({ root: tmp }),
    /voice-and-pov\.md/,
    'throws referencing the missing file'
  );

  rmSync(tmp, { recursive: true, force: true });
});

test('loadFoundation: throws when ingredient-stories.json is malformed JSON', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'pdp-foundation-'));
  mkdirSync(join(tmp, 'data', 'brand'), { recursive: true });
  mkdirSync(join(tmp, 'config'), { recursive: true });
  writeFileSync(join(tmp, 'data', 'brand', 'voice-and-pov.md'), 'stub');
  writeFileSync(join(tmp, 'data', 'brand', 'cluster-povs.md'), 'stub');
  writeFileSync(join(tmp, 'data', 'brand', 'ingredient-stories.json'), '{ this is not json }');
  writeFileSync(join(tmp, 'data', 'brand', 'comparison-framework.md'), 'stub');
  writeFileSync(join(tmp, 'data', 'brand', 'founder-narrative.md'), 'stub');
  copyFileSync(join(REPO_ROOT, 'config', 'ingredients.json'), join(tmp, 'config', 'ingredients.json'));

  assert.throws(
    () => loadFoundation({ root: tmp }),
    /ingredient-stories\.json/,
    'throws referencing the malformed file'
  );

  rmSync(tmp, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run the test (expect failure — module doesn't exist)**

```bash
node --test tests/agents/pdp-builder/load-foundation.test.js
```
Expected: tests fail with `Cannot find module '...load-foundation.js'`.

---

## Task 4: Implement `load-foundation.js`

**Files:**
- Create: `agents/pdp-builder/lib/load-foundation.js`

- [ ] **Step 1: Implement the module**

```javascript
// agents/pdp-builder/lib/load-foundation.js
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = join(__dirname, '..', '..', '..');

/**
 * Loads the foundation content from disk.
 *
 * Returns:
 *   {
 *     voice:                string  // raw markdown of data/brand/voice-and-pov.md
 *     clusterPOVs:          string  // raw markdown of data/brand/cluster-povs.md
 *     ingredientStories:    object  // parsed JSON of data/brand/ingredient-stories.json
 *     comparisonFramework:  string  // raw markdown of data/brand/comparison-framework.md
 *     founderNarrative:     string  // raw markdown of data/brand/founder-narrative.md
 *     ingredientsByCluster: object  // parsed JSON of config/ingredients.json (existing source-of-truth)
 *   }
 *
 * Throws (loud failure) if any required file is missing or malformed.
 * The caller never publishes without the foundation in hand — falling back
 * to defaults would let mass-market copy slip through.
 */
export function loadFoundation({ root = DEFAULT_ROOT } = {}) {
  const required = [
    { path: join(root, 'data', 'brand', 'voice-and-pov.md'),         key: 'voice',               type: 'text' },
    { path: join(root, 'data', 'brand', 'cluster-povs.md'),          key: 'clusterPOVs',         type: 'text' },
    { path: join(root, 'data', 'brand', 'ingredient-stories.json'),  key: 'ingredientStories',   type: 'json' },
    { path: join(root, 'data', 'brand', 'comparison-framework.md'),  key: 'comparisonFramework', type: 'text' },
    { path: join(root, 'data', 'brand', 'founder-narrative.md'),     key: 'founderNarrative',    type: 'text' },
    { path: join(root, 'config', 'ingredients.json'),                key: 'ingredientsByCluster', type: 'json' },
  ];

  const out = {};
  for (const file of required) {
    if (!existsSync(file.path)) {
      throw new Error(`Foundation missing: ${file.path}`);
    }
    let raw;
    try {
      raw = readFileSync(file.path, 'utf8');
    } catch (e) {
      throw new Error(`Foundation unreadable (${file.path}): ${e.message}`);
    }
    if (file.type === 'json') {
      try {
        out[file.key] = JSON.parse(raw);
      } catch (e) {
        throw new Error(`Foundation malformed (${file.path}): ${e.message}`);
      }
    } else {
      out[file.key] = raw;
    }
  }
  return out;
}
```

- [ ] **Step 2: Run the test**

```bash
node --test tests/agents/pdp-builder/load-foundation.test.js
```
Expected: all 3 tests pass.

- [ ] **Step 3: Commit**

```bash
git add agents/pdp-builder/lib/load-foundation.js tests/agents/pdp-builder/load-foundation.test.js
git commit -m "feat(pdp-builder): foundation loader

Reads data/brand/* + config/ingredients.json. Returns a Foundation
object the assemblers will pass around. Throws loud on missing/malformed
files — we never want to publish without the curated foundation in
hand, so fallbacks would be wrong here."
```

---

## Task 5: Write failing tests for ingredient validator

**Files:**
- Create: `tests/agents/pdp-builder/validators.test.js`

- [ ] **Step 1: Create the test file**

```javascript
// tests/agents/pdp-builder/validators.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateIngredients,
  validateLengths,
  validateBrandTermExclusion,
} from '../../../agents/pdp-builder/lib/validators.js';

// Mock cluster ingredient list (mirrors what load-foundation produces from config/ingredients.json)
const TOOTHPASTE_INGREDIENTS = {
  toothpaste: {
    base_ingredients: [
      'purified spring water',
      'organic virgin coconut oil',
      'baking soda',
      'xanthan gum',
      'wildcrafted myrrh powder',
      'stevia',
    ],
    variations: [
      { essential_oils: ['organic essential oil of peppermint', 'organic essential oil of spearmint'] },
    ],
  },
};

// ── validateIngredients ──────────────────────────────────────────────

test('validateIngredients: passes when every claimed ingredient is in the cluster spec', () => {
  const result = validateIngredients({
    cluster: 'toothpaste',
    claimedIngredients: ['organic virgin coconut oil', 'baking soda', 'wildcrafted myrrh powder'],
    ingredientsByCluster: TOOTHPASTE_INGREDIENTS,
  });
  assert.equal(result.valid, true);
  assert.deepEqual(result.fabricated, []);
});

test('validateIngredients: rejects fabricated ingredients', () => {
  const result = validateIngredients({
    cluster: 'toothpaste',
    claimedIngredients: ['hydroxyapatite', 'baking soda'],  // hydroxyapatite is not in the spec
    ingredientsByCluster: TOOTHPASTE_INGREDIENTS,
  });
  assert.equal(result.valid, false);
  assert.deepEqual(result.fabricated, ['hydroxyapatite']);
});

test('validateIngredients: case-insensitive', () => {
  const result = validateIngredients({
    cluster: 'toothpaste',
    claimedIngredients: ['Organic Virgin Coconut Oil', 'BAKING SODA'],
    ingredientsByCluster: TOOTHPASTE_INGREDIENTS,
  });
  assert.equal(result.valid, true);
});

test('validateIngredients: matches essential oils from variations', () => {
  const result = validateIngredients({
    cluster: 'toothpaste',
    claimedIngredients: ['organic essential oil of peppermint'],
    ingredientsByCluster: TOOTHPASTE_INGREDIENTS,
  });
  assert.equal(result.valid, true);
});

test('validateIngredients: throws when cluster missing from ingredientsByCluster', () => {
  assert.throws(
    () => validateIngredients({
      cluster: 'unknown-cluster',
      claimedIngredients: ['anything'],
      ingredientsByCluster: TOOTHPASTE_INGREDIENTS,
    }),
    /unknown-cluster/,
  );
});

// ── validateLengths ──────────────────────────────────────────────────

test('validateLengths: SEO title 55-70 chars passes', () => {
  const result = validateLengths({
    seoTitle: 'Coconut Oil Toothpaste | Fluoride-Free | Real Skin Care',  // 55 chars
  });
  assert.equal(result.valid, true);
});

test('validateLengths: SEO title 80 chars fails', () => {
  const result = validateLengths({
    seoTitle: 'X'.repeat(80),
  });
  assert.equal(result.valid, false);
  assert.match(result.errors.join(' '), /seoTitle.*80.*70/);
});

test('validateLengths: meta description 145-160 chars passes', () => {
  const result = validateLengths({
    metaDescription: 'A'.repeat(150),
  });
  assert.equal(result.valid, true);
});

test('validateLengths: meta description 200 chars fails', () => {
  const result = validateLengths({
    metaDescription: 'A'.repeat(200),
  });
  assert.equal(result.valid, false);
});

test('validateLengths: ingredient story word count 40-60 passes', () => {
  const story = Array(50).fill('word').join(' ');
  const result = validateLengths({
    ingredientCards: [{ name: 'X', story }],
  });
  assert.equal(result.valid, true);
});

test('validateLengths: ingredient story 100 words fails', () => {
  const story = Array(100).fill('word').join(' ');
  const result = validateLengths({
    ingredientCards: [{ name: 'X', story }],
  });
  assert.equal(result.valid, false);
});

// ── validateBrandTermExclusion ───────────────────────────────────────

test('validateBrandTermExclusion: passes for clean keyword', () => {
  const result = validateBrandTermExclusion({
    text: 'Coconut Oil Toothpaste | Fluoride-Free | Real Skin Care',
    field: 'seoTitle',
  });
  assert.equal(result.valid, true);
});

test('validateBrandTermExclusion: rejects competitor brand in body_html', () => {
  const result = validateBrandTermExclusion({
    text: 'Better than Tom\'s of Maine and gentler than Schmidt\'s.',
    field: 'bodyHtml',
  });
  assert.equal(result.valid, false);
  assert.match(result.errors.join(' '), /tom's of maine|schmidt/i);
});

test('validateBrandTermExclusion: rejects generic-blocklist term in seoTitle', () => {
  const result = validateBrandTermExclusion({
    text: 'Authentic Skincare Products',
    field: 'seoTitle',
  });
  assert.equal(result.valid, false);
});

test('validateBrandTermExclusion: allows brand_terms in seoTitle (it IS our brand)', () => {
  // BRAND_TERMS like "real skin care" are allowed in our own product titles.
  // Only competitor and generic terms are blocked.
  const result = validateBrandTermExclusion({
    text: 'Coconut Oil Toothpaste | Real Skin Care',
    field: 'seoTitle',
  });
  assert.equal(result.valid, true);
});
```

- [ ] **Step 2: Run the test (expect failure — module doesn't exist)**

```bash
node --test tests/agents/pdp-builder/validators.test.js
```
Expected: all tests fail with `Cannot find module`.

---

## Task 6: Implement `validators.js`

**Files:**
- Create: `agents/pdp-builder/lib/validators.js`

- [ ] **Step 1: Implement the module**

```javascript
// agents/pdp-builder/lib/validators.js
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..', '..');

// Reuse the same exclusion config as the existing product-optimizer (see
// docs/superpowers/specs/2026-05-02-pdp-builder-design.md "Decision log").
// Brand terms are allowed in our own title/copy (we're Real Skin Care), but
// competitor and generic-umbrella terms are blocked everywhere.
const SITE_CONFIG = JSON.parse(readFileSync(join(ROOT, 'config', 'site.json'), 'utf8'));
const AI_CITATIONS = JSON.parse(readFileSync(join(ROOT, 'config', 'ai-citation-prompts.json'), 'utf8'));

const GENERIC_BLOCKLIST = (SITE_CONFIG.generic_keyword_blocklist || []).map((t) => t.toLowerCase());
const COMPETITOR_TERMS = (() => {
  const out = new Set();
  for (const c of (AI_CITATIONS.competitors || [])) {
    if (c.name) out.add(c.name.toLowerCase());
    for (const a of (c.aliases || [])) out.add(a.toLowerCase());
  }
  return [...out];
})();

// ── Length bounds — these are tuned from the competitor research in the spec.
const LENGTH_BOUNDS = {
  seoTitle:        { min: 50, max: 70, unit: 'chars' },
  metaDescription: { min: 140, max: 160, unit: 'chars' },
  bodyHtml:        { min: 120, max: 180, unit: 'words' },
  ingredientStory: { min: 40, max: 60, unit: 'words' },
  mechanismBlock:  { min: 80, max: 100, unit: 'words' },
  founderBlock:    { min: 60, max: 80, unit: 'words' },
  faqAnswer:       { min: 30, max: 80, unit: 'words' },
};

function wordCount(s) {
  return (s || '').trim().split(/\s+/).filter(Boolean).length;
}

function stripHtml(s) {
  return (s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Verifies every claimed ingredient is present in `config/ingredients.json`
 * for the named cluster. Returns { valid, fabricated: string[] }.
 *
 * Throws if the cluster doesn't exist in ingredientsByCluster (caller bug).
 */
export function validateIngredients({ cluster, claimedIngredients, ingredientsByCluster }) {
  const spec = ingredientsByCluster[cluster];
  if (!spec) throw new Error(`validateIngredients: cluster "${cluster}" not found in ingredientsByCluster`);

  const allowed = new Set();
  for (const ing of (spec.base_ingredients || [])) allowed.add(ing.toLowerCase());
  for (const variation of (spec.variations || [])) {
    for (const oil of (variation.essential_oils || [])) allowed.add(oil.toLowerCase());
  }

  const fabricated = [];
  for (const claimed of (claimedIngredients || [])) {
    if (!allowed.has(claimed.toLowerCase())) fabricated.push(claimed);
  }

  return { valid: fabricated.length === 0, fabricated };
}

/**
 * Checks lengths of generated content against the scaffold bounds.
 * Returns { valid, errors: string[] }. Empty/missing fields are skipped.
 */
export function validateLengths(content) {
  const errors = [];
  if (content.seoTitle != null) {
    const len = content.seoTitle.length;
    const b = LENGTH_BOUNDS.seoTitle;
    if (len < b.min || len > b.max) errors.push(`seoTitle ${len} ${b.unit} outside ${b.min}-${b.max}`);
  }
  if (content.metaDescription != null) {
    const len = content.metaDescription.length;
    const b = LENGTH_BOUNDS.metaDescription;
    if (len < b.min || len > b.max) errors.push(`metaDescription ${len} ${b.unit} outside ${b.min}-${b.max}`);
  }
  if (content.bodyHtml != null) {
    const wc = wordCount(stripHtml(content.bodyHtml));
    const b = LENGTH_BOUNDS.bodyHtml;
    if (wc < b.min || wc > b.max) errors.push(`bodyHtml ${wc} ${b.unit} outside ${b.min}-${b.max}`);
  }
  if (Array.isArray(content.ingredientCards)) {
    for (const [i, card] of content.ingredientCards.entries()) {
      const wc = wordCount(card.story || '');
      const b = LENGTH_BOUNDS.ingredientStory;
      if (wc < b.min || wc > b.max) errors.push(`ingredientCards[${i}] story ${wc} ${b.unit} outside ${b.min}-${b.max}`);
    }
  }
  if (content.mechanismBlock != null) {
    const wc = wordCount(content.mechanismBlock);
    const b = LENGTH_BOUNDS.mechanismBlock;
    if (wc < b.min || wc > b.max) errors.push(`mechanismBlock ${wc} ${b.unit} outside ${b.min}-${b.max}`);
  }
  if (content.founderBlock != null) {
    const wc = wordCount(content.founderBlock);
    const b = LENGTH_BOUNDS.founderBlock;
    if (wc < b.min || wc > b.max) errors.push(`founderBlock ${wc} ${b.unit} outside ${b.min}-${b.max}`);
  }
  if (Array.isArray(content.faq)) {
    for (const [i, qa] of content.faq.entries()) {
      const wc = wordCount(qa.answer || '');
      const b = LENGTH_BOUNDS.faqAnswer;
      if (wc < b.min || wc > b.max) errors.push(`faq[${i}] answer ${wc} ${b.unit} outside ${b.min}-${b.max}`);
    }
  }
  return { valid: errors.length === 0, errors };
}

/**
 * Checks generated text for competitor and generic-blocklist terms.
 * Brand terms (Real Skin Care, etc.) are intentionally NOT blocked here —
 * those are our own brand and SHOULD appear in our copy.
 */
export function validateBrandTermExclusion({ text, field }) {
  const lower = (text || '').toLowerCase();
  const errors = [];
  for (const term of COMPETITOR_TERMS) {
    if (lower.includes(term)) errors.push(`${field}: contains competitor term "${term}"`);
  }
  for (const term of GENERIC_BLOCKLIST) {
    if (lower.includes(term)) errors.push(`${field}: contains generic-blocklist term "${term}"`);
  }
  return { valid: errors.length === 0, errors };
}
```

- [ ] **Step 2: Run the validator tests**

```bash
node --test tests/agents/pdp-builder/validators.test.js
```
Expected: all 13 tests pass.

- [ ] **Step 3: Commit**

```bash
git add agents/pdp-builder/lib/validators.js tests/agents/pdp-builder/validators.test.js
git commit -m "feat(pdp-builder): validators (ingredients, lengths, brand-term exclusion)

Three pre-queue gates:
- validateIngredients: every claimed ingredient must be in
  config/ingredients.json for the named cluster (no fabrication).
- validateLengths: generated content within scaffold bounds (titles
  50-70 chars, meta 140-160, ingredient stories 40-60 words, etc.).
- validateBrandTermExclusion: rejects competitor and generic-blocklist
  terms. Reuses the existing config/ai-citation-prompts.json competitor
  list and config/site.json generic_keyword_blocklist."
```

---

## Task 7: Write failing test for `prompt-builder.js`

**Files:**
- Create: `tests/agents/pdp-builder/prompt-builder.test.js`

- [ ] **Step 1: Create the test file**

```javascript
// tests/agents/pdp-builder/prompt-builder.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadFoundation } from '../../../agents/pdp-builder/lib/load-foundation.js';
import {
  buildClusterSystemPrompt,
  buildProductSystemPrompt,
} from '../../../agents/pdp-builder/lib/prompt-builder.js';

const foundation = loadFoundation();

test('buildClusterSystemPrompt: includes voice doc text', () => {
  const prompt = buildClusterSystemPrompt({ foundation, clusterName: 'toothpaste' });
  assert.match(prompt, /Clinical-confident/);
});

test('buildClusterSystemPrompt: includes the cluster POV', () => {
  const prompt = buildClusterSystemPrompt({ foundation, clusterName: 'toothpaste' });
  assert.match(prompt, /## toothpaste/);
});

test('buildClusterSystemPrompt: includes ingredient stories for the cluster', () => {
  const prompt = buildClusterSystemPrompt({ foundation, clusterName: 'toothpaste' });
  assert.match(prompt, /organic virgin coconut oil/i);
  assert.match(prompt, /wildcrafted myrrh/i);
});

test('buildClusterSystemPrompt: includes comparison framework', () => {
  const prompt = buildClusterSystemPrompt({ foundation, clusterName: 'toothpaste' });
  assert.match(prompt, /SLS|Aluminum|Fluoride/);
});

test('buildClusterSystemPrompt: includes founder narrative', () => {
  const prompt = buildClusterSystemPrompt({ foundation, clusterName: 'toothpaste' });
  assert.match(prompt, /Real Skin Care/);
});

test('buildClusterSystemPrompt: throws on unknown cluster', () => {
  assert.throws(
    () => buildClusterSystemPrompt({ foundation, clusterName: 'unknown' }),
    /unknown/,
  );
});

test('buildProductSystemPrompt: includes product handle and known ingredients', () => {
  const prompt = buildProductSystemPrompt({
    foundation,
    clusterName: 'toothpaste',
    product: { handle: 'coconut-oil-toothpaste', title: 'Coconut Oil Toothpaste' },
  });
  assert.match(prompt, /coconut-oil-toothpaste/);
  assert.match(prompt, /baking soda/i);
});

test('buildProductSystemPrompt: includes voice doc + cluster POV (same as cluster prompt baseline)', () => {
  const prompt = buildProductSystemPrompt({
    foundation,
    clusterName: 'toothpaste',
    product: { handle: 'coconut-oil-toothpaste', title: 'Coconut Oil Toothpaste' },
  });
  assert.match(prompt, /Clinical-confident/);
  assert.match(prompt, /## toothpaste/);
});
```

- [ ] **Step 2: Run the test (expect failure)**

```bash
node --test tests/agents/pdp-builder/prompt-builder.test.js
```
Expected: tests fail with `Cannot find module`.

---

## Task 8: Implement `prompt-builder.js`

**Files:**
- Create: `agents/pdp-builder/lib/prompt-builder.js`

- [ ] **Step 1: Implement the module**

```javascript
// agents/pdp-builder/lib/prompt-builder.js

/**
 * Extracts a single cluster's section from cluster-povs.md.
 * The markdown convention: "## <cluster-name>" headings, content until next "## " or EOF.
 */
function extractClusterPOV(clusterPOVsMarkdown, clusterName) {
  const re = new RegExp(`##\\s+${clusterName}\\b([\\s\\S]*?)(?=\\n##\\s|$)`, 'i');
  const m = clusterPOVsMarkdown.match(re);
  if (!m) throw new Error(`prompt-builder: cluster "${clusterName}" not found in cluster-povs.md`);
  return `## ${clusterName}${m[1]}`.trim();
}

/**
 * Filters ingredient stories down to those relevant to a cluster.
 * Heuristic: an ingredient is relevant if its name appears (case-insensitive)
 * in the cluster's base_ingredients or any variation's essential_oils list.
 */
function relevantIngredientStories(ingredientStories, clusterSpec) {
  if (!clusterSpec) return {};
  const allowed = new Set();
  for (const ing of (clusterSpec.base_ingredients || [])) allowed.add(ing.toLowerCase());
  for (const v of (clusterSpec.variations || [])) {
    for (const oil of (v.essential_oils || [])) allowed.add(oil.toLowerCase());
  }
  const out = {};
  for (const [key, story] of Object.entries(ingredientStories)) {
    if (story?.name && allowed.has(story.name.toLowerCase())) out[key] = story;
  }
  return out;
}

/**
 * Builds the system prompt for cluster mode. The agent uses this to generate
 * the cluster template's content blocks (FAQs, ingredient cards, mechanism,
 * founder, free-from, badges, etc.).
 */
export function buildClusterSystemPrompt({ foundation, clusterName }) {
  const clusterSpec = foundation.ingredientsByCluster[clusterName];
  if (!clusterSpec) throw new Error(`prompt-builder: cluster "${clusterName}" not in ingredientsByCluster`);
  const pov = extractClusterPOV(foundation.clusterPOVs, clusterName);
  const ingredients = relevantIngredientStories(foundation.ingredientStories, clusterSpec);

  return [
    `You are the content writer for Real Skin Care, a premium natural skincare brand.`,
    ``,
    `# Voice and POV`,
    foundation.voice,
    ``,
    `# Cluster POV`,
    pov,
    ``,
    `# Hero ingredient stories (use these — do not invent ingredient claims)`,
    JSON.stringify(ingredients, null, 2),
    ``,
    `# Comparison framework`,
    foundation.comparisonFramework,
    ``,
    `# Founder narrative (exemplar tone for the founder block)`,
    foundation.founderNarrative,
    ``,
    `# Cluster product spec (every ingredient claim must come from this list)`,
    JSON.stringify(clusterSpec, null, 2),
    ``,
    `# Your task`,
    `Generate the content for the ${clusterName} cluster's product-page template.`,
    `Output a single JSON object with these keys:`,
    `  hookLine:        string (1-2 sentences setting the page's worldview)`,
    `  ingredientCards: array of 3 objects { name, role, story } (story 40-60 words)`,
    `  mechanismBlock:  string (80-100 words, "How this actually protects sensitive skin")`,
    `  founderBlock:    string (60-80 words, in Sean's voice, why this product exists)`,
    `  freeFrom:        array of 4-6 short callout strings (e.g., "No SLS", "No fluoride")`,
    `  faq:             array of 7 objects { question, answer } (answers 30-80 words)`,
    `  badges:          array of 4 short strings (cert/promise labels)`,
    `  guarantees:      array of 4 short strings`,
    ``,
    `Output JSON only, no preamble.`,
  ].join('\n');
}

/**
 * Builds the system prompt for product mode. Used to generate per-SKU SEO
 * title, meta description, body_html, and metafield overrides.
 */
export function buildProductSystemPrompt({ foundation, clusterName, product }) {
  const clusterSpec = foundation.ingredientsByCluster[clusterName];
  if (!clusterSpec) throw new Error(`prompt-builder: cluster "${clusterName}" not in ingredientsByCluster`);
  const pov = extractClusterPOV(foundation.clusterPOVs, clusterName);
  const ingredients = relevantIngredientStories(foundation.ingredientStories, clusterSpec);

  return [
    `You are the content writer for Real Skin Care, a premium natural skincare brand.`,
    ``,
    `# Voice and POV`,
    foundation.voice,
    ``,
    `# Cluster POV`,
    pov,
    ``,
    `# Hero ingredient stories`,
    JSON.stringify(ingredients, null, 2),
    ``,
    `# Comparison framework`,
    foundation.comparisonFramework,
    ``,
    `# Product`,
    `Handle: ${product.handle}`,
    `Title:  ${product.title || ''}`,
    `Cluster spec: ${JSON.stringify(clusterSpec, null, 2)}`,
    ``,
    `# Your task`,
    `Generate per-SKU content for this product's PDP. Output JSON with keys:`,
    `  seoTitle:           string (50-70 chars; format: "[Variant/Type] [Product] | [Differentiator] | Real Skin Care")`,
    `  metaDescription:    string (140-160 chars)`,
    `  bodyHtml:           string (HTML; 120-180 words of marketing prose: hook + 4 benefit bullets)`,
    `  metafieldOverrides: object (optional; only include if SKU-specific data warrants overriding cluster defaults; keys: hero_ingredients_override, faq_additional, free_from, sensitive_skin_notes, scent_notes)`,
    ``,
    `Output JSON only, no preamble. Every ingredient mentioned must come from the cluster spec above.`,
  ].join('\n');
}
```

- [ ] **Step 2: Run prompt-builder tests**

```bash
node --test tests/agents/pdp-builder/prompt-builder.test.js
```
Expected: all 8 tests pass.

- [ ] **Step 3: Commit**

```bash
git add agents/pdp-builder/lib/prompt-builder.js tests/agents/pdp-builder/prompt-builder.test.js
git commit -m "feat(pdp-builder): system prompt builder for cluster + product modes

Two functions, both pure: build a system prompt from Foundation +
target. The voice doc is the spine; the cluster POV is the angle;
the ingredient stories form the body; the comparison framework is
the differentiation tool. Output schema is documented inline so
the assemblers can JSON.parse the model response."
```

---

## Task 9: Write failing test for `assemble-cluster.js` (Claude client mocked)

**Files:**
- Create: `tests/agents/pdp-builder/assemble-cluster.test.js`

- [ ] **Step 1: Create the test file**

```javascript
// tests/agents/pdp-builder/assemble-cluster.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadFoundation } from '../../../agents/pdp-builder/lib/load-foundation.js';
import { assembleCluster } from '../../../agents/pdp-builder/lib/assemble-cluster.js';

const foundation = loadFoundation();

// Build a Claude-shaped response that the agent will parse.
function fakeClaudeResponse(payload) {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
  };
}

const VALID_CLUSTER_OUTPUT = {
  hookLine: 'For sensitive teeth, less in the formula means more for your enamel.',
  ingredientCards: [
    {
      name: 'Organic Virgin Coconut Oil',
      role: 'antimicrobial base',
      story: Array(50).fill('word').join(' '),
    },
    {
      name: 'Baking Soda',
      role: 'pH balancer',
      story: Array(50).fill('word').join(' '),
    },
    {
      name: 'Wildcrafted Myrrh Powder',
      role: 'anti-inflammatory',
      story: Array(50).fill('word').join(' '),
    },
  ],
  mechanismBlock: Array(90).fill('word').join(' '),
  founderBlock: Array(70).fill('word').join(' '),
  freeFrom: ['No SLS', 'No fluoride', 'No synthetic flavors', 'No glycerin coating'],
  faq: Array.from({ length: 7 }, (_, i) => ({
    question: `Q${i+1}?`,
    answer: Array(50).fill('word').join(' '),
  })),
  badges: ['Vegan', 'Cruelty-Free', 'Made in USA', 'Small Batch'],
  guarantees: ['30-day MBG', 'Free shipping over $50', 'Clean ingredients', 'Handcrafted'],
};

test('assembleCluster: returns queue item with status pending when validation passes', async () => {
  const mockClient = {
    messages: { create: async () => fakeClaudeResponse(VALID_CLUSTER_OUTPUT) },
  };
  const result = await assembleCluster({
    foundation,
    clusterName: 'toothpaste',
    claudeClient: mockClient,
  });
  assert.equal(result.type, 'pdp-cluster');
  assert.equal(result.slug, 'toothpaste');
  assert.equal(result.status, 'pending');
  assert.deepEqual(result.proposed.ingredientCards.map((c) => c.name).sort(),
    ['Baking Soda', 'Organic Virgin Coconut Oil', 'Wildcrafted Myrrh Powder'].sort());
  assert.equal(result.validation.passed, true);
});

test('assembleCluster: returns queue item with status needs_rework when ingredient fabricated', async () => {
  const fabricatedOutput = {
    ...VALID_CLUSTER_OUTPUT,
    ingredientCards: [
      ...VALID_CLUSTER_OUTPUT.ingredientCards.slice(0, 2),
      { name: 'Hydroxyapatite', role: 'remineralizer', story: Array(50).fill('w').join(' ') },
    ],
  };
  const mockClient = {
    messages: { create: async () => fakeClaudeResponse(fabricatedOutput) },
  };
  const result = await assembleCluster({
    foundation,
    clusterName: 'toothpaste',
    claudeClient: mockClient,
  });
  assert.equal(result.status, 'needs_rework');
  assert.equal(result.validation.passed, false);
  assert.match(JSON.stringify(result.validation.errors), /hydroxyapatite/i);
});

test('assembleCluster: returns needs_rework when length out of bounds', async () => {
  const tooShortOutput = {
    ...VALID_CLUSTER_OUTPUT,
    mechanismBlock: 'just a few words',
  };
  const mockClient = {
    messages: { create: async () => fakeClaudeResponse(tooShortOutput) },
  };
  const result = await assembleCluster({
    foundation,
    clusterName: 'toothpaste',
    claudeClient: mockClient,
  });
  assert.equal(result.status, 'needs_rework');
});
```

- [ ] **Step 2: Run the test (expect failure)**

```bash
node --test tests/agents/pdp-builder/assemble-cluster.test.js
```
Expected: tests fail with `Cannot find module`.

---

## Task 10: Implement `assemble-cluster.js`

**Files:**
- Create: `agents/pdp-builder/lib/assemble-cluster.js`

- [ ] **Step 1: Implement the module**

```javascript
// agents/pdp-builder/lib/assemble-cluster.js
import { execSync } from 'node:child_process';
import { buildClusterSystemPrompt } from './prompt-builder.js';
import {
  validateIngredients,
  validateLengths,
  validateBrandTermExclusion,
} from './validators.js';

const CLAUDE_MODEL = 'claude-opus-4-7';

function gitSha() {
  try { return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim(); }
  catch { return 'unknown'; }
}

function parseClaudeJson(response) {
  const text = response?.content?.find((b) => b.type === 'text')?.text || '';
  // Strip code fences if Claude wrapped the JSON.
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
  return JSON.parse(cleaned);
}

/**
 * Cluster mode: generates the content for a cluster template.
 *
 * @param {Object} args
 * @param {Object} args.foundation     loaded Foundation object
 * @param {string} args.clusterName    e.g. "toothpaste"
 * @param {Object} args.claudeClient   Anthropic SDK client (injectable for tests)
 * @returns {Promise<Object>}          queue item ready for write
 */
export async function assembleCluster({ foundation, clusterName, claudeClient }) {
  const systemPrompt = buildClusterSystemPrompt({ foundation, clusterName });

  const response = await claudeClient.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 4096,
    system: systemPrompt,
    messages: [
      { role: 'user', content: `Generate the cluster content for ${clusterName}. Output JSON only.` },
    ],
  });

  let proposed;
  try { proposed = parseClaudeJson(response); }
  catch (e) {
    return {
      type: 'pdp-cluster',
      slug: clusterName,
      status: 'needs_rework',
      generated_at: new Date().toISOString(),
      foundation_version: gitSha(),
      proposed: null,
      validation: { passed: false, errors: [`Claude response not valid JSON: ${e.message}`], warnings: [] },
    };
  }

  // ── Validate ──────────────────────────────────────────────────────
  const errors = [];

  // Ingredient validation: every ingredient card's name must be in the spec.
  const claimedIngredients = (proposed.ingredientCards || []).map((c) => c.name);
  const ing = validateIngredients({
    cluster: clusterName,
    claimedIngredients,
    ingredientsByCluster: foundation.ingredientsByCluster,
  });
  if (!ing.valid) errors.push(`Fabricated ingredients: ${ing.fabricated.join(', ')}`);

  // Length validation
  const lengths = validateLengths({
    ingredientCards: proposed.ingredientCards,
    mechanismBlock:  proposed.mechanismBlock,
    founderBlock:    proposed.founderBlock,
    faq:             proposed.faq,
  });
  if (!lengths.valid) errors.push(...lengths.errors);

  // Brand-term exclusion across all generated text fields
  const textFields = [
    ['hookLine', proposed.hookLine],
    ['mechanismBlock', proposed.mechanismBlock],
    ['founderBlock', proposed.founderBlock],
    ...((proposed.ingredientCards || []).map((c, i) => [`ingredientCards[${i}].story`, c.story])),
    ...((proposed.faq || []).map((qa, i) => [`faq[${i}].answer`, qa.answer])),
  ];
  for (const [field, text] of textFields) {
    const e = validateBrandTermExclusion({ text, field });
    if (!e.valid) errors.push(...e.errors);
  }

  return {
    type: 'pdp-cluster',
    slug: clusterName,
    status: errors.length === 0 ? 'pending' : 'needs_rework',
    generated_at: new Date().toISOString(),
    foundation_version: gitSha(),
    proposed,
    validation: { passed: errors.length === 0, errors, warnings: [] },
  };
}
```

- [ ] **Step 2: Run the cluster assembler tests**

```bash
node --test tests/agents/pdp-builder/assemble-cluster.test.js
```
Expected: all 3 tests pass.

- [ ] **Step 3: Commit**

```bash
git add agents/pdp-builder/lib/assemble-cluster.js tests/agents/pdp-builder/assemble-cluster.test.js
git commit -m "feat(pdp-builder): cluster-mode assembler with mocked Claude client

Cluster mode takes a Foundation + cluster name, calls Claude with a
foundation-grounded system prompt, parses the JSON response, and runs
all three validators. Returns a queue item with status 'pending' or
'needs_rework' based on validation.

Claude client is injected (Anthropic SDK shape) so tests can pass a
mock; the CLI entry will instantiate the real one in Task 13."
```

---

## Task 11: Write failing test for `assemble-product.js`

**Files:**
- Create: `tests/agents/pdp-builder/assemble-product.test.js`

- [ ] **Step 1: Create the test file**

```javascript
// tests/agents/pdp-builder/assemble-product.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadFoundation } from '../../../agents/pdp-builder/lib/load-foundation.js';
import { assembleProduct } from '../../../agents/pdp-builder/lib/assemble-product.js';

const foundation = loadFoundation();

function fakeClaudeResponse(payload) {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

const VALID_PRODUCT_OUTPUT = {
  seoTitle: 'Coconut Oil Toothpaste | Fluoride-Free | Real Skin Care',  // 55 chars
  metaDescription: 'A'.repeat(150),
  bodyHtml: '<p>' + Array(150).fill('word').join(' ') + '</p>',
  metafieldOverrides: {},
};

test('assembleProduct: returns pending queue item when valid', async () => {
  const mockClient = {
    messages: { create: async () => fakeClaudeResponse(VALID_PRODUCT_OUTPUT) },
  };
  const result = await assembleProduct({
    foundation,
    clusterName: 'toothpaste',
    product: { handle: 'coconut-oil-toothpaste', title: 'Coconut Oil Toothpaste' },
    claudeClient: mockClient,
  });
  assert.equal(result.type, 'pdp-product');
  assert.equal(result.slug, 'coconut-oil-toothpaste');
  assert.equal(result.status, 'pending');
  assert.equal(result.proposed.seoTitle.length, 55);
});

test('assembleProduct: returns needs_rework when seoTitle too long', async () => {
  const longTitleOutput = { ...VALID_PRODUCT_OUTPUT, seoTitle: 'X'.repeat(80) };
  const mockClient = {
    messages: { create: async () => fakeClaudeResponse(longTitleOutput) },
  };
  const result = await assembleProduct({
    foundation,
    clusterName: 'toothpaste',
    product: { handle: 'coconut-oil-toothpaste', title: 'Coconut Oil Toothpaste' },
    claudeClient: mockClient,
  });
  assert.equal(result.status, 'needs_rework');
  assert.match(JSON.stringify(result.validation.errors), /seoTitle.*80/);
});

test('assembleProduct: rejects competitor name in body_html', async () => {
  const competitorOutput = {
    ...VALID_PRODUCT_OUTPUT,
    bodyHtml: '<p>Better than Tom\'s of Maine.</p> ' + Array(140).fill('word').join(' '),
  };
  const mockClient = {
    messages: { create: async () => fakeClaudeResponse(competitorOutput) },
  };
  const result = await assembleProduct({
    foundation,
    clusterName: 'toothpaste',
    product: { handle: 'coconut-oil-toothpaste', title: 'Coconut Oil Toothpaste' },
    claudeClient: mockClient,
  });
  assert.equal(result.status, 'needs_rework');
});
```

- [ ] **Step 2: Run the test (expect failure)**

```bash
node --test tests/agents/pdp-builder/assemble-product.test.js
```
Expected: tests fail with `Cannot find module`.

---

## Task 12: Implement `assemble-product.js`

**Files:**
- Create: `agents/pdp-builder/lib/assemble-product.js`

- [ ] **Step 1: Implement the module**

```javascript
// agents/pdp-builder/lib/assemble-product.js
import { execSync } from 'node:child_process';
import { buildProductSystemPrompt } from './prompt-builder.js';
import {
  validateLengths,
  validateBrandTermExclusion,
} from './validators.js';

const CLAUDE_MODEL = 'claude-opus-4-7';

function gitSha() {
  try { return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim(); }
  catch { return 'unknown'; }
}

function parseClaudeJson(response) {
  const text = response?.content?.find((b) => b.type === 'text')?.text || '';
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
  return JSON.parse(cleaned);
}

/**
 * Product mode: generates per-SKU SEO title, meta description, body_html,
 * and optional metafield overrides.
 *
 * @param {Object} args
 * @param {Object} args.foundation
 * @param {string} args.clusterName
 * @param {Object} args.product       { handle, title, ... }
 * @param {Object} args.claudeClient
 */
export async function assembleProduct({ foundation, clusterName, product, claudeClient }) {
  const systemPrompt = buildProductSystemPrompt({ foundation, clusterName, product });

  const response = await claudeClient.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 2048,
    system: systemPrompt,
    messages: [
      { role: 'user', content: `Generate PDP content for product handle "${product.handle}". Output JSON only.` },
    ],
  });

  let proposed;
  try { proposed = parseClaudeJson(response); }
  catch (e) {
    return {
      type: 'pdp-product',
      slug: product.handle,
      status: 'needs_rework',
      generated_at: new Date().toISOString(),
      foundation_version: gitSha(),
      proposed: null,
      validation: { passed: false, errors: [`Claude response not valid JSON: ${e.message}`], warnings: [] },
    };
  }

  const errors = [];

  const lengths = validateLengths({
    seoTitle:        proposed.seoTitle,
    metaDescription: proposed.metaDescription,
    bodyHtml:        proposed.bodyHtml,
  });
  if (!lengths.valid) errors.push(...lengths.errors);

  for (const [field, text] of [
    ['seoTitle',        proposed.seoTitle],
    ['metaDescription', proposed.metaDescription],
    ['bodyHtml',        proposed.bodyHtml],
  ]) {
    const e = validateBrandTermExclusion({ text, field });
    if (!e.valid) errors.push(...e.errors);
  }

  return {
    type: 'pdp-product',
    slug: product.handle,
    status: errors.length === 0 ? 'pending' : 'needs_rework',
    generated_at: new Date().toISOString(),
    foundation_version: gitSha(),
    proposed,
    validation: { passed: errors.length === 0, errors, warnings: [] },
  };
}
```

- [ ] **Step 2: Run the product assembler tests**

```bash
node --test tests/agents/pdp-builder/assemble-product.test.js
```
Expected: all 3 tests pass.

- [ ] **Step 3: Commit**

```bash
git add agents/pdp-builder/lib/assemble-product.js tests/agents/pdp-builder/assemble-product.test.js
git commit -m "feat(pdp-builder): product-mode assembler

Product mode generates SEO title, meta description, body_html, and
optional metafield overrides for a single SKU. Same validation gate
shape as cluster mode."
```

---

## Task 13: Implement CLI dispatcher in `index.js`

**Files:**
- Create: `agents/pdp-builder/index.js`

- [ ] **Step 1: Implement the entry point**

```javascript
#!/usr/bin/env node
/**
 * PDP Builder Agent
 *
 * Generates Shopify product-page content from a curated foundation.
 * Output goes to data/performance-queue/ for human review; nothing
 * publishes from this agent.
 *
 * Modes:
 *   cluster <cluster-name>    Generate cluster template content
 *   product <product-handle>  Generate per-SKU content
 *
 * Usage:
 *   node agents/pdp-builder/index.js cluster toothpaste
 *   node agents/pdp-builder/index.js product coconut-oil-toothpaste
 */

import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadFoundation } from './lib/load-foundation.js';
import { assembleCluster } from './lib/assemble-cluster.js';
import { assembleProduct } from './lib/assemble-product.js';
import { getProducts } from '../../lib/shopify.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const QUEUE_DIR = join(ROOT, 'data', 'performance-queue');

function loadEnv() {
  const lines = readFileSync(join(ROOT, '.env'), 'utf8').split('\n');
  const env = {};
  for (const line of lines) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const idx = t.indexOf('=');
    if (idx === -1) continue;
    env[t.slice(0, idx).trim()] = t.slice(idx + 1).trim();
  }
  return env;
}

const CLUSTER_BY_HANDLE = {
  'coconut-oil-deodorant':       'deodorant',
  'coconut-oil-toothpaste':      'toothpaste',
  'coconut-lotion':              'lotion',
  'coconut-moisturizer':         'cream',
  'coconut-soap':                'bar_soap',
  'organic-foaming-hand-soap':   'liquid_soap',
  'foam-soap-refill-32oz':       'liquid_soap',
  'coconut-oil-lip-balm':        'lip_balm',
};

function writeQueueItem(item) {
  if (!existsSync(QUEUE_DIR)) mkdirSync(QUEUE_DIR, { recursive: true });
  const fileName = item.type === 'pdp-cluster'
    ? `cluster-${item.slug}.json`
    : `${item.slug}.json`;
  const path = join(QUEUE_DIR, fileName);
  writeFileSync(path, JSON.stringify(item, null, 2));
  return path;
}

async function main() {
  const [, , mode, target] = process.argv;
  if (!mode || !target) {
    console.error('Usage: node agents/pdp-builder/index.js <cluster|product> <name-or-handle>');
    process.exit(1);
  }

  const env = loadEnv();
  if (!env.ANTHROPIC_API_KEY) {
    console.error('Missing ANTHROPIC_API_KEY in .env');
    process.exit(1);
  }
  const claudeClient = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

  const foundation = loadFoundation();

  let item;
  if (mode === 'cluster') {
    console.log(`\nPDP Builder — cluster mode — ${target}\n`);
    item = await assembleCluster({ foundation, clusterName: target, claudeClient });
  } else if (mode === 'product') {
    console.log(`\nPDP Builder — product mode — ${target}\n`);
    const clusterName = CLUSTER_BY_HANDLE[target];
    if (!clusterName) {
      console.error(`Unknown product handle: ${target}. Add to CLUSTER_BY_HANDLE in agents/pdp-builder/index.js if this is a real SKU.`);
      process.exit(1);
    }
    const products = await getProducts();
    const product = products.find((p) => p.handle === target);
    if (!product) {
      console.error(`Product not found in Shopify: ${target}`);
      process.exit(1);
    }
    item = await assembleProduct({ foundation, clusterName, product, claudeClient });
  } else {
    console.error(`Unknown mode: ${mode}. Use "cluster" or "product".`);
    process.exit(1);
  }

  const path = writeQueueItem(item);
  console.log(`  Queue item written: ${path}`);
  console.log(`  Status: ${item.status}`);
  if (item.validation.errors.length) {
    console.log(`  Errors:`);
    for (const e of item.validation.errors) console.log(`    - ${e}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Make the file executable (optional, since we always invoke via `node`)**

```bash
chmod +x agents/pdp-builder/index.js
```

- [ ] **Step 3: Verify file syntax**

```bash
node -c agents/pdp-builder/index.js && echo "syntax OK"
```
Expected: `syntax OK`.

- [ ] **Step 4: Commit**

```bash
git add agents/pdp-builder/index.js
git commit -m "feat(pdp-builder): CLI dispatcher

Top-level entry point. Loads .env, instantiates the Claude client,
loads Foundation, dispatches to cluster or product mode, writes the
queue item to data/performance-queue/.

CLUSTER_BY_HANDLE table maps the 8 active SKUs (per the spec) to
their config/ingredients.json cluster keys."
```

---

## Task 14: Write integration test (end-to-end with mocked Claude)

**Files:**
- Create: `tests/agents/pdp-builder/integration.test.js`

- [ ] **Step 1: Create the test file**

```javascript
// tests/agents/pdp-builder/integration.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadFoundation } from '../../../agents/pdp-builder/lib/load-foundation.js';
import { assembleCluster } from '../../../agents/pdp-builder/lib/assemble-cluster.js';
import { assembleProduct } from '../../../agents/pdp-builder/lib/assemble-product.js';

const foundation = loadFoundation();

function fakeClaudeResponse(payload) {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

test('integration: cluster mode end-to-end (toothpaste, mocked Claude)', async () => {
  const validClusterOutput = {
    hookLine: 'For sensitive teeth, less in the formula means more for your enamel.',
    ingredientCards: [
      { name: 'Organic Virgin Coconut Oil', role: 'antimicrobial', story: Array(50).fill('word').join(' ') },
      { name: 'Baking Soda', role: 'pH balance', story: Array(50).fill('word').join(' ') },
      { name: 'Wildcrafted Myrrh Powder', role: 'anti-inflammatory', story: Array(50).fill('word').join(' ') },
    ],
    mechanismBlock: Array(90).fill('word').join(' '),
    founderBlock: Array(70).fill('word').join(' '),
    freeFrom: ['No SLS', 'No fluoride', 'No glycerin coating', 'No synthetic sweeteners'],
    faq: Array.from({ length: 7 }, (_, i) => ({ question: `Q${i+1}`, answer: Array(50).fill('w').join(' ') })),
    badges: ['Vegan', 'Cruelty-Free', 'Made in USA', 'Small Batch'],
    guarantees: ['30-day MBG', 'Free shipping over $50', 'Clean ingredients', 'Handcrafted'],
  };
  const mockClient = { messages: { create: async () => fakeClaudeResponse(validClusterOutput) } };

  const item = await assembleCluster({
    foundation,
    clusterName: 'toothpaste',
    claudeClient: mockClient,
  });

  assert.equal(item.type, 'pdp-cluster');
  assert.equal(item.status, 'pending');
  assert.ok(item.foundation_version);
  assert.equal(item.proposed.faq.length, 7);
  assert.ok(item.proposed.hookLine.length > 0);
});

test('integration: product mode end-to-end (coconut-oil-toothpaste, mocked Claude)', async () => {
  const validProductOutput = {
    seoTitle: 'Coconut Oil Toothpaste | Fluoride-Free | Real Skin Care',  // 55 chars
    metaDescription: 'A'.repeat(150),
    bodyHtml: '<p>' + Array(150).fill('word').join(' ') + '</p>',
    metafieldOverrides: {},
  };
  const mockClient = { messages: { create: async () => fakeClaudeResponse(validProductOutput) } };

  const item = await assembleProduct({
    foundation,
    clusterName: 'toothpaste',
    product: { handle: 'coconut-oil-toothpaste', title: 'Coconut Oil Toothpaste' },
    claudeClient: mockClient,
  });

  assert.equal(item.type, 'pdp-product');
  assert.equal(item.status, 'pending');
  assert.equal(item.proposed.seoTitle.length, 55);
});
```

- [ ] **Step 2: Run all pdp-builder tests**

```bash
node --test tests/agents/pdp-builder/*.test.js
```
Expected: all tests pass (load-foundation: 3, validators: 13, prompt-builder: 8, assemble-cluster: 3, assemble-product: 3, integration: 2 = 32 total).

- [ ] **Step 3: Commit**

```bash
git add tests/agents/pdp-builder/integration.test.js
git commit -m "test(pdp-builder): integration tests for cluster + product modes

Confirms the full pipeline (load foundation → build prompt → call
Claude → parse → validate → return queue item) works end-to-end with
a mocked Claude client. The pilot in Plan 5 will exercise it against
the real Claude API."
```

---

## Task 15: Push branch + open PR

- [ ] **Step 1: Push the branch**

```bash
git push -u origin feat/pdp-builder-agent
```

- [ ] **Step 2: Open PR**

```bash
gh pr create --title "feat(pdp-builder): agent core (loader, validators, prompt builder, assemblers, CLI)" --body "$(cat <<'EOF'
## Summary
First plan from the PDP redesign initiative ([spec](docs/superpowers/specs/2026-05-02-pdp-builder-design.md)).

Builds the \`agents/pdp-builder/\` core. Two operating modes (cluster | product) that take a curated Foundation (\`data/brand/*\` + \`config/ingredients.json\`) and produce reviewable queue items in \`data/performance-queue/\`. Nothing in this PR publishes to Shopify — the agent is queue-only by design.

## What's in
- \`agents/pdp-builder/index.js\` — CLI dispatcher
- \`agents/pdp-builder/lib/load-foundation.js\` — reads data/brand/* + config/ingredients.json, fails loud on missing/malformed
- \`agents/pdp-builder/lib/prompt-builder.js\` — system-prompt builders for both modes
- \`agents/pdp-builder/lib/assemble-cluster.js\` — cluster mode w/ injectable Claude client
- \`agents/pdp-builder/lib/assemble-product.js\` — product mode w/ injectable Claude client
- \`agents/pdp-builder/lib/validators.js\` — ingredient presence, length bounds, brand/competitor/generic exclusion
- \`tests/agents/pdp-builder/*.test.js\` — 32 tests covering all of the above
- \`data/brand/*\` — STUB foundation content (Plan 2 replaces every word)

## What's not in (separate plans)
- Plan 2: Real foundation content
- Plan 3: Theme refactor for toothpaste cluster
- Plan 4: Dashboard /pdp-review UI
- Plan 5: Pilot end-to-end on toothpaste
- Plan 6: Propagate to remaining 7 SKUs

## Test plan
- [ ] \`node --test tests/agents/pdp-builder/*.test.js\` passes (32 tests)
- [ ] \`node agents/pdp-builder/index.js cluster toothpaste\` produces a queue item at \`data/performance-queue/cluster-toothpaste.json\` (uses real Claude — costs a few cents)
- [ ] Inspect the queue item; status is either \`pending\` (validation passed) or \`needs_rework\` (rare; means stub foundation was insufficient — that's expected, Plan 2 fixes the foundation)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 3: Note the PR number for reference in subsequent plans**

```
PR #___ → write the number into the bottom of this plan when known.
```

---

## Deferred from spec — addressed in follow-up plans or based on pilot findings

The spec calls for two validation/reliability features this plan intentionally omits, to keep the first PR tight:

- **Voice consistency (LLM-judge against voice-and-pov.md).** Spec Layer 3 validator. Implementing this requires another Claude call per generation with a tuned threshold and prompt; without real foundation content (Plan 2) we can't tune the threshold meaningfully. Deferred to a follow-up plan after the pilot. In the meantime, voice quality is checked by humans during dashboard review (Plan 4).
- **Retry with exponential backoff on Claude API failures.** Spec error-handling. Existing `lib/retry.js` pattern is used by other agents. Deferred until the pilot surfaces a flaky-call instance — adding it speculatively without a real failure mode wastes scope.

Both should be cheap follow-ups (one PR each, ~50 lines + tests).

## Self-review checklist (after all tasks complete)

Before merging:

1. **Spec coverage** — every component in the spec's "Layer 3 — Agent" section has a corresponding task.
   - [x] Foundation loader (Task 4)
   - [x] Prompt builder (Task 8)
   - [x] Cluster assembler (Task 10)
   - [x] Product assembler (Task 12)
   - [x] Validators (Task 6)
   - [x] CLI dispatcher (Task 13)
   - [ ] Voice consistency validator — DEFERRED (see above)
2. **Validation gates from spec** — ingredient validation, length bounds, brand/competitor/generic exclusion. All present in `validators.js`. Voice judge deferred.
3. **Queue item shape from spec** — matches: `{type, slug, status, generated_at, foundation_version, proposed, validation, current?}`. The `current` field is added in Plan 4 when the dashboard fetches Shopify state for the diff view; not produced by the agent.
4. **No `--apply` flag** — confirmed; the agent only writes to the queue. Publishing happens via `--publish-approved` in a later plan.
5. **No autonomous publishing** — confirmed.
