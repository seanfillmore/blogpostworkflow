# Ad Concepts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A new agent, `agents/ad-concepts`, that turns a product into one ready-to-launch Meta flexible ad (3 finished images from 3 distinct concepts, 2 primary texts, 2 headlines), concept-first, reusing Ad Studio's gates.

**Architecture:** The new agent owns concept generation, judging, auto-pick, shot specs, takes, overlay copy and code typesetting. It reuses Ad Studio's render call, verification (extracted as `verifyImage`), claim and health gates, critique, flexible-ad copy helpers, budget and archive. Three small additive changes go into Ad Studio, each defaulting to today's behaviour.

**Tech Stack:** Node 22 ESM, `node --test`, Anthropic via `lib/anthropic.js` (`messages.create`), Gemini via `@google/genai` (`renderVariation`), Puppeteer (typesetting), sharp (band luminance).

**Spec:** `docs/superpowers/specs/2026-10-03-ad-concepts-design.md`

## Global Constraints

- Run tests on Node 22 (`source ~/.nvm/nvm.sh && nvm use`). Check the `cancelled` count as well as `fail`.
- Every Ad Studio test must pass with **no edits to its assertions**.
- Never import `@anthropic-ai/sdk` directly. Use `lib/anthropic.js` (a source-scan test enforces this).
- Every agent entry point is guarded with `isDirectRun(import.meta.url)` from `lib/is-direct-run.js`.
- Published copy may not contain an em dash (U+2014).
- RSC sells a deodorant, never an antiperspirant (`findProductCategoryMisnomers`).
- No named competitor (any `name` in `config/competitors.json`) appears in a concept or in copy.
- No before/after imagery of skin, body, face, underarm or teeth.
- `notify()` is deferred, never `immediate: true`, and `status: 'error'` only when the agent itself broke.
- Default render ceiling is `30` render attempts (`USD_PER_RENDER` = $0.13 in `lib/ad-studio-cost.js`).
- Output root: `data/creatives/ad-studio/concepts-<product>-<variant|default>-<ISO stamp with : and . replaced by ->`.
- Image filenames: `meta-plate-take<N>-<ratioSlug>.jpg` and `meta-final-take<N>-<ratioSlug>.jpg`. `ratioSlug('4:5')` → `4x5`. The dashboard parses ratio and platform from these names.
- Nothing publishes to Meta.

## Review Focus

1. **The generator returns a `family` outside the enum.** It must normalise to `'other'`, and the distinct-family rule must still apply to it (two `'other'` concepts never both get picked). Test in Task 5.
2. **A `--concept` idea duplicates a system concept's id.** Ids must be de-duplicated so a picked concept never overwrites another's output folder. Test in Task 5.
3. **Gemini returns PNG on one take and JPEG on another.** Typesetting and verification must sniff the media type per buffer, never assume one. Test in Task 8.
4. **A long headline at 4:5.** The typesetter must shrink the type to fit the band and never overflow the frame; the 2026-10-03 mockup overflowed. Test in Task 8.
5. **The budget runs out mid-concept.** The run must still write `run.json`, mark the run short, and list what was skipped. Test in Task 9.

---

### Task 1: Extract brand font-face CSS into `lib/brand-fonts.js`

**Files:**
- Create: `lib/brand-fonts.js`
- Modify: `scripts/render-frame.mjs` (replace the local `fontFaceCss` and `FONT_DIR`)
- Test: `tests/lib/brand-fonts.test.js`

**Interfaces:**
- Produces: `export const BRAND_FONT_DIR` (absolute path to `data/brand/fonts`), `export const BRAND_FACES` (`{ 'cabin-400.woff2': ['Cabin', 400], … }`), `export function fontFaceCss({ fontDir = BRAND_FONT_DIR } = {}): string`.

- [ ] **Step 1: Write the failing test**

```js
// tests/lib/brand-fonts.test.js
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fontFaceCss, BRAND_FACES, BRAND_FONT_DIR } from '../../lib/brand-fonts.js';

test('inlines every brand face from the real font directory', () => {
  const css = fontFaceCss();
  for (const [, [family, weight]] of Object.entries(BRAND_FACES)) {
    assert.match(css, new RegExp(`font-family:'${family}';font-weight:${weight}`));
  }
  assert.match(css, /src:url\(data:font\/woff2;base64,/);
  assert.ok(BRAND_FONT_DIR.endsWith(join('data', 'brand', 'fonts')));
});

test('throws naming the missing files when a face is absent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fonts-'));
  writeFileSync(join(dir, 'cabin-400.woff2'), 'x');
  assert.throws(() => fontFaceCss({ fontDir: dir }), /missing brand fonts.*cabin-700\.woff2/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/lib/brand-fonts.test.js`
Expected: FAIL with `Cannot find module '…/lib/brand-fonts.js'`

- [ ] **Step 3: Write the implementation**

```js
// lib/brand-fonts.js
//
// The brand faces, inlined as @font-face CSS so a Puppeteer render never depends on a
// network font or a locally installed one. Extracted from scripts/render-frame.mjs so the
// ad-concepts typesetter sets copy in the same faces the PDP gallery frames use.
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const BRAND_FONT_DIR = join(ROOT, 'data', 'brand', 'fonts');

export const BRAND_FACES = Object.freeze({
  'cabin-400.woff2': ['Cabin', 400], 'cabin-700.woff2': ['Cabin', 700],
  'outfit-300.woff2': ['Outfit', 300], 'outfit-400.woff2': ['Outfit', 400], 'outfit-600.woff2': ['Outfit', 600],
});

export function fontFaceCss({ fontDir = BRAND_FONT_DIR } = {}) {
  const present = readdirSync(fontDir).filter((f) => f.endsWith('.woff2'));
  const missing = Object.keys(BRAND_FACES).filter((f) => !present.includes(f));
  if (missing.length) throw new Error(`missing brand fonts in ${fontDir}: ${missing.join(', ')}`);
  return Object.entries(BRAND_FACES).map(([file, [family, weight]]) => {
    const b64 = readFileSync(join(fontDir, file)).toString('base64');
    return `@font-face{font-family:'${family}';font-weight:${weight};font-style:normal;font-display:block;`
      + `src:url(data:font/woff2;base64,${b64}) format('woff2');}`;
  }).join('\n');
}
```

In `scripts/render-frame.mjs`: delete the local `function fontFaceCss() { … }` (the block starting `/** Brand faces, inlined …`), add `import { fontFaceCss } from '../lib/brand-fonts.js';` beside the other imports, and remove the `FONT_DIR` constant if nothing else uses it (`grep -n FONT_DIR scripts/render-frame.mjs`). Call sites stay `fontFaceCss()`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/lib/brand-fonts.test.js && node --check scripts/render-frame.mjs`
Expected: PASS, and no syntax error from `--check`.

- [ ] **Step 5: Commit**

```bash
git add lib/brand-fonts.js scripts/render-frame.mjs tests/lib/brand-fonts.test.js
git commit -m "refactor: extract brand font-face CSS into lib/brand-fonts.js"
```

---

### Task 2: Export the product fidelity block from `render.js`

**Files:**
- Modify: `agents/ad-studio/render.js` (move the `physical` through `fidelity` construction inside `buildRenderPrompt` into a new exported function)
- Test: `tests/agents/ad-studio-render-fidelity-block.test.js`

**Interfaces:**
- Produces: `export function buildProductFidelityBlock(product, { allowPeople = false } = {}): string`. It returns exactly today's `fidelity` string when `allowPeople` is false. When true, the final sentence `No human hands or faces.` is replaced with `People may appear where the scene describes them, but never touching, covering or obscuring the product's label.`
- `buildRenderPrompt` calls `buildProductFidelityBlock(product)`; its output is unchanged.

- [ ] **Step 1: Write the failing test**

```js
// tests/agents/ad-studio-render-fidelity-block.test.js
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { buildRenderPrompt, buildProductFidelityBlock } from '../../agents/ad-studio/render.js';
import { formatByKey } from '../../agents/ad-studio/formats.js';

const product = {
  handle: 'coconut-soap', unitCount: 1, variant: 'nourishing-tea-tree',
  labelStrings: ['real SKIN CARE', 'nourishing tea tree', '3.4 oz • 84g'],
  badgeStrings: ['Made with Organic Coconut Oil'],
  physicalDescription: 'A round, puck-shaped bar of soap wrapped in white pleated paper.',
};

test('the block buildRenderPrompt embeds is the exported block, verbatim', () => {
  const prompt = buildRenderPrompt({ format: formatByKey('problem-aware'), zones: {}, product, brandKit: { palette_hexes: [] }, mode: 'plate' });
  assert.ok(prompt.includes(buildProductFidelityBlock(product)));
});

test('default forbids people; allowPeople permits them but protects the label', () => {
  assert.match(buildProductFidelityBlock(product), /No human hands or faces\.$/);
  const allowed = buildProductFidelityBlock(product, { allowPeople: true });
  assert.doesNotMatch(allowed, /No human hands or faces/);
  assert.match(allowed, /never touching, covering or obscuring the product's label/);
  assert.match(allowed, /3\.4 oz • 84g/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/agents/ad-studio-render-fidelity-block.test.js`
Expected: FAIL with `buildProductFidelityBlock is not a function` (SyntaxError on the missing export).

- [ ] **Step 3: Write the implementation**

In `agents/ad-studio/render.js`, cut the lines from `const physical = String(product.physicalDescription || '').trim();` down to and including the `const fidelity = \`PRODUCT FIDELITY IS THE HIGHEST PRIORITY.` template literal (ending `Do not paste it in flat. No human hands or faces.\`;`). Paste them, with every comment kept, into:

```js
/**
 * The product half of every render prompt: reference-photo fidelity, the manifest's physical
 * description, the exact label and badge strings. Exported so agents/ad-concepts builds its
 * scene prompts around the SAME words, not a second copy that drifts.
 *
 * `allowPeople` exists for concept scenes that put a person in frame on purpose. It only
 * replaces the closing no-people sentence; every fidelity instruction is unchanged.
 */
export function buildProductFidelityBlock(product, { allowPeople = false } = {}) {
  // ...the moved lines, unchanged, ending with the `const fidelity = \`…\`` literal...
  if (!allowPeople) return fidelity;
  return fidelity.replace(
    /No human hands or faces\.$/,
    "People may appear where the scene describes them, but never touching, covering or obscuring the product's label.",
  );
}
```

Inside `buildRenderPrompt`, where the moved lines were, write `const fidelity = buildProductFidelityBlock(product);`. `labels` stays where it is only if it is used outside the moved block (check with `grep -n '\${labels}' agents/ad-studio/render.js`); otherwise it moves too.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/agents/ad-studio-render-fidelity-block.test.js tests/agents/ad-studio-render.test.js`
Expected: PASS. The existing render tests pass unedited.

- [ ] **Step 5: Commit**

```bash
git add agents/ad-studio/render.js tests/agents/ad-studio-render-fidelity-block.test.js
git commit -m "refactor(ad-studio): export buildProductFidelityBlock"
```

---

### Task 3: `allowedSceneText` in verify.js

**Files:**
- Modify: `agents/ad-studio/verify.js` (`buildVerifyPrompt`, `normalizeDefects`, `verdictFor`)
- Test: `tests/agents/ad-studio-verify-scene-text.test.js`

**Interfaces:**
- Produces:
  - `export const ALLOWED_SCENE_TEXT = Object.freeze(['illegible-print'])`
  - `buildVerifyPrompt({ …existing, allowedSceneText = null })`
  - `normalizeDefects(defects, mode = 'finished', { allowedSceneText = null } = {})`
  - `verdictFor({ …existing, allowedSceneText = null })`
  - `export function isIllegiblePrintReport(text): boolean`
- Behaviour with `allowedSceneText: 'illegible-print'` on a plate:
  - The prompt's plate "NOT defects" list gains one bullet: `- printed lines, hairlines or texture on paper or packaging in the scene that carry NO readable letters or digits (declared illegible print). Report it only if you can read actual characters in it.`
  - `normalizeDefects` drops a defect whose `text` is a description of unreadable print, matched by `ILLEGIBLE_PRINT_RE = /\b(illegible|unreadable|indistinct|blurr?(ed|y)|hairlines?|printed lines|lines of print|faint (print|lines))\b/i`. It keeps any defect quoting actual characters.
- With `allowedSceneText` null, every output is byte-identical to today's.

- [ ] **Step 1: Write the failing test**

```js
// tests/agents/ad-studio-verify-scene-text.test.js
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { buildVerifyPrompt, normalizeDefects, verdictFor, isIllegiblePrintReport, ALLOWED_SCENE_TEXT } from '../../agents/ad-studio/verify.js';

const format = { key: 'concept', plateSetting: 'scene', pairsImagesWithLabels: false };
const base = { expected: [], format, mode: 'plate', volumeStrings: [], physicalDescription: '', referenceCount: 0, unitCount: 1 };

test('off by default: prompt and defects are unchanged', () => {
  assert.equal(buildVerifyPrompt(base), buildVerifyPrompt({ ...base, allowedSceneText: null }));
  const d = [{ text: 'illegible printed lines', issue: 'stray-text' }];
  assert.deepEqual(normalizeDefects(d, 'plate'), normalizeDefects(d, 'plate', { allowedSceneText: null }));
  assert.equal(normalizeDefects(d, 'plate').length, 1, 'without the declaration, any reported text still fails');
});

test('declared illegible print: the prompt says so, descriptions pass, real characters fail', () => {
  assert.deepEqual([...ALLOWED_SCENE_TEXT], ['illegible-print']);
  const prompt = buildVerifyPrompt({ ...base, allowedSceneText: 'illegible-print' });
  assert.match(prompt, /declared illegible print/);
  const defects = [
    { text: 'illegible printed lines on the receipt paper', issue: 'stray-text' },
    { text: 'Orgarric Nacet 12.50', issue: 'stray-text' },
  ];
  const kept = normalizeDefects(defects, 'plate', { allowedSceneText: 'illegible-print' });
  assert.deepEqual(kept.map(k => k.text), ['Orgarric Nacet 12.50']);
  assert.equal(isIllegiblePrintReport('faint hairlines'), true);
  assert.equal(isIllegiblePrintReport('WEAK SOAP'), false);
});

test('verdictFor threads the option to the defect check', () => {
  const args = {
    expected: [], checks: [], format, mode: 'plate', sceneInventory: [{ object: 'soap bar', kind: 'product-unit' }],
    defects: [{ text: 'blurred lines of print', issue: 'stray-text' }],
  };
  assert.equal(verdictFor(args).ok, false);
  assert.equal(verdictFor({ ...args, allowedSceneText: 'illegible-print' }).ok, true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/agents/ad-studio-verify-scene-text.test.js`
Expected: FAIL (`isIllegiblePrintReport` is not exported).

- [ ] **Step 3: Write the implementation**

In `agents/ad-studio/verify.js`:

```js
// Declared scene text (agents/ad-concepts). A concept can declare that its scene carries
// printed texture on purpose (an endless receipt rendered as hairlines). The model sometimes
// reports that texture as a "defect" by DESCRIBING it rather than quoting characters; those
// descriptions are not text and are dropped. Anything quoting real characters still fails.
// Off unless a caller passes the declaration, so every Ad Studio path is unchanged.
export const ALLOWED_SCENE_TEXT = Object.freeze(['illegible-print']);
const ILLEGIBLE_PRINT_RE = /\b(illegible|unreadable|indistinct|blurr?(ed|y)|hairlines?|printed lines|lines of print|faint (print|lines))\b/i;

export function isIllegiblePrintReport(text) {
  return ILLEGIBLE_PRINT_RE.test(String(text || ''));
}
```

In `buildVerifyPrompt`, add `allowedSceneText = null` to the destructured params. In the plate `defectsSection`, change the closing NOT-defects bullet list so that when `allowedSceneText === 'illegible-print'` one more bullet is inserted after `- an empty zone, a blank bar, …`:

```js
const sceneTextNote = (isPlate && allowedSceneText === 'illegible-print')
  ? `\n     - printed lines, hairlines or texture on paper or packaging in the scene that carry NO readable letters or digits (declared illegible print). Report it only if you can read actual characters in it.`
  : '';
```

Interpolate `${sceneTextNote}` immediately after the text `a bare icon with no text beside it.` in the plate branch. With the option off, `sceneTextNote` is `''` and the string is identical.

Change `normalizeDefects` to:

```js
export function normalizeDefects(defects, mode = 'finished', { allowedSceneText = null } = {}) {
  return (defects || [])
    .filter(d => d && typeof d.text === 'string' && d.text.trim())
    .filter(d => mode !== 'plate' || !isAbsenceReport(d.text))
    .filter(d => !(mode === 'plate' && allowedSceneText === 'illegible-print' && isIllegiblePrintReport(d.text)))
    .map(d => ({
      text: d.text.trim(),
      issue: DEFECT_ISSUES.has(String(d.issue || '').toLowerCase()) ? String(d.issue).toLowerCase() : 'unspecified',
      detail: typeof d.detail === 'string' ? d.detail : '',
    }));
}
```

In `verdictFor`, add `allowedSceneText = null` to the params and change `const reportedDefects = normalizeDefects(defects, mode);` to `const reportedDefects = normalizeDefects(defects, mode, { allowedSceneText });`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/agents/ad-studio-verify-scene-text.test.js tests/agents/ad-studio-verify.test.js`
Expected: PASS. The existing verify tests pass unedited.

- [ ] **Step 5: Commit**

```bash
git add agents/ad-studio/verify.js tests/agents/ad-studio-verify-scene-text.test.js
git commit -m "feat(ad-studio): optional declared illegible scene print in verify"
```

---

### Task 4: Extract `verifyImage` and export `fetchPdpBody` from Ad Studio

**Files:**
- Modify: `agents/ad-studio/index.js` (`renderWithRetry`, `fetchPdpBody`)
- Test: `tests/agents/ad-studio-verify-image.test.js`

**Interfaces:**
- Produces:
  - `export function loadReferencePhotos(photoPaths): { mediaType, data }[]` (capped at `VERIFY_REFERENCE_MAX`)
  - `export async function verifyImage({ anthropic, buffer, mediaType, referencePhotos = [], expected = [], format, mode = 'plate', volumeStrings = [], physicalDescription = '', unitCount = 1, variant = null, expectedLabelInk = null, expectedBadge = [], allowedSceneText = null }): Promise<proof>` returns the `verdictFor` result with `.transcript` set.
  - `export async function fetchPdpBody(siteUrl, handle)` (the existing function, now exported).
  - `export function sniffImageMediaType(buf)` (the existing helper; export it if it is not already exported).
- `renderWithRetry` builds `referencePhotos` with `loadReferencePhotos` and calls `verifyImage`. Its behaviour, including the `max_tokens` error message, is unchanged.

- [ ] **Step 1: Write the failing test**

```js
// tests/agents/ad-studio-verify-image.test.js
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { verifyImage, fetchPdpBody, sniffImageMediaType } from '../../agents/ad-studio/index.js';

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0x00]);
const format = { key: 'concept', plateSetting: 'scene', pairsImagesWithLabels: false };

function stubAnthropic(json, stop_reason = 'end_turn') {
  const calls = [];
  return {
    calls,
    messages: { create: async (req) => { calls.push(req); return { stop_reason, content: [{ type: 'text', text: JSON.stringify(json) }] }; } },
  };
}

test('verifies an arbitrary buffer and threads allowedSceneText', async () => {
  const anthropic = stubAnthropic({
    checks: [], productVolume: '', defects: [{ text: 'illegible printed lines', issue: 'stray-text' }],
    transcript: [], sceneInventory: [{ object: 'soap bar', kind: 'product-unit' }],
  });
  const strict = await verifyImage({ anthropic, buffer: JPEG, mediaType: sniffImageMediaType(JPEG), format, mode: 'plate' });
  assert.equal(strict.ok, false);
  const relaxed = await verifyImage({ anthropic, buffer: JPEG, mediaType: 'image/jpeg', format, mode: 'plate', allowedSceneText: 'illegible-print' });
  assert.equal(relaxed.ok, true);
  assert.match(anthropic.calls[1].messages[0].content.at(-1).text, /declared illegible print/);
});

test('a truncated verify response throws, never passes', async () => {
  const anthropic = stubAnthropic({}, 'max_tokens');
  await assert.rejects(() => verifyImage({ anthropic, buffer: JPEG, mediaType: 'image/jpeg', format }), /cut off/);
});

test('fetchPdpBody is exported', () => {
  assert.equal(typeof fetchPdpBody, 'function');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/agents/ad-studio-verify-image.test.js`
Expected: FAIL (`verifyImage` is not exported).

- [ ] **Step 3: Write the implementation**

In `agents/ad-studio/index.js`:

```js
export function loadReferencePhotos(photoPaths) {
  return (photoPaths || []).slice(0, VERIFY_REFERENCE_MAX).map(p => {
    const buf = readFileSync(p);
    return { mediaType: sniffImageMediaType(buf), data: buf.toString('base64') };
  });
}

/**
 * The verify gate on ONE image buffer. Extracted from renderWithRetry so agents/ad-concepts
 * gates its takes with the identical call; renderWithRetry now delegates here.
 */
export async function verifyImage({
  anthropic, buffer, mediaType, referencePhotos = [], expected = [], format, mode = 'plate',
  volumeStrings = [], physicalDescription = '', unitCount = 1, variant = null,
  expectedLabelInk = null, expectedBadge = [], allowedSceneText = null,
}) {
  const msg = await anthropic.messages.create({
    model: CREATIVE_MODELS.adStudio.verify,
    max_tokens: 8000,
    messages: [{
      role: 'user',
      content: [
        ...referencePhotos.flatMap((ref, i) => [
          { type: 'text', text: `REFERENCE PHOTOGRAPH ${i + 1} of the real product:` },
          { type: 'image', source: { type: 'base64', media_type: ref.mediaType, data: ref.data } },
        ]),
        ...(referencePhotos.length ? [{ type: 'text', text: 'THE RENDER UNDER TEST:' }] : []),
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: buffer.toString('base64') } },
        { type: 'text', text: buildVerifyPrompt({
          expected, format, mode, volumeStrings,
          physicalDescription, referenceCount: referencePhotos.length, unitCount, allowedSceneText,
        }) },
      ],
    }],
  });
  if (msg.stop_reason === 'max_tokens') {
    throw new Error(
      `ad-studio: the verify response was cut off at the ${msg.usage?.output_tokens ?? '?'}-token ` +
      `limit, so this render could not be scored. Raise max_tokens in verifyImage.`
    );
  }
  const { checks, productVolume, labelScent, labelInk, defects, transcript, pairings, fidelity, sceneInventory } = parseVerifyResponse(textOf(msg));
  const proof = verdictFor({
    expected, checks, productVolume, defects, transcript, pairings, format, mode, volumeStrings,
    fidelity, hasReference: referencePhotos.length > 0, sceneInventory, unitCount,
    labelScent, variant, labelInk, expectedLabelInk, expectedBadge, allowedSceneText,
  });
  proof.transcript = transcript;
  return proof;
}
```

Move the existing explanatory comments about the reference-photo ordering and the 8000-token ceiling from `renderWithRetry` onto these lines. In `renderWithRetry`, replace the `referencePhotos` construction with `const referencePhotos = loadReferencePhotos(photoPaths);` and replace everything from `const msg = await anthropic.messages.create({` through `lastProof.transcript = transcript;` with:

```js
lastProof = await verifyImage({
  anthropic, buffer: lastBuffer, mediaType: lastMediaType, referencePhotos, expected, format, mode,
  volumeStrings, physicalDescription, unitCount, variant, expectedLabelInk, expectedBadge,
});
```

Add `export` to `async function fetchPdpBody(` and to `function sniffImageMediaType(` if it lacks one.

The existing test asserting the `max_tokens` message must still pass. If it matches the literal `Raise max_tokens in renderWithRetry`, keep that substring in the message: use `Raise max_tokens in renderWithRetry / verifyImage.` so neither assertion needs editing.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/agents/ad-studio-verify-image.test.js tests/agents/ad-studio-orchestrator.test.js tests/agents/ad-studio-*.test.js`
Expected: PASS, with 0 cancelled.

- [ ] **Step 5: Commit**

```bash
git add agents/ad-studio/index.js tests/agents/ad-studio-verify-image.test.js
git commit -m "refactor(ad-studio): extract verifyImage; export fetchPdpBody"
```

---

### Task 5: Concept stage: `agents/ad-concepts/concepts.js`

**Files:**
- Create: `agents/ad-concepts/concepts.js`
- Test: `tests/agents/ad-concepts-concepts.test.js`

**Interfaces:**
- Consumes:
  - `findHealthClaims(text) → {category,why,match}[]` (`agents/ad-studio/health-claims.js`)
  - `findProductCategoryMisnomers(text) → hit[]` (`lib/product-category-terms.js`)
  - `assertClaimsSourced(claims, index)`, which throws (`agents/ad-studio/claims.js`)
- Produces:
  - `FAMILIES`, `SCENE_TEXT`, `PEOPLE`, `TYPE_BANDS`, `AWARENESS`, `JUDGE_CRITERIA` (frozen arrays)
  - `normalizeConcept(raw, i) → Concept|null`
  - `parseConceptsResponse(text) → Concept[]` (de-duplicated ids)
  - `buildConceptPrompt({ product, catalogEntry, pdpBody, brandKit, persona, reviews, tactics, requested, count, sourceIds }) → string`
  - `preGate(concept, { sourceIndex, competitorNames }) → { ok, reasons }`
  - `buildJudgePrompt(concepts) → string`
  - `parseJudgeResponse(text, n) → { i, scores, total }[]`
  - `pickConcepts(scored, { slots = 3 }) → { picked, runnersUp }`
  - `nextReplacement(runnersUp, usedFamilies) → Concept|null`
- A `Concept` is: `{ id, title, picture, anchor, twist, family, productRole, sceneText, people, typeBand, awareness, headlineIdea, claims: [{text, sourceId}], requested: boolean }`. Scored concepts add `{ scores, total }`.

- [ ] **Step 1: Write the failing test**

```js
// tests/agents/ad-concepts-concepts.test.js
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  normalizeConcept, parseConceptsResponse, preGate, parseJudgeResponse, pickConcepts, nextReplacement,
  buildConceptPrompt, FAMILIES,
} from '../../agents/ad-concepts/concepts.js';

const raw = (o = {}) => ({
  id: 'the-receipt', title: 'The Receipt', picture: 'A soap box spews an endless receipt down the hallway.',
  anchor: 'the endless pharmacy receipt', twist: 'it is a soap ingredient list', family: 'scale-gag',
  productRole: 'our bar sits calm beside a thumb-length slip', sceneText: 'illegible-print', people: 'none',
  typeBand: 'top', awareness: 'problem', headlineIdea: "Your soap's ingredient list.",
  claims: [{ text: 'one fat', sourceId: 'pdp' }], ...o,
});
const sourceIndex = { pdp: 'One fat: organic virgin coconut oil, cold-pressed and unrefined, turned into soap.' };
const ctx = { sourceIndex, competitorNames: ['Native', "Schmidt's Naturals"] };

test('normalizeConcept coerces enums and rejects incomplete entries', () => {
  const c = normalizeConcept(raw({ family: 'Weird New Thing', sceneText: 'lots', people: 'crowd', typeBand: 'middle' }), 0);
  assert.equal(c.family, 'other');
  assert.equal(c.sceneText, 'none');
  assert.equal(c.people, 'face', 'unknown people value takes the strict reading: a person is present');
  assert.equal(c.typeBand, 'top');
  assert.equal(normalizeConcept(raw({ picture: '' }), 0), null);
  assert.equal(normalizeConcept(raw({ family: 'template:us-vs-them' }), 0).family, 'template:us-vs-them');
});

test('parseConceptsResponse de-duplicates ids and tolerates prose around the JSON', () => {
  const text = `Here you go:\n${JSON.stringify({ concepts: [raw(), raw({ title: 'Dup' }), raw({ id: '' , title: 'No Id Given' })] })}`;
  const out = parseConceptsResponse(text);
  assert.deepEqual(out.map(c => c.id), ['the-receipt', 'the-receipt-2', 'no-id-given']);
  assert.throws(() => parseConceptsResponse('no json here'), /no JSON/);
});

test('preGate passes a category jab and drops each banned shape with a reason', () => {
  assert.deepEqual(preGate(normalizeConcept(raw(), 0), ctx), { ok: true, reasons: [] });
  const cases = [
    [{ twist: 'it cures eczema overnight' }, /health/],
    [{ headlineIdea: 'Our antiperspirant, reinvented' }, /antiperspirant|category/i],
    [{ picture: 'A Native deodorant stick in an evidence bag' }, /competitor/],
    [{ picture: 'Before and after shots of an armpit' }, /before\/after/],
    [{ claims: [{ text: 'clinically proven', sourceId: 'pdp' }] }, /unsourced|claim/i],
  ];
  for (const [o, re] of cases) {
    const r = preGate(normalizeConcept(raw(o), 0), ctx);
    assert.equal(r.ok, false, JSON.stringify(o));
    assert.match(r.reasons.join(' '), re);
  }
});

test('parseJudgeResponse clamps scores and totals them', () => {
  const out = parseJudgeResponse(JSON.stringify({ scores: [
    { i: 0, thumbStop: 5, oneSecondRead: 4, productClarity: 4, renderability: 3, brandFit: 4 },
    { i: 1, thumbStop: 9, oneSecondRead: -2, productClarity: 'x', renderability: 3, brandFit: 3 },
  ] }), 2);
  assert.equal(out[0].total, 20);
  assert.deepEqual(out[1].scores, { thumbStop: 5, oneSecondRead: 1, productClarity: 1, renderability: 3, brandFit: 3 });
});

test('pickConcepts: requested first, then best by total with distinct families', () => {
  const mk = (id, family, total, requested = false) => ({ ...normalizeConcept(raw({ id, family }), 0), total, requested });
  const scored = [
    mk('a', 'scale-gag', 22), mk('b', 'scale-gag', 21), mk('c', 'genre-parody', 20),
    mk('d', 'other', 19), mk('e', 'other', 18), mk('mine', 'scale-gag', 5, true),
  ];
  const { picked, runnersUp } = pickConcepts(scored, { slots: 3 });
  assert.deepEqual(picked.map(c => c.id), ['mine', 'c', 'd'], 'requested takes a slot; scale-gag then used; two "other" never both');
  assert.deepEqual(runnersUp.map(c => c.id), ['a', 'b', 'e']);
  assert.equal(nextReplacement(runnersUp, new Set(['scale-gag', 'genre-parody'])).id, 'e', "'e' is family other, unused");
  assert.equal(nextReplacement([mk('p', 'product-art', 10)], new Set(['scale-gag'])).id, 'p');
  assert.equal(nextReplacement([mk('q', 'scale-gag', 10)], new Set(['scale-gag'])), null);
});

test('the concept prompt carries the rules and the operator ideas', () => {
  const p = buildConceptPrompt({
    product: { title: 'Moisturizing Coconut Soap', handle: 'coconut-soap' }, catalogEntry: {}, pdpBody: 'One fat.',
    brandKit: {}, persona: null, reviews: [], tactics: 'TACTICS MENU', requested: ['a dog sniffing the bar'], count: 18,
    sourceIds: ['pdp', 'catalog'],
  });
  for (const re of [/never an antiperspirant/i, /named competitor/i, /before\/after/i, /em dash/i, /a dog sniffing the bar/, /TACTICS MENU/, /"concepts"/]) {
    assert.match(p, re);
  }
  for (const f of FAMILIES) assert.match(p, new RegExp(f));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/agents/ad-concepts-concepts.test.js`
Expected: FAIL (`Cannot find module '…/agents/ad-concepts/concepts.js'`).

- [ ] **Step 3: Write the implementation**

```js
// agents/ad-concepts/concepts.js
//
// Stage 1 of the concept-first pipeline (spec: docs/superpowers/specs/2026-10-03-ad-concepts-design.md).
// Pure: prompt builders, parsers, the free pre-gate, and the auto-pick. No I/O, no model calls.
import { findHealthClaims } from '../ad-studio/health-claims.js';
import { assertClaimsSourced } from '../ad-studio/claims.js';
import { findProductCategoryMisnomers } from '../../lib/product-category-terms.js';

export const FAMILIES = Object.freeze(['scale-gag', 'genre-parody', 'native-screenshot', 'product-art', 'identity-comedy']);
export const SCENE_TEXT = Object.freeze(['none', 'illegible-print']);
export const PEOPLE = Object.freeze(['none', 'hands', 'face']);
export const TYPE_BANDS = Object.freeze(['top', 'bottom']);
export const AWARENESS = Object.freeze(['unaware', 'problem', 'solution', 'product', 'most-aware']);
export const JUDGE_CRITERIA = Object.freeze(['thumbStop', 'oneSecondRead', 'productClarity', 'renderability', 'brandFit']);

const BEFORE_AFTER_RE = /\bbefore[\s-]*(?:and|&|\/|-)?[\s-]*after\b|\b(?:skin|face|body|underarms?|armpits?|teeth)\b[^.]{0,40}\b(?:improv\w*|clear(?:s|ed|er)?|transform\w*|heal\w*|whiter|smoother)\b/i;

const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);
const str = (v) => (typeof v === 'string' ? v.trim() : '');

export function normalizeFamily(f) {
  const s = str(f).toLowerCase();
  if (FAMILIES.includes(s)) return s;
  if (/^template:[a-z0-9-]+$/.test(s)) return s;
  return 'other';
}

export function normalizeConcept(r, i) {
  if (!r || typeof r !== 'object') return null;
  const title = str(r.title);
  const picture = str(r.picture);
  const anchor = str(r.anchor);
  const twist = str(r.twist);
  if (!title || !picture || !anchor || !twist) return null;
  const pick = (v, allowed, fallback) => (allowed.includes(str(v).toLowerCase()) ? str(v).toLowerCase() : fallback);
  // An unrecognised `people` value is read strictly as "a face is present": that is the
  // value that triggers human review, and silently reading it as "none" would skip it.
  const people = str(r.people) ? pick(r.people, PEOPLE, 'face') : 'none';
  return {
    id: slug(r.id) || slug(title) || `concept-${i + 1}`,
    title, picture, anchor, twist,
    family: normalizeFamily(r.family),
    productRole: str(r.productRole),
    sceneText: pick(r.sceneText, SCENE_TEXT, 'none'),
    people,
    typeBand: pick(r.typeBand, TYPE_BANDS, 'top'),
    awareness: pick(r.awareness, AWARENESS, 'solution'),
    headlineIdea: str(r.headlineIdea),
    claims: (Array.isArray(r.claims) ? r.claims : [])
      .filter(c => c && str(c.text))
      .map(c => ({ text: str(c.text), sourceId: str(c.sourceId) })),
    requested: r.requested === true,
  };
}

function extractJson(text) {
  const s = String(text || '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('ad-concepts: no JSON object in the model response');
  return JSON.parse(s.slice(start, end + 1));
}

export function parseConceptsResponse(text) {
  const obj = extractJson(text);
  const list = Array.isArray(obj.concepts) ? obj.concepts : [];
  const seen = new Map();
  const out = [];
  list.forEach((r, i) => {
    const c = normalizeConcept(r, i);
    if (!c) return;
    const n = (seen.get(c.id) || 0) + 1;
    seen.set(c.id, n);
    if (n > 1) c.id = `${c.id}-${n}`;
    out.push(c);
  });
  return out;
}

export function buildConceptPrompt({ product, catalogEntry, pdpBody, brandKit, persona, reviews = [], tactics = '', requested = [], count = 18, sourceIds = [] }) {
  const requestedBlock = requested.length
    ? `\nOPERATOR IDEAS. Include each of these as its own concept, faithful to the idea, with "requested": true:\n${requested.map((r, i) => `  ${i + 1}. ${r}`).join('\n')}\n`
    : '';
  const reviewLines = (reviews || []).slice(0, 8).map(r => `  - "${String(r.body || r.text || '').slice(0, 240)}"`).join('\n');
  return `You are the creative director for Real Skin Care, generating ad CONCEPTS for one Meta flexible ad.
Product: ${product.title} (${product.handle}).

THE JOB. A concept is an IDEA for a single static image that stops a thumb mid-scroll. Generate ${count} concepts that differ in kind, not just wording. Each one needs a recognisable ANCHOR (something the viewer already knows) and a TWIST (the unexpected thing it turns out to be about). It must read in about one second, with one primary subject and room for at most four words of overlay type. Stock photography is a failed concept.

FAMILIES. Give every concept exactly one family:
  scale-gag         absurd exaggeration of scale or quantity
  genre-parody      a recognisable genre restaged (true crime, nature documentary, infomercial)
  native-screenshot it looks like a phone screenshot or a post, not an ad
  product-art       a beautiful, surreal product image
  identity-comedy   a joke about who the buyer is or wants to be
  template:<key>    one of the existing Ad Studio layouts, only when it is genuinely the best idea

RULES. A concept that breaks one is discarded before anyone sees it:
  - Jabs at a generic CATEGORY are fine ("your soap's ingredient list"). Never a named competitor, its brand, colours or packaging.
  - Real Skin Care sells a DEODORANT, never an antiperspirant. Never describe our product with the word.
  - No before/after imagery of skin, a body, a face, an underarm or teeth, and no claim to treat, heal or cure anything. This is a cosmetic.
  - Every fact a concept leans on goes in "claims" with a sourceId from: ${sourceIds.join(', ')}. Invent nothing.
  - No em dash anywhere in any field.
  - Text in the scene is either none, or "illegible-print" (texture that reads as print from a distance with no readable characters). Overlay type is set later, in code, in the typeBand you name.

EVIDENCE
PDP:
${String(pdpBody || '').slice(0, 4000)}
Catalog: ${JSON.stringify(catalogEntry || {}).slice(0, 1500)}
Brand: ${JSON.stringify({ voice: brandKit?.voice, palette: brandKit?.palette_hexes }).slice(0, 800)}
Persona: ${persona ? JSON.stringify(persona).slice(0, 2000) : 'none'}
Customer words:
${reviewLines || '  (none)'}

TACTICS YOU MAY DRAW ON, AND THE ONES YOU MUST NOT PROPOSE:
${tactics || '(none)'}
${requestedBlock}
Return ONLY this JSON:
{"concepts":[{"id":"kebab-slug","title":"","picture":"one sentence describing the image","anchor":"","twist":"","family":"","productRole":"","sceneText":"none|illegible-print","people":"none|hands|face","typeBand":"top|bottom","awareness":"unaware|problem|solution|product|most-aware","headlineIdea":"","claims":[{"text":"","sourceId":""}],"requested":false}]}`;
}

export function preGate(concept, { sourceIndex, competitorNames = [] }) {
  const reasons = [];
  const text = [concept.title, concept.picture, concept.anchor, concept.twist, concept.productRole, concept.headlineIdea].join(' ');
  const health = findHealthClaims(text);
  if (health.length) reasons.push(`health claim: ${health.map(h => `"${h.match}" (${h.category})`).join(', ')}`);
  const misnomer = findProductCategoryMisnomers(text);
  if (misnomer.length) reasons.push(`product category: ${misnomer.map(m => m.match || m.term || 'antiperspirant').join(', ')}`);
  const lower = text.toLowerCase();
  const named = competitorNames.filter(n => n && new RegExp(`\\b${n.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(lower));
  if (named.length) reasons.push(`names a competitor: ${named.join(', ')}`);
  if (BEFORE_AFTER_RE.test(text)) reasons.push('before/after imagery of skin or body');
  if (/—/.test(text)) reasons.push('em dash');
  if (concept.claims.length) {
    try { assertClaimsSourced(concept.claims, sourceIndex); } catch (e) { reasons.push(`unsourced claim: ${String(e.message).split('\n')[0]}`); }
  }
  return { ok: reasons.length === 0, reasons };
}

export function buildJudgePrompt(concepts) {
  const list = concepts.map((c, i) => `[${i}] ${c.title} (${c.family}): ${c.picture} Anchor: ${c.anchor}. Twist: ${c.twist}. Overlay idea: "${c.headlineIdea}".`).join('\n');
  return `You are judging static Meta ad concepts for a small natural skincare brand. You did NOT write them. Score each 1-5 on:
  thumbStop       does the anchor + twist stop a scrolling thumb?
  oneSecondRead   one subject, readable in a second, four words of overlay is enough
  productClarity  will the real product be clearly visible and recognisable?
  renderability   can an image model produce this convincingly in one frame?
  brandFit        natural, honest, a bit cheeky; never mean about the buyer
Be harsh: anything that would look like stock photography scores 1-2 on thumbStop.

${list}

Return ONLY: {"scores":[{"i":0,"thumbStop":0,"oneSecondRead":0,"productClarity":0,"renderability":0,"brandFit":0}]}`;
}

export function parseJudgeResponse(text, n) {
  const obj = extractJson(text);
  const rows = Array.isArray(obj.scores) ? obj.scores : [];
  const clamp = (v) => { const x = Math.round(Number(v)); return Number.isFinite(x) ? Math.min(5, Math.max(1, x)) : 1; };
  const out = [];
  for (const r of rows) {
    const i = Number(r?.i);
    if (!Number.isInteger(i) || i < 0 || i >= n || out.some(o => o.i === i)) continue;
    const scores = Object.fromEntries(JUDGE_CRITERIA.map(k => [k, clamp(r[k])]));
    out.push({ i, scores, total: Object.values(scores).reduce((a, b) => a + b, 0) });
  }
  return out;
}

export function pickConcepts(scored, { slots = 3 } = {}) {
  const picked = [];
  const used = new Set();
  for (const c of scored.filter(c => c.requested)) {
    if (picked.length >= slots) break;
    picked.push(c);
    used.add(c.family);
  }
  const rest = scored.filter(c => !c.requested).sort((a, b) => (b.total ?? 0) - (a.total ?? 0));
  const runnersUp = [];
  for (const c of rest) {
    if (picked.length < slots && !used.has(c.family)) { picked.push(c); used.add(c.family); }
    else runnersUp.push(c);
  }
  return { picked, runnersUp };
}

export function nextReplacement(runnersUp, usedFamilies) {
  return runnersUp.find(c => !usedFamilies.has(c.family)) || null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/agents/ad-concepts-concepts.test.js`
Expected: PASS. If the misnomer case fails because `findProductCategoryMisnomers` does not match `Our antiperspirant, reinvented`, check its brand-governed shapes in `lib/product-category-terms.js`: "our antiperspirant" is the HEAD shape and must match. Fix the fixture only if the library documents a different shape; never weaken the gate.

- [ ] **Step 5: Commit**

```bash
git add agents/ad-concepts/concepts.js tests/agents/ad-concepts-concepts.test.js
git commit -m "feat(ad-concepts): concept generation prompt, pre-gate, judge and auto-pick"
```

---

### Task 6: Copy: `agents/ad-concepts/copy.js`

**Files:**
- Create: `agents/ad-concepts/copy.js`
- Test: `tests/agents/ad-concepts-copy.test.js`

**Interfaces:**
- Consumes:
  - `assertNoHealthClaims(zones)`, which throws (`agents/ad-studio/health-claims.js`)
  - `assertClaimsSourced`
  - `findProductCategoryMisnomers`
  - `buildFlexibleCopyPrompt`, `parseFlexibleCopyResponse`, `flexibleZones` (`agents/ad-studio/flexible.js`)
- Produces:
  - `HEADLINE_MAX_WORDS = 6`, `SUB_MAX_WORDS = 12`
  - `buildOverlayCopyPrompt({ concept, product, pdpBody, sourceIds, retryNote })`
  - `parseOverlayCopy(text) → { headline, sub, claims }`
  - `gateCopy(fields: Record<string,string>, claims, { sourceIndex }) → { ok, reasons }`
  - `writeOverlayCopy({ anthropic, model, concept, product, pdpBody, sourceIndex }) → { ok: true, copy } | { ok: false, reasons }` (one regeneration with the reasons named)
  - `writeFlexibleCopy({ anthropic, model, product, concepts, sourceIndex, pdpBody, persona, reviews }) → { ok: true, primaryTexts, headlines, claims } | { ok: false, reasons }`

- [ ] **Step 1: Write the failing test**

```js
// tests/agents/ad-concepts-copy.test.js
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { parseOverlayCopy, gateCopy, writeOverlayCopy, writeFlexibleCopy, buildOverlayCopyPrompt } from '../../agents/ad-concepts/copy.js';

const sourceIndex = { pdp: 'One fat: organic virgin coconut oil, cold-pressed and unrefined, turned into soap.' };
const concept = { id: 'the-receipt', title: 'The Receipt', picture: 'An endless receipt.', twist: 'ingredient list', headlineIdea: "Your soap's ingredient list.", awareness: 'problem' };
const product = { handle: 'coconut-soap', title: 'Moisturizing Coconut Soap' };
const reply = (obj) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(obj) }] });
const scripted = (...replies) => { const calls = []; return { calls, messages: { create: async (req) => { calls.push(req); return replies.shift(); } } }; };

test('gateCopy rejects em dash, health claims, misnomers, overlong lines and unsourced claims', () => {
  assert.deepEqual(gateCopy({ headline: "Your soap's ingredient list.", sub: 'Ours: one fat.' }, [{ text: 'one fat', sourceId: 'pdp' }], { sourceIndex }), { ok: true, reasons: [] });
  const bad = gateCopy({ headline: 'Our antiperspirant heals — seven words long here now', sub: '' }, [{ text: 'clinically proven', sourceId: 'pdp' }], { sourceIndex });
  assert.equal(bad.ok, false);
  const r = bad.reasons.join(' | ');
  for (const re of [/em dash/, /health/i, /antiperspirant|category/i, /headline has \d+ words/, /unsourced/i]) assert.match(r, re);
});

test('parseOverlayCopy reads the JSON', () => {
  assert.deepEqual(parseOverlayCopy('x {"headline":"A","sub":"B","claims":[]} y'), { headline: 'A', sub: 'B', claims: [] });
});

test('writeOverlayCopy regenerates once naming the failure, then succeeds', async () => {
  const anthropic = scripted(
    reply({ headline: 'Clean — finally', sub: '', claims: [] }),
    reply({ headline: "Your soap's ingredient list.", sub: 'Ours: one fat.', claims: [{ text: 'one fat', sourceId: 'pdp' }] }),
  );
  const r = await writeOverlayCopy({ anthropic, model: 'm', concept, product, pdpBody: '', sourceIndex });
  assert.equal(r.ok, true);
  assert.equal(r.copy.headline, "Your soap's ingredient list.");
  assert.match(anthropic.calls[1].messages[0].content, /em dash/);
});

test('writeOverlayCopy gives up after the second failure', async () => {
  const anthropic = scripted(reply({ headline: 'a — b', sub: '', claims: [] }), reply({ headline: 'c — d', sub: '', claims: [] }));
  const r = await writeOverlayCopy({ anthropic, model: 'm', concept, product, pdpBody: '', sourceIndex });
  assert.equal(r.ok, false);
});

test('a truncated copy response throws', async () => {
  const anthropic = scripted({ stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"headline":"' }] });
  await assert.rejects(() => writeOverlayCopy({ anthropic, model: 'm', concept, product, pdpBody: '', sourceIndex }), /cut off/);
});

test('writeFlexibleCopy gates primary texts and headlines the same way', async () => {
  const good = { primaryTexts: ['One fat. Organic virgin coconut oil, turned into soap. That is the whole ingredient story.', 'Swap the ingredient list for one fat. Coconut oil soap, made in small batches.'], headlines: ['One fat. Real soap.', 'Coconut oil soap'], claims: [{ text: 'one fat', sourceId: 'pdp' }] };
  const anthropic = scripted(reply(good));
  const r = await writeFlexibleCopy({ anthropic, model: 'm', product, concepts: [concept, concept, concept], sourceIndex, pdpBody: '', persona: null, reviews: [] });
  assert.equal(r.ok, true);
  assert.equal(r.primaryTexts.length, 2);
  assert.match(buildOverlayCopyPrompt({ concept, product, pdpBody: '', sourceIds: ['pdp'] }), /6 words or fewer/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/agents/ad-concepts-copy.test.js`
Expected: FAIL (module not found).

- [ ] **Step 3: Write the implementation**

```js
// agents/ad-concepts/copy.js
//
// Overlay copy per concept and the ad-level flexible copy. Every string passes the same
// gates as Ad Studio's copy, plus Sean's no-em-dash rule. Policy: one regeneration that
// names the failure, then give up (the caller replaces the concept).
import { assertNoHealthClaims } from '../ad-studio/health-claims.js';
import { assertClaimsSourced } from '../ad-studio/claims.js';
import { findProductCategoryMisnomers } from '../../lib/product-category-terms.js';
import { buildFlexibleCopyPrompt, parseFlexibleCopyResponse, flexibleZones } from '../ad-studio/flexible.js';

export const HEADLINE_MAX_WORDS = 6;
export const SUB_MAX_WORDS = 12;

const textOf = (msg) => (msg?.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
const words = (s) => String(s || '').trim().split(/\s+/).filter(Boolean).length;

function extractJson(text) {
  const s = String(text || '');
  const a = s.indexOf('{'); const b = s.lastIndexOf('}');
  if (a === -1 || b <= a) throw new Error('ad-concepts: no JSON object in the copy response');
  return JSON.parse(s.slice(a, b + 1));
}

async function call(anthropic, model, content, maxTokens = 1500) {
  const msg = await anthropic.messages.create({ model, max_tokens: maxTokens, messages: [{ role: 'user', content }] });
  if (msg.stop_reason === 'max_tokens') throw new Error('ad-concepts: the copy response was cut off at the token limit.');
  return textOf(msg);
}

export function buildOverlayCopyPrompt({ concept, product, pdpBody, sourceIds, retryNote = null }) {
  return `Write the overlay type for one static ad image for ${product.title}.
The image: ${concept.picture}
Anchor: ${concept.anchor || ''}. Twist: ${concept.twist}. Draft idea: "${concept.headlineIdea}".

Rules:
  - headline: ${HEADLINE_MAX_WORDS} words or fewer. It completes the joke the picture sets up.
  - sub: optional, ${SUB_MAX_WORDS} words or fewer, plain and factual.
  - Every fact goes in "claims" with a sourceId from: ${sourceIds.join(', ')}. Invent nothing.
  - No em dash. No health claim. Our product is a deodorant or soap, never an antiperspirant.
PDP:
${String(pdpBody || '').slice(0, 3000)}
${retryNote ? `\nYOUR PREVIOUS ATTEMPT WAS REJECTED:\n${retryNote}\nFix exactly that.\n` : ''}
Return ONLY: {"headline":"","sub":"","claims":[{"text":"","sourceId":""}]}`;
}

export function parseOverlayCopy(text) {
  const o = extractJson(text);
  return {
    headline: String(o.headline || '').trim(),
    sub: String(o.sub || '').trim(),
    claims: Array.isArray(o.claims) ? o.claims.filter(c => c && c.text).map(c => ({ text: String(c.text), sourceId: String(c.sourceId || '') })) : [],
  };
}

export function gateCopy(fields, claims, { sourceIndex }) {
  const reasons = [];
  const entries = Object.entries(fields).filter(([, v]) => String(v || '').trim());
  for (const [k, v] of entries) if (/—/.test(v)) reasons.push(`em dash in ${k}`);
  try { assertNoHealthClaims(Object.fromEntries(entries)); } catch (e) { reasons.push(`health claim: ${String(e.message).split('\n')[0]}`); }
  for (const [k, v] of entries) {
    const m = findProductCategoryMisnomers(v);
    if (m.length) reasons.push(`product category in ${k}: our product is never an antiperspirant`);
  }
  if ('headline' in fields && words(fields.headline) > HEADLINE_MAX_WORDS) reasons.push(`headline has ${words(fields.headline)} words (max ${HEADLINE_MAX_WORDS})`);
  if ('sub' in fields && words(fields.sub) > SUB_MAX_WORDS) reasons.push(`sub has ${words(fields.sub)} words (max ${SUB_MAX_WORDS})`);
  if (claims?.length) {
    try { assertClaimsSourced(claims, sourceIndex); } catch (e) { reasons.push(`unsourced claim: ${String(e.message).split('\n')[0]}`); }
  }
  return { ok: reasons.length === 0, reasons };
}

export async function writeOverlayCopy({ anthropic, model, concept, product, pdpBody, sourceIndex }) {
  let retryNote = null;
  let lastReasons = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const prompt = buildOverlayCopyPrompt({ concept, product, pdpBody, sourceIds: Object.keys(sourceIndex), retryNote });
    const copy = parseOverlayCopy(await call(anthropic, model, prompt));
    const gate = gateCopy({ headline: copy.headline, sub: copy.sub }, copy.claims, { sourceIndex });
    if (gate.ok && copy.headline) return { ok: true, copy };
    lastReasons = copy.headline ? gate.reasons : ['empty headline', ...gate.reasons];
    retryNote = lastReasons.join('\n');
  }
  return { ok: false, reasons: lastReasons };
}

export async function writeFlexibleCopy({ anthropic, model, product, concepts, sourceIndex, pdpBody, persona = null, reviews = [] }) {
  const pseudo = concepts.map(c => ({ format: { key: c.id, name: c.title, awareness: c.awareness || 'solution' } }));
  const base = buildFlexibleCopyPrompt({ product, concepts: pseudo, sourceIds: Object.keys(sourceIndex), persona, pdpBody, reviews });
  let note = null;
  let lastReasons = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const content = note ? `${base}\n\nYOUR PREVIOUS ATTEMPT WAS REJECTED:\n${note}\nFix exactly that and return the whole JSON again.` : base;
    let parsed;
    try { parsed = parseFlexibleCopyResponse(await call(anthropic, model, content, 2000)); }
    catch (e) {
      if (/cut off/.test(e.message)) throw e;
      lastReasons = [String(e.message).split('\n')[0]]; note = lastReasons[0]; continue;
    }
    const gate = gateCopy(flexibleZones(parsed), parsed.claims, { sourceIndex });
    if (gate.ok) return { ok: true, ...parsed };
    lastReasons = gate.reasons; note = gate.reasons.join('\n');
  }
  return { ok: false, reasons: lastReasons };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/agents/ad-concepts-copy.test.js`
Expected: PASS. If `parseFlexibleCopyResponse` enforces a minimum length or uniqueness that the fixture violates, adjust the **fixture** to meet Meta's real constraints (read `agents/ad-studio/flexible.js` lines 252-300); do not loosen the parser.

- [ ] **Step 5: Commit**

```bash
git add agents/ad-concepts/copy.js tests/agents/ad-concepts-copy.test.js
git commit -m "feat(ad-concepts): overlay and flexible copy with the shared gates plus no-em-dash"
```

---

### Task 7: Shots and takes: `agents/ad-concepts/shots.js`

**Files:**
- Create: `agents/ad-concepts/shots.js`
- Test: `tests/agents/ad-concepts-shots.test.js`

**Interfaces:**
- Consumes:
  - `buildProductFidelityBlock(product, { allowPeople })` (Task 2)
  - `createRenderBudget(max)` with `take()` and `used()` (`agents/ad-studio/index.js`)
- Produces:
  - `sceneTextBlock(sceneText) → string`
  - `typeBandBlock(typeBand) → string`
  - `unitBlock(unitCount) → string`
  - `buildShotSpecPrompt({ concept, product, ratio }) → string`
  - `parseShotSpec(text) → string` (throws on empty)
  - `buildTakePrompt({ sceneSpec, concept, product, brandKit }) → string`
  - `runConceptTakes({ concept, prompt, render, verify, budget, takes = 3, retryTakes = 2 }) → Promise<{ takes: Take[], passed: Take[], budgetStopped: boolean, repaired: boolean }>`
- `Take = { n, buffer, mediaType, proof, needsHumanReview: string[] }`. `render(prompt) → Promise<Buffer>`. `verify(buffer) → Promise<{ mediaType, proof }>`.

- [ ] **Step 1: Write the failing test**

```js
// tests/agents/ad-concepts-shots.test.js
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { sceneTextBlock, typeBandBlock, buildTakePrompt, parseShotSpec, runConceptTakes } from '../../agents/ad-concepts/shots.js';
import { createRenderBudget } from '../../agents/ad-studio/index.js';

const product = { handle: 'coconut-soap', unitCount: 1, labelStrings: ['real SKIN CARE', '3.4 oz • 84g'], badgeStrings: [], physicalDescription: 'A round wrapped bar.' };
const concept = { id: 'c', people: 'none', sceneText: 'illegible-print', typeBand: 'top' };

test('scene-text and type-band blocks are exact', () => {
  assert.match(sceneTextBlock('illegible-print'), /fine grey hairlines only/);
  assert.match(sceneTextBlock('illegible-print'), /no letters, numbers or symbols/);
  assert.match(sceneTextBlock('none'), /no text anywhere except our product's own label/i);
  assert.match(typeBandBlock('top'), /top quarter/);
  assert.match(typeBandBlock('bottom'), /bottom quarter/);
});

test('take prompt = scene + type band + scene text + product fidelity; people flag reaches fidelity', () => {
  const p = buildTakePrompt({ sceneSpec: 'A kitchen.', concept, product, brandKit: {} });
  assert.ok(p.startsWith('A kitchen.'));
  assert.match(p, /PRODUCT FIDELITY IS THE HIGHEST PRIORITY/);
  assert.match(p, /No human hands or faces\./);
  assert.match(p, /EXACTLY 1 UNIT OF OUR PRODUCT/);
  const withPeople = buildTakePrompt({ sceneSpec: 'A man.', concept: { ...concept, people: 'face' }, product, brandKit: {} });
  assert.doesNotMatch(withPeople, /No human hands or faces/);
  assert.throws(() => parseShotSpec('   '), /empty/);
});

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 1]);
const mkVerify = (results) => async () => ({ mediaType: 'image/jpeg', proof: { ok: results.shift(), reasons: ['volume wrong'] } });

test('three takes; passes are kept; people flag stamped', async () => {
  const r = await runConceptTakes({
    concept: { ...concept, people: 'hands' }, prompt: 'P', render: async () => JPEG,
    verify: mkVerify([false, true, true]), budget: createRenderBudget(30),
  });
  assert.equal(r.takes.length, 3);
  assert.deepEqual(r.passed.map(t => t.n), [2, 3]);
  assert.deepEqual(r.passed[0].needsHumanReview, ['anatomy']);
  assert.equal(r.repaired, false);
});

test('zero passes triggers ONE repair round of two takes with the reasons in the prompt', async () => {
  const prompts = [];
  const r = await runConceptTakes({
    concept, prompt: 'P', render: async (p) => { prompts.push(p); return JPEG; },
    verify: mkVerify([false, false, false, true, false]), budget: createRenderBudget(30),
  });
  assert.equal(r.takes.length, 5);
  assert.equal(r.repaired, true);
  assert.match(prompts[3], /PREVIOUS TAKES FAILED[\s\S]*volume wrong/);
  assert.deepEqual(r.passed.map(t => t.n), [4]);
});

test('budget exhaustion stops takes and says so', async () => {
  const r = await runConceptTakes({ concept, prompt: 'P', render: async () => JPEG, verify: mkVerify([false, false]), budget: createRenderBudget(2) });
  assert.equal(r.takes.length, 2);
  assert.equal(r.budgetStopped, true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/agents/ad-concepts-shots.test.js`
Expected: FAIL (module not found).

- [ ] **Step 3: Write the implementation**

```js
// agents/ad-concepts/shots.js
//
// Stage 2: the shot spec (model-written scene), wrapped in code-owned product and scene-text
// blocks, then the take loop. The product block is Ad Studio's own (buildProductFidelityBlock)
// so the two pipelines describe the product in identical words.
import { buildProductFidelityBlock } from '../ad-studio/render.js';

export function sceneTextBlock(sceneText) {
  return sceneText === 'illegible-print'
    ? `PRINT IN THE SCENE: any printed surface the scene describes (paper, a receipt, packaging) shows fine grey hairlines only, like rows of print seen from far away. There are no letters, numbers or symbols on it anywhere. The only readable text in the whole image is our product's own label.`
    : `TEXT: there is no text anywhere except our product's own label. No signs, no packaging copy, no screens with words.`;
}

export function typeBandBlock(typeBand) {
  const where = typeBand === 'bottom' ? 'bottom' : 'top';
  return `Keep the ${where} quarter of the frame clean, evenly lit and empty of objects and fine detail, so type can be set over it later.`;
}

export function unitBlock(unitCount) {
  const n = Number(unitCount);
  return `EXACTLY ${n} UNIT${n === 1 ? '' : 'S'} OF OUR PRODUCT. Any other object the scene describes is a different object and must not resemble our product in shape, colour or label.`;
}

export function buildShotSpecPrompt({ concept, product, ratio }) {
  return `Write the SCENE description for one photorealistic ${ratio} ad image. It will be sent to an image model together with reference photographs of the product, which are described separately, so do NOT describe our product's appearance.

Concept: ${concept.title}. ${concept.picture}
Anchor: ${concept.anchor}. Twist: ${concept.twist}. Our product's role: ${concept.productRole}.
People: ${concept.people}.

Direct it like a film director:
  - one style line (lens, light, mood), then literal blocking: where every object sits relative to the frame and to each other
  - any person's acting as observable behaviour ("brow raised, holding it at arm's length"), never an emotion label
  - no referential language ("same as", "as before", "as established")
  - make it bold and graphic enough to stop a scroll; avoid anything that reads as stock photography
  - our product (${product.title}) is the sharpest, best-lit object in the frame
Return ONLY the scene description as plain prose, under 220 words.`;
}

export function parseShotSpec(text) {
  const s = String(text || '').trim();
  if (!s) throw new Error('ad-concepts: the shot spec came back empty');
  return s;
}

export function buildTakePrompt({ sceneSpec, concept, product, brandKit }) {
  const palette = (brandKit?.palette_hexes || []).join(', ');
  return [
    sceneSpec.trim(),
    typeBandBlock(concept.typeBand),
    sceneTextBlock(concept.sceneText),
    unitBlock(product.unitCount),
    palette ? `Brand palette, for any colour accents: ${palette}.` : '',
    buildProductFidelityBlock(product, { allowPeople: concept.people !== 'none' }),
  ].filter(Boolean).join('\n\n');
}

export async function runConceptTakes({ concept, prompt, render, verify, budget, takes = 3, retryTakes = 2 }) {
  const all = [];
  let budgetStopped = false;
  const review = concept.people !== 'none' ? ['anatomy'] : [];

  const shoot = async (count, p) => {
    for (let i = 0; i < count; i++) {
      if (!budget.take()) { budgetStopped = true; return; }
      const buffer = await render(p);
      const { mediaType, proof } = await verify(buffer);
      all.push({ n: all.length + 1, buffer, mediaType, proof, needsHumanReview: review });
    }
  };

  await shoot(takes, prompt);
  let repaired = false;
  if (!budgetStopped && !all.some(t => t.proof.ok)) {
    repaired = true;
    const reasons = [...new Set(all.flatMap(t => t.proof.reasons || []))].slice(0, 12);
    await shoot(retryTakes, `${prompt}\n\nPREVIOUS TAKES FAILED these checks. Fix them:\n${reasons.map(r => `- ${r}`).join('\n')}`);
  }
  return { takes: all, passed: all.filter(t => t.proof.ok), budgetStopped, repaired };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/agents/ad-concepts-shots.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add agents/ad-concepts/shots.js tests/agents/ad-concepts-shots.test.js
git commit -m "feat(ad-concepts): shot specs, code-owned product/scene-text blocks, take loop"
```

---

### Task 8: Typesetting: `agents/ad-concepts/typeset.js`

**Files:**
- Create: `agents/ad-concepts/typeset.js`
- Test: `tests/agents/ad-concepts-typeset.test.js`

**Interfaces:**
- Consumes: `fontFaceCss()` (Task 1); `sniffImageMediaType(buf)` (Task 4).
- Produces:
  - `TREATMENTS = ['band', 'caption']`
  - `pickTextColour(luminance) → '#000000'|'#FFFFFF'` (black when luminance ≥ 140)
  - `bandLuminance(buffer, band) → Promise<number>` (mean Rec. 709 luma, 0-255, of the top or bottom 25%)
  - `buildOverlayHtml({ dataUrl, width, height, headline, sub, band, treatment, colour, fontCss }) → string`
  - `typesetTake({ buffer, headline, sub, band, treatment = 'band', browser = null }) → Promise<{ buffer, mediaType: 'image/jpeg', colour, treatment, overflow: boolean, headlinePx: number }>`
- `typesetTake` launches its own browser when none is passed and closes it in `finally`.

- [ ] **Step 1: Write the failing test**

```js
// tests/agents/ad-concepts-typeset.test.js
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import { pickTextColour, bandLuminance, buildOverlayHtml, typesetTake } from '../../agents/ad-concepts/typeset.js';

const require = createRequire(import.meta.url);
const sharp = require('sharp');
const solid = (rgb, fmt = 'jpeg') => sharp({ create: { width: 800, height: 1000, channels: 3, background: rgb } })[fmt]().toBuffer();

test('colour flips on light vs dark bands', async () => {
  assert.equal(pickTextColour(200), '#000000');
  assert.equal(pickTextColour(40), '#FFFFFF');
  assert.ok(await bandLuminance(await solid({ r: 237, g: 229, b: 216 }), 'top') > 200);
  assert.ok(await bandLuminance(await solid({ r: 20, g: 20, b: 20 }), 'bottom') < 40);
});

test('the HTML carries the exact strings and the brand faces', () => {
  const html = buildOverlayHtml({ dataUrl: 'data:image/jpeg;base64,AA', width: 800, height: 1000, headline: "Your soap's ingredient list.", sub: 'Ours: one fat.', band: 'top', treatment: 'band', colour: '#000000', fontCss: '@font-face{}' });
  assert.match(html, /Your soap&#39;s ingredient list\.|Your soap's ingredient list\./);
  assert.match(html, /Ours: one fat\./);
  assert.match(html, /@font-face/);
});

test('renders at the take size, PNG or JPEG in, and shrinks a long headline instead of overflowing', { timeout: 60000 }, async () => {
  for (const fmt of ['jpeg', 'png']) {
    const r = await typesetTake({ buffer: await solid({ r: 237, g: 229, b: 216 }, fmt), headline: 'Your soap has a very long ingredient list', sub: 'Ours: one fat. Organic virgin coconut oil.', band: 'top' });
    const meta = await sharp(r.buffer).metadata();
    assert.equal(meta.width, 800);
    assert.equal(meta.height, 1000);
    assert.equal(r.overflow, false);
    assert.equal(r.colour, '#000000');
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/agents/ad-concepts-typeset.test.js`
Expected: FAIL (module not found).

- [ ] **Step 3: Write the implementation**

```js
// agents/ad-concepts/typeset.js
//
// Overlay type set in CODE, in the real brand faces, so the copy on the ad is exactly the
// copy that passed the gates. Image models approximate type: Ad Studio's comp pass printed
// "50ml" on a 60ml bottle on 2026-10-03, and a hand mockup that day overflowed the frame,
// which is why the headline is fitted to the band by measuring it in the browser.
import { createRequire } from 'node:module';
import { fontFaceCss } from '../../lib/brand-fonts.js';
import { sniffImageMediaType } from '../ad-studio/index.js';

const require = createRequire(import.meta.url);
const sharp = require('sharp');

export const TREATMENTS = Object.freeze(['band', 'caption']);
const SAND = '#EDE5D8';

export function pickTextColour(luminance) {
  return luminance >= 140 ? '#000000' : '#FFFFFF';
}

export async function bandLuminance(buffer, band) {
  const img = sharp(buffer);
  const { width, height } = await img.metadata();
  const h = Math.max(1, Math.round(height * 0.25));
  const top = band === 'bottom' ? height - h : 0;
  const { channels } = await sharp(buffer).extract({ left: 0, top, width, height: h }).stats();
  const [r, g, b] = channels.map(c => c.mean);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function buildOverlayHtml({ dataUrl, width, height, headline, sub, band, treatment, colour, fontCss }) {
  const pad = Math.round(width * 0.06);
  const caption = treatment === 'caption';
  const ink = caption ? '#000000' : colour;
  const pos = band === 'bottom' ? 'bottom:0' : 'top:0';
  return `<!doctype html><html><head><meta charset="utf-8"><style>
${fontCss}
html,body{margin:0;padding:0;width:${width}px;height:${height}px;overflow:hidden}
.frame{position:relative;width:${width}px;height:${height}px;background:url('${dataUrl}') center/cover no-repeat}
.band{position:absolute;left:0;right:0;${pos};height:${Math.round(height * 0.25)}px;box-sizing:border-box;padding:${pad}px;
  display:flex;flex-direction:column;justify-content:center;${caption ? `background:${SAND};` : ''}}
.h{font-family:'Outfit';font-weight:600;color:${ink};line-height:1.02;letter-spacing:-0.01em;white-space:normal;margin:0}
.s{font-family:'Cabin';font-weight:400;color:${ink};margin:${Math.round(pad * 0.35)}px 0 0;font-size:${Math.round(width * 0.034)}px;line-height:1.2}
</style></head><body><div class="frame"><div class="band" id="band"><p class="h" id="h">${esc(headline)}</p>${sub ? `<p class="s" id="s">${esc(sub)}</p>` : ''}</div></div>
<script>
(() => {
  const band = document.getElementById('band'); const h = document.getElementById('h');
  let px = ${Math.round(width * 0.11)}; const min = ${Math.round(width * 0.045)};
  h.style.fontSize = px + 'px';
  while (px > min && (band.scrollHeight > band.clientHeight || h.scrollWidth > h.clientWidth)) { px -= 2; h.style.fontSize = px + 'px'; }
  window.__fit = { px, overflow: band.scrollHeight > band.clientHeight || h.scrollWidth > h.clientWidth };
})();
</script></body></html>`;
}

export async function typesetTake({ buffer, headline, sub = '', band = 'top', treatment = 'band', browser = null }) {
  const mediaType = sniffImageMediaType(buffer);
  const { width, height } = await sharp(buffer).metadata();
  const colour = pickTextColour(await bandLuminance(buffer, band));
  const html = buildOverlayHtml({
    dataUrl: `data:${mediaType};base64,${buffer.toString('base64')}`,
    width, height, headline, sub, band, treatment, colour, fontCss: fontFaceCss(),
  });
  const puppeteer = require('puppeteer');
  const own = !browser;
  const b = browser || await puppeteer.launch({ args: ['--no-sandbox', '--font-render-hinting=none'] });
  try {
    const page = await b.newPage();
    await page.setViewport({ width, height, deviceScaleFactor: 1 });
    await page.setContent(html, { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready);
    const fit = await page.evaluate(() => window.__fit);
    const out = await page.screenshot({ type: 'jpeg', quality: 92, clip: { x: 0, y: 0, width, height } });
    await page.close();
    return { buffer: Buffer.from(out), mediaType: 'image/jpeg', colour: treatment === 'caption' ? '#000000' : colour, treatment, overflow: !!fit?.overflow, headlinePx: fit?.px ?? 0 };
  } finally {
    if (own) await b.close();
  }
}
```

The fit script runs before `document.fonts.ready` resolves. If the test shows an overflow, re-run the fit loop after fonts load: move the script body into a `window.__runFit = () => {…}` function, then call `await page.evaluate(() => window.__runFit())` after `document.fonts.ready`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/agents/ad-concepts-typeset.test.js`
Expected: PASS. Puppeteer launches a local Chrome, so allow up to a minute.

- [ ] **Step 5: Commit**

```bash
git add agents/ad-concepts/typeset.js tests/agents/ad-concepts-typeset.test.js
git commit -m "feat(ad-concepts): code typesetting in brand faces with fit-to-band"
```

---

### Task 9: Orchestrator: `agents/ad-concepts/index.js` + README + CLAUDE.md

**Files:**
- Create: `agents/ad-concepts/index.js`, `agents/ad-concepts/README.md`
- Modify: `CLAUDE.md` (one paragraph under "Ad creative pipeline")
- Test: `tests/agents/ad-concepts-orchestrator.test.js`

**Interfaces:**
- Consumes everything above, plus from `agents/ad-studio/index.js`:
  - `createRenderBudget`, `renderVariationWithBackoff`, `verifyImage`, `loadReferencePhotos`, `critiqueArtifact`, `fetchAdReviews`, `fetchPdpBody`
  - `buildLabelStrings({ manifestEntry, variant })`, `resolveBadgeStrings({ manifestEntry, variant })`, `projectPersonaForCopy(personasData)`
- Also consumes:
  - `selectReferencePhotos` (`render.js`), `buildSourceIndex` (`claims.js`), `renderFlexibleManifest` (`flexible.js`), `ratioSlug` (`packaging.js`)
  - `overlayPersonas` (`lib/operator-angles.js`), `scanSkillInventory`, `renderContextMirror` (`lib/marketing-learner.js`)
  - `archiveRunOutput` (`lib/archive-run-output.js`), `notify` (`lib/notify.js`), `isDirectRun`, `USD_PER_RENDER`
- Produces:
  - `parseArgs(argv) → { product, variant, concepts: string[], ratio, maxRenders, dryRun }`
  - `runConcepts({ args, deps }) → Promise<runReport>`
  - The test injects every effect in `deps` = `{ root, outRoot, now, loadEvidence, anthropic, models, render, typeset, critique, notify, archive }`:
    - `loadEvidence({ product, variant }) → { product, manifestEntry, catalogEntry, brandKit, pdpBody, persona, reviews, sourceIndex, photoPaths, competitorNames, tactics }`
    - `render(prompt, { ratio }) → Buffer`
    - `verify` is built inside `runConcepts` from `deps.verifyImage` and `deps.referencePhotos`
    - `typeset(args) → typesetTake result`
    - `critique({ buffer, mediaType, zones }) → { ok, score, reasons }`
  - `main()` builds the real `deps` and calls `runConcepts`.

- [ ] **Step 1: Write the failing test**

```js
// tests/agents/ad-concepts-orchestrator.test.js
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs, runConcepts } from '../../agents/ad-concepts/index.js';
import { listRuns } from '../../agents/dashboard/lib/ad-studio-runs.js';

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 9]);
const concept = (id, family, extra = {}) => ({ id, title: id, picture: `${id} picture`, anchor: 'a', twist: 't', family, productRole: 'r', sceneText: 'none', people: 'none', typeBand: 'top', awareness: 'problem', headlineIdea: 'One fat.', claims: [], ...extra });
const reply = (o) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: typeof o === 'string' ? o : JSON.stringify(o) }] });

function deps({ verifyOk = () => true, maxConcepts = 4, peopleOn = null } = {}) {
  const out = mkdtempSync(join(tmpdir(), 'adc-'));
  const concepts = [concept('a', 'scale-gag'), concept('b', 'genre-parody', peopleOn === 'b' ? { people: 'face' } : {}), concept('c', 'product-art'), concept('d', 'identity-comedy')].slice(0, maxConcepts);
  const queue = [];
  const anthropic = { messages: { create: async (req) => {
    const t = req.messages[0].content;
    const text = typeof t === 'string' ? t : '';
    if (text.includes('generating ad CONCEPTS')) return reply({ concepts });
    if (text.includes('You did NOT write them')) return reply({ scores: concepts.map((_, i) => ({ i, thumbStop: 5 - (i % 2), oneSecondRead: 4, productClarity: 4, renderability: 4, brandFit: 4 })) });
    if (text.includes('Write the SCENE description')) return reply('A bold kitchen scene.');
    if (text.includes('overlay type')) return reply({ headline: 'One fat. Real soap.', sub: '', claims: [{ text: 'one fat', sourceId: 'pdp' }] });
    if (text.includes('AD-LEVEL copy')) return reply({ primaryTexts: ['One fat. Organic virgin coconut oil, turned into soap. That is the list.', 'Swap a long ingredient list for one fat. Coconut oil soap, small batches.'], headlines: ['One fat. Real soap.', 'Coconut oil soap'], claims: [{ text: 'one fat', sourceId: 'pdp' }] });
    throw new Error(`unexpected prompt: ${text.slice(0, 80)}`);
  } } };
  return {
    out,
    deps: {
      root: out, outRoot: out, now: () => new Date('2026-10-03T12:00:00Z'),
      models: { concept: 'm', judge: 'j', shot: 'm', copy: 'm' },
      anthropic,
      loadEvidence: async () => ({
        product: { handle: 'coconut-soap', title: 'Moisturizing Coconut Soap', unitCount: 1, labelStrings: ['real SKIN CARE'], badgeStrings: [], physicalDescription: 'bar', variant: 'nourishing-tea-tree', labelInk: null },
        catalogEntry: {}, brandKit: {}, pdpBody: 'One fat: organic virgin coconut oil.', persona: null, reviews: [],
        sourceIndex: { pdp: 'One fat: organic virgin coconut oil.' }, photoPaths: [], competitorNames: [], tactics: '',
      }),
      render: async () => JPEG,
      verifyImage: async () => ({ ok: verifyOk(), reasons: verifyOk() ? [] : ['bad'] }),
      typeset: async ({ buffer }) => ({ buffer, mediaType: 'image/jpeg', colour: '#000000', treatment: 'band', overflow: false, headlinePx: 80 }),
      critique: async () => ({ ok: true, score: 4, reasons: [] }),
      notify: async (n) => { queue.push(n); },
      archive: () => null,
      notifications: queue,
    },
  };
}

test('parseArgs', () => {
  const a = parseArgs(['--product', 'coconut-soap', '--variant', 'nourishing-tea-tree', '--concept', 'a dog', '--concept', 'a crime scene', '--max-renders', '12', '--dry-run']);
  assert.deepEqual(a, { product: 'coconut-soap', variant: 'nourishing-tea-tree', concepts: ['a dog', 'a crime scene'], ratio: '4:5', maxRenders: 12, dryRun: true });
  assert.throws(() => parseArgs([]), /--product/);
  assert.throws(() => parseArgs(['--product', 'x', '--ratio', '9:16']), /ratio/);
});

test('end to end: a complete run folder, a 3-image manifest, and a run the dashboard lists', async () => {
  const { out, deps: d } = deps({ peopleOn: 'b' });
  const report = await runConcepts({ args: parseArgs(['--product', 'coconut-soap', '--variant', 'nourishing-tea-tree']), deps: d });
  const runDir = join(out, report.runId);
  assert.ok(existsSync(join(runDir, 'concepts.json')));
  assert.ok(existsSync(join(runDir, 'run.json')));
  const manifest = JSON.parse(readFileSync(join(runDir, 'flexible-ad.json'), 'utf8'));
  assert.equal(manifest.plates.length, 3);
  assert.equal(manifest.short, false);
  const files = readdirSync(join(runDir, 'a', 'v1'));
  assert.ok(files.includes('meta-plate-take1-4x5.jpg') && files.includes('meta-final-take1-4x5.jpg'));
  assert.deepEqual(report.needsHumanReview, ['b']);
  assert.match(d.notifications[0].subject, /NEEDS HUMAN REVIEW/);
  assert.notEqual(d.notifications[0].immediate, true);
  const listed = listRuns(out);
  assert.ok(listed.some(r => r.runId === report.runId));
});

test('dry run stops after concepts with no render', async () => {
  const { out, deps: d } = deps();
  let renders = 0; d.render = async () => { renders++; return JPEG; };
  const report = await runConcepts({ args: parseArgs(['--product', 'coconut-soap', '--dry-run']), deps: d });
  assert.equal(renders, 0);
  assert.ok(existsSync(join(out, report.runId, 'concepts.json')));
  assert.equal(existsSync(join(out, report.runId, 'flexible-ad.json')), false);
});

test('budget runs out mid-concept: run.json says so, manifest is short or absent', async () => {
  const { out, deps: d } = deps({ verifyOk: () => false });
  const report = await runConcepts({ args: parseArgs(['--product', 'coconut-soap', '--max-renders', '4']), deps: d });
  const run = JSON.parse(readFileSync(join(out, report.runId, 'run.json'), 'utf8'));
  assert.equal(run.budget.stopped, true);
  assert.ok(run.budget.skipped.length > 0);
  assert.equal(existsSync(join(out, report.runId, 'flexible-ad.json')), false, 'fewer than 2 finished concepts writes no manifest');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/agents/ad-concepts-orchestrator.test.js`
Expected: FAIL (module not found).

- [ ] **Step 3: Write the implementation**

```js
// agents/ad-concepts/index.js
//
// Concept-first ad creation. One run → one Meta flexible ad: 3 finished images from 3
// distinct concepts, 2 primary texts, 2 headlines. Spec:
// docs/superpowers/specs/2026-10-03-ad-concepts-design.md
//
//   node agents/ad-concepts/index.js --product <handle> [--variant <name>]
//     [--concept "<idea>"]... [--ratio 4:5|1:1] [--max-renders 30] [--dry-run]
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDirectRun } from '../../lib/is-direct-run.js';
import { notify as realNotify } from '../../lib/notify.js';
import { archiveRunOutput } from '../../lib/archive-run-output.js';
import { USD_PER_RENDER } from '../../lib/ad-studio-cost.js';
import { renderFlexibleManifest } from '../ad-studio/flexible.js';
import { ratioSlug } from '../ad-studio/packaging.js';
import { createRenderBudget } from '../ad-studio/index.js';
import { buildConceptPrompt, parseConceptsResponse, preGate, buildJudgePrompt, parseJudgeResponse, pickConcepts, nextReplacement } from './concepts.js';
import { buildShotSpecPrompt, parseShotSpec, buildTakePrompt, runConceptTakes } from './shots.js';
import { writeOverlayCopy, writeFlexibleCopy } from './copy.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DEFAULT_MAX_RENDERS = 30;
export const RATIOS = Object.freeze(['4:5', '1:1']);
const SLOTS = 3;

export function parseArgs(argv) {
  const a = { product: null, variant: null, concepts: [], ratio: '4:5', maxRenders: DEFAULT_MAX_RENDERS, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = () => { const x = argv[++i]; if (x === undefined) throw new Error(`${k} needs a value`); return x; };
    if (k === '--product') a.product = v();
    else if (k === '--variant') a.variant = v();
    else if (k === '--concept') a.concepts.push(v());
    else if (k === '--ratio') a.ratio = v();
    else if (k === '--max-renders') a.maxRenders = Number(v());
    else if (k === '--dry-run') a.dryRun = true;
    else throw new Error(`unknown argument ${k}`);
  }
  if (!a.product) throw new Error('--product is required');
  if (!RATIOS.includes(a.ratio)) throw new Error(`--ratio must be one of ${RATIOS.join(', ')}`);
  if (!Number.isInteger(a.maxRenders) || a.maxRenders < 1) throw new Error('--max-renders must be a positive integer');
  return a;
}

const textOf = (m) => (m?.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
async function ask(anthropic, model, content, maxTokens) {
  const msg = await anthropic.messages.create({ model, max_tokens: maxTokens, messages: [{ role: 'user', content }] });
  if (msg.stop_reason === 'max_tokens') throw new Error('ad-concepts: a model response was cut off at the token limit');
  return textOf(msg);
}
const writeJson = (p, o) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, JSON.stringify(o, null, 2)); };

export async function runConcepts({ args, deps }) {
  const stamp = deps.now().toISOString().replace(/[:.]/g, '-');
  const runId = `concepts-${args.product}-${args.variant || 'default'}-${stamp}`;
  const runDir = join(deps.outRoot, runId);
  mkdirSync(runDir, { recursive: true });
  const ev = await deps.loadEvidence({ product: args.product, variant: args.variant });
  const { product, sourceIndex } = ev;

  // 1. Concepts: generate (one retry on malformed JSON), pre-gate, judge, pick.
  const conceptPrompt = buildConceptPrompt({ ...ev, requested: args.concepts, count: 18, sourceIds: Object.keys(sourceIndex) });
  let generated;
  try { generated = parseConceptsResponse(await ask(deps.anthropic, deps.models.concept, conceptPrompt, 12000)); }
  catch (e) {
    if (/cut off/.test(e.message)) throw e;
    generated = parseConceptsResponse(await ask(deps.anthropic, deps.models.concept, `${conceptPrompt}\n\nYour previous reply was not valid JSON (${e.message}). Return ONLY the JSON.`, 12000));
  }
  const verdicts = {};
  const survivors = [];
  for (const c of generated) {
    const g = preGate(c, { sourceIndex, competitorNames: ev.competitorNames });
    if (g.ok) survivors.push(c); else verdicts[c.id] = `gated: ${g.reasons.join('; ')}`;
  }
  const judged = survivors.length ? parseJudgeResponse(await ask(deps.anthropic, deps.models.judge, buildJudgePrompt(survivors), 4000), survivors.length) : [];
  const scored = survivors.map((c, i) => { const j = judged.find(x => x.i === i); return { ...c, scores: j?.scores || null, total: j?.total ?? 0 }; });
  const { picked, runnersUp } = pickConcepts(scored, { slots: SLOTS });
  const writeConcepts = () => writeJson(join(runDir, 'concepts.json'), {
    runId, generated: generated.length,
    concepts: [...scored, ...generated.filter(g => !survivors.includes(g))].map(c => ({ ...c, verdict: verdicts[c.id] || (picked.includes(c) ? 'picked' : runnersUp.includes(c) ? 'runner-up' : 'outscored') })),
  });
  writeConcepts();
  const requestedGated = generated.filter(c => c.requested && verdicts[c.id]);
  if (args.dryRun) return finish({ dry: true });

  // 2-3. Takes, gates, copy, typeset, critique, per concept, with replacement.
  const budget = createRenderBudget(args.maxRenders);
  const referencePhotos = deps.referencePhotos ?? [];
  const finals = [];
  const skipped = [];
  const used = new Set(picked.map(c => c.family));
  const queue = [...picked];
  let budgetStopped = false;
  const rSlug = ratioSlug(args.ratio);

  while (queue.length && finals.length < SLOTS) {
    const c = queue.shift();
    if (budgetStopped) { skipped.push(c.id); continue; }
    const sceneSpec = parseShotSpec(await ask(deps.anthropic, deps.models.shot, buildShotSpecPrompt({ concept: c, product, ratio: args.ratio }), 1200));
    const prompt = buildTakePrompt({ sceneSpec, concept: c, product, brandKit: ev.brandKit });
    const takes = await runConceptTakes({
      concept: c, prompt, budget,
      render: (p) => deps.render(p, { ratio: args.ratio, budget }),
      verify: async (buffer) => {
        const mediaType = buffer[0] === 0x89 ? 'image/png' : 'image/jpeg';
        const proof = await deps.verifyImage({
          buffer, mediaType, referencePhotos, expected: [], mode: 'plate',
          format: { key: c.id, plateSetting: 'scene', pairsImagesWithLabels: false },
          physicalDescription: product.physicalDescription, unitCount: product.unitCount, variant: product.variant,
          expectedLabelInk: product.labelInk, expectedBadge: product.badgeStrings,
          volumeStrings: product.labelStrings, allowedSceneText: c.sceneText === 'illegible-print' ? 'illegible-print' : null,
        });
        return { mediaType, proof };
      },
    });
    if (takes.budgetStopped) budgetStopped = true;
    const dir = join(runDir, c.id, 'v1');
    mkdirSync(dir, { recursive: true });
    const proofs = {};
    for (const t of takes.takes) {
      writeFileSync(join(dir, `meta-plate-take${t.n}-${rSlug}.jpg`), t.buffer);
      proofs[`meta-plate-take${t.n}-${rSlug}.jpg`] = { ...t.proof, needsHumanReview: t.needsHumanReview };
    }
    let best = null;
    if (takes.passed.length) {
      const copy = await writeOverlayCopy({ anthropic: deps.anthropic, model: deps.models.copy, concept: c, product, pdpBody: ev.pdpBody, sourceIndex });
      if (copy.ok) {
        writeJson(join(runDir, c.id, 'copy.json'), { zones: { headline: copy.copy.headline, sub: copy.copy.sub }, claims: copy.copy.claims });
        for (const t of takes.passed) {
          let set = await deps.typeset({ buffer: t.buffer, headline: copy.copy.headline, sub: copy.copy.sub, band: c.typeBand, treatment: 'band' });
          let crit = await deps.critique({ buffer: set.buffer, mediaType: set.mediaType, zones: { headline: copy.copy.headline, sub: copy.copy.sub } });
          if (!crit.ok || set.overflow) {
            set = await deps.typeset({ buffer: t.buffer, headline: copy.copy.headline, sub: copy.copy.sub, band: c.typeBand, treatment: 'caption' });
            crit = await deps.critique({ buffer: set.buffer, mediaType: set.mediaType, zones: { headline: copy.copy.headline, sub: copy.copy.sub } });
          }
          const name = `meta-final-take${t.n}-${rSlug}.jpg`;
          writeFileSync(join(dir, name), set.buffer);
          proofs[`meta-plate-take${t.n}-${rSlug}.jpg`].critique = crit;
          proofs[`meta-plate-take${t.n}-${rSlug}.jpg`].final = name;
          if (crit.ok && !set.overflow && (!best || (crit.score ?? 0) > (best.score ?? 0))) best = { take: t, file: join(c.id, 'v1', name), score: crit.score, concept: c };
        }
      } else {
        verdicts[c.id] = `copy rejected: ${copy.reasons.join('; ')}`;
      }
    }
    writeJson(join(dir, 'proof.json'), proofs);
    if (best) finals.push(best);
    else {
      const rep = nextReplacement(runnersUp.filter(r => !queue.includes(r) && !finals.some(f => f.concept === r)), used);
      if (rep) { used.add(rep.family); queue.push(rep); runnersUp.splice(runnersUp.indexOf(rep), 1); }
    }
  }
  for (const c of queue) skipped.push(c.id);
  writeConcepts();

  let manifest = null;
  if (finals.length >= 2) {
    const flex = await writeFlexibleCopy({ anthropic: deps.anthropic, model: deps.models.copy, product, concepts: finals.map(f => f.concept), sourceIndex, pdpBody: ev.pdpBody, persona: ev.persona, reviews: ev.reviews });
    if (flex.ok) {
      const { json, md } = renderFlexibleManifest({
        runId, product, variant: args.variant, target: { platform: 'meta', ratio: args.ratio },
        plates: finals.map(f => ({ format: f.concept.id, file: f.file, verified: true })),
        primaryTexts: flex.primaryTexts, headlines: flex.headlines, claims: flex.claims,
      });
      manifest = { ...json, short: finals.length < SLOTS, needsHumanReview: finals.filter(f => f.take.needsHumanReview.length).map(f => f.concept.id) };
      writeJson(join(runDir, 'flexible-ad.json'), manifest);
      writeFileSync(join(runDir, 'flexible-ad.md'), md);
    }
  }
  return finish({ dry: false });

  async function finish({ dry }) {
    const renders = dry ? 0 : budget.used();
    const needsHumanReview = dry ? [] : finals.filter(f => f.take.needsHumanReview.length).map(f => f.concept.id);
    const report = {
      kind: 'concepts', runId, generatedAt: deps.now().toISOString(),
      product: { handle: product.handle, title: product.title }, variant: args.variant,
      totals: { artifacts: dry ? 0 : finals.length },
      results: dry ? [] : finals.map(f => ({ conceptSlug: f.concept.id, file: f.file, score: f.score })),
      rejectedConcepts: Object.entries(verdicts).map(([conceptSlug, error]) => ({ conceptSlug, error })),
      requestedGated: requestedGated.map(c => ({ conceptSlug: c.id, reason: verdicts[c.id] })),
      cost: { renders, perRenderUsd: USD_PER_RENDER, estimatedUsd: Number((renders * USD_PER_RENDER).toFixed(2)) },
      budget: { maxRenders: args.maxRenders, stopped: dry ? false : budgetStopped, skipped: dry ? [] : skipped, skippedCount: dry ? 0 : skipped.length },
      manifest: manifest ? 'flexible-ad.json' : null,
      needsHumanReview,
    };
    writeJson(join(runDir, 'run.json'), report);
    deps.archive({ sourceDir: runDir, runId });
    const n = dry ? 0 : finals.length;
    const subject = dry
      ? `Ad Concepts dry run, ${product.title}: ${picked.length} concepts picked`
      : `Ad Concepts, ${product.title}: ${n} image${n === 1 ? '' : 's'}${manifest?.short ? ' (SHORT)' : ''}${needsHumanReview.length ? ' · NEEDS HUMAN REVIEW' : ''}`;
    await deps.notify({ subject, body: `Run ${runId}\n${manifest ? 'flexible-ad.md is ready.' : 'No flexible ad: fewer than 2 concepts finished.'}`, status: 'info', category: 'ads' });
    return report;
  }
}
```

`main()` builds the real deps:

```js
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { default: Anthropic } = await import('../../lib/anthropic.js');
  const { GoogleGenAI } = await import('@google/genai');
  const studio = await import('../ad-studio/index.js');
  const { selectReferencePhotos } = await import('../ad-studio/render.js');
  const { buildSourceIndex } = await import('../ad-studio/claims.js');
  const { overlayPersonas } = await import('../../lib/operator-angles.js');
  const { scanSkillInventory, renderContextMirror } = await import('../../lib/marketing-learner.js');
  const { typesetTake } = await import('./typeset.js');
  const { CREATIVE_MODELS } = await import('../../config/creative-models.js');
  const env = Object.fromEntries(readFileSync(join(ROOT, '.env'), 'utf8').split('\n')
    .filter(l => /^[A-Z_]+=/.test(l)).map(l => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')]; }));
  const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const gemini = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
  const loadJson = (p) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));
  const manifestEntry = loadJson('data/product-images/manifest.json').find(e => e.handle === args.product);
  if (!manifestEntry) throw new Error(`ad-concepts: "${args.product}" is not in data/product-images/manifest.json`);
  const photoDir = join(ROOT, 'data', 'product-images', manifestEntry.imageDir, args.variant || '');
  const photoPaths = selectReferencePhotos(photoDir, 4);
  const outRoot = join(ROOT, 'data', 'creatives', 'ad-studio');
  const report = await runConcepts({
    args,
    deps: {
      root: ROOT, outRoot, now: () => new Date(),
      models: { concept: CREATIVE_MODELS.adStudio.angle, judge: CREATIVE_MODELS.adStudio.verify, shot: CREATIVE_MODELS.adStudio.copy, copy: CREATIVE_MODELS.adStudio.copy },
      anthropic,
      referencePhotos: studio.loadReferencePhotos(photoPaths),
      loadEvidence: async () => {
        const catalogEntry = loadJson('data/brand/product-catalog.json').products?.[args.product];
        if (!catalogEntry) throw new Error(`ad-concepts: no catalog entry for "${args.product}"`);
        const brandKit = loadJson('data/brand/brand-kit.json');
        const pdpBody = await studio.fetchPdpBody(loadJson('config/site.json').url, args.product);
        const reviews = await studio.fetchAdReviews(args.product, { env });
        const persona = studio.projectPersonaForCopy(overlayPersonas(loadJson('data/context/personas.json'), { root: ROOT })).persona;
        const product = {
          handle: args.product, title: catalogEntry.title, variant: args.variant, unitCount: manifestEntry.unitCount,
          labelStrings: studio.buildLabelStrings({ manifestEntry, variant: args.variant }),
          badgeStrings: studio.resolveBadgeStrings({ manifestEntry, variant: args.variant }),
          labelInk: manifestEntry.labelInk || null, physicalDescription: manifestEntry.productDescription || '',
        };
        return {
          product, catalogEntry, brandKit, pdpBody, persona, reviews,
          sourceIndex: buildSourceIndex({ pdpBody, brandKit, catalogEntry, reviews }),
          photoPaths, competitorNames: loadJson('config/competitors.json').map(c => c.name),
          tactics: renderContextMirror(scanSkillInventory(join(ROOT, '.claude', 'skills'))).trim(),
        };
      },
      render: (prompt, { ratio, budget }) => studio.renderVariationWithBackoff(gemini, { prompt, photoPaths, ratio }, { budget }),
      verifyImage: (o) => studio.verifyImage({ anthropic, ...o }),
      typeset: typesetTake,
      critique: ({ buffer, mediaType, zones }) => studio.critiqueArtifact({ anthropic, buffer, mediaType, format: { key: 'concept' }, zones, mode: 'finished', ratio: args.ratio }),
      notify: realNotify,
      archive: ({ sourceDir, runId }) => archiveRunOutput({ sourceDir, runId, relativeDir: 'data/creatives/ad-studio', root: ROOT, label: 'ad-concepts' }),
    },
  });
  console.log(`\n${report.runId}\n${report.manifest ? `Flexible ad: ${join(outRoot, report.runId, 'flexible-ad.md')}` : 'No flexible ad this run (see run.json).'}`);
  if (report.needsHumanReview.length) console.log(`NEEDS HUMAN REVIEW (people in frame): ${report.needsHumanReview.join(', ')}`);
}

if (isDirectRun(import.meta.url)) {
  main().catch(async (err) => {
    await realNotify({ subject: 'Ad Concepts failed', body: err.message || String(err), status: 'error', category: 'ads' }).catch(() => {});
    console.error(err);
    process.exit(1);
  });
}
```

Check that `lib/anthropic.js` default-exports a constructor taking `{ apiKey }`, the same way `agents/ad-studio/index.js` constructs it (`grep -n "new Anthropic" agents/ad-studio/index.js`), and copy that construction exactly.

Also write:
- `agents/ad-concepts/README.md`: purpose, usage, the pipeline diagram from the spec, output files, `needsHumanReview`, and the dry-run tip.
- In `CLAUDE.md`, under **Ad creative pipeline**, one paragraph: `agents/ad-concepts` is the concept-first front end, it produces one flexible ad per run, it reuses Ad Studio's gates via `verifyImage`, `allowedSceneText` exists only for declared illegible print, and type is set in code. Link the spec.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/agents/ad-concepts-orchestrator.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add agents/ad-concepts/index.js agents/ad-concepts/README.md CLAUDE.md tests/agents/ad-concepts-orchestrator.test.js
git commit -m "feat(ad-concepts): orchestrator, flexible-ad output, README"
```

---

### Task 10: Dashboard prefers the typeset final

**Files:**
- Modify: `agents/dashboard/lib/ad-studio-runs.js` (`compFor` and the target builder near line 187)
- Test: `tests/dashboard/ad-studio-runs-final.test.js`

**Interfaces:**
- When a `-final-` sibling exists for a plate, the target carries `comp: <final name>` and `compTrusted: true`, since the final is gated, code-typeset copy over the verified plate. Otherwise behaviour is unchanged (`-comp-`, `compTrusted: false`).

- [ ] **Step 1: Write the failing test**

```js
// tests/dashboard/ad-studio-runs-final.test.js
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readRun } from '../../agents/dashboard/lib/ad-studio-runs.js';

test('a concepts run shows the typeset final as a trusted comp', () => {
  const root = mkdtempSync(join(tmpdir(), 'runs-'));
  const run = join(root, 'concepts-x'); const v = join(run, 'a', 'v1');
  mkdirSync(v, { recursive: true });
  writeFileSync(join(run, 'run.json'), JSON.stringify({ kind: 'concepts', generatedAt: '2026-10-03', product: { handle: 'x', title: 'X' }, totals: {}, results: [], rejectedConcepts: [] }));
  writeFileSync(join(run, 'a', 'copy.json'), JSON.stringify({ zones: {}, claims: [] }));
  writeFileSync(join(v, 'meta-plate-take1-4x5.jpg'), 'x');
  writeFileSync(join(v, 'meta-final-take1-4x5.jpg'), 'x');
  writeFileSync(join(v, 'proof.json'), JSON.stringify({ 'meta-plate-take1-4x5.jpg': { ok: true, reasons: [] } }));
  const r = readRun(root, 'concepts-x');
  const t = r.concepts[0].variations[0].targets[0];
  assert.equal(t.comp, 'meta-final-take1-4x5.jpg');
  assert.equal(t.compTrusted, true);
  assert.equal(t.ratio, '4x5');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/dashboard/ad-studio-runs-final.test.js`
Expected: FAIL (`comp` is null because no `-comp-` file exists).

- [ ] **Step 3: Write the implementation**

In `agents/dashboard/lib/ad-studio-runs.js`:

```js
/** A concepts run's typeset final; preferred over a comp because its copy is set in code, not by an image model. */
function finalFor(plateName) {
  return plateName.replace('-plate-', '-final-');
}
```

In the target builder, replace `comp: files.includes(comp) ? comp : null, compTrusted: false,` with:

```js
comp: files.includes(finalFor(plateName)) ? finalFor(plateName) : (files.includes(comp) ? comp : null),
compTrusted: files.includes(finalFor(plateName)),
```

Image filtering must not treat `-final-` files as plates; `files.filter(f => f.includes('-plate-'))` already excludes them.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/dashboard/ad-studio-runs-final.test.js tests/dashboard/*.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add agents/dashboard/lib/ad-studio-runs.js tests/dashboard/ad-studio-runs-final.test.js
git commit -m "feat(dashboard): show an ad-concepts final as the trusted comp"
```

---

### Task 11: Full suite and live acceptance run

- [ ] **Step 1: Full suite on Node 22**

Run: `source ~/.nvm/nvm.sh && nvm use && npm test 2>&1 | grep -E '^# (tests|pass|fail|cancelled)'`
Expected: `fail 0`, `cancelled 0`.

- [ ] **Step 2: Dry run (no image spend)**

Run: `node agents/ad-concepts/index.js --product coconut-soap --variant nourishing-tea-tree --dry-run`
Expected: `concepts.json` with about 18 concepts, 3 picked from 3 different families, and gated ones carrying reasons. Read the picked three; if they read like stock photography, fix the prompt before spending.

- [ ] **Step 3: Live run**

Run: `node agents/ad-concepts/index.js --product coconut-soap --variant nourishing-tea-tree`
Expected: `flexible-ad.md` plus 3 finals, at a cost under $3.90. Open the finals and judge them by eye. Confirm the net weight reads `3.4 oz • 84g` (or illegible) on every final, check any `needsHumanReview` frame, and confirm no em dash anywhere.

- [ ] **Step 4: Open the PR**

```bash
git push -u origin feature/ad-concepts
gh pr create --base main --title "Ad Concepts: concept-first ad creation" --body "<summary, test results, live run results and cost>"
```
