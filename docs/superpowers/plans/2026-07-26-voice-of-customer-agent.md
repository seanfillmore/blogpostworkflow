# Voice-of-Customer Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an agent that mines Judge.me reviews plus Reddit/SERP friction into three durable context artifacts consumed by `blog-post-writer`, `pdp-builder`, and `creative-packager`.

**Architecture:** One agent (`agents/voice-of-customer/index.js`) with two phases — `--collect` caches a normalized corpus to disk, `--analyze` runs a single Claude call over it and writes the artifacts. All pure logic (normalization, dedup, cluster filtering, validation, markdown rendering) lives in `lib/voice-of-customer.js` so it is unit-testable without network or LLM, following the `lib/seo-opportunities.js` precedent.

**Tech Stack:** Node ESM, `node:test` + `node:assert/strict`, existing `lib/judgeme.js` / `lib/tavily.js` / `lib/dataforseo.js` / `lib/anthropic.js` / `lib/notify.js`.

**Spec:** `docs/superpowers/specs/2026-07-26-voice-of-customer-agent-design.md`

## Global Constraints

- **Branch:** all work on `feature/voice-of-customer-agent`. Never commit to `main`. Merge via `gh pr create`.
- **Model:** `claude-opus-5`. Import the client from `../../lib/anthropic.js` (never `@anthropic-ai/sdk` directly) — that wrapper meters token spend into `lib/llm-usage.js`.
- **Use `client.messages.create()`, not `.stream()`** — the wrapper does not meter streaming.
- **Thinking is on by default on Claude Opus 5** and `max_tokens` caps thinking + output *together*. Use `max_tokens: 16000` and treat `stop_reason === 'max_tokens'` as fatal.
- **No `temperature`, `top_p`, `top_k`, or `budget_tokens`** — all return 400 on Claude Opus 5.
- **Skin cluster handle list** (exact, hardcoded): `coconut-lotion`, `body-lotion-1`, `coconut-moisturizer`, `coconut-soap`, `organic-foaming-hand-soap`.
- **Cadence:** monthly, on the 1st, inside the existing `if (new Date().getDate() === 1)` block in `scheduler.js`.
- **No dashboard UI, no approval gate.** The agent writes artifacts directly.
- **Test runner:** `npm test` runs `node --test 'tests/**/*.test.js'`. Run single files with `node --test tests/lib/voice-of-customer.test.js`.
- **Env vars** (already in `.env`): `JUDGEME_API_TOKEN`, `TAVILY_API_KEY`, `ANTHROPIC_API_KEY`, DataForSEO creds read inside `lib/dataforseo.js`. Judge.me shop domain is `realskincare-com.myshopify.com`.

---

## File Structure

| File | Responsibility |
|---|---|
| `lib/voice-of-customer.js` (create) | Pure brain: source normalization, dedup, cluster filter, prompt assembly, output validation, markdown rendering. No I/O, no network. |
| `lib/judgeme.js` (modify) | Add `fetchAllReviews()` — paginating fetcher that returns review **bodies**. The two existing fetchers can't: `fetchAllReviewStats` discards bodies, `fetchRecentReviews` reads only page 1. |
| `agents/voice-of-customer/index.js` (create) | Orchestration: CLI flags, network calls, file writes, `notify()`. |
| `tests/lib/voice-of-customer.test.js` (create) | Unit tests for the pure brain. |
| `tests/agents/voice-of-customer.test.js` (create) | Smoke test with a stubbed LLM client. |
| `agents/blog-post-writer/index.js` (modify) | `loadVoiceOfCustomer()` beside `loadAgentFeedback()`. |
| `agents/pdp-builder/lib/load-foundation.js` (modify) | Add VOC as an **optional** foundation file. |
| `agents/creative-packager/index.js` (modify) | Persona/angle-aware `buildCopyBrief` + `buildCopyPrompt`. |
| `tests/agents/creative-packager.test.js` (modify) | Cover both persona paths. |
| `scheduler.js` (modify) | Monthly entry. |

**Artifacts written at runtime** (not created by this plan): `data/context/voice-of-customer.md`, `data/context/personas.md`, `data/context/personas.json`, `data/reports/voice-of-customer/corpus-YYYY-MM-DD.json`, `data/reports/voice-of-customer/latest.json`.

---

## Task 1: Pure brain — normalization, dedup, cluster filter

**Files:**
- Create: `lib/voice-of-customer.js`
- Create: `tests/lib/voice-of-customer.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `SKIN_CLUSTER_HANDLES: string[]`
  - `normalizeJudgemeReview(r) -> Record`
  - `normalizeTavilyResult(r) -> Record`
  - `normalizeSerpItem(item) -> Record`
  - `dedupeRecords(records: Record[]) -> Record[]`
  - `filterSkinCluster(records: Record[]) -> Record[]`
  - A `Record` is `{ source: 'judgeme'|'reddit'|'serp', id: string, url: string|null, handle: string|null, rating: number|null, text: string }`.

- [ ] **Step 1: Write the failing test**

Create `tests/lib/voice-of-customer.test.js`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SKIN_CLUSTER_HANDLES,
  normalizeJudgemeReview,
  normalizeTavilyResult,
  normalizeSerpItem,
  dedupeRecords,
  filterSkinCluster,
} from '../../lib/voice-of-customer.js';

// ── cluster definition ──────────────────────────────────────────────────────
test('SKIN_CLUSTER_HANDLES is the exact five-handle list', () => {
  assert.deepEqual([...SKIN_CLUSTER_HANDLES].sort(), [
    'body-lotion-1',
    'coconut-lotion',
    'coconut-moisturizer',
    'coconut-soap',
    'organic-foaming-hand-soap',
  ]);
});

// ── normalization ───────────────────────────────────────────────────────────
test('normalizeJudgemeReview maps a Judge.me review onto the record shape', () => {
  const rec = normalizeJudgemeReview({
    id: 991,
    product_handle: 'coconut-lotion',
    rating: 5,
    body: '  Cleared up my eczema in a week.  ',
  });
  assert.equal(rec.source, 'judgeme');
  assert.equal(rec.id, 'judgeme:991');
  assert.equal(rec.handle, 'coconut-lotion');
  assert.equal(rec.rating, 5);
  assert.equal(rec.text, 'Cleared up my eczema in a week.');
  assert.equal(rec.url, null);
});

test('normalizeTavilyResult keys on the URL and joins title + content', () => {
  const rec = normalizeTavilyResult({
    url: 'https://reddit.com/r/SkincareAddiction/comments/abc/',
    title: 'Does coconut oil clog pores?',
    content: 'It broke me out badly.',
  });
  assert.equal(rec.source, 'reddit');
  assert.equal(rec.url, 'https://reddit.com/r/SkincareAddiction/comments/abc/');
  assert.match(rec.text, /Does coconut oil clog pores\?/);
  assert.match(rec.text, /broke me out badly/);
  assert.equal(rec.handle, null);
  assert.equal(rec.rating, null);
});

test('normalizeSerpItem maps a DataForSEO organic item', () => {
  const rec = normalizeSerpItem({
    url: 'https://example.com/coconut-oil-review',
    title: 'Coconut Oil Lotion Review',
    description: 'Greasy and slow to absorb.',
  });
  assert.equal(rec.source, 'serp');
  assert.equal(rec.url, 'https://example.com/coconut-oil-review');
  assert.match(rec.text, /Greasy and slow to absorb/);
});

// ── dedup ───────────────────────────────────────────────────────────────────
test('dedupeRecords collapses the same URL arriving via Tavily and SERP', () => {
  const shared = 'https://reddit.com/r/SkincareAddiction/comments/abc/';
  const out = dedupeRecords([
    normalizeTavilyResult({ url: shared, title: 'T', content: 'body' }),
    normalizeSerpItem({ url: shared, title: 'T', description: 'body' }),
  ]);
  assert.equal(out.length, 1);
});

test('dedupeRecords ignores a trailing slash and querystring when comparing URLs', () => {
  const out = dedupeRecords([
    normalizeTavilyResult({ url: 'https://reddit.com/r/x/abc/', title: 'T', content: 'b' }),
    normalizeSerpItem({ url: 'https://reddit.com/r/x/abc?utm_source=g', title: 'T', description: 'b' }),
  ]);
  assert.equal(out.length, 1);
});

test('dedupeRecords keeps distinct Judge.me reviews that have no URL', () => {
  const out = dedupeRecords([
    normalizeJudgemeReview({ id: 1, product_handle: 'coconut-lotion', rating: 5, body: 'a' }),
    normalizeJudgemeReview({ id: 2, product_handle: 'coconut-lotion', rating: 4, body: 'b' }),
  ]);
  assert.equal(out.length, 2);
});

// ── cluster filter ──────────────────────────────────────────────────────────
test('filterSkinCluster keeps skin handles and drops other clusters', () => {
  const out = filterSkinCluster([
    normalizeJudgemeReview({ id: 1, product_handle: 'coconut-lotion', rating: 5, body: 'a' }),
    normalizeJudgemeReview({ id: 2, product_handle: 'coconut-oil-toothpaste', rating: 4, body: 'b' }),
    normalizeJudgemeReview({ id: 3, product_handle: 'coconut-breeze', rating: 5, body: 'c' }),
  ]);
  assert.deepEqual(out.map((r) => r.handle), ['coconut-lotion']);
});

test('filterSkinCluster keeps handle-less external records', () => {
  const out = filterSkinCluster([
    normalizeTavilyResult({ url: 'https://reddit.com/r/x/1', title: 'T', content: 'b' }),
  ]);
  assert.equal(out.length, 1);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/lib/voice-of-customer.test.js`
Expected: FAIL — `Cannot find module '.../lib/voice-of-customer.js'`

- [ ] **Step 3: Write the implementation**

Create `lib/voice-of-customer.js`:

```javascript
// lib/voice-of-customer.js
//
// Pure brain for the voice-of-customer agent. No network, no filesystem, no
// LLM — everything here is deterministic and unit-tested so the agent shell
// stays thin. Mirrors the lib/seo-opportunities.js split.

/**
 * The skin cluster, as an explicit handle list rather than a keyword match.
 * A keyword match on "lotion"/"soap" would silently pull in or drop products
 * as the catalog changes; this list is asserted in tests.
 *
 * organic-foaming-hand-soap is deliberately included: it is a skin-contact
 * wash-off product whose reviewers share the sensitive-skin and
 * ingredient-scrutiny concerns of the lotion buyers.
 */
export const SKIN_CLUSTER_HANDLES = [
  'coconut-lotion',
  'body-lotion-1',
  'coconut-moisturizer',
  'coconut-soap',
  'organic-foaming-hand-soap',
];

const SKIN_SET = new Set(SKIN_CLUSTER_HANDLES);

/** Strip querystring + trailing slash so the same page from two sources matches. */
function canonicalUrl(url) {
  if (!url) return null;
  const withoutQuery = String(url).split(/[?#]/)[0];
  return withoutQuery.replace(/\/+$/, '').toLowerCase();
}

export function normalizeJudgemeReview(r) {
  return {
    source: 'judgeme',
    id: `judgeme:${r.id}`,
    url: null,
    handle: r.product_handle || null,
    rating: typeof r.rating === 'number' ? r.rating : null,
    text: String(r.body || '').trim(),
  };
}

export function normalizeTavilyResult(r) {
  const title = String(r.title || '').trim();
  const content = String(r.content || '').trim();
  return {
    source: 'reddit',
    id: `reddit:${canonicalUrl(r.url)}`,
    url: r.url || null,
    handle: null,
    rating: null,
    text: [title, content].filter(Boolean).join(' — '),
  };
}

export function normalizeSerpItem(item) {
  const title = String(item.title || '').trim();
  const description = String(item.description || item.snippet || '').trim();
  return {
    source: 'serp',
    id: `serp:${canonicalUrl(item.url)}`,
    url: item.url || null,
    handle: null,
    rating: null,
    text: [title, description].filter(Boolean).join(' — '),
  };
}

/**
 * Collapse records that point at the same page. Judge.me reviews have no URL
 * and are keyed by their own id, so they never collapse into each other.
 */
export function dedupeRecords(records) {
  const seen = new Set();
  const out = [];
  for (const rec of records) {
    const key = rec.url ? `url:${canonicalUrl(rec.url)}` : rec.id;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(rec);
  }
  return out;
}

/**
 * Keep only skin-cluster material. Records with no handle are external
 * (Reddit/SERP) and are already scoped by the queries that fetched them.
 */
export function filterSkinCluster(records) {
  return records.filter((r) => r.handle === null || SKIN_SET.has(r.handle));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/lib/voice-of-customer.test.js`
Expected: PASS — 9 tests

- [ ] **Step 5: Commit**

```bash
git add lib/voice-of-customer.js tests/lib/voice-of-customer.test.js
git commit -m "feat(voc): corpus normalization, dedup and skin-cluster filter

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Output validation and markdown rendering

**Files:**
- Modify: `lib/voice-of-customer.js`
- Modify: `tests/lib/voice-of-customer.test.js`

**Interfaces:**
- Consumes: nothing from Task 1 at runtime (same file, separate exports).
- Produces:
  - `AWARENESS_LEVELS: string[]`
  - `validateAnalysis(obj) -> { ok: boolean, errors: string[] }`
  - `rankPersonas(personas) -> personas[]` (sorted, highest first)
  - `renderPersonasMarkdown(analysis) -> string`
  - `renderVoiceOfCustomerMarkdown(analysis, { partial }) -> string`
- The `analysis` object is the LLM's output: `{ personas: [...], objections: [...], golden_nugget_phrases: [...], trigger_points: [...], not_for: [...] }`. Each of the four non-persona arrays holds `{ text, evidence_count, quote }`. Persona shape is in the spec.

- [ ] **Step 1: Write the failing test**

Append to `tests/lib/voice-of-customer.test.js`:

```javascript
import {
  AWARENESS_LEVELS,
  validateAnalysis,
  rankPersonas,
  renderPersonasMarkdown,
  renderVoiceOfCustomerMarkdown,
} from '../../lib/voice-of-customer.js';

function validAngle(overrides = {}) {
  return {
    id: 'steroid-cream-off-ramp',
    label: 'The steroid-cream off-ramp',
    awareness: 'problem-aware',
    objection_addressed: 'Will a natural lotion actually do anything?',
    proof: '97 reviews at 4.91 stars',
    hook_examples: ['Off the steroid cream in three weeks'],
    source_quotes: ['I finally stopped using hydrocortisone.'],
    ...overrides,
  };
}

function validPersona(overrides = {}) {
  return {
    id: 'eczema-flare-parent',
    name: 'The eczema flare parent',
    summary: 'Buys for a child whose skin reacts to everything.',
    evidence_count: 23,
    emotional_intensity: 8.4,
    angles: [validAngle()],
    ...overrides,
  };
}

function validAnalysis(overrides = {}) {
  return {
    personas: [validPersona()],
    objections: [{ text: 'Worried it will feel greasy', evidence_count: 12, quote: 'Too greasy for me.' }],
    golden_nugget_phrases: [{ text: 'like butter for your skin', evidence_count: 3, quote: 'It is like butter for your skin.' }],
    trigger_points: [{ text: 'A winter flare-up', evidence_count: 7, quote: 'My hands cracked in January.' }],
    not_for: [{ text: 'People who want a fragrance-free gel', evidence_count: 4, quote: 'I wanted a gel, not a balm.' }],
    ...overrides,
  };
}

// ── validation ──────────────────────────────────────────────────────────────
test('validateAnalysis accepts a well-formed analysis', () => {
  const res = validateAnalysis(validAnalysis());
  assert.equal(res.ok, true, res.errors.join('; '));
  assert.deepEqual(res.errors, []);
});

test('validateAnalysis rejects a persona with zero angles', () => {
  const res = validateAnalysis(validAnalysis({ personas: [validPersona({ angles: [] })] }));
  assert.equal(res.ok, false);
  assert.match(res.errors.join(' '), /at least one angle/i);
});

test('validateAnalysis rejects an angle with no source_quotes', () => {
  const persona = validPersona({ angles: [validAngle({ source_quotes: [] })] });
  const res = validateAnalysis(validAnalysis({ personas: [persona] }));
  assert.equal(res.ok, false);
  assert.match(res.errors.join(' '), /source_quotes/);
});

test('validateAnalysis rejects an awareness value outside the allowed set', () => {
  const persona = validPersona({ angles: [validAngle({ awareness: 'vaguely-curious' })] });
  const res = validateAnalysis(validAnalysis({ personas: [persona] }));
  assert.equal(res.ok, false);
  assert.match(res.errors.join(' '), /awareness/);
  assert.ok(AWARENESS_LEVELS.includes('problem-aware'));
});

test('validateAnalysis rejects an analysis with no personas', () => {
  const res = validateAnalysis(validAnalysis({ personas: [] }));
  assert.equal(res.ok, false);
});

test('validateAnalysis rejects a voice-of-customer entry with no quote', () => {
  const res = validateAnalysis(validAnalysis({
    objections: [{ text: 'Too greasy', evidence_count: 2, quote: '' }],
  }));
  assert.equal(res.ok, false);
  assert.match(res.errors.join(' '), /quote/);
});

// ── ranking ─────────────────────────────────────────────────────────────────
test('rankPersonas orders by evidence_count x emotional_intensity, highest first', () => {
  const low = validPersona({ id: 'low', evidence_count: 40, emotional_intensity: 2 });   // 80
  const high = validPersona({ id: 'high', evidence_count: 12, emotional_intensity: 9 }); // 108
  assert.deepEqual(rankPersonas([low, high]).map((p) => p.id), ['high', 'low']);
});

test('rankPersonas does not mutate its input', () => {
  const input = [
    validPersona({ id: 'a', evidence_count: 1, emotional_intensity: 1 }),
    validPersona({ id: 'b', evidence_count: 10, emotional_intensity: 10 }),
  ];
  rankPersonas(input);
  assert.deepEqual(input.map((p) => p.id), ['a', 'b']);
});

// ── rendering ───────────────────────────────────────────────────────────────
test('renderVoiceOfCustomerMarkdown emits the five stable headings', () => {
  const md = renderVoiceOfCustomerMarkdown(validAnalysis(), { partial: false });
  for (const heading of [
    '## Objections',
    '## Golden-nugget phrases',
    '## Trigger points',
    "## Who we're not for",
    '## Source notes',
  ]) {
    assert.ok(md.includes(heading), `missing ${heading}`);
  }
});

test('renderVoiceOfCustomerMarkdown flags a partial corpus in Source notes', () => {
  const md = renderVoiceOfCustomerMarkdown(validAnalysis(), { partial: true });
  assert.match(md, /generated without external friction data/);
});

test('renderVoiceOfCustomerMarkdown puts evidence count and quote on every entry', () => {
  const md = renderVoiceOfCustomerMarkdown(validAnalysis(), { partial: false });
  assert.match(md, /Worried it will feel greasy/);
  assert.match(md, /12 mentions/);
  assert.match(md, /Too greasy for me\./);
});

test('renderPersonasMarkdown lists personas in rank order with their angles', () => {
  const analysis = validAnalysis({
    personas: [
      validPersona({ id: 'low', name: 'Low persona', evidence_count: 1, emotional_intensity: 1 }),
      validPersona({ id: 'high', name: 'High persona', evidence_count: 50, emotional_intensity: 9 }),
    ],
  });
  const md = renderPersonasMarkdown(analysis);
  assert.ok(md.indexOf('High persona') < md.indexOf('Low persona'));
  assert.match(md, /problem-aware/);
  assert.match(md, /steroid-cream-off-ramp/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/lib/voice-of-customer.test.js`
Expected: FAIL — `SyntaxError: The requested module '../../lib/voice-of-customer.js' does not provide an export named 'AWARENESS_LEVELS'`

- [ ] **Step 3: Write the implementation**

Append to `lib/voice-of-customer.js`:

```javascript
// ── analysis validation ──────────────────────────────────────────────────────

export const AWARENESS_LEVELS = [
  'unaware',
  'problem-aware',
  'solution-aware',
  'product-aware',
  'most-aware',
];

const VOC_SECTIONS = [
  { key: 'objections', heading: '## Objections' },
  { key: 'golden_nugget_phrases', heading: '## Golden-nugget phrases' },
  { key: 'trigger_points', heading: '## Trigger points' },
  { key: 'not_for', heading: "## Who we're not for" },
];

/**
 * Semantic validation of the LLM's output. The API-level JSON schema already
 * guarantees the shape; this catches what a JSON schema cannot express here —
 * non-empty angle and quote arrays, and the awareness enum.
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateAnalysis(obj) {
  const errors = [];

  if (!obj || typeof obj !== 'object') {
    return { ok: false, errors: ['analysis is not an object'] };
  }

  if (!Array.isArray(obj.personas) || obj.personas.length === 0) {
    errors.push('analysis must contain at least one persona');
  } else {
    obj.personas.forEach((p, i) => {
      const where = `personas[${i}] (${p?.id || 'no id'})`;
      if (!p?.id) errors.push(`${where}: missing id`);
      if (!p?.name) errors.push(`${where}: missing name`);
      if (typeof p?.evidence_count !== 'number') errors.push(`${where}: evidence_count must be a number`);
      if (typeof p?.emotional_intensity !== 'number') errors.push(`${where}: emotional_intensity must be a number`);

      if (!Array.isArray(p?.angles) || p.angles.length === 0) {
        errors.push(`${where}: must have at least one angle`);
        return;
      }
      p.angles.forEach((a, j) => {
        const aWhere = `${where}.angles[${j}] (${a?.id || 'no id'})`;
        if (!a?.id) errors.push(`${aWhere}: missing id`);
        if (!AWARENESS_LEVELS.includes(a?.awareness)) {
          errors.push(`${aWhere}: awareness "${a?.awareness}" not in ${AWARENESS_LEVELS.join('|')}`);
        }
        if (!Array.isArray(a?.source_quotes) || a.source_quotes.length === 0) {
          errors.push(`${aWhere}: source_quotes must be non-empty`);
        }
      });
    });
  }

  for (const { key } of VOC_SECTIONS) {
    if (!Array.isArray(obj[key])) {
      errors.push(`${key} must be an array`);
      continue;
    }
    obj[key].forEach((e, i) => {
      if (!e?.text) errors.push(`${key}[${i}]: missing text`);
      if (!e?.quote) errors.push(`${key}[${i}]: missing quote`);
      if (typeof e?.evidence_count !== 'number') errors.push(`${key}[${i}]: evidence_count must be a number`);
    });
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Rank by volume AND emotional intensity, highest first. A persona appearing
 * in 12 reviews with intense language outranks one appearing in 40 flat ones.
 * Order is part of the personas.json contract — creative-packager reads
 * personas[0].angles[0] as its default.
 */
export function rankPersonas(personas) {
  const score = (p) => (p.evidence_count || 0) * (p.emotional_intensity || 0);
  return [...personas].sort((a, b) => score(b) - score(a));
}

// ── markdown rendering ───────────────────────────────────────────────────────
//
// Two constraints are binding here and are asserted in tests:
//   1. Heading text never changes between runs, so grep-based lookups keep working.
//   2. Every entry is self-contained — a single grep hit is useful on its own.

function renderEntry(e) {
  return `- **${e.text}** — ${e.evidence_count} mentions. > "${e.quote}"`;
}

export function renderVoiceOfCustomerMarkdown(analysis, { partial = false } = {}) {
  const lines = [
    '# Voice of Customer — skin cluster',
    '',
    '> Generated by `agents/voice-of-customer`. Do not hand-edit — rerun the agent.',
    '',
  ];

  for (const { key, heading } of VOC_SECTIONS) {
    lines.push(heading, '');
    const entries = analysis[key] || [];
    if (entries.length === 0) lines.push('_None found in this corpus._');
    else entries.forEach((e) => lines.push(renderEntry(e)));
    lines.push('');
  }

  lines.push('## Source notes', '');
  lines.push('- Judge.me reviews for the skin cluster, Reddit via Tavily, Google page-1 via DataForSEO.');
  if (partial) {
    lines.push('- **Partial corpus: generated without external friction data.** Reddit and/or SERP collection failed on this run, so the objections section reflects our own reviews only and understates friction.');
  }
  lines.push('');

  return lines.join('\n');
}

export function renderPersonasMarkdown(analysis) {
  const lines = [
    '# Personas — skin cluster',
    '',
    '> Generated by `agents/voice-of-customer`. Ranked by evidence volume and emotional intensity.',
    '',
  ];

  rankPersonas(analysis.personas || []).forEach((p, i) => {
    lines.push(`## ${i + 1}. ${p.name}`, '');
    lines.push(`\`${p.id}\` — ${p.evidence_count} mentions, emotional intensity ${p.emotional_intensity}`, '');
    lines.push(p.summary || '', '');
    (p.angles || []).forEach((a) => {
      lines.push(`### Angle: ${a.label}`, '');
      lines.push(`- \`${a.id}\` · awareness: **${a.awareness}**`);
      lines.push(`- Objection addressed: ${a.objection_addressed}`);
      lines.push(`- Proof: ${a.proof}`);
      (a.hook_examples || []).forEach((h) => lines.push(`- Hook: "${h}"`));
      (a.source_quotes || []).forEach((q) => lines.push(`- Source: > "${q}"`));
      lines.push('');
    });
  });

  return lines.join('\n');
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/lib/voice-of-customer.test.js`
Expected: PASS — 20 tests

- [ ] **Step 5: Commit**

```bash
git add lib/voice-of-customer.js tests/lib/voice-of-customer.test.js
git commit -m "feat(voc): analysis validation, persona ranking and markdown renderers

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Paginating Judge.me review-body fetcher

**Files:**
- Modify: `lib/judgeme.js`
- Create: `tests/lib/judgeme-all-reviews.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `fetchAllReviews(shopDomain, apiToken, { maxPages = 50, fetchImpl = fetch }) -> Promise<Array<{ id, product_handle, rating, body, created_at }>>`

**Why this is needed:** neither existing fetcher works for the corpus. `fetchAllReviewStats` paginates but throws away review bodies (it only tallies counts and ratings). `fetchRecentReviews` returns bodies but reads a single page, so it silently caps at 100 reviews.

- [ ] **Step 1: Write the failing test**

Create `tests/lib/judgeme-all-reviews.test.js`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchAllReviews } from '../../lib/judgeme.js';

function pagedFetch(pages) {
  return async (url) => {
    const page = Number(new URL(url).searchParams.get('page'));
    return { ok: true, json: async () => ({ reviews: pages[page - 1] || [] }) };
  };
}

function review(id) {
  return { id, product_handle: 'coconut-lotion', rating: 5, body: `body ${id}`, created_at: '2026-01-01' };
}

test('fetchAllReviews follows pages until a short page ends it', async () => {
  const full = Array.from({ length: 100 }, (_, i) => review(i + 1));
  const tail = [review(101), review(102)];
  const out = await fetchAllReviews('shop.myshopify.com', 'tok', { fetchImpl: pagedFetch([full, tail]) });
  assert.equal(out.length, 102);
  assert.equal(out[101].body, 'body 102');
});

test('fetchAllReviews stops at maxPages instead of looping forever', async () => {
  const full = Array.from({ length: 100 }, (_, i) => review(i + 1));
  const fetchImpl = pagedFetch([full, full, full, full]);
  const out = await fetchAllReviews('shop.myshopify.com', 'tok', { maxPages: 2, fetchImpl });
  assert.equal(out.length, 200);
});

test('fetchAllReviews returns what it has when a page errors', async () => {
  const full = Array.from({ length: 100 }, (_, i) => review(i + 1));
  const fetchImpl = async (url) => {
    const page = Number(new URL(url).searchParams.get('page'));
    if (page === 2) return { ok: false, status: 500, json: async () => ({}) };
    return { ok: true, json: async () => ({ reviews: full }) };
  };
  const out = await fetchAllReviews('shop.myshopify.com', 'tok', { fetchImpl });
  assert.equal(out.length, 100);
});

test('fetchAllReviews drops reviews with an empty body', async () => {
  const fetchImpl = pagedFetch([[review(1), { id: 2, product_handle: 'coconut-lotion', rating: 5, body: '   ' }]]);
  const out = await fetchAllReviews('shop.myshopify.com', 'tok', { fetchImpl });
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 1);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/lib/judgeme-all-reviews.test.js`
Expected: FAIL — `does not provide an export named 'fetchAllReviews'`

- [ ] **Step 3: Write the implementation**

Append to `lib/judgeme.js` (after `fetchAllReviewStats`):

```javascript
/**
 * Paginate ALL shop reviews and return their full bodies.
 *
 * fetchAllReviewStats() paginates but discards bodies (it only tallies counts),
 * and fetchRecentReviews() returns bodies but reads a single page. The
 * voice-of-customer corpus needs both, so this is its own fetcher.
 *
 * Reviews with an empty body are dropped — a bare star rating carries no
 * language to mine.
 *
 * @returns {Promise<Array<{id, product_handle, rating, body, created_at}>>}
 */
export async function fetchAllReviews(shopDomain, apiToken, { maxPages = 50, fetchImpl = fetch } = {}) {
  const out = [];
  for (let page = 1; page <= maxPages; page++) {
    const qs = new URLSearchParams({
      api_token: apiToken,
      shop_domain: shopDomain,
      per_page: '100',
      page: String(page),
    });
    const res = await fetchImpl(`${JUDGEME_BASE}/reviews?${qs}`);
    if (!res.ok) {
      console.warn(`  Judge.me reviews page ${page} → HTTP ${res.status} (returning ${out.length} so far)`);
      break;
    }
    const data = await res.json();
    const reviews = data.reviews || [];
    if (reviews.length === 0) break;
    for (const r of reviews) {
      if (!String(r.body || '').trim()) continue;
      out.push({
        id: r.id,
        product_handle: r.product_handle || null,
        rating: r.rating,
        body: r.body,
        created_at: r.created_at,
      });
    }
    if (reviews.length < 100) break; // last page
  }
  return out;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/lib/judgeme-all-reviews.test.js`
Expected: PASS — 4 tests

- [ ] **Step 5: Commit**

```bash
git add lib/judgeme.js tests/lib/judgeme-all-reviews.test.js
git commit -m "feat(judgeme): add fetchAllReviews paginating body fetcher

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: The agent — collect and analyze

**Files:**
- Create: `agents/voice-of-customer/index.js`
- Create: `tests/agents/voice-of-customer.test.js`

**Interfaces:**
- Consumes: `SKIN_CLUSTER_HANDLES`, `normalizeJudgemeReview`, `normalizeTavilyResult`, `normalizeSerpItem`, `dedupeRecords`, `filterSkinCluster`, `validateAnalysis`, `rankPersonas`, `renderPersonasMarkdown`, `renderVoiceOfCustomerMarkdown`, `AWARENESS_LEVELS` from `lib/voice-of-customer.js`; `fetchAllReviews` from `lib/judgeme.js`; `searchWeb` from `lib/tavily.js`; `getSerpResults` from `lib/dataforseo.js`; `notify` from `lib/notify.js`; default export from `lib/anthropic.js`.
- Produces:
  - `EXTERNAL_QUERIES: string[]`
  - `buildAnalysisPrompt(corpus) -> string`
  - `ANALYSIS_SCHEMA: object`
  - `runAnalysis({ corpus, client, root }) -> Promise<{ analysis, partial }>`
  - `writeArtifacts({ analysis, corpus, root }) -> { personasJsonPath, personasMdPath, vocMdPath }`

- [ ] **Step 1: Write the failing test**

Create `tests/agents/voice-of-customer.test.js`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  EXTERNAL_QUERIES,
  buildAnalysisPrompt,
  runAnalysis,
  writeArtifacts,
} from '../../agents/voice-of-customer/index.js';

function fixtureAnalysis() {
  return {
    personas: [
      {
        id: 'low', name: 'Low', summary: 's', evidence_count: 1, emotional_intensity: 1,
        angles: [{
          id: 'a1', label: 'A1', awareness: 'problem-aware', objection_addressed: 'o',
          proof: 'p', hook_examples: ['h'], source_quotes: ['q'],
        }],
      },
      {
        id: 'high', name: 'High', summary: 's', evidence_count: 30, emotional_intensity: 9,
        angles: [{
          id: 'a2', label: 'A2', awareness: 'solution-aware', objection_addressed: 'o',
          proof: 'p', hook_examples: ['h'], source_quotes: ['q'],
        }],
      },
    ],
    objections: [{ text: 't', evidence_count: 1, quote: 'q' }],
    golden_nugget_phrases: [{ text: 't', evidence_count: 1, quote: 'q' }],
    trigger_points: [{ text: 't', evidence_count: 1, quote: 'q' }],
    not_for: [{ text: 't', evidence_count: 1, quote: 'q' }],
  };
}

function stubClient(payload, { stopReason = 'end_turn' } = {}) {
  return {
    messages: {
      create: async () => ({
        stop_reason: stopReason,
        content: [{ type: 'text', text: JSON.stringify(payload) }],
      }),
    },
  };
}

const CORPUS = {
  generated_at: '2026-08-01T00:00:00Z',
  cluster: 'skin',
  partial: false,
  records: [
    { source: 'judgeme', id: 'judgeme:1', url: null, handle: 'coconut-lotion', rating: 5, text: 'Great lotion.' },
    { source: 'reddit', id: 'reddit:x', url: 'https://reddit.com/x', handle: null, rating: null, text: 'Broke me out.' },
  ],
};

test('EXTERNAL_QUERIES covers Reddit friction for the skin cluster', () => {
  assert.ok(EXTERNAL_QUERIES.length >= 4);
  assert.ok(EXTERNAL_QUERIES.some((q) => /reddit/i.test(q)));
});

test('buildAnalysisPrompt includes every corpus record and labels its source', () => {
  const prompt = buildAnalysisPrompt(CORPUS);
  assert.match(prompt, /Great lotion\./);
  assert.match(prompt, /Broke me out\./);
  assert.match(prompt, /judgeme/);
  assert.match(prompt, /reddit/);
});

test('buildAnalysisPrompt tells the model not to invent quotes', () => {
  assert.match(buildAnalysisPrompt(CORPUS), /verbatim/i);
});

test('runAnalysis returns the parsed analysis on a valid response', async () => {
  const { analysis } = await runAnalysis({ corpus: CORPUS, client: stubClient(fixtureAnalysis()) });
  assert.equal(analysis.personas.length, 2);
});

test('runAnalysis throws when the model hits the token cap', async () => {
  const client = stubClient(fixtureAnalysis(), { stopReason: 'max_tokens' });
  await assert.rejects(
    () => runAnalysis({ corpus: CORPUS, client }),
    /max_tokens/,
  );
});

test('runAnalysis retries once then throws on schema-invalid output', async () => {
  let calls = 0;
  const client = {
    messages: {
      create: async () => {
        calls += 1;
        return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ personas: [] }) }] };
      },
    },
  };
  await assert.rejects(() => runAnalysis({ corpus: CORPUS, client }), /validation/i);
  assert.equal(calls, 2, 'should attempt exactly twice');
});

test('writeArtifacts writes all three files with personas rank-ordered', () => {
  const root = mkdtempSync(join(tmpdir(), 'voc-'));
  mkdirSync(join(root, 'data', 'context'), { recursive: true });
  mkdirSync(join(root, 'data', 'reports', 'voice-of-customer'), { recursive: true });

  const paths = writeArtifacts({ analysis: fixtureAnalysis(), corpus: CORPUS, root });

  const json = JSON.parse(readFileSync(paths.personasJsonPath, 'utf8'));
  assert.equal(json.personas[0].id, 'high', 'personas must be rank-ordered');
  assert.equal(json.cluster, 'skin');
  assert.equal(json.partial, false);
  assert.equal(json.status, undefined, 'no approval gate — status must not be written');

  const personasMd = readFileSync(paths.personasMdPath, 'utf8');
  assert.ok(personasMd.indexOf('High') < personasMd.indexOf('Low'));

  const vocMd = readFileSync(paths.vocMdPath, 'utf8');
  assert.match(vocMd, /## Objections/);
});

test('writeArtifacts carries the partial flag into personas.json and the markdown', () => {
  const root = mkdtempSync(join(tmpdir(), 'voc-'));
  mkdirSync(join(root, 'data', 'context'), { recursive: true });
  mkdirSync(join(root, 'data', 'reports', 'voice-of-customer'), { recursive: true });

  const corpus = { ...CORPUS, partial: true };
  const paths = writeArtifacts({ analysis: fixtureAnalysis(), corpus, root });

  assert.equal(JSON.parse(readFileSync(paths.personasJsonPath, 'utf8')).partial, true);
  assert.match(readFileSync(paths.vocMdPath, 'utf8'), /generated without external friction data/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/agents/voice-of-customer.test.js`
Expected: FAIL — `Cannot find module '.../agents/voice-of-customer/index.js'`

- [ ] **Step 3: Write the implementation**

Create `agents/voice-of-customer/index.js`:

```javascript
#!/usr/bin/env node
/**
 * Voice-of-Customer Agent
 *
 * Mines Judge.me reviews plus Reddit/SERP friction into three durable context
 * artifacts that agents and humans read:
 *   data/context/voice-of-customer.md   objections, phrases, triggers, not-for
 *   data/context/personas.md            human-readable persona deck
 *   data/context/personas.json          machine-readable, rank-ordered
 *
 * Scope: the skin cluster only (see SKIN_CLUSTER_HANDLES in lib/voice-of-customer.js).
 *
 * Usage:
 *   node agents/voice-of-customer/index.js              # collect + analyze
 *   node agents/voice-of-customer/index.js --collect    # refresh the corpus only
 *   node agents/voice-of-customer/index.js --analyze    # re-synthesize from cache
 *
 * Spec: docs/superpowers/specs/2026-07-26-voice-of-customer-agent-design.md
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '../../lib/anthropic.js';
import { fetchAllReviews } from '../../lib/judgeme.js';
import { searchWeb } from '../../lib/tavily.js';
import { getSerpResults } from '../../lib/dataforseo.js';
import { notify } from '../../lib/notify.js';
import {
  AWARENESS_LEVELS,
  normalizeJudgemeReview,
  normalizeTavilyResult,
  normalizeSerpItem,
  dedupeRecords,
  filterSkinCluster,
  validateAnalysis,
  rankPersonas,
  renderPersonasMarkdown,
  renderVoiceOfCustomerMarkdown,
} from '../../lib/voice-of-customer.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const REPORT_DIR = join('data', 'reports', 'voice-of-customer');
const CONTEXT_DIR = join('data', 'context');

const MODEL = 'claude-opus-5';

/** Where the objections actually live — our own reviews are 4.68 stars. */
export const EXTERNAL_QUERIES = [
  'reddit natural deodorant coconut oil lotion does it actually work',
  'reddit coconut oil lotion clogged pores breakout',
  'reddit sensitive skin natural lotion eczema what worked',
  'reddit natural bar soap dry skin stripping',
  'is coconut oil lotion worth it review complaints',
  'natural body lotion greasy absorbs slowly problem',
];

const SERP_KEYWORDS = [
  'coconut oil lotion',
  'natural body lotion sensitive skin',
  'natural bar soap dry skin',
];

// ── .env loader (same pattern as the other agents) ───────────────────────────

function loadEnv(root = ROOT) {
  try {
    const lines = readFileSync(join(root, '.env'), 'utf8').split('\n');
    const env = {};
    for (const line of lines) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const idx = t.indexOf('=');
      if (idx === -1) continue;
      env[t.slice(0, idx).trim()] = t.slice(idx + 1).trim();
    }
    return env;
  } catch { return {}; }
}

// ── collect ──────────────────────────────────────────────────────────────────

/**
 * Build the corpus. External sources are best-effort: if Tavily or DataForSEO
 * fail we degrade to Judge.me-only and set partial=true rather than silently
 * shipping a thin corpus as a full one.
 */
export async function collectCorpus({ env, root = ROOT } = {}) {
  const e = env || loadEnv(root);
  const records = [];
  let partial = false;

  const shop = e.JUDGEME_SHOP_DOMAIN || 'realskincare-com.myshopify.com';
  const reviews = await fetchAllReviews(shop, e.JUDGEME_API_TOKEN);
  console.log(`  judge.me: ${reviews.length} reviews with bodies`);
  records.push(...reviews.map(normalizeJudgemeReview));

  const tavilyKey = e.TAVILY_API_KEY || process.env.TAVILY_API_KEY;
  if (!tavilyKey) {
    console.warn('  no TAVILY_API_KEY — skipping Reddit collection');
    partial = true;
  } else {
    for (const query of EXTERNAL_QUERIES) {
      try {
        const results = await searchWeb(tavilyKey, query, { maxResults: 6 });
        records.push(...(results || []).map(normalizeTavilyResult));
      } catch (err) {
        console.warn(`  tavily "${query}" failed: ${err.message}`);
        partial = true;
      }
    }
  }

  for (const keyword of SERP_KEYWORDS) {
    try {
      const items = await getSerpResults(keyword, 10);
      records.push(...(items || []).map(normalizeSerpItem));
    } catch (err) {
      console.warn(`  dataforseo "${keyword}" failed: ${err.message}`);
      partial = true;
    }
  }

  const clean = filterSkinCluster(dedupeRecords(records)).filter((r) => r.text);
  console.log(`  corpus: ${clean.length} records (partial=${partial})`);

  return {
    generated_at: new Date().toISOString(),
    cluster: 'skin',
    partial,
    records: clean,
  };
}

export function writeCorpus(corpus, { root = ROOT } = {}) {
  const dir = join(root, REPORT_DIR);
  mkdirSync(dir, { recursive: true });
  const day = corpus.generated_at.slice(0, 10);
  const path = join(dir, `corpus-${day}.json`);
  writeFileSync(path, JSON.stringify(corpus, null, 2), 'utf8');
  return path;
}

export function readLatestCorpus({ root = ROOT } = {}) {
  const dir = join(root, REPORT_DIR);
  if (!existsSync(dir)) throw new Error(`No corpus cached in ${REPORT_DIR} — run with --collect first.`);
  const files = readdirSync(dir).filter((f) => f.startsWith('corpus-') && f.endsWith('.json')).sort();
  if (files.length === 0) throw new Error(`No corpus cached in ${REPORT_DIR} — run with --collect first.`);
  return JSON.parse(readFileSync(join(dir, files[files.length - 1]), 'utf8'));
}

// ── analyze ──────────────────────────────────────────────────────────────────

export const ANALYSIS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['personas', 'objections', 'golden_nugget_phrases', 'trigger_points', 'not_for'],
  properties: {
    personas: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'name', 'summary', 'evidence_count', 'emotional_intensity', 'angles'],
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          summary: { type: 'string' },
          evidence_count: { type: 'integer' },
          emotional_intensity: { type: 'number' },
          angles: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['id', 'label', 'awareness', 'objection_addressed', 'proof', 'hook_examples', 'source_quotes'],
              properties: {
                id: { type: 'string' },
                label: { type: 'string' },
                awareness: { type: 'string', enum: AWARENESS_LEVELS },
                objection_addressed: { type: 'string' },
                proof: { type: 'string' },
                hook_examples: { type: 'array', items: { type: 'string' } },
                source_quotes: { type: 'array', items: { type: 'string' } },
              },
            },
          },
        },
      },
    },
    ...Object.fromEntries(
      ['objections', 'golden_nugget_phrases', 'trigger_points', 'not_for'].map((key) => [
        key,
        {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['text', 'evidence_count', 'quote'],
            properties: {
              text: { type: 'string' },
              evidence_count: { type: 'integer' },
              quote: { type: 'string' },
            },
          },
        },
      ]),
    ),
  },
};

export function buildAnalysisPrompt(corpus) {
  const lines = [
    'You are a creative strategist doing voice-of-customer research for Real Skin Care,',
    'a natural body-care brand (realskincare.com). Below is the complete research corpus',
    'for the skin cluster: coconut lotion, body lotion, coconut moisturizer, coconut bar',
    'soap, and organic foaming hand soap.',
    '',
    'Each record is labelled with its source:',
    '  judgeme — one of our own verified customer reviews (survivor-biased, 4.68 avg)',
    '  reddit  — an outside discussion thread (where the real objections live)',
    '  serp    — a Google page-1 result a first-time buyer would hit',
    '',
    'Produce:',
    '  1. personas — 3 to 5 distinct buyer personas, each with 2-3 angles.',
    '  2. objections — what stops people buying. Weight the reddit and serp records',
    '     heavily here; our own reviews are from people who already bought and stayed.',
    '  3. golden_nugget_phrases — striking customer language worth putting in an ad verbatim.',
    '  4. trigger_points — what makes someone finally buy.',
    '  5. not_for — who this product genuinely is not for.',
    '',
    'Rules:',
    '  - Every quote you output must be VERBATIM from a record below. Never invent,',
    '    paraphrase, or compose a quote. If you cannot find a real quote, omit the entry.',
    '  - evidence_count is how many records support that entry.',
    '  - emotional_intensity (0-10) rates how affect-laden the persona\'s source language is,',
    '    independently of how often it appears. A persona voiced by 12 people in anguished',
    '    terms scores higher than one voiced by 40 people flatly.',
    '  - Each angle gets an awareness level from: ' + AWARENESS_LEVELS.join(', ') + '.',
    '  - Write every entry so it stands alone: someone reading that one line, with no',
    '    surrounding context, should understand it. Do not refer to a previous entry.',
    '',
    `CORPUS (${corpus.records.length} records${corpus.partial ? ', PARTIAL — external sources incomplete' : ''}):`,
    '',
  ];

  corpus.records.forEach((r, i) => {
    const meta = [r.source, r.handle, r.rating ? `${r.rating}star` : null].filter(Boolean).join(' | ');
    lines.push(`[${i + 1}] (${meta}) ${r.text}`);
  });

  return lines.join('\n');
}

/**
 * One Claude call over the whole corpus. Validates, retries once, then throws.
 * A max_tokens stop means the JSON is truncated — fatal, never save.
 */
export async function runAnalysis({ corpus, client, root = ROOT }) {
  const e = loadEnv(root);
  const anthropic = client || new Anthropic({ apiKey: e.ANTHROPIC_API_KEY });
  const prompt = buildAnalysisPrompt(corpus);

  let lastErrors = [];
  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 16000,
      output_config: {
        effort: 'high',
        format: { type: 'json_schema', schema: ANALYSIS_SCHEMA },
      },
      messages: [{ role: 'user', content: prompt }],
    });

    if (res.stop_reason === 'max_tokens') {
      throw new Error('voice-of-customer: response hit max_tokens — output is truncated, not saving.');
    }

    const text = (res.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      lastErrors = [`JSON.parse failed: ${err.message}`];
      continue;
    }

    const check = validateAnalysis(parsed);
    if (check.ok) return { analysis: parsed, partial: corpus.partial };
    lastErrors = check.errors;
    console.warn(`  attempt ${attempt} failed validation: ${check.errors.slice(0, 3).join('; ')}`);
  }

  throw new Error(`voice-of-customer: analysis failed validation twice — ${lastErrors.join('; ')}`);
}

// ── artifacts ────────────────────────────────────────────────────────────────

export function writeArtifacts({ analysis, corpus, root = ROOT }) {
  const contextDir = join(root, CONTEXT_DIR);
  mkdirSync(contextDir, { recursive: true });

  const day = corpus.generated_at.slice(0, 10);
  const personasJson = {
    generated_at: corpus.generated_at,
    corpus_ref: `corpus-${day}.json`,
    cluster: corpus.cluster,
    partial: corpus.partial,
    personas: rankPersonas(analysis.personas),
  };

  const personasJsonPath = join(contextDir, 'personas.json');
  const personasMdPath = join(contextDir, 'personas.md');
  const vocMdPath = join(contextDir, 'voice-of-customer.md');

  writeFileSync(personasJsonPath, JSON.stringify(personasJson, null, 2), 'utf8');
  writeFileSync(personasMdPath, renderPersonasMarkdown(analysis), 'utf8');
  writeFileSync(vocMdPath, renderVoiceOfCustomerMarkdown(analysis, { partial: corpus.partial }), 'utf8');

  const reportDir = join(root, REPORT_DIR);
  mkdirSync(reportDir, { recursive: true });
  writeFileSync(join(reportDir, 'latest.json'), JSON.stringify({
    generated_at: corpus.generated_at,
    partial: corpus.partial,
    record_count: corpus.records.length,
    persona_count: personasJson.personas.length,
    objection_count: (analysis.objections || []).length,
  }, null, 2), 'utf8');

  return { personasJsonPath, personasMdPath, vocMdPath };
}

// ── CLI ──────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const collectOnly = args.includes('--collect');
  const analyzeOnly = args.includes('--analyze');

  try {
    let corpus;
    if (analyzeOnly) {
      corpus = readLatestCorpus();
      console.log(`  reusing cached corpus from ${corpus.generated_at}`);
    } else {
      console.log('voice-of-customer: collecting…');
      corpus = await collectCorpus();
      console.log(`  corpus written to ${writeCorpus(corpus)}`);
    }

    if (collectOnly) return;

    if (corpus.records.filter((r) => r.source === 'judgeme').length === 0) {
      console.log('  no reviews in corpus — skipping the LLM call.');
      return;
    }

    console.log('voice-of-customer: analyzing…');
    const { analysis } = await runAnalysis({ corpus });
    const paths = writeArtifacts({ analysis, corpus });
    console.log(`  wrote ${paths.personasJsonPath}`);
    console.log(`  wrote ${paths.personasMdPath}`);
    console.log(`  wrote ${paths.vocMdPath}`);

    await notify({
      subject: `Voice-of-customer refreshed — ${analysis.personas.length} personas`,
      body: `Corpus: ${corpus.records.length} records${corpus.partial ? ' (PARTIAL — external sources incomplete)' : ''}.\n`
          + `Personas: ${analysis.personas.length}. Objections: ${(analysis.objections || []).length}.\n`
          + `Review data/context/personas.md, then git diff data/context/ to see what changed.`,
      status: 'success',
      category: 'voice-of-customer',
    });
  } catch (err) {
    console.error(`voice-of-customer failed: ${err.message}`);
    await notify({
      subject: 'Voice-of-customer FAILED',
      body: err.stack || err.message,
      status: 'error',
      category: 'voice-of-customer',
    });
    process.exitCode = 1;
  }
}

if (process.argv[1] && process.argv[1].endsWith('voice-of-customer/index.js')) {
  main();
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/agents/voice-of-customer.test.js`
Expected: PASS — 8 tests

- [ ] **Step 5: Run the whole suite for regressions**

Run: `npm test`
Expected: PASS — no new failures versus the pre-task baseline

- [ ] **Step 6: Commit**

```bash
git add agents/voice-of-customer/index.js tests/agents/voice-of-customer.test.js
git commit -m "feat(voc): voice-of-customer agent with cached corpus and single-call analysis

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Consumer wiring

**Files:**
- Modify: `agents/blog-post-writer/index.js` (after `loadAgentFeedback`, around line 70)
- Modify: `agents/pdp-builder/lib/load-foundation.js`
- Modify: `agents/creative-packager/index.js:93-140`
- Modify: `tests/agents/creative-packager.test.js`

**Interfaces:**
- Consumes: `data/context/voice-of-customer.md` and `data/context/personas.json` written by Task 4.
- Produces: `buildCopyBrief(ad, { personas, personaId, angleId })` and `buildCopyPrompt(brief)` with persona support.

**Critical constraint:** `loadFoundation()` in `pdp-builder` **throws** when a listed file is missing. The VOC doc must be added to an *optional* list, not the `required` array — otherwise `pdp-builder` breaks on every run before the first voice-of-customer run.

- [ ] **Step 1: Write the failing test**

Append to `tests/agents/creative-packager.test.js`:

```javascript
import { buildCopyBrief, buildCopyPrompt } from '../../agents/creative-packager/index.js';

const PERSONAS = {
  personas: [
    {
      id: 'eczema-flare-parent',
      name: 'The eczema flare parent',
      summary: 'Buys for a child whose skin reacts to everything.',
      angles: [
        { id: 'steroid-off-ramp', label: 'The steroid-cream off-ramp', awareness: 'problem-aware',
          objection_addressed: 'Will natural actually work?', proof: '97 reviews at 4.91',
          hook_examples: ['Off the steroid cream in three weeks'], source_quotes: ['q'] },
      ],
    },
    {
      id: 'ingredient-reader',
      name: 'The ingredient reader',
      summary: 'Reads every label.',
      angles: [
        { id: 'four-ingredients', label: 'Four ingredients, that is it', awareness: 'solution-aware',
          objection_addressed: 'What is actually in it?', proof: 'Full INCI on the PDP',
          hook_examples: ['Four ingredients. Read them out loud.'], source_quotes: ['q'] },
      ],
    },
  ],
};

const AD = {
  pageName: 'Rival Brand',
  pageSlug: 'rival-brand',
  landingUrl: 'https://realskincare.com/products/coconut-lotion',
  adCreativeBody: 'Competitor body copy',
  analysis: { messagingAngle: 'competitor-derived angle', copyInsights: 'insight' },
};

test('buildCopyBrief falls back to the competitor angle when no personas exist', () => {
  const brief = buildCopyBrief(AD, { personas: null });
  assert.equal(brief.angle, 'competitor-derived angle');
  assert.equal(brief.persona, undefined);
});

test('buildCopyBrief defaults to the top-ranked persona angle when personas exist', () => {
  const brief = buildCopyBrief(AD, { personas: PERSONAS });
  assert.equal(brief.angle, 'The steroid-cream off-ramp');
  assert.equal(brief.persona, 'The eczema flare parent');
  assert.equal(brief.awareness, 'problem-aware');
});

test('buildCopyBrief honours an explicit personaId and angleId', () => {
  const brief = buildCopyBrief(AD, {
    personas: PERSONAS, personaId: 'ingredient-reader', angleId: 'four-ingredients',
  });
  assert.equal(brief.angle, 'Four ingredients, that is it');
  assert.equal(brief.persona, 'The ingredient reader');
});

test('buildCopyBrief drops the competitor reference copy once a persona drives the angle', () => {
  const brief = buildCopyBrief(AD, { personas: PERSONAS });
  assert.ok(!brief.competitorBody, 'reference ad should drive style only, not copy');
});

test('buildCopyBrief throws on an unknown personaId rather than silently defaulting', () => {
  assert.throws(
    () => buildCopyBrief(AD, { personas: PERSONAS, personaId: 'nope' }),
    /nope/,
  );
});

test('buildCopyPrompt surfaces the persona and objection to the model', () => {
  const brief = buildCopyBrief(AD, { personas: PERSONAS });
  const prompt = buildCopyPrompt(brief);
  assert.match(prompt, /The eczema flare parent/);
  assert.match(prompt, /Will natural actually work\?/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/agents/creative-packager.test.js`
Expected: FAIL — `buildCopyBrief(AD, { personas: PERSONAS })` returns the competitor angle; `brief.persona` is `undefined`

- [ ] **Step 3: Update `creative-packager`**

In `agents/creative-packager/index.js`, replace `buildCopyBrief` and `buildCopyPrompt`:

```javascript
/**
 * Load the approved persona set, if the voice-of-customer agent has run.
 * Returns null when absent so every caller degrades to prior behavior.
 */
export function loadPersonas(root = ROOT) {
  try {
    const raw = readFileSync(join(root, 'data', 'context', 'personas.json'), 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.personas) && parsed.personas.length ? parsed : null;
  } catch { return null; }
}

/**
 * Build a copy brief.
 *
 * The angle used to come from the competitor reference ad's messagingAngle,
 * which made this a competitor reverse-engineering machine. When personas.json
 * exists the angle now comes from our own research and the reference ad drives
 * style only. With no personas.json we fall back to the old behavior so the
 * agent never breaks.
 *
 * personas.personas is rank-ordered by the voice-of-customer agent, so
 * personas[0].angles[0] is the default.
 */
export function buildCopyBrief(ad, { personas = null, personaId = null, angleId = null } = {}) {
  const base = {
    product: ad.pageName || ad.pageSlug || 'Real Skin Care',
    destinationUrl: ad.landingUrl || '',
  };

  if (!personas) {
    return {
      ...base,
      angle: ad.analysis?.messagingAngle || '',
      competitorBody: ad.adCreativeBody || '',
      copyInsights: ad.analysis?.copyInsights || '',
    };
  }

  const persona = personaId
    ? personas.personas.find((p) => p.id === personaId)
    : personas.personas[0];
  if (!persona) throw new Error(`buildCopyBrief: no persona with id "${personaId}" in personas.json`);

  const angle = angleId
    ? persona.angles.find((a) => a.id === angleId)
    : persona.angles[0];
  if (!angle) throw new Error(`buildCopyBrief: no angle with id "${angleId}" on persona "${persona.id}"`);

  return {
    ...base,
    angle: angle.label,
    persona: persona.name,
    personaSummary: persona.summary,
    awareness: angle.awareness,
    objection: angle.objection_addressed,
    proof: angle.proof,
    hooks: angle.hook_examples || [],
  };
}

/** Prompt for Claude to write 3 ad-copy variations from a copy brief. */
export function buildCopyPrompt(brief) {
  const lines = [
    'Write 3 ad copy variations for Real Skin Care (realskincare.com).',
    '',
    `Product: ${brief.product}`,
    `Angle: ${brief.angle || 'natural skincare'}`,
  ];
  if (brief.persona) {
    lines.push(`Audience: ${brief.persona} — ${brief.personaSummary || ''}`);
    lines.push(`Awareness level: ${brief.awareness}`);
    lines.push(`Objection to overcome: ${brief.objection}`);
    lines.push(`Proof we can point to: ${brief.proof}`);
    if (brief.hooks?.length) lines.push(`Hook directions from customer language: ${brief.hooks.join(' / ')}`);
  }
  if (brief.destinationUrl) lines.push(`Landing page: ${brief.destinationUrl}`);
  if (brief.competitorBody) lines.push(`Reference competitor copy: ${brief.competitorBody}`);
  if (brief.copyInsights) lines.push(`What works about it: ${brief.copyInsights}`);
  lines.push(
    '',
    'Our brand makes natural skincare products. Make it authentic to Real Skin Care and lead with a benefit tied to the angle.',
    '',
    'Return ONLY valid JSON (no markdown):',
    '[',
    '  { "headline": "max 40 chars", "body": "max 125 chars", "cta": "2-4 words", "placement": "general" },',
    '  { "headline": "...", "body": "...", "cta": "...", "placement": "instagram-feed" },',
    '  { "headline": "...", "body": "...", "cta": "...", "placement": "facebook-feed" }',
    ']',
  );
  return lines.join('\n');
}
```

Then update the legacy call site around `index.js:299` so the Ad Intelligence path passes personas through:

```javascript
    brief = job.copyBrief || buildCopyBrief(ad, {
      personas: loadPersonas(),
      personaId: job.personaId || null,
      angleId: job.angleId || null,
    });
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/agents/creative-packager.test.js`
Expected: PASS — existing tests plus the 6 new ones

- [ ] **Step 5: Wire `blog-post-writer`**

In `agents/blog-post-writer/index.js`, add directly after `loadAgentFeedback`:

```javascript
/**
 * Load the voice-of-customer research written by agents/voice-of-customer.
 * Returns '' when absent so the writer behaves exactly as before the first run.
 */
function loadVoiceOfCustomer() {
  try {
    return readFileSync(join(ROOT, 'data', 'context', 'voice-of-customer.md'), 'utf8').trim();
  } catch { return ''; }
}
```

Find where `loadAgentFeedback('blog-post-writer')` is called and its result interpolated into the prompt, and add the VOC block alongside it:

```javascript
  const voc = loadVoiceOfCustomer();
  const vocBlock = voc
    ? `\n\nVOICE OF CUSTOMER — real objections, phrases and triggers from our own reviews, Reddit and Google. Open the post by naming the objection the reader actually has, and prefer this customer language over invented phrasing:\n\n${voc}`
    : '';
```

Append `vocBlock` to the same prompt string that already receives the feedback text.

- [ ] **Step 6: Wire `pdp-builder` (optional, never throwing)**

In `agents/pdp-builder/lib/load-foundation.js`, after the `required` loop that populates `out`, add:

```javascript
  // Optional foundation files. Unlike `required` above these must never throw —
  // voice-of-customer.md does not exist until agents/voice-of-customer has run,
  // and pdp-builder has to keep working before and after that.
  const optional = [
    { path: join(root, 'data', 'context', 'voice-of-customer.md'), key: 'voiceOfCustomer', type: 'text' },
  ];
  for (const file of optional) {
    out[file.key] = existsSync(file.path) ? readFileSync(file.path, 'utf8') : '';
  }
```

Update the docstring's returns block to list `voiceOfCustomer: string // raw markdown, '' when the VOC agent has not run yet`.

- [ ] **Step 7: Verify nothing regressed**

Run: `npm test`
Expected: PASS — no new failures

Run: `node -e "import('./agents/pdp-builder/lib/load-foundation.js').then(m => console.log(typeof m.loadFoundation({}).voiceOfCustomer))"`
Expected: prints `string` (empty string is correct — the VOC agent has not run yet)

- [ ] **Step 8: Commit**

```bash
git add agents/creative-packager/index.js agents/blog-post-writer/index.js \
        agents/pdp-builder/lib/load-foundation.js tests/agents/creative-packager.test.js
git commit -m "feat(voc): wire personas and VOC into packager, writer and pdp-builder

creative-packager's angle now comes from our own personas.json rather than the
competitor reference ad's messagingAngle; the reference ad drives style only.
Falls back to prior behavior when personas.json is absent.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Schedule, document, and open the PR

**Files:**
- Modify: `scheduler.js` (monthly block at line ~337)
- Modify: `package.json` (scripts)
- Modify: `CLAUDE.md` (Data Layout Conventions)

- [ ] **Step 1: Add the monthly scheduler entry**

In `scheduler.js`, inside the existing `if (new Date().getDate() === 1) {` block, after the `device-weights` step:

```javascript
  // Step 13: voice-of-customer — mine Judge.me reviews + Reddit/SERP friction into
  // data/context/{voice-of-customer,personas}.md and personas.json. Monthly because
  // reviews accrue a handful a week and Reddit sentiment moves slowly.
  runStep('voice-of-customer', `"${NODE}" agents/voice-of-customer/index.js`, { indent: '    ' });
```

- [ ] **Step 2: Add npm scripts**

In `package.json`, add beside the other agent scripts:

```json
    "voc": "node agents/voice-of-customer/index.js",
    "voc-analyze": "node agents/voice-of-customer/index.js --analyze",
```

- [ ] **Step 3: Document the artifacts in CLAUDE.md**

In the **Data Layout Conventions** section, after the `data/context/feedback.md` bullet:

```markdown
- `data/context/voice-of-customer.md`, `data/context/personas.md`, `data/context/personas.json` — voice-of-customer research for the skin cluster, written monthly by `agents/voice-of-customer`. Headings are stable so the files stay greppable; every entry carries an evidence count and a verbatim quote. `personas.json` is rank-ordered — `creative-packager` reads `personas[0].angles[0]` as its default angle instead of the competitor reference ad's `messagingAngle`.
```

- [ ] **Step 4: Verify the full suite and a real dry run**

Run: `npm test`
Expected: PASS

Run: `node agents/voice-of-customer/index.js --collect`
Expected: prints a judge.me review count near 390, a corpus count, and a written corpus path under `data/reports/voice-of-customer/`. Confirm `partial=false`; if it prints `partial=true`, read the warnings — a missing `TAVILY_API_KEY` or a DataForSEO failure is the cause and must be fixed before the analyze step is meaningful.

Run: `node agents/voice-of-customer/index.js --analyze`
Expected: writes all three artifacts. **Then actually read `data/context/personas.md`** — this is the real acceptance check. Verify:
1. The personas are recognisable buyers, not generic marketing archetypes.
2. `data/context/voice-of-customer.md` contains at least one objection sourced from a `reddit` or `serp` record, not only our own reviews. If every objection traces to Judge.me, the external queries are not earning their place — report that rather than shipping it.

- [ ] **Step 5: Commit and open the PR**

```bash
git add scheduler.js package.json CLAUDE.md
git commit -m "chore(voc): schedule monthly, add npm scripts, document artifacts

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
git push -u origin feature/voice-of-customer-agent
gh pr create --title "feat: voice-of-customer research agent" --body "$(cat <<'EOF'
## Summary

Adds `agents/voice-of-customer`, which mines Judge.me reviews plus Reddit and Google page-1 friction into three durable context artifacts under `data/context/`.

Motivation: `creative-packager` derived its messaging angle from the **competitor reference ad's** `analysis.messagingAngle`, making the Ad Builder a competitor reverse-engineering machine. This builds the persona/angle layer that belongs before format selection, and points the packager at it.

## What changed

- `lib/voice-of-customer.js` — pure brain (normalization, dedup, cluster filter, validation, markdown rendering), fully unit-tested
- `lib/judgeme.js` — new `fetchAllReviews()`; the existing fetchers either discard review bodies or read only one page
- `agents/voice-of-customer/index.js` — `--collect` / `--analyze`, cached corpus, one Claude call
- Consumers: `creative-packager` (persona-driven angle), `blog-post-writer` (objection-led openings), `pdp-builder` (optional foundation file)
- Monthly scheduler entry on the 1st

## Scope

Skin cluster only — 293 of our 390 reviews, the paid-ready half of the catalog. No dashboard UI and no approval gate: the artifacts are files, and `git diff data/context/` is the change-review mechanism.

## Safety

Every consumer degrades to exactly current behavior when `personas.json` / `voice-of-customer.md` are absent, so the feature is never half-live. `loadFoundation()` treats the VOC doc as optional and never throws on it.

Spec: `docs/superpowers/specs/2026-07-26-voice-of-customer-agent-design.md`
Plan: `docs/superpowers/plans/2026-07-26-voice-of-customer-agent.md`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-Review Notes

Checked against the spec:

| Spec requirement | Task |
|---|---|
| Skin cluster as explicit handle list | 1 |
| Judge.me + Tavily + DataForSEO sources | 4 |
| `--collect` / `--analyze` with cached corpus | 4 |
| Single Claude call, no chunking | 4 |
| Rank by volume AND emotional intensity | 2 (`rankPersonas`), 4 (prompt) |
| `personas.json` rank-ordered, no `status` field | 2, 4 (asserted in test) |
| Stable headings, self-contained entries | 2 (asserted), 4 (prompt rule) |
| Every angle carries `source_quotes` | 2 (validator), 4 (schema) |
| Partial-corpus flag propagates | 2, 4 (both asserted) |
| Malformed output: validate, retry once, throw | 4 (asserted: exactly 2 attempts) |
| Zero reviews → skip the LLM call | 4 (CLI guard) |
| Errors bypass digest deferral | 4 (`notify` with `status: 'error'`) |
| Consumer degradation with no artifacts | 5 (asserted for packager; `''` for writer and pdp-builder) |
| Monthly cadence | 6 |
| Success criterion: an objection not from our own reviews | 6 Step 4 |
