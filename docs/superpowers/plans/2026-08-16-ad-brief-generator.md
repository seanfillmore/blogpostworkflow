# Ad Brief Generator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generate scored, gate-passed ad briefs from persona angles *before* any image is rendered, and let Ad Studio render only approved briefs — stamping persona/angle/awareness/format onto every creative so results become explainable later.

**Architecture:** A new `agents/ad-brief/` agent imports the copy stage and both gates from `agents/ad-studio/` (never duplicating them), walks a product's persona angles, proposes a format by matching angle awareness to format awareness, and writes one scored brief per angle into `data/briefs/ad-studio/<product>/`. Ad Studio gains `--brief <id>`, which renders a brief's stored copy verbatim with no second LLM call. Scoring ranks; only objective failures floor a brief.

**Tech Stack:** Node 22 LTS (ESM), `node --test` + `node:assert/strict`, vanilla browser JS in `agents/dashboard/public/`, the dashboard's existing tiny router.

**Spec:** `docs/superpowers/specs/2026-08-16-ad-brief-generator-design.md` — read it first, especially "The honest data inventory".

**Worktree:** `.claude/worktrees/ad-brief`, branch `feat/ad-brief-generator`.

## DEADLINE

**Paid ads start in 2 days.** Target products: `coconut-lotion` and `coconut-soap`.

Task 4 (the `--brief` render mode **and the attribute tagging**) is the deadline-critical one. Attributes recorded at production time cannot be reconstructed afterwards — if a creative runs as an ad before it carries its persona/angle/awareness/format, that ad is unattributable forever. If time runs short, Tasks 1-4 plus Task 7 deliver a working pipeline driven from the CLI; Tasks 5-6 (dashboard) are the operator convenience.

## Global Constraints

- **Node 22 LTS.** Run `nvm use`. When reading `node --test` output check the **cancelled** count as well as fail — a cancelled test prints beside `# fail 0` and reads like a pass.
- **The gates are never reimplemented.** `agents/ad-brief/` imports `assertNoHealthClaims`, `assertClaimsSourced`, `buildSourceIndex`, `selectQuotableReviews` and `FORMATS` from `agents/ad-studio/`. A second copy that drifts from the first is the worst outcome this work could produce.
- **A brief carries the FINISHED copy.** Approving it renders those exact strings with no second LLM call.
- **The score only ranks. It never auto-kills.** Only three things floor a brief: an unsourceable factual claim, a health-claim violation, or a falsified tactic.
- **Scoring weights:** persona strength 30, proof 25, commercial 25, headroom 20. Total 100.
- **Headroom order** (per `.claude/skills/marketing-awareness-level-messaging/SKILL.md`): `unaware` and `problem-aware` score highest, then `solution-aware`, then `product-aware` and `most-aware`. Narrow angles harvest fast and run dry.
- **`personas.json` is cluster-scoped** (`cluster: "skin"`), not product-scoped. A product outside the covered cluster **aborts with that reason named** — never a fallback persona, never an invented one.
- **Model:** the brief's copy call uses `CREATIVE_MODELS.adStudio.copy` (`claude-opus-4-8`). Do not downgrade it — the brief *is* the copy that renders.
- Never commit to `main`. Branch `feat/ad-brief-generator` only.

## File Structure

| File | Responsibility |
|---|---|
| `lib/ad-brief-score.js` (new) | Pure scoring. No I/O, no imports from agents. |
| `lib/ad-brief.js` (new) | Brief store: paths, atomic read/write, list, decide. Mirrors `lib/ad-studio-job.js`. |
| `agents/ad-brief/index.js` (new) | The agent: angle selection, awareness join, copy + gates, scoring, persistence. |
| `agents/ad-brief/README.md` (new) | Usage and the non-obvious rules. |
| `agents/ad-studio/index.js` (modify) | `--brief <id>` render mode + attribute tagging. |
| `agents/dashboard/routes/ad-brief.js` (new) | list / read / generate / decide routes. |
| `agents/dashboard/public/{index.html,js/dashboard.js}` (modify) | The Briefs view. |

---

### Task 1: The scoring model

Pure arithmetic over data we hold, in its own module because it is the piece most likely to be argued with and must be testable without personas, network or disk.

**Files:**
- Create: `lib/ad-brief-score.js`
- Test: `tests/lib/ad-brief-score.test.js`

**Interfaces:**
- Consumes: nothing. Imports nothing.
- Produces:
  - `HEADROOM_BY_AWARENESS: Record<string, number>`
  - `scorePersona(persona) => number` (0-30)
  - `scoreProof(angle, reviews) => number` (0-25)
  - `scoreCommercial(productHandle, seoImpact) => number` (0-25)
  - `scoreHeadroom(awareness) => number` (0-20)
  - `scoreBrief({ persona, angle, reviews, productHandle, seoImpact }) => { total, persona, proof, commercial, headroom }`

- [ ] **Step 1: Write the failing test**

Create `tests/lib/ad-brief-score.test.js`:

```js
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  HEADROOM_BY_AWARENESS, scorePersona, scoreProof, scoreCommercial, scoreHeadroom, scoreBrief,
} from '../../lib/ad-brief-score.js';

const P1 = { id: 'p1', evidence_count: 18, emotional_intensity: 9.2 };
const P_WEAK = { id: 'p9', evidence_count: 1, emotional_intensity: 2 };

const ANGLE = {
  id: 'p1a1', awareness: 'problem-aware',
  proof: 'Verified reviewer with severe eczema reports going from hourly reapplication to twice a day.',
  source_quotes: ['I have tried prescription strength lotions, steroids, you name it, to no avail'],
};

const REVIEWS = [{ body: 'I have tried prescription strength lotions, steroids, you name it, to no avail' }];

const SEO = {
  clusters: [
    { cluster: 'body lotion', revenue: 177.8, revenueDelta: 111.8 },
    { cluster: 'lotion', revenue: 30, revenueDelta: -29.4 },
    { cluster: 'soap', revenue: 0, revenueDelta: 0 },
  ],
};

// ── persona strength ────────────────────────────────────────────────────────────────
test('persona strength rewards evidence and intensity, capped at 30', () => {
  assert.equal(scorePersona(P1), 30);
  assert.ok(scorePersona(P_WEAK) < 10);
  assert.ok(scorePersona(P1) > scorePersona(P_WEAK));
});

test('a persona with missing fields scores 0 rather than NaN', () => {
  assert.equal(scorePersona({}), 0);
  assert.equal(scorePersona(null), 0);
});

// ── proof ───────────────────────────────────────────────────────────────────────────
//
// The point of this component: an angle whose proof traces to a REAL review is worth more
// than one asserting a benefit nobody said. A quote that appears in no review on file is
// not proof, however confident the persona file sounds.
test('proof scores full when a source quote appears in a real review', () => {
  assert.equal(scoreProof(ANGLE, REVIEWS), 25);
});

test('proof scores low when no review corroborates the quote', () => {
  assert.ok(scoreProof(ANGLE, [{ body: 'nice smell, fast shipping' }]) < 10);
});

test('proof matching ignores case and punctuation drift', () => {
  const drifted = [{ body: 'I HAVE TRIED PRESCRIPTION-STRENGTH LOTIONS, STEROIDS... you name it, to no avail!' }];
  assert.equal(scoreProof(ANGLE, drifted), 25);
});

test('an angle with no source quotes scores 0 proof, not full marks', () => {
  assert.equal(scoreProof({ id: 'x', proof: 'trust me' }, REVIEWS), 0);
});

// ── commercial ──────────────────────────────────────────────────────────────────────
test('commercial rewards a product whose cluster earns revenue', () => {
  assert.ok(scoreCommercial('coconut-lotion', SEO) > scoreCommercial('coconut-soap', SEO));
});

// Absence of data is NOT evidence of a bad product. A product with no matching cluster
// must land mid-scale, never at zero — otherwise every new product is ranked last for
// the crime of being new.
test('a product with no matching cluster scores neutral, not zero', () => {
  const n = scoreCommercial('coconut-oil-lip-balm', SEO);
  assert.ok(n > 0, 'no-data must not score zero');
  assert.ok(n < 25, 'no-data must not score full marks either');
});

test('a missing or malformed seo-impact report scores neutral for everything', () => {
  assert.equal(scoreCommercial('coconut-lotion', null), scoreCommercial('coconut-soap', null));
});

// ── headroom ────────────────────────────────────────────────────────────────────────
//
// Narrow product-aware angles harvest fast and exhaust fast; broad problem-aware and
// unaware angles convert slower and keep running. Without this the queue fills with the
// angles that run dry first.
test('headroom ranks broad angles above narrow ones', () => {
  assert.ok(scoreHeadroom('unaware') > scoreHeadroom('solution-aware'));
  assert.ok(scoreHeadroom('problem-aware') > scoreHeadroom('solution-aware'));
  assert.ok(scoreHeadroom('solution-aware') > scoreHeadroom('product-aware'));
  assert.equal(scoreHeadroom('unaware'), 20);
});

test('an unknown awareness value scores 0 headroom rather than throwing', () => {
  assert.equal(scoreHeadroom('banana'), 0);
  assert.equal(scoreHeadroom(undefined), 0);
});

test('every awareness level in the table has a headroom value', () => {
  for (const level of ['unaware', 'problem-aware', 'solution-aware', 'product-aware', 'most-aware']) {
    assert.equal(typeof HEADROOM_BY_AWARENESS[level], 'number', `${level} must have a headroom score`);
  }
});

// ── the whole score ─────────────────────────────────────────────────────────────────
test('scoreBrief returns every component alongside the total', () => {
  const s = scoreBrief({ persona: P1, angle: ANGLE, reviews: REVIEWS, productHandle: 'coconut-lotion', seoImpact: SEO });
  assert.equal(s.total, s.persona + s.proof + s.commercial + s.headroom);
  assert.ok(s.total > 0 && s.total <= 100);
  for (const k of ['persona', 'proof', 'commercial', 'headroom']) {
    assert.equal(typeof s[k], 'number', `${k} must be reported, not hidden`);
  }
});

test('the total can never exceed 100 even at maximum everything', () => {
  const s = scoreBrief({
    persona: { evidence_count: 9999, emotional_intensity: 10 },
    angle: { awareness: 'unaware', source_quotes: ['exact'] },
    reviews: [{ body: 'exact' }],
    productHandle: 'coconut-lotion',
    seoImpact: { clusters: [{ cluster: 'lotion', revenue: 1e9, revenueDelta: 1e9 }] },
  });
  assert.ok(s.total <= 100, `total was ${s.total}`);
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd /Users/seanfillmore/Code/Claude/.claude/worktrees/ad-brief
nvm use
node --test tests/lib/ad-brief-score.test.js
```

Expected: FAIL — `Cannot find module '.../lib/ad-brief-score.js'`.

- [ ] **Step 3: Write the implementation**

Create `lib/ad-brief-score.js`:

```js
// lib/ad-brief-score.js
//
// How good is an ad brief, from data we actually hold?
//
// READ THIS BEFORE CHANGING A WEIGHT. There is NO ad-performance data behind any of
// this — data/meta-ads-insights/ is empty on the production server and nothing this
// pipeline makes has ever run as a paid ad. Every number here is an a-priori judgement
// about evidence, not a measured outcome. That is exactly why the score only ever RANKS
// briefs and never kills one: a guess dressed as a threshold is how good work gets
// thrown away. Objective failures (unsourced claim, health-claim violation, falsified
// tactic) are handled elsewhere, as hard floors, and they are not scores.
//
// Imports nothing on purpose, so it can be tested without personas, disk or network.

/**
 * Awareness headroom. Narrow product-aware angles harvest fast and exhaust fast; broad
 * problem-aware and unaware angles convert more slowly and keep running
 * (.claude/skills/marketing-awareness-level-messaging/SKILL.md). Without this component
 * the queue fills with the angles that run dry first.
 */
export const HEADROOM_BY_AWARENESS = {
  'unaware': 20,
  'problem-aware': 20,
  'solution-aware': 13,
  'product-aware': 7,
  'most-aware': 7,
};

const MAX = { persona: 30, proof: 25, commercial: 25, headroom: 20 };

/** Neutral commercial score when there is no data. Absence of evidence is not evidence. */
const COMMERCIAL_NEUTRAL = 12;

const clamp = (n, max) => Math.max(0, Math.min(max, n));

/** Strip case, punctuation and whitespace so quote matching survives ordinary drift. */
function normalize(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Persona strength: how much real evidence sits behind this buyer, and how hard the
 * feeling runs. voice-of-customer writes both fields with an evidence count per persona.
 * 18 reviews at intensity 9.2 is the strongest persona on file and earns full marks.
 */
export function scorePersona(persona) {
  if (!persona) return 0;
  const evidence = Number(persona.evidence_count) || 0;
  const intensity = Number(persona.emotional_intensity) || 0;
  // 15 pts of evidence saturating at 15 reviews, 15 pts of intensity on a 0-10 scale.
  return clamp(Math.round(Math.min(evidence, 15) + intensity * 1.5), MAX.persona);
}

/**
 * Proof: does this angle's claim trace to something a customer actually said?
 *
 * An angle with no `source_quotes` scores ZERO, not a default — the persona file is
 * generated, and an angle asserting a benefit no reviewer voiced is precisely the kind of
 * confident-sounding fiction the claim gate exists to stop. Scoring it neutral would let
 * it outrank a corroborated angle on the other three components.
 */
export function scoreProof(angle, reviews = []) {
  const quotes = (angle?.source_quotes || []).map(normalize).filter(Boolean);
  if (!quotes.length) return 0;
  const corpus = reviews.map(r => normalize(r?.body ?? r)).join('   ');
  // A quote counts when a substantial run of it survives into a real review. Full quotes
  // are often lightly trimmed by the persona writer, so match on the first 8 words.
  const hit = quotes.some(q => {
    const head = q.split(' ').slice(0, 8).join(' ');
    return head.length > 12 && corpus.includes(head);
  });
  return hit ? MAX.proof : 6;
}

/**
 * Commercial: is this product's cluster actually earning?
 *
 * Matched loosely against seo-impact's cluster names, which are human phrases ("body
 * lotion") rather than handles. A product with no matching cluster scores NEUTRAL — new
 * products and products the SEO side has never covered must not be ranked last for having
 * no history.
 */
export function scoreCommercial(productHandle, seoImpact) {
  const clusters = seoImpact?.clusters;
  if (!Array.isArray(clusters) || !clusters.length) return COMMERCIAL_NEUTRAL;
  const words = normalize(productHandle).split(' ').filter(w => w.length > 3);
  const matches = clusters.filter(c => {
    const name = normalize(c.cluster);
    return words.some(w => name.includes(w));
  });
  if (!matches.length) return COMMERCIAL_NEUTRAL;
  const revenue = matches.reduce((sum, c) => sum + (Number(c.revenue) || 0), 0);
  const growing = matches.some(c => (Number(c.revenueDelta) || 0) > 0);
  // 20 pts of revenue saturating at $200 in the window, 5 for a cluster that is growing.
  return clamp(Math.round(Math.min(revenue, 200) / 10 + (growing ? 5 : 0)), MAX.commercial);
}

export function scoreHeadroom(awareness) {
  return HEADROOM_BY_AWARENESS[awareness] ?? 0;
}

/** Every component is returned, never just the total — a score with hidden parts is a black box. */
export function scoreBrief({ persona, angle, reviews = [], productHandle, seoImpact } = {}) {
  const parts = {
    persona: scorePersona(persona),
    proof: scoreProof(angle, reviews),
    commercial: scoreCommercial(productHandle, seoImpact),
    headroom: scoreHeadroom(angle?.awareness),
  };
  return { ...parts, total: parts.persona + parts.proof + parts.commercial + parts.headroom };
}
```

- [ ] **Step 4: Run it and watch it pass**

```bash
node --test tests/lib/ad-brief-score.test.js
```

Expected: PASS, 0 fail, **0 cancelled**.

- [ ] **Step 5: Commit**

```bash
git add lib/ad-brief-score.js tests/lib/ad-brief-score.test.js
git commit -m "feat(ad-brief): scoring model — ranks briefs, never kills them

No ad-performance data exists behind any of this, so every weight is an
a-priori judgement about evidence. That is why the score only ranks: a guess
dressed as a threshold throws away good work. Objective failures are hard
floors handled elsewhere.

Headroom is a real component, not a tiebreaker — narrow product-aware
angles harvest fast and run dry, so without it the queue fills with exactly
the angles that stop working first.

An angle with no corroborating review scores ZERO proof, not a neutral
default: a confident-sounding angle nobody actually said is what the claim
gate exists to stop, and a default would let it outrank a real one.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: The brief store

**Files:**
- Create: `lib/ad-brief.js`
- Test: `tests/lib/ad-brief.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `BRIEF_STATES: string[]` — `['needs-evidence','ready','approved','rejected','rendered']`
  - `briefsDir(root, product) => string`
  - `briefPath(root, product, briefId) => string`
  - `isValidBriefId(id) => boolean`
  - `writeBrief(root, brief) => brief` — atomic; requires `briefId` and `product`
  - `readBrief(root, product, briefId) => brief | null`
  - `listBriefs(root, product) => brief[]` — highest `score.total` first, then newest
  - `decideBrief(root, product, briefId, { state, note }) => brief`
  - `listProductsWithBriefs(root) => string[]`

- [ ] **Step 1: Write the failing test**

Create `tests/lib/ad-brief.test.js`:

```js
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  BRIEF_STATES, briefsDir, briefPath, isValidBriefId,
  writeBrief, readBrief, listBriefs, decideBrief, listProductsWithBriefs,
} from '../../lib/ad-brief.js';

const freshRoot = () => mkdtempSync(join(tmpdir(), 'ad-brief-'));

const brief = (over = {}) => ({
  briefId: 'coconut-lotion-p1a1-1786000000000',
  product: 'coconut-lotion',
  state: 'ready',
  score: { total: 70, persona: 30, proof: 25, commercial: 10, headroom: 5 },
  createdAt: '2026-08-16T00:00:00.000Z',
  ...over,
});

test('brief ids may not contain a path separator', () => {
  assert.equal(isValidBriefId('coconut-lotion-p1a1-1786000000000'), true);
  assert.equal(isValidBriefId('../../../etc/passwd'), false);
  assert.equal(isValidBriefId('a/b'), false);
  assert.equal(isValidBriefId('..'), false);
  assert.equal(isValidBriefId(''), false);
});

// The product name is a directory segment and reaches the filesystem from HTTP.
test('a product name with a separator is refused, not joined', () => {
  const root = freshRoot();
  assert.throws(() => briefsDir(root, '../escape'), /product/i);
  assert.throws(() => briefPath(root, 'a/b', 'x'), /product/i);
});

test('write then read round-trips and creates the directory', () => {
  const root = freshRoot();
  writeBrief(root, brief());
  assert.equal(readBrief(root, 'coconut-lotion', brief().briefId).state, 'ready');
});

test('reading a missing or corrupt brief is null, never a throw', () => {
  const root = freshRoot();
  assert.equal(readBrief(root, 'coconut-lotion', 'nope'), null);
  mkdirSync(briefsDir(root, 'coconut-lotion'), { recursive: true });
  writeFileSync(briefPath(root, 'coconut-lotion', 'bad'), '{ not json');
  assert.equal(readBrief(root, 'coconut-lotion', 'bad'), null);
});

test('writeBrief refuses a brief with no id or no product', () => {
  const root = freshRoot();
  assert.throws(() => writeBrief(root, { product: 'x' }), /briefId/);
  assert.throws(() => writeBrief(root, { briefId: 'x' }), /product/);
});

// The dashboard reads these while the agent writes them.
test('a write leaves no partial file behind', () => {
  const root = freshRoot();
  writeBrief(root, brief());
  writeBrief(root, brief({ state: 'approved' }));
  assert.deepEqual(readdirSync(briefsDir(root, 'coconut-lotion')), [`${brief().briefId}.json`]);
});

test('listBriefs ranks by score, highest first', () => {
  const root = freshRoot();
  writeBrief(root, brief({ briefId: 'lo', score: { total: 20 } }));
  writeBrief(root, brief({ briefId: 'hi', score: { total: 90 } }));
  writeBrief(root, brief({ briefId: 'mid', score: { total: 55 } }));
  assert.deepEqual(listBriefs(root, 'coconut-lotion').map(b => b.briefId), ['hi', 'mid', 'lo']);
});

test('a brief with no score sorts last rather than crashing the list', () => {
  const root = freshRoot();
  writeBrief(root, brief({ briefId: 'scored', score: { total: 10 } }));
  writeBrief(root, brief({ briefId: 'unscored', score: undefined }));
  assert.deepEqual(listBriefs(root, 'coconut-lotion').map(b => b.briefId), ['scored', 'unscored']);
});

test('listBriefs on a product with none is empty, not an error', () => {
  assert.deepEqual(listBriefs(freshRoot(), 'coconut-lotion'), []);
});

test('decide sets the state and stamps decidedAt', () => {
  const root = freshRoot();
  writeBrief(root, brief());
  const out = decideBrief(root, 'coconut-lotion', brief().briefId, { state: 'approved', note: 'good angle' });
  assert.equal(out.state, 'approved');
  assert.equal(out.note, 'good angle');
  assert.ok(Date.parse(out.decidedAt));
});

// The state machine is the whole safety story: only an approved brief renders.
test('decide refuses a state that is not in the vocabulary', () => {
  const root = freshRoot();
  writeBrief(root, brief());
  assert.throws(() => decideBrief(root, 'coconut-lotion', brief().briefId, { state: 'shipped' }), /state/i);
  for (const s of BRIEF_STATES) {
    assert.doesNotThrow(() => decideBrief(root, 'coconut-lotion', brief().briefId, { state: s }));
  }
});

// A brief the gates floored must not be approvable by anyone, including a crafted request.
test('a needs-evidence brief cannot be approved directly', () => {
  const root = freshRoot();
  writeBrief(root, brief({ state: 'needs-evidence' }));
  assert.throws(
    () => decideBrief(root, 'coconut-lotion', brief().briefId, { state: 'approved' }),
    /needs-evidence/i,
  );
});

test('decide on a missing brief throws rather than creating one', () => {
  assert.throws(() => decideBrief(freshRoot(), 'coconut-lotion', 'ghost', { state: 'approved' }), /ghost/);
});

test('listProductsWithBriefs enumerates the product directories', () => {
  const root = freshRoot();
  writeBrief(root, brief());
  writeBrief(root, brief({ briefId: 'soap-p5a3-1', product: 'coconut-soap' }));
  assert.deepEqual(listProductsWithBriefs(root).sort(), ['coconut-lotion', 'coconut-soap']);
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
node --test tests/lib/ad-brief.test.js
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `lib/ad-brief.js`:

```js
// lib/ad-brief.js
//
// Where ad briefs live between being generated and being rendered.
//
// A brief carries the FINISHED, gate-passed copy — approving one renders those exact
// strings with no second LLM call, so nothing can drift between what the operator read
// and what gets baked into a plate. That is the whole compliance argument for letting a
// human steer ad copy at all, and it is why `state` is a closed vocabulary rather than a
// free string: only `approved` renders.
//
// Same atomic-write discipline as lib/ad-studio-job.js — the dashboard reads these files
// while the agent writes them, and a partial read would show half a brief.

import { readdirSync, readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const BRIEF_STATES = ['needs-evidence', 'ready', 'approved', 'rejected', 'rendered'];

const SAFE_SEGMENT = /^[\w.-]+$/;

const checkSegment = (value, label) => {
  const s = String(value || '');
  if (!s || s === '.' || s === '..' || !SAFE_SEGMENT.test(s)) {
    throw new Error(`ad-brief: invalid ${label} "${value}"`);
  }
  return s;
};

export function isValidBriefId(id) {
  try { checkSegment(id, 'briefId'); return true; } catch { return false; }
}

export function briefsDir(root, product) {
  return join(root, 'data', 'briefs', 'ad-studio', checkSegment(product, 'product'));
}

export function briefPath(root, product, briefId) {
  return join(briefsDir(root, product), `${checkSegment(briefId, 'briefId')}.json`);
}

export function writeBrief(root, brief) {
  if (!brief?.briefId) throw new Error('ad-brief: writeBrief requires a briefId');
  if (!brief?.product) throw new Error('ad-brief: writeBrief requires a product');
  const dir = briefsDir(root, brief.product);
  mkdirSync(dir, { recursive: true });
  const record = { createdAt: new Date().toISOString(), ...brief };
  const final = briefPath(root, brief.product, brief.briefId);
  const tmp = `${final}.tmp`;
  writeFileSync(tmp, JSON.stringify(record, null, 2));
  renameSync(tmp, final);
  return record;
}

/** null for missing OR corrupt — a reader must never crash on either. */
export function readBrief(root, product, briefId) {
  try { return JSON.parse(readFileSync(briefPath(root, product, briefId), 'utf8')); } catch { return null; }
}

/** Highest score first; unscored briefs sort last rather than poisoning the comparison. */
export function listBriefs(root, product) {
  let dir;
  try { dir = briefsDir(root, product); } catch { return []; }
  if (!existsSync(dir)) return [];
  const out = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    const b = readBrief(root, product, f.replace(/\.json$/, ''));
    if (b) out.push(b);
  }
  return out.sort((a, b) => {
    const sa = Number(a.score?.total);
    const sb = Number(b.score?.total);
    const na = Number.isFinite(sa) ? sa : -1;
    const nb = Number.isFinite(sb) ? sb : -1;
    if (nb !== na) return nb - na;
    return String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
  });
}

/**
 * A brief the gates floored is not approvable. `needs-evidence` means a factual claim
 * could not be traced or a health-claim pattern fired; the fix is to supply evidence or
 * rewrite the line and REGENERATE, so the copy that renders is copy the gates have seen.
 * Letting a crafted request flip that state straight to `approved` would route unsourced
 * text to a paid render, which is the one thing this pipeline exists to prevent.
 */
export function decideBrief(root, product, briefId, { state, note } = {}) {
  if (!BRIEF_STATES.includes(state)) {
    throw new Error(`ad-brief: unknown state "${state}" — one of: ${BRIEF_STATES.join(', ')}`);
  }
  const current = readBrief(root, product, briefId);
  if (!current) throw new Error(`ad-brief: no such brief "${briefId}"`);
  if (current.state === 'needs-evidence' && state === 'approved') {
    throw new Error(
      `ad-brief: "${briefId}" is needs-evidence and cannot be approved — ` +
      `supply the missing evidence and regenerate, so the gates see the copy that renders`
    );
  }
  const next = { ...current, state, decidedAt: new Date().toISOString() };
  if (note !== undefined) next.note = note;
  return writeBrief(root, next);
}

export function listProductsWithBriefs(root) {
  const dir = join(root, 'data', 'briefs', 'ad-studio');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(name => {
    try { return statSync(join(dir, name)).isDirectory(); } catch { return false; }
  });
}
```

- [ ] **Step 4: Run it and watch it pass**

```bash
node --test tests/lib/ad-brief.test.js
```

Expected: PASS, 0 fail, **0 cancelled**.

- [ ] **Step 5: Add the gitignore entry**

`data/briefs/ad-studio/` holds generated output. Append to `.gitignore`, beside the other `data/` entries:

```
data/briefs/ad-studio/
```

Note `data/briefs/` itself is NOT ignored — it already holds committed content-brief JSON. Ignore only the `ad-studio/` subtree.

- [ ] **Step 6: Commit**

```bash
git add lib/ad-brief.js tests/lib/ad-brief.test.js .gitignore
git commit -m "feat(ad-brief): the brief store

Atomic writes because the dashboard reads these while the agent writes them.
State is a closed vocabulary, not a free string — only 'approved' renders.

A needs-evidence brief cannot be flipped to approved: that state means a
claim could not be traced or a health pattern fired, and the fix is to
supply evidence and regenerate so the gates see the copy that actually
renders. Allowing the flip would route unsourced text to a paid render.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: The brief generator agent

**Files:**
- Create: `agents/ad-brief/index.js`
- Create: `agents/ad-brief/README.md`
- Test: `tests/agents/ad-brief.test.js`

**Interfaces:**
- Consumes: `scoreBrief` (Task 1); `writeBrief`, `readBrief` (Task 2); from `agents/ad-studio/`: `FORMATS` (`formats.js`), `buildConcept`, `buildLabelStrings`, `fetchAdReviews` (`index.js`), `buildSourceIndex` (`claims.js`).
- Produces:
  - `AWARENESS_TO_FORMAT_AWARENESS: Record<string,string|null>`
  - `formatsForAngle(angle, formats) => { proposed: string|null, alternatives: string[] }`
  - `personaProjection(persona, angle) => { name: string, angles: string[] }`
  - `angleRelevance(angle, product) => boolean`
  - `buildBriefId(product, angleId, now) => string`
  - `parseArgs(argv) => { product, variant, angles, apply, root }`

**CLI:** `node agents/ad-brief/index.js --product <handle> [--variant <name>] [--angles p1a1,p5a3] [--dry-run]`

- [ ] **Step 1: Write the failing test**

Create `tests/agents/ad-brief.test.js`:

```js
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  AWARENESS_TO_FORMAT_AWARENESS, formatsForAngle, personaProjection, angleRelevance,
  buildBriefId, parseArgs,
} from '../../agents/ad-brief/index.js';
import { FORMATS } from '../../agents/ad-studio/formats.js';

// ── the awareness join ──────────────────────────────────────────────────────────────
//
// formats.js tags each format problem|solution|product; persona angles carry
// unaware|problem-aware|solution-aware|product-aware|most-aware. This is the join that
// lets a brief propose its own format instead of a rotation choosing for it.

test('a problem-aware angle proposes a problem-awareness format', () => {
  const { proposed, alternatives } = formatsForAngle({ awareness: 'problem-aware' }, FORMATS);
  const all = [proposed, ...alternatives];
  assert.ok(proposed, 'a problem-aware angle must get a format');
  for (const key of all) {
    assert.equal(FORMATS.find(f => f.key === key).awareness, 'problem');
  }
});

test('a solution-aware angle proposes a solution-awareness format', () => {
  const { proposed } = formatsForAngle({ awareness: 'solution-aware' }, FORMATS);
  assert.equal(FORMATS.find(f => f.key === proposed).awareness, 'solution');
});

test('a product-aware angle proposes a product-awareness format', () => {
  const { proposed } = formatsForAngle({ awareness: 'product-aware' }, FORMATS);
  assert.equal(FORMATS.find(f => f.key === proposed).awareness, 'product');
});

// THE KNOWN GAP, pinned so it is countable rather than inferred. No format covers
// `unaware` or `most-aware`, and by the headroom argument those are the most valuable
// angles we hold. When a format is finally built for either level, this test tells you.
test('unaware and most-aware angles have NO format and say so', () => {
  assert.equal(formatsForAngle({ awareness: 'unaware' }, FORMATS).proposed, null);
  assert.equal(formatsForAngle({ awareness: 'most-aware' }, FORMATS).proposed, null);
  assert.equal(AWARENESS_TO_FORMAT_AWARENESS['unaware'], null);
  assert.equal(AWARENESS_TO_FORMAT_AWARENESS['most-aware'], null);
});

test('the proposal is deterministic — the same angle always proposes the same format', () => {
  const a = formatsForAngle({ awareness: 'problem-aware' }, FORMATS);
  const b = formatsForAngle({ awareness: 'problem-aware' }, FORMATS);
  assert.deepEqual(a, b);
});

test('an unknown awareness value yields no format rather than throwing', () => {
  assert.equal(formatsForAngle({ awareness: 'banana' }, FORMATS).proposed, null);
  assert.equal(formatsForAngle({}, FORMATS).proposed, null);
});

// ── persona projection ──────────────────────────────────────────────────────────────
//
// copy.js's buildCopyPrompt wants { name, angles: [flat strings] }. Ad Studio passes ALL
// of a persona's angles, which tells the writer to address five things at once. A brief
// is ONE angle, and the projection is what makes the copy specific to it.

test('the projection carries exactly one angle, not the persona whole', () => {
  const persona = {
    name: 'The Ingredient-Label Reader',
    angles: [
      { id: 'p2a1', label: 'One ingredient', objection_addressed: 'is it really one thing?', proof: 'the label' },
      { id: 'p2a2', label: '125 chemicals a day', objection_addressed: 'x', proof: 'y' },
    ],
  };
  const p = personaProjection(persona, persona.angles[0]);
  assert.equal(p.name, 'The Ingredient-Label Reader');
  assert.equal(p.angles.length, 1);
  assert.match(p.angles[0], /One ingredient/);
  assert.ok(!p.angles[0].includes('125 chemicals'), 'must not leak the other angles');
});

test('the projection folds in the objection so the copy answers it', () => {
  const angle = { id: 'x', label: 'L', objection_addressed: "I've tried everything", proof: 'P' };
  const p = personaProjection({ name: 'N', angles: [angle] }, angle);
  assert.match(p.angles[0], /tried everything/);
});

test('the projection survives an angle missing its optional fields', () => {
  const angle = { id: 'x', label: 'Just a label' };
  const p = personaProjection({ name: 'N', angles: [angle] }, angle);
  assert.equal(typeof p.angles[0], 'string');
  assert.match(p.angles[0], /Just a label/);
});

// ── relevance ───────────────────────────────────────────────────────────────────────
//
// personas.json is cluster-scoped, so a lotion-specific angle would otherwise be briefed
// against bar soap and produce nonsense at one Opus call apiece.

test('a soap angle is relevant to soap and not to lotion', () => {
  const angle = { label: 'The bar you put out for guests', proof: 'a bar of soap by the sink' };
  assert.equal(angleRelevance(angle, { handle: 'coconut-soap', title: 'Coconut Bar Soap' }), true);
  assert.equal(angleRelevance(angle, { handle: 'coconut-lotion', title: 'Coconut Lotion' }), false);
});

test('an angle naming no product stays relevant to everything', () => {
  const angle = { label: 'After prescriptions failed', proof: 'reviewer with eczema' };
  assert.equal(angleRelevance(angle, { handle: 'coconut-lotion', title: 'Coconut Lotion' }), true);
  assert.equal(angleRelevance(angle, { handle: 'coconut-soap', title: 'Coconut Bar Soap' }), true);
});

// ── ids and args ────────────────────────────────────────────────────────────────────
test('a brief id is safe as a filename and carries product and angle', () => {
  const id = buildBriefId('coconut-lotion', 'p1a1', 1786000000000);
  assert.match(id, /^[\w.-]+$/);
  assert.match(id, /coconut-lotion/);
  assert.match(id, /p1a1/);
});

test('--product is required', () => {
  assert.throws(() => parseArgs([]), /--product/);
});

test('--angles is parsed as a list and defaults to empty (meaning all relevant)', () => {
  assert.deepEqual(parseArgs(['--product', 'coconut-lotion']).angles, []);
  assert.deepEqual(parseArgs(['--product', 'coconut-lotion', '--angles', 'p1a1, p5a3']).angles, ['p1a1', 'p5a3']);
});

test('--dry-run is off by default', () => {
  assert.equal(parseArgs(['--product', 'coconut-lotion']).dryRun, false);
  assert.equal(parseArgs(['--product', 'coconut-lotion', '--dry-run']).dryRun, true);
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
node --test tests/agents/ad-brief.test.js
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the agent**

Create `agents/ad-brief/index.js`. The pure helpers first, then `main()`:

```js
// agents/ad-brief/index.js
//
// Generates ad BRIEFS — one per persona angle — before any image is rendered.
//
//   node agents/ad-brief/index.js --product coconut-lotion [--variant coconut-breeze]
//                                [--angles p1a1,p5a3] [--dry-run]
//
// WHY THIS EXISTS. Ad Studio used to write copy and immediately spend ~$0.78 rendering
// it. The copy is the part that decides whether a concept was ever worth rendering, so
// judging it first is roughly a tenth of the cost of finding out from pixels.
//
// WHAT A BRIEF IS. The FINISHED, gate-passed copy for one persona angle, plus the
// evidence behind it and a score. Approving one renders those exact strings with no
// second LLM call — nothing drifts between what was read and what gets baked in.
//
// THE GATES ARE IMPORTED, NEVER REIMPLEMENTED. buildConcept (ad-studio) runs
// assertNoHealthClaims then assertClaimsSourced on every brief, the same modules in the
// same order Ad Studio uses. A second copy that drifts from the first would be the worst
// thing this agent could do.

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { FORMATS } from '../ad-studio/formats.js';
import { buildSourceIndex } from '../ad-studio/claims.js';
import { buildConcept, buildLabelStrings, fetchAdReviews } from '../ad-studio/index.js';
import { scoreBrief } from '../../lib/ad-brief-score.js';
import { writeBrief } from '../../lib/ad-brief.js';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * The awareness join.
 *
 * formats.js tags each format problem|solution|product. Persona angles carry the finer
 * five-level scale. `unaware` and `most-aware` map to NULL because no format covers them
 * — 4 of the 15 angles on file are unrenderable today, and by the headroom argument in
 * lib/ad-brief-score.js those are among the most valuable angles we hold. Null is
 * deliberate: mapping them to the nearest format would silently render a broad angle as
 * a narrow one and hide the gap. See the spec's "Known gap".
 */
export const AWARENESS_TO_FORMAT_AWARENESS = {
  'unaware': null,
  'problem-aware': 'problem',
  'solution-aware': 'solution',
  'product-aware': 'product',
  'most-aware': null,
};

/**
 * Which formats can carry this angle. `proposed` is the first match in FORMATS'
 * declaration order, which is curated rather than arbitrary; the rest are offered as
 * alternatives so the operator can override in one click.
 */
export function formatsForAngle(angle, formats = FORMATS) {
  const want = AWARENESS_TO_FORMAT_AWARENESS[angle?.awareness] ?? null;
  if (!want) return { proposed: null, alternatives: [] };
  const keys = formats.filter(f => f.awareness === want).map(f => f.key);
  return { proposed: keys[0] ?? null, alternatives: keys.slice(1) };
}

/**
 * copy.js's buildCopyPrompt wants { name, angles: [flat strings] } and renders them as
 * "WHAT THEY ALREADY TRIED". Ad Studio passes a persona's WHOLE angle list, which asks
 * the writer to address five things at once. A brief is one angle — this projection is
 * what makes the copy specific to it.
 */
export function personaProjection(persona, angle) {
  const parts = [angle?.label, angle?.objection_addressed, angle?.proof].filter(Boolean);
  return { name: persona?.name || '', angles: [parts.join(' — ')] };
}

const PRODUCT_WORDS = /\b(soap|bar|lotion|cream|deodorant|toothpaste|balm|wash)\b/gi;

/**
 * Is this angle about this product?
 *
 * personas.json is cluster-scoped, so without this a lotion-specific angle ("The first
 * lotion that didn't react") would be briefed against bar soap and produce nonsense — at
 * one Opus call apiece. An angle naming NO product word stays relevant to everything,
 * which is the common case and the safe default.
 */
export function angleRelevance(angle, product) {
  const text = `${angle?.label || ''} ${angle?.proof || ''} ${angle?.objection_addressed || ''}`;
  const named = [...new Set((text.match(PRODUCT_WORDS) || []).map(w => w.toLowerCase()))];
  if (!named.length) return true;
  const target = `${product?.handle || ''} ${product?.title || ''}`.toLowerCase();
  return named.some(w => target.includes(w));
}

export function buildBriefId(product, angleId, now = Date.now()) {
  return `${product}-${angleId}-${now}`;
}

export function parseArgs(argv) {
  const get = (name) => { const i = argv.indexOf(name); return i === -1 ? undefined : argv[i + 1]; };
  const product = get('--product');
  if (!product) throw new Error('ad-brief: --product is required, e.g. --product coconut-lotion');
  const anglesRaw = get('--angles');
  return {
    product,
    variant: get('--variant') || null,
    angles: anglesRaw ? anglesRaw.split(',').map(s => s.trim()).filter(Boolean) : [],
    dryRun: argv.includes('--dry-run'),
  };
}
```

Then `main()`, following `agents/ad-studio/index.js`'s existing loaders (`loadEnv`, `loadJson`, the manifest and catalog reads). It must:

1. Load `data/context/personas.json`. **If its `cluster` has no coverage for this product, abort naming the cluster** — never fall back to another cluster's personas, never invent one.
2. Load the product from `data/product-images/manifest.json` and `data/brand/product-catalog.json`, exactly as Ad Studio does, and build `labelStrings` via `buildLabelStrings`.
3. Fetch reviews via `fetchAdReviews(handle, { env })` and build `sourceIndex` via `buildSourceIndex({ pdpBody, brandKit, catalogEntry, reviews })`.
4. Load `data/reports/seo-impact/latest.json` if present; a missing file is fine and scores neutral.
5. Select angles: those named by `--angles`, else every angle passing `angleRelevance`.
6. For each selected angle, resolve the format via `formatsForAngle`. **An angle with no format is still recorded, and no copy call is made for it** — write the brief with `format.proposed: null`, `state: 'ready'`, `zones: null` and `score` computed as normal, so the gap is countable and the angle keeps its rank. Do NOT substitute the nearest format: that would render a broad angle as a narrow one and hide exactly the gap this is meant to surface. `state` stays `ready` because nothing failed — there is simply nowhere to render it yet; `needs-evidence` is reserved for gate failures and nothing else.
7. For angles that DO have a format: call `buildConcept({ anthropic, format, product, pdpBody, persona: personaProjection(persona, angle), sourceIndex, reviews })`. It returns `{ ok, zones, claims }` on success, or `{ ok: false, ... }` carrying gate violations.
8. Score via `scoreBrief` and persist via `writeBrief` with `state` = `ready` when `ok`, `needs-evidence` when a gate rejected it (storing the violations so the clarification loop can name the phrase and the source it searched).
9. Print a ranked summary. `--dry-run` prints what it WOULD generate — the angles, formats and estimated call count — and makes no Anthropic calls at all.

Guard the entry point exactly as Ad Studio does, so importing this module never runs it:

```js
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => { console.error(err.message); process.exit(1); });
}
```

- [ ] **Step 4: Run the unit tests and watch them pass**

```bash
node --test tests/agents/ad-brief.test.js
```

Expected: PASS, 0 fail, **0 cancelled**.

- [ ] **Step 5: Prove `--dry-run` costs nothing and the cluster guard fires**

```bash
node agents/ad-brief/index.js --product coconut-lotion --variant coconut-breeze --dry-run
node agents/ad-brief/index.js --product coconut-oil-toothpaste --dry-run
```

Expected: the first lists the relevant angles with their proposed formats and a call estimate, making no Anthropic calls. The second **aborts** naming the cluster and telling you to run `agents/voice-of-customer` for it — it must not silently use the skin personas.

- [ ] **Step 6: Write the README**

Create `agents/ad-brief/README.md` covering: what a brief is, the awareness join and the `unaware`/`most-aware` gap, why the gates are imported rather than reimplemented, the cluster-scoping abort, the scoring components with their weights and the reason the score never kills a brief, and the state vocabulary.

- [ ] **Step 7: Commit**

```bash
git add agents/ad-brief/ tests/agents/ad-brief.test.js
git commit -m "feat(ad-brief): generate scored briefs from persona angles

One brief per persona angle, carrying the finished gate-passed copy. The
awareness join lets a brief propose its own format instead of a rotation
choosing for it: formats.js tags problem|solution|product, angles carry the
five-level scale.

unaware and most-aware map to NULL on purpose — no format covers them, so 4
of 15 angles are unrenderable today, and mapping them to the nearest format
would render a broad angle as a narrow one and hide the gap.

personaProjection passes ONE angle, not the persona's whole list; Ad Studio
passes all five, which asks the writer to address five things at once.

A product outside the personas' cluster aborts naming the cluster. It never
falls back and never invents a persona — fabricated audience reasoning under
a claim-gated ad is the thing this pipeline exists to prevent.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Render an approved brief, and tag every artifact — DEADLINE-CRITICAL

**Files:**
- Modify: `agents/ad-studio/index.js` — `parseArgs`, `main()`, `finalizeRunReport`/`buildRunReport`
- Test: `tests/agents/ad-studio-brief-mode.test.js`

**Interfaces:**
- Consumes: `readBrief`, `decideBrief` (Task 2).
- Produces: `--brief <id>` on the Ad Studio CLI; `attribution` on every artifact row in `run.json` and every line of `scores.jsonl`.

**Why this is the deadline-critical task.** Attributes recorded at production time cannot be reconstructed afterwards. If a creative runs as a paid ad before it carries its persona, angle, awareness and format, that ad is unattributable forever — the difference between "ad B won" and "problem-aware, testimonial, persona 1 won".

- [ ] **Step 1: Write the failing test**

Create `tests/agents/ad-studio-brief-mode.test.js`:

```js
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseArgs, buildRunReport } from '../../agents/ad-studio/index.js';
import { writeBrief, readBrief } from '../../lib/ad-brief.js';

const freshRoot = () => mkdtempSync(join(tmpdir(), 'ad-studio-brief-'));

test('--brief is parsed and is absent by default', () => {
  assert.equal(parseArgs(['--product', 'coconut-lotion', '--formats', 'manifesto']).brief, null);
  assert.equal(parseArgs(['--brief', 'coconut-lotion-p1a1-123']).brief, 'coconut-lotion-p1a1-123');
});

// In brief mode the brief supplies the product AND the format, so demanding them again
// would make the operator restate what they already approved — and let the two disagree.
test('--brief mode does not require --product or --formats', () => {
  assert.doesNotThrow(() => parseArgs(['--brief', 'coconut-lotion-p1a1-123']));
});

test('a brief id with a path separator is refused at parse time', () => {
  assert.throws(() => parseArgs(['--brief', '../escape']), /brief/i);
});

// ── attribution ─────────────────────────────────────────────────────────────────────
//
// THE POINT OF THIS TASK. These fields cannot be reconstructed after an ad has run.

test('buildRunReport carries attribution onto every artifact row', () => {
  const attribution = {
    briefId: 'coconut-lotion-p1a1-123', personaId: 'p1', angleId: 'p1a1',
    awareness: 'problem-aware', format: 'problem-aware',
  };
  const report = buildRunReport({
    runId: 'r1',
    product: { handle: 'coconut-lotion', title: 'Lotion' },
    attribution,
    results: [{
      conceptSlug: 'problem-aware', format: 'problem-aware',
      variations: [{ n: 1, ok: true, artifacts: [{ artifact: 'meta-plate-1x1.png', ok: true, errored: false, score: 4 }] }],
    }],
    renders: 2,
  });
  assert.deepEqual(report.attribution, attribution);
  const row = report.results[0].variations[0].artifacts[0];
  assert.equal(row.attribution.angleId, 'p1a1', 'each artifact must carry its own attribution');
  assert.equal(row.attribution.awareness, 'problem-aware');
});

// A run launched the old way must still work and must say so, rather than carrying a
// half-filled attribution that looks like data.
test('a run with no brief reports attribution as null, not a stub', () => {
  const report = buildRunReport({
    runId: 'r1', product: { handle: 'coconut-lotion' },
    results: [{ conceptSlug: 'manifesto', format: 'manifesto', variations: [{ n: 1, ok: true, artifacts: [] }] }],
    renders: 0,
  });
  assert.equal(report.attribution, null);
});

test('an approved brief round-trips through the store for rendering', () => {
  const root = freshRoot();
  writeBrief(root, {
    briefId: 'coconut-lotion-p1a1-123', product: 'coconut-lotion', state: 'approved',
    zones: { headline: 'A real headline' }, claims: [],
    format: { proposed: 'problem-aware', chosen: null },
    persona: { id: 'p1' }, angle: { id: 'p1a1', awareness: 'problem-aware' },
  });
  const b = readBrief(root, 'coconut-lotion', 'coconut-lotion-p1a1-123');
  assert.equal(b.state, 'approved');
  assert.equal(b.zones.headline, 'A real headline');
});
```

Replace the `require` in the last test with a top-level `import { readBrief }` — the file is ESM.

- [ ] **Step 2: Run it and watch it fail**

```bash
node --test tests/agents/ad-studio-brief-mode.test.js
```

Expected: FAIL — `brief` is not on the parsed args.

- [ ] **Step 3: Add `--brief` to `parseArgs`**

In `agents/ad-studio/index.js`'s `parseArgs`, before the `--product` requirement:

```js
  // Brief mode. The brief carries the product, the format and the finished copy, so
  // --product and --formats are not required (and must not be, or the two could disagree
  // with what was approved).
  const brief = getFlag('--brief') || null;
  if (brief !== null && !isValidBriefId(brief)) {
    throw new Error(`ad-studio: invalid --brief "${brief}" — letters, digits, dot, dash and underscore only`);
  }
```

Make the `--product` and `--formats` requirements conditional on `brief === null`, and add `brief` to the returned object. Import `isValidBriefId` and `readBrief` from `../../lib/ad-brief.js`.

- [ ] **Step 4: Add attribution to the run report**

In `buildRunReport`, accept `attribution = null` and: set it on the report, and set the same object on every artifact row it builds. Both are needed — the report-level copy is what a human reads, the per-artifact copy is what `scores.jsonl` rows and any future per-creative join need.

In `finalizeRunReport`, write `attribution` onto each `scores.jsonl` line alongside the existing run id, product, format, variation, artifact and score fields.

- [ ] **Step 5: Wire brief mode into `main()`**

When `args.brief` is set, `main()` must:

1. Read the brief (its product is embedded in the id's prefix — read it by scanning `listProductsWithBriefs` for the one holding this id, so a malformed id cannot address an arbitrary path).
2. **Refuse anything not in state `approved`**, naming the actual state. A `ready` brief has not been approved by a human; a `needs-evidence` one failed a gate.
3. Skip concept generation entirely — no `buildConcepts`, no copy call. Build the single concept from the brief's stored `zones` and `claims`, and the format from `format.chosen ?? format.proposed`.
4. Refuse a brief whose format is null, naming the awareness level that has no format.
5. Build `attribution` from the brief and thread it into `finalizeRunReport`.
6. On success, `decideBrief(..., { state: 'rendered' })` and append the run id to the brief's `renderedRunIds`.

- [ ] **Step 6: Run the tests**

```bash
node --test tests/agents/ad-studio-brief-mode.test.js 'tests/agents/ad-studio-*.test.js'
```

Expected: PASS, 0 fail, **0 cancelled**. The existing Ad Studio suite must be untouched — the old `--product --formats` path behaves exactly as before.

- [ ] **Step 7: Commit**

```bash
git add agents/ad-studio/index.js tests/agents/ad-studio-brief-mode.test.js
git commit -m "feat(ad-studio): render an approved brief, and tag every artifact

--brief <id> renders a brief's stored copy verbatim — no copy call, so
nothing drifts between what was approved and what is baked in. Only state
'approved' renders; ready and needs-evidence are refused by name.

Every artifact now carries attribution: brief id, persona, angle, awareness
and format, in run.json and in scores.jsonl. This is the deadline-critical
half — attributes recorded at production time cannot be reconstructed, so a
creative that runs as an ad without them is unattributable forever. It is
the difference between 'ad B won' and 'problem-aware, testimonial, persona
1 won'.

A run with no brief reports attribution as null rather than a half-filled
stub that would look like data.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: The brief routes

**Files:**
- Create: `agents/dashboard/routes/ad-brief.js`
- Modify: `agents/dashboard/index.js` — register the route module
- Test: `tests/dashboard/ad-brief-routes.test.js`

**Interfaces:**
- Consumes: `listBriefs`, `readBrief`, `decideBrief`, `listProductsWithBriefs`, `isValidBriefId`, `BRIEF_STATES` (Task 2); `findActiveJob`, `writeJob` (`lib/ad-studio-job.js`); `validateLaunch`-style discipline from `routes/ad-studio-launch.js`.
- Produces: four routes.

| Method | URL | Behaviour |
|---|---|---|
| GET | `/api/ad-brief/products` | products with briefs, plus the manifest products briefs can be generated for |
| GET | `/api/ad-brief/list?product=<handle>` | ranked briefs for a product |
| POST | `/api/ad-brief/generate` | spawn `agents/ad-brief/index.js` detached with a job id, same pattern as the Ad Studio launch route |
| POST | `/api/ad-brief/decide` | `{ product, briefId, state, note }` → `decideBrief` |

**Reuse, do not reinvent:** generation is a long job that outlives a request, so it uses the SAME job-file mechanism as Ad Studio (`lib/ad-studio-job.js`), including one-run-at-a-time and the detached spawn. Copy the security discipline from `routes/ad-studio-launch.js` verbatim in shape: validate every segment before it reaches the filesystem, return fixed error strings, never echo an exception message, wrap the handler body in try/catch so a throw cannot become an unhandled rejection that kills the shared dashboard process.

- [ ] **Step 1: Write the failing test**

Create `tests/dashboard/ad-brief-routes.test.js` testing the pure validator the module exports:

```js
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { validateDecide, validateGenerate } from '../../agents/dashboard/routes/ad-brief.js';

const PRODUCTS = [{ handle: 'coconut-lotion' }, { handle: 'coconut-soap' }];

test('a well-formed decision is accepted', () => {
  const r = validateDecide({ product: 'coconut-lotion', briefId: 'coconut-lotion-p1a1-1', state: 'approved' }, { products: PRODUCTS });
  assert.equal(r.ok, true);
});

test('an unknown state is refused', () => {
  assert.equal(validateDecide({ product: 'coconut-lotion', briefId: 'b1', state: 'shipped' }, { products: PRODUCTS }).ok, false);
});

test('a traversal product or brief id is refused', () => {
  assert.equal(validateDecide({ product: '../etc', briefId: 'b1', state: 'approved' }, { products: PRODUCTS }).ok, false);
  assert.equal(validateDecide({ product: 'coconut-lotion', briefId: '../../x', state: 'approved' }, { products: PRODUCTS }).ok, false);
});

test('an unknown product is refused', () => {
  assert.equal(validateDecide({ product: 'not-a-product', briefId: 'b1', state: 'approved' }, { products: PRODUCTS }).ok, false);
});

test('generate requires a known product', () => {
  assert.equal(validateGenerate({ product: 'coconut-lotion' }, { products: PRODUCTS }).ok, true);
  assert.equal(validateGenerate({ product: 'nope' }, { products: PRODUCTS }).ok, false);
  assert.equal(validateGenerate({}, { products: PRODUCTS }).ok, false);
});

test('generate normalises an angle list and refuses a malformed one', () => {
  assert.deepEqual(validateGenerate({ product: 'coconut-lotion', angles: ['p1a1', ' p5a3 '] }, { products: PRODUCTS }).args.angles, ['p1a1', 'p5a3']);
  assert.equal(validateGenerate({ product: 'coconut-lotion', angles: ['../x'] }, { products: PRODUCTS }).ok, false);
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
node --test tests/dashboard/ad-brief-routes.test.js
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the routes**, following `agents/dashboard/routes/ad-studio-launch.js` for shape, and exporting `validateDecide` and `validateGenerate` as pure functions.

- [ ] **Step 4: Register them** in `agents/dashboard/index.js` beside `adStudioLaunchRoutes`.

- [ ] **Step 5: Run the tests, then exercise the read routes live**

```bash
node --test tests/dashboard/ad-brief-routes.test.js
node agents/dashboard/index.js &
sleep 3
curl -s localhost:4242/api/ad-brief/products | head -c 300
curl -s 'localhost:4242/api/ad-brief/list?product=coconut-lotion' | head -c 300
```

Kill the dashboard afterwards. Do not POST `/generate` here — Task 7 does that with real spend.

- [ ] **Step 6: Commit**

```bash
git add agents/dashboard/routes/ad-brief.js agents/dashboard/index.js tests/dashboard/ad-brief-routes.test.js
git commit -m "feat(dashboard): brief list, generate and decide routes

Generation reuses the Ad Studio job mechanism rather than inventing a
second one — same detached spawn, same one-at-a-time guard, same job file.

Security discipline copied in shape from the launch route: every segment
validated before it reaches the filesystem, fixed error strings, no
exception text in a response, and the handler body wrapped so a throw
cannot become an unhandled rejection that kills the shared process.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: The Briefs view

**Files:**
- Modify: `agents/dashboard/public/index.html` — a third view button beside New run and Judge, and the Briefs panel
- Modify: `agents/dashboard/public/js/dashboard.js`
- Test: extend `tests/agents/dashboard-ad-studio-setup.test.js`

**Interfaces:**
- Consumes: the four routes from Task 5.
- Produces: `switchAdStudioView('briefs')`, `loadBriefs()`, `renderBriefs()`, `briefDecide(briefId, state)`, `briefGenerate()`.

What the view shows per brief, ranked highest score first: the score **with its four components broken out** (a total alone is a black box), the persona and angle label, the awareness level, the proposed format with a dropdown of alternatives, the finished copy zone by zone, and every claim with the source it was traced to. `needs-evidence` briefs show the phrase that failed and which source was searched. A brief whose format is null shows "no format covers this awareness level" and cannot be approved for render.

Actions: **Approve**, **Reject**, **Render** (approved only), and **Generate briefs** for the selected product.

- [ ] **Step 1: Extend the parity tests**

The existing `tests/agents/dashboard-ad-studio-setup.test.js` already asserts that every `getElementById` the Ad Studio JS references exists in `index.html`, and that every function invoked from an inline handler is defined. **Both must now cover the Briefs code too** — they are the only guard against a dead reference, and this exact class of bug shipped once already in this feature area. Verify by temporarily breaking one id and one handler name and confirming each test fails.

- [ ] **Step 2: Add the markup and the browser logic**, following the Ad Studio New-run panel already in those files for style and escaping. Every interpolation of brief text into `innerHTML` goes through the existing `adStudioEsc()` — brief copy is model-generated and must never be trusted into the DOM raw.

- [ ] **Step 3: Run the full suite**

```bash
node --test 'tests/**/*.test.js' 2>&1 | tail -20
```

Expected: 0 fail, **0 cancelled**.

- [ ] **Step 4: Commit**

```bash
git add agents/dashboard/public/index.html agents/dashboard/public/js/dashboard.js tests/agents/dashboard-ad-studio-setup.test.js
git commit -m "feat(dashboard): the Briefs view

Ranked briefs with the score broken into its four components — a total
alone is a black box, and with no outcome data behind it that is exactly
what this must not be.

Shows the finished copy and every claim's traced source, so approving is a
decision about text the operator has actually read. needs-evidence briefs
name the phrase that failed and the source searched. An angle with no
format says so and cannot be rendered.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Ship it, and produce the ads

The task that meets the deadline. Real spend, approved.

- [ ] **Step 1: Open the PR and merge**, following the repo's rules — `gh pr create`, merge via PR, never push to `main`.

- [ ] **Step 2: Deploy**

```bash
ssh root@137.184.119.230 'cd ~/seo-claude && git pull && pm2 restart seo-dashboard'
ssh root@137.184.119.230 'pm2 status | grep seo-dashboard'
```

- [ ] **Step 3: Free dry run on the server, both products**

```bash
ssh root@137.184.119.230 'cd ~/seo-claude && node agents/ad-brief/index.js --product coconut-lotion --dry-run && node agents/ad-brief/index.js --product coconut-soap --dry-run'
```

Expected: each lists its relevant angles, the proposed format per angle, the count of angles with no format, and an estimated call count. No Anthropic calls.

- [ ] **Step 4: Generate briefs for both products**

Roughly one Opus copy call per relevant angle — expect ~10-15 per product. Then read the ranked output and confirm: every brief carries finished copy, every factual claim names a source, `needs-evidence` briefs name their failing phrase, and `unaware`/`most-aware` angles are recorded with a null format rather than silently dropped.

- [ ] **Step 5: Approve and render**

Approve the top-scoring brief for each product in the dashboard, then render each — 6 renders ≈ $0.78 apiece.

Verify on the server that `run.json` carries `attribution` with the brief id, persona, angle and awareness, that each artifact row carries it too, and that `scores.jsonl` lines do. **This is the check that matters most: an ad that runs without it is unattributable forever.**

- [ ] **Step 6: Confirm the disk and the budget**

```bash
ssh root@137.184.119.230 'cd ~/seo-claude && du -sh data/creatives && df -h / | tail -1 && node scripts/creatives-budget.mjs | head -4'
```

Expected: comfortably inside the 4 GiB ceiling.

- [ ] **Step 7: Clean up the worktree** once the PR has merged, confirming nothing unarchived is lost first.

---

## Self-review against the spec

| Spec section | Task |
|---|---|
| The artifact — fields, path, state vocabulary | 2 |
| Generation — on demand, awareness join, Opus, cluster abort | 3 |
| Which angles apply to a product | 3 (`angleRelevance`) |
| Scoring — rank plus hard floor, four components, weights | 1, 3 |
| Headroom weighting | 1 |
| The clarification loop — `needs-evidence` naming the phrase | 3, 6 |
| Approve → render, `--brief`, variations meaning | 4 |
| Tagging for the future feedback loop | 4 |
| The dashboard Briefs view | 5, 6 |
| The `unaware`/`most-aware` format gap made countable | 3 (pinned by test), 6 (displayed) |
| Out of scope: building the missing formats, scheduling, Meta upload | not implemented anywhere — correct |

**Known plan risk, stated rather than hidden:** Task 3's `main()` is described in prose steps rather than given as complete code, because it follows `agents/ad-studio/index.js`'s existing loader sequence closely and transcribing 200 lines of that here would drift from the original the moment either changes. Its pure helpers — the parts with real logic — are given verbatim with tests. The implementer must read Ad Studio's `main()` before writing it.

**Deliberate ordering:** Tasks 1-4 deliver a working CLI pipeline. If the two-day deadline bites, stop after Task 4 and Task 7's steps 3-5, driving briefs from the command line; Tasks 5-6 are the operator's convenience, not the capability.
