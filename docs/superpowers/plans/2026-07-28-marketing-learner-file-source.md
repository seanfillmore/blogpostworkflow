# Marketing Learner — File Source — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let `agents/marketing-learner` ingest a local `.txt`/`.md` book through the
same extraction/scoring/merge pipeline it already uses for YouTube transcripts.

**Architecture:** Add `lib/text-source.js` as a sibling seam to `lib/transcript-source.js`;
both loaders return the same normalized source object. Chunk long text by word budget over
paragraph boundaries, extract per chunk, then run ONE consolidation call over the whole
run's candidates to collapse cross-chunk duplicates before anything touches a skill.
Everything downstream of the loader is unchanged.

**Tech Stack:** Node 22 ESM, `node --test`, `@anthropic-ai/sdk` (`claude-opus-5`), `node:crypto`.

**Spec:** `docs/superpowers/specs/2026-07-28-marketing-learner-file-source-design.md`

## Global Constraints

- **ESM only. No new npm dependencies.** Node built-ins only.
- **Bare-assertion test style.** Top-level `assert.*` in bare blocks, then
  `console.log('✓ … tests pass')` at the end of the file. No `describe`/`it` anywhere.
- **`new Anthropic()` with no args does not work here.** `loadEnv()` parses `.env` into a
  local object and never touches `process.env`. Always pass `{ apiKey: env.ANTHROPIC_API_KEY }`.
- **`max_tokens` must be ≥16000 on `claude-opus-5`.** Thinking is on by default and shares
  the budget with the response.
- **Do not execute the agent without `--no-pr`.** A normal run pushes a branch and opens a real PR.
- **Work in the worktree.** `git -C /Users/seanfillmore/Code/Claude/.claude/worktrees/marketing-learner-file-source`
  for every git command — `cd` does not reliably persist and has already put one commit on `main` this session.
- Run tests with `npm test` (`node --test 'tests/**/*.test.js'`). Baseline before starting: **1007 pass, 0 fail.**

---

### Task 1: `lib/text-source.js` — the file-source seam

**Files:**
- Create: `lib/text-source.js`
- Create: `tests/lib/text-source.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `class TextSourceError extends Error` with `.code`
  - `slugify(title: string) → string`
  - `normalizeFileText(raw: string) → string`
  - `loadTextFile(path: string, { author, title, publishedAt = null }) → { sourceId, sourceType: 'file', videoId: null, title, creator, creatorUrl: null, durationSeconds: null, publishedAt, language: 'en', text }`

- [ ] **Step 1: Write the failing test**

Create `tests/lib/text-source.test.js`:

```js
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadTextFile, normalizeFileText, slugify, TextSourceError } from '../../lib/text-source.js';

const dir = mkdtempSync(join(tmpdir(), 'text-source-'));

// ── slugify ─────────────────────────────────────────────────────────────────
{
  assert.equal(slugify('$100M Money Models'), '100m-money-models');
  assert.equal(slugify('  Hello,  World!  '), 'hello-world');
  assert.equal(slugify('Ünïcödé Tïtlé'), 'unicode-title', 'diacritics fold to ascii');
  assert.throws(() => slugify('!!!'), /produced an empty slug/, 'unusable title is an error, not an empty path segment');
}

// ── normalizeFileText: blank lines are load-bearing and must survive ─────────
{
  const out = normalizeFileText('Para  one\nstill   one\n\n\n\nPara two\t\ttabs\n');
  assert.equal(out, 'Para one still one\n\nPara two tabs', 'intra-paragraph wrapping collapses, paragraph breaks survive');
  assert.equal(normalizeFileText('a\r\n\r\nb'), 'a\n\nb', 'CRLF normalises');
}

// ── happy path ──────────────────────────────────────────────────────────────
{
  const p = join(dir, 'book.txt');
  writeFileSync(p, 'Chapter one.\n\nChapter two.\n');
  const src = loadTextFile(p, { author: 'Alex Hormozi', title: '$100M Money Models', publishedAt: '2025' });
  assert.equal(src.sourceId, '100m-money-models');
  assert.equal(src.sourceType, 'file');
  assert.equal(src.videoId, null, 'file sources carry a null videoId so downstream shape checks stay uniform');
  assert.equal(src.creator, 'Alex Hormozi');
  assert.equal(src.title, '$100M Money Models');
  assert.equal(src.publishedAt, '2025');
  assert.equal(src.language, 'en');
  assert.equal(src.durationSeconds, null);
  assert.equal(src.text, 'Chapter one.\n\nChapter two.');
}

// ── every failure mode throws TextSourceError with a distinct code ───────────
{
  const cases = [
    ['MISSING',   () => loadTextFile(join(dir, 'nope.txt'), { author: 'A', title: 'T' })],
    ['BAD_EXT',   () => { const p = join(dir, 'book.pdf'); writeFileSync(p, 'x'); return loadTextFile(p, { author: 'A', title: 'T' }); }],
    ['EMPTY',     () => { const p = join(dir, 'empty.txt'); writeFileSync(p, '   \n\n  '); return loadTextFile(p, { author: 'A', title: 'T' }); }],
  ];
  for (const [code, fn] of cases) {
    assert.throws(fn, (e) => e instanceof TextSourceError && e.code === code, `expected ${code}`);
  }
}

// ── size ceiling: a PDF passed by mistake must not reach Opus ────────────────
{
  const p = join(dir, 'huge.txt');
  writeFileSync(p, 'x'.repeat(11 * 1024 * 1024));
  assert.throws(
    () => loadTextFile(p, { author: 'A', title: 'T' }),
    (e) => e instanceof TextSourceError && e.code === 'TOO_LARGE' && /10 MB/.test(e.message),
  );
}

// ── author and title are the provenance; absence is fatal ───────────────────
{
  const p = join(dir, 'book.txt');
  assert.throws(() => loadTextFile(p, { title: 'T' }), /author is required/);
  assert.throws(() => loadTextFile(p, { author: 'A' }), /title is required/);
}

console.log('✓ text-source tests pass');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/lib/text-source.test.js`
Expected: FAIL — `Cannot find module '../../lib/text-source.js'`

- [ ] **Step 3: Write the implementation**

Create `lib/text-source.js`:

```js
/**
 * lib/text-source.js
 *
 * The file-source seam, sibling to lib/transcript-source.js. Both loaders return
 * the same normalized shape so everything downstream of the loader stays
 * source-agnostic.
 *
 * Text only, by design: Node has no good built-in PDF extractor and this repo
 * takes no new npm dependencies. Conversion is a documented manual step — see
 * the runbook in docs/superpowers/specs/2026-07-28-marketing-learner-file-source-design.md.
 */

import { readFileSync, statSync } from 'node:fs';
import { extname } from 'node:path';

/** A converted 188-page book is ~264 KB. A PDF passed by mistake is multiple MB. */
const MAX_BYTES = 10 * 1024 * 1024;
const ALLOWED_EXTENSIONS = new Set(['.txt', '.md']);

export class TextSourceError extends Error {
  constructor(message, { code = 'UNKNOWN' } = {}) {
    super(message);
    this.name = 'TextSourceError';
    this.code = code;
  }
}

/** Kebab slug used for corpus and report paths. */
export function slugify(title) {
  const slug = String(title ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')   // strip combining diacritics
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!slug) {
    throw new TextSourceError(`--title "${title}" produced an empty slug; it needs some letters or digits.`, { code: 'BAD_TITLE' });
  }
  return slug;
}

/**
 * Collapse the line wrapping pdftotext leaves mid-sentence, WITHOUT collapsing
 * blank lines. This is the one place the file source deliberately differs from
 * normalizeTranscriptText: paragraph boundaries are what chunkText packs on, so
 * losing them would turn the whole book into one unsplittable paragraph.
 */
export function normalizeFileText(raw) {
  return String(raw ?? '')
    .replace(/\r\n?/g, '\n')
    .split(/\n[ \t]*\n[\s]*/)          // paragraph break: blank line, plus any run of blanks after it
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n\n');
}

export function loadTextFile(path, { author, title, publishedAt = null } = {}) {
  if (!author) throw new TextSourceError('--author is required with --file; it is the provenance on every claim.', { code: 'NO_AUTHOR' });
  if (!title) throw new TextSourceError('--title is required with --file; it is the provenance on every claim.', { code: 'NO_TITLE' });

  const ext = extname(path).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    throw new TextSourceError(
      `--file must be .txt or .md, got "${ext || '(no extension)'}". Convert first: ` +
      `pdftotext -layout <in.pdf> <out.txt> (see digitalassets/README.md).`,
      { code: 'BAD_EXT' },
    );
  }

  let stat;
  try {
    stat = statSync(path);
  } catch {
    throw new TextSourceError(`No such file: ${path}`, { code: 'MISSING' });
  }
  if (stat.size > MAX_BYTES) {
    throw new TextSourceError(
      `${path} is ${(stat.size / 1024 / 1024).toFixed(1)} MB, over the 10 MB ceiling. ` +
      `A converted book is well under 1 MB — this looks like a PDF or binary passed by mistake.`,
      { code: 'TOO_LARGE' },
    );
  }

  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    throw new TextSourceError(`Could not read ${path}: ${err.message}`, { code: 'UNREADABLE' });
  }

  const text = normalizeFileText(raw);
  if (!text) throw new TextSourceError(`${path} has no text content.`, { code: 'EMPTY' });

  return {
    sourceId: slugify(title),
    sourceType: 'file',
    videoId: null,
    title,
    creator: author,
    creatorUrl: null,
    durationSeconds: null,
    publishedAt,
    language: 'en',
    text,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/lib/text-source.test.js`
Expected: PASS, ending `✓ text-source tests pass`

- [ ] **Step 5: Run the full suite for regressions**

Run: `npm test`
Expected: 1007 baseline + the new assertions, 0 fail.

- [ ] **Step 6: Commit**

```bash
WT=/Users/seanfillmore/Code/Claude/.claude/worktrees/marketing-learner-file-source
git -C $WT add lib/text-source.js tests/lib/text-source.test.js
git -C $WT commit -m "feat(marketing-learner): add lib/text-source.js file seam

Sibling to lib/transcript-source.js, same normalized return shape. Text only
(.txt/.md) with a 10 MB ceiling so a PDF passed by mistake cannot reach Opus.

normalizeFileText deliberately preserves blank lines where
normalizeTranscriptText collapses them — paragraph boundaries are what the
chunker packs on."
```

---

### Task 2: `chunkText` — word-budget packing over paragraph boundaries

**Files:**
- Modify: `lib/marketing-learner.js` (append after `buildConstraintBlock`, ~line 100)
- Create: `tests/lib/chunk-text.test.js`

**Interfaces:**
- Consumes: nothing from Task 1 (pure string function).
- Produces: `chunkText(text, { maxWords = 4500, overlapWords = 200, splitOn = null }) → Array<{ index: number, total: number, label: string, text: string }>`

- [ ] **Step 1: Write the failing test**

Create `tests/lib/chunk-text.test.js`:

```js
import { strict as assert } from 'node:assert';
import { chunkText } from '../../lib/marketing-learner.js';

const words = (n, w = 'w') => Array.from({ length: n }, () => w).join(' ');

// ── short input is exactly one chunk ────────────────────────────────────────
{
  const out = chunkText('One short paragraph.', { maxWords: 100 });
  assert.equal(out.length, 1);
  assert.equal(out[0].index, 0);
  assert.equal(out[0].total, 1);
  assert.equal(out[0].label, 'part 1 of 1');
  assert.equal(out[0].text, 'One short paragraph.');
}

// ── packs to the budget and never splits a paragraph ────────────────────────
{
  const text = [words(60, 'a'), words(60, 'b'), words(60, 'c')].join('\n\n');
  const out = chunkText(text, { maxWords: 100, overlapWords: 0 });
  assert.equal(out.length, 3, '60+60 exceeds 100, so each paragraph lands in its own chunk');
  assert.ok(out[0].text.startsWith('a a'), 'chunk 0 is the a-paragraph');
  assert.ok(out[1].text.startsWith('b b'), 'chunk 1 is the b-paragraph');
  for (const c of out) {
    assert.ok(!/a a.*b b/s.test(c.text), 'no chunk contains two whole paragraphs at this budget');
  }
}

// ── a single paragraph over budget becomes its own oversized chunk ──────────
{
  const out = chunkText(words(500, 'z'), { maxWords: 100, overlapWords: 0 });
  assert.equal(out.length, 1, 'paragraphs are never split mid-paragraph, even over budget');
  assert.equal(out[0].text.split(' ').length, 500);
}

// ── overlap: chunk N+1 opens with the tail of chunk N ───────────────────────
{
  const text = [words(60, 'a'), words(60, 'b')].join('\n\n');
  const out = chunkText(text, { maxWords: 100, overlapWords: 10 });
  assert.equal(out.length, 2);
  assert.ok(out[1].text.startsWith(words(10, 'a')), 'chunk 1 opens with the last 10 words of chunk 0');
  assert.ok(out[1].text.includes('b b'), 'and still carries its own paragraph');
}

// ── index/total are correct and sequential across every chunk ───────────────
{
  const text = Array.from({ length: 6 }, (_, i) => words(60, `p${i}`)).join('\n\n');
  const out = chunkText(text, { maxWords: 100, overlapWords: 0 });
  out.forEach((c, i) => {
    assert.equal(c.index, i);
    assert.equal(c.total, out.length);
  });
}

// ── splitOn: a match STARTS a chunk, its text becomes the label ─────────────
{
  const text = 'Chapter One\n\nalpha body\n\nChapter Two\n\nbeta body';
  const out = chunkText(text, { maxWords: 1000, splitOn: '^Chapter ' });
  assert.equal(out.length, 2);
  assert.equal(out[0].label, 'Chapter One');
  assert.ok(out[0].text.includes('alpha body'), 'heading line is kept at the top of its own chunk');
  assert.equal(out[1].label, 'Chapter Two');
  assert.ok(out[1].text.includes('beta body'));
}

// ── splitOn still respects maxWords; oversized sections sub-pack and label ──
{
  const text = `Chapter One\n\n${words(60, 'a')}\n\n${words(60, 'b')}`;
  const out = chunkText(text, { maxWords: 70, overlapWords: 0, splitOn: '^Chapter ' });
  assert.equal(out.length, 2, 'one long chapter must not become a single oversized call');
  assert.equal(out[0].label, 'Chapter One (part 1 of 2)');
  assert.equal(out[1].label, 'Chapter One (part 2 of 2)');
}

// ── empty / whitespace-only input yields no chunks rather than one blank one ─
{
  assert.deepEqual(chunkText('', { maxWords: 10 }), []);
  assert.deepEqual(chunkText('   \n\n   ', { maxWords: 10 }), []);
}

console.log('✓ chunkText tests pass');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/lib/chunk-text.test.js`
Expected: FAIL — `chunkText is not a function`

- [ ] **Step 3: Write the implementation**

Append to `lib/marketing-learner.js` immediately after `buildConstraintBlock` (before `const SHRINK_FLOOR`):

```js
const countWords = (s) => String(s).split(/\s+/).filter(Boolean).length;

/** Last `n` words of a chunk, prepended to the next one as its own paragraph. */
function overlapTail(prevChunk, n) {
  if (n <= 0) return [];
  const w = String(prevChunk).split(/\s+/).filter(Boolean);
  return w.length ? [w.slice(-n).join(' ')] : [];
}

/** Greedily pack blank-line-delimited paragraphs up to `maxWords`. */
function packParagraphs(text, maxWords, overlapWords) {
  const paras = String(text).split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  if (!paras.length) return [];

  const chunks = [];
  let cur = [];
  let count = 0;

  for (const p of paras) {
    const n = countWords(p);
    // `count &&` is load-bearing: a lone paragraph over budget must still be
    // emitted rather than flushing an empty chunk ahead of itself. Paragraphs
    // are never split, so an oversized one becomes its own oversized chunk.
    if (count && count + n > maxWords) {
      const finished = cur.join('\n\n');
      chunks.push(finished);
      cur = overlapTail(finished, overlapWords);
      count = countWords(cur.join('\n\n'));
    }
    cur.push(p);
    count += n;
  }
  if (cur.length) chunks.push(cur.join('\n\n'));
  return chunks;
}

/** Split on a heading regex; each match STARTS a section and becomes its label. */
function splitSections(text, splitOn) {
  const re = new RegExp(splitOn);
  const sections = [];
  let cur = null;
  for (const line of String(text).split('\n')) {
    const trimmed = line.trim();
    if (trimmed && re.test(trimmed)) {
      if (cur) sections.push(cur);
      cur = { label: trimmed, lines: [line] };
    } else if (cur) {
      cur.lines.push(line);
    } else {
      cur = { label: null, lines: [line] };
    }
  }
  if (cur) sections.push(cur);
  return sections
    .map((s) => ({ label: s.label, text: s.lines.join('\n') }))
    .filter((s) => s.text.trim());
}

/**
 * Split long source text into extraction-sized chunks.
 *
 * Word-budget packing over paragraph boundaries is the default, NOT chapter
 * detection. Confirmed against the real $100M Money Models conversion: every
 * chapter repeats "Description" / "Examples" / "Important Notes" / "Summary
 * Points" — 44 headings that are indistinguishable by shape from the ~22 real
 * chapter titles, so a Title-Case heading regex splits that book into ~65
 * chunks. A misfiring regex has no error and no warning; the operator finds out
 * from the bill. `--split-on` stays opt-in for files that genuinely have clean
 * headings.
 *
 * A 200-word overlap means a tactic straddling a boundary appears whole in at
 * least one chunk. It creates duplicates on purpose — consolidateTactics merges
 * them.
 */
export function chunkText(text, { maxWords = 4500, overlapWords = 200, splitOn = null } = {}) {
  const sections = splitOn
    ? splitSections(text, splitOn)
    : [{ label: null, text: String(text ?? '') }];

  const flat = [];
  for (const section of sections) {
    const packed = packParagraphs(section.text, maxWords, overlapWords);
    packed.forEach((chunk, i) => {
      const label = section.label
        ? (packed.length > 1 ? `${section.label} (part ${i + 1} of ${packed.length})` : section.label)
        : null;
      flat.push({ label, text: chunk });
    });
  }

  return flat.map((c, i) => ({
    index: i,
    total: flat.length,
    label: c.label ?? `part ${i + 1} of ${flat.length}`,
    text: c.text,
  }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/lib/chunk-text.test.js`
Expected: PASS, ending `✓ chunkText tests pass`

- [ ] **Step 5: Verify against the real book**

Run:
```bash
node -e "
import('./lib/marketing-learner.js').then(async (m) => {
  const { readFileSync } = await import('node:fs');
  const t = readFileSync('digitalassets/100m-money-models.txt','utf8');
  const c = m.chunkText(t);
  console.log('chunks:', c.length);
  console.log('word counts:', c.map(x => x.text.split(/\s+/).length).join(', '));
});"
```
Expected: **11 chunks**, each 3,716–4,477 words (measured 2026-07-28). Note the loader
normalizes first, so the check must pipe through `normalizeFileText`.
If this prints a wildly different count, stop — the spec's cost table assumes 11.

- [ ] **Step 6: Run the full suite, then commit**

Run: `npm test` → 0 fail.

```bash
WT=/Users/seanfillmore/Code/Claude/.claude/worktrees/marketing-learner-file-source
git -C $WT add lib/marketing-learner.js tests/lib/chunk-text.test.js
git -C $WT commit -m "feat(marketing-learner): add chunkText word-budget chunker

Packs blank-line paragraphs up to maxWords, never splitting a paragraph, with
a 200-word overlap so a tactic straddling a boundary survives whole in one
chunk. --split-on is opt-in: the real book's repeated Description/Examples/
Important Notes/Summary Points headings would split it into ~65 chunks
instead of ~22 chapters.

Verified: 10 chunks over digitalassets/100m-money-models.txt."
```

---

### Task 3: Generalize provenance from `videoId` to a locator

**Files:**
- Modify: `lib/marketing-learner.js` — `renderSkillMarkdown` (~line 149), `buildConstraintBlock` (~line 65), `buildExtractionPrompt` (~line 226), `mergeSkillContent` tactic block + prompt rule (~lines 473–496)
- Modify: `tests/agents/marketing-learner.test.js` (add assertions; do not delete existing ones)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `renderSkillMarkdown({ name, description, tactics })` where each `tactic.source` is
    `{ creator, title, locator }`. `locator` replaces `videoId`.
  - `buildConstraintBlock({ sourceType = 'video' } = {})`
  - `buildExtractionPrompt({ video, inventory, chunk = null })`

**Critical:** the video-form output must stay **byte-identical** so the 8 existing skills
see no diff churn when next edited.

- [ ] **Step 1: Write the failing test**

Append to `tests/agents/marketing-learner.test.js` (before its final `console.log`):

```js
// ── provenance locator: video form is byte-identical to what shipped ────────
{
  const md = renderSkillMarkdown({
    name: 'marketing-x', description: 'd',
    tactics: [{ claim: 'c', mechanism: 'm', evidence: 'e', rscFit: { score: 8, reasoning: 'r' },
      source: { creator: 'Alex Becker', title: 'How I Scaled', locator: 'dQw4w9WgXcQ' } }],
  });
  assert.ok(md.includes('*Source: Alex Becker — "How I Scaled" (dQw4w9WgXcQ)*'),
    'video provenance line is unchanged');
}

// ── book form renders the book locator ──────────────────────────────────────
{
  const md = renderSkillMarkdown({
    name: 'marketing-x', description: 'd',
    tactics: [{ claim: 'c', mechanism: 'm', rscFit: { score: 8, reasoning: 'r' },
      source: { creator: 'Alex Hormozi', title: '$100M Money Models', locator: 'book, part 7 of 10' } }],
  });
  assert.ok(md.includes('*Source: Alex Hormozi — "$100M Money Models" (book, part 7 of 10)*'));
}

// ── missing source degrades, never throws ───────────────────────────────────
{
  const md = renderSkillMarkdown({ name: 'marketing-x', description: 'd',
    tactics: [{ claim: 'c', mechanism: 'm', rscFit: { score: 1, reasoning: 'r' } }] });
  assert.ok(md.includes('*Source: unknown — "untitled" (n/a)*'));
}

// ── constraint block gains a durability note for files only ─────────────────
{
  const video = buildConstraintBlock({ sourceType: 'video' });
  const file = buildConstraintBlock({ sourceType: 'file' });
  assert.equal(buildConstraintBlock(), video, 'default is the video form');
  assert.ok(!/durable principle rather than platform mechanics/.test(video));
  assert.ok(/durable principle rather than platform mechanics/.test(file));
  for (const b of [video, file]) {
    assert.ok(/\$50\.46/.test(b), 'AOV survives in both');
    assert.ok(/Platform mechanics/.test(b), 'decay table survives in both');
  }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/agents/marketing-learner.test.js`
Expected: FAIL — the book-locator assertion fails (renders `(n/a)`), and
`buildConstraintBlock({sourceType:'file'})` has no durability sentence.

- [ ] **Step 3: Make the four edits**

**3a.** In `renderSkillMarkdown`, replace the source line:

```js
    const s = t.source ?? {};
    lines.push(`*Source: ${s.creator ?? 'unknown'} — "${s.title ?? 'untitled'}" (${s.locator ?? 'n/a'})*`, '');
```

**3b.** Change the `buildConstraintBlock` signature and append the file note. Replace
`export function buildConstraintBlock() {` with:

```js
export function buildConstraintBlock({ sourceType = 'video' } = {}) {
  const durability = sourceType === 'file'
    ? `\n\nThis source is a book, not a platform-era video. Treat its content as durable ` +
      `principle rather than platform mechanics unless a passage names a specific platform, ` +
      `product, or feature — those passages still decay at the fast rate above.`
    : '';
  return `## Real Skin Care — operating reality
```

…and change the final line of the returned template from:

```js
which class the tactic falls into.`;
```

to:

```js
which class the tactic falls into.${durability}`;
```

**3c.** In `buildExtractionPrompt`, accept an optional chunk and use `sourceId`. Replace the
signature and the `dateLine`/metadata region:

```js
export function buildExtractionPrompt({ video, inventory = [], chunk = null }) {
  const dateLine = video.publishedAt
    ? `Published: ${video.publishedAt}`
    : 'Published: the publish date is unknown — infer era from the transcript and report it in recencySignals.';

  const sourceId = video.sourceId ?? video.videoId;
  const chunkLine = chunk
    ? `\nThis is an EXCERPT of a longer work: ${chunk.label} (${chunk.index + 1} of ${chunk.total}). ` +
      `Extract only what THIS excerpt supports. Do not speculate about the rest of the work — ` +
      `a later step reconciles every excerpt.`
    : '';
```

Then in the same function, replace the metadata block and the JSON `videoId` field:

```js
Title: ${video.title ?? 'unknown'}
Creator: ${video.creator ?? 'unknown'}
${dateLine}
Duration: ${video.durationSeconds ? Math.round(video.durationSeconds / 60) + ' minutes' : 'unknown'}${chunkLine}

<transcript>
${chunk ? chunk.text : video.text}
</transcript>
```

and

```js
  "sourceId": "${sourceId}",
```

Also update the `buildConstraintBlock()` call inside it to
`buildConstraintBlock({ sourceType: video.sourceType })`.

**3d.** In `mergeSkillContent`, fix the tactic block and the prompt rule so the merge LLM
does not "correct" book provenance into video shape. Replace:

```js
    `  Source: ${t.source.creator} — "${t.source.title}" (${t.source.videoId})`
```
with
```js
    `  Source: ${t.source.creator} — "${t.source.title}" (${t.source.locator})`
```

and replace the prompt rule:

```js
- Every claim keeps inline provenance in the form: *Source: Creator — "Title" (locator)*
  where the locator is whatever the tactic above carries — a YouTube id for a video, or
  something like \`book, part 7 of 10\` for a book. Copy it verbatim; never invent or reshape it.
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/agents/marketing-learner.test.js`
Expected: PASS.

- [ ] **Step 5: Prove the existing skills see no churn**

Run:
```bash
node -e "
import('./lib/marketing-learner.js').then((m) => {
  const inv = m.scanSkillInventory('.claude/skills');
  console.log('skills scanned:', inv.length);
  const n = inv.reduce((a,s) => a + (s.content.match(/\*Source: /g)||[]).length, 0);
  console.log('existing provenance lines:', n);
});"
```
Expected: 8 skills, a non-zero provenance count, no throw. This confirms the renderer
change did not alter the format the on-disk skills already use.

- [ ] **Step 6: Run the full suite, then commit**

Run: `npm test` → 0 fail.

```bash
WT=/Users/seanfillmore/Code/Claude/.claude/worktrees/marketing-learner-file-source
git -C $WT add lib/marketing-learner.js tests/agents/marketing-learner.test.js
git -C $WT commit -m "refactor(marketing-learner): provenance locator replaces videoId

renderSkillMarkdown, buildExtractionPrompt and mergeSkillContent now carry a
generic locator. The video form is byte-identical to what shipped, so the 8
existing skills see no diff churn.

mergeSkillContent's prompt previously hardcoded (videoId) as the provenance
shape — left alone it would have 'corrected' book provenance into video shape
on the first edit.

buildConstraintBlock({sourceType:'file'}) adds one durability sentence; the
decay table is unchanged for both source types."
```

---

### Task 4: CLI — `--file` mode and bare-`YYYY` `--published`

**Files:**
- Modify: `agents/marketing-learner/index.js` — `VALUE_FLAGS`/`FLAGS` (~line 61, 79), `parseArgs` (~line 81)
- Modify: `lib/marketing-learner.js` — `parsePublishedFlags` (~line 22)
- Modify: `tests/agents/marketing-learner-cli.test.js`

**Interfaces:**
- Consumes: `slugify`, `TextSourceError` from Task 1 (not yet wired — Task 6 does that).
- Produces: `parseArgs(argv)` returning `{ urls, published, file, author, title, chunkWords, splitOn, extractOnly, noPr, refetch, falsify, claim, reason }`;
  `parsePublishedFlags(urls, flags, { today, allowYearOnly = false })`.

- [ ] **Step 1: Write the failing test**

Append to `tests/agents/marketing-learner-cli.test.js` (before its final `console.log`):

```js
// ── --file requires author and title ────────────────────────────────────────
{
  assert.throws(() => parseArgs(['--file', 'b.txt']), /--author is required/);
  assert.throws(() => parseArgs(['--file', 'b.txt', '--author', 'A']), /--title is required/);
  const a = parseArgs(['--file', 'b.txt', '--author', 'A', '--title', 'T']);
  assert.equal(a.file, 'b.txt');
  assert.equal(a.author, 'A');
  assert.equal(a.title, 'T');
  assert.deepEqual(a.urls, []);
}

// ── --file is a mode, not a batch member ────────────────────────────────────
{
  assert.throws(() => parseArgs(['--file', 'b.txt', '--author', 'A', '--title', 'T', 'https://youtu.be/aaaaaaaaaaa']),
    /cannot be combined with URLs/);
  assert.throws(() => parseArgs(['--file', 'b.txt', '--author', 'A', '--title', 'T', '--falsify', 'marketing-x']),
    /cannot be combined/);
}

// ── chunking knobs parse, with defaults ─────────────────────────────────────
{
  const d = parseArgs(['--file', 'b.txt', '--author', 'A', '--title', 'T']);
  assert.equal(d.chunkWords, 4500, 'default budget');
  assert.equal(d.splitOn, null);
  const c = parseArgs(['--file', 'b.txt', '--author', 'A', '--title', 'T', '--chunk-words', '2000', '--split-on', '^Chapter ']);
  assert.equal(c.chunkWords, 2000);
  assert.equal(c.splitOn, '^Chapter ');
  assert.throws(() => parseArgs(['--file', 'b.txt', '--author', 'A', '--title', 'T', '--chunk-words', 'lots']),
    /--chunk-words must be a positive integer/);
}

// ── author/title/chunk flags are meaningless without --file ─────────────────
{
  assert.throws(() => parseArgs(['https://youtu.be/aaaaaaaaaaa', '--author', 'A']), /only valid with --file/);
  assert.throws(() => parseArgs(['https://youtu.be/aaaaaaaaaaa', '--chunk-words', '10']), /only valid with --file/);
}
```

And append to `tests/agents/marketing-learner.test.js`:

```js
// ── bare YYYY: allowed for files, rejected for videos ───────────────────────
{
  const ok = parsePublishedFlags(['book.txt'], ['2025'], { today: '2026-07-28', allowYearOnly: true });
  assert.equal(ok[0].publishedAt, '2025', 'a copyright page carries a year, not a date');

  assert.throws(
    () => parsePublishedFlags(['https://youtu.be/aaaaaaaaaaa'], ['2025'], { today: '2026-07-28' }),
    /YYYY-MM-DD/,
    'a video has a real upload date; a bare year there would be invented precision',
  );

  assert.throws(
    () => parsePublishedFlags(['book.txt'], ['2099'], { today: '2026-07-28', allowYearOnly: true }),
    /in the future/,
  );

  const stale = parsePublishedFlags(['book.txt'], ['2015'], { today: '2026-07-28', allowYearOnly: true });
  assert.ok(/older than 4 years/.test(stale[0].warning), 'staleness warning still fires on a year');
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/agents/marketing-learner-cli.test.js tests/agents/marketing-learner.test.js`
Expected: FAIL — `--file` is an unknown flag; `allowYearOnly` is ignored.

- [ ] **Step 3: Implement `parsePublishedFlags` year support**

In `lib/marketing-learner.js`, change the signature and the date-validation block:

```js
export function parsePublishedFlags(urls, publishedFlags = [], { today = null, allowYearOnly = false } = {}) {
```

Then replace the format check inside the `map` with:

```js
    const isYearOnly = allowYearOnly && /^\d{4}$/.test(raw);
    if (!isYearOnly && !/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
      throw new Error(
        `--published "${raw}" must be in YYYY-MM-DD form` +
        (allowYearOnly ? ' (or a bare YYYY for a file source).' : '.'),
      );
    }
    // A bare year is compared at Jan 1: a 2026 copyright is not "in the future"
    // in mid-2026, and staleness is judged from the start of the year.
    const iso = isYearOnly ? `${raw}-01-01` : raw;
    const d = new Date(`${iso}T00:00:00Z`);
    if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== iso) {
      throw new Error(`--published "${raw}" is not a real calendar date.`);
    }
```

The remaining future/stale checks and the `return { url, publishedAt: raw, warning }` are
unchanged — `publishedAt` keeps the operator's original form (`2025`, not `2025-01-01`).

- [ ] **Step 4: Implement the CLI flags**

In `agents/marketing-learner/index.js`, extend the flag tables:

```js
const VALUE_FLAGS = {
  '--published': 'published', '--falsify': 'falsify', '--claim': 'claim', '--reason': 'reason',
  '--file': 'file', '--author': 'author', '--title': 'title',
  '--chunk-words': 'chunkWords', '--split-on': 'splitOn',
};
```

In `parseArgs`, extend the defaults:

```js
  const out = {
    urls: [], published: [], extractOnly: false, noPr: false, refetch: false,
    falsify: null, claim: null, reason: null,
    file: null, author: null, title: null, chunkWords: 4500, splitOn: null,
  };
```

Then insert this validation block immediately **after** the existing `--falsify` block
returns and **before** `if (out.claim || out.reason)`:

```js
  const fileOnlyFlags = ['author', 'title', 'splitOn'];
  if (out.file) {
    if (!out.author) throw new Error('--file requires --author "<name>" — it is the provenance on every claim.');
    if (!out.title) throw new Error('--file requires --title "<title>" — it is the provenance on every claim.');
    if (out.urls.length) throw new Error('--file cannot be combined with URLs — it is a separate mode. Run once per source.');
    const n = Number(out.chunkWords);
    if (!Number.isInteger(n) || n <= 0) throw new Error(`--chunk-words must be a positive integer, got "${out.chunkWords}".`);
    out.chunkWords = n;
    return out;
  }

  for (const f of fileOnlyFlags) {
    if (out[f]) throw new Error(`--${f === 'splitOn' ? 'split-on' : f} is only valid with --file.`);
  }
  if (out.chunkWords !== 4500) throw new Error('--chunk-words is only valid with --file.');
```

Finally, extend the `--falsify` mutual-exclusion check to name `--file`:

```js
    if (out.urls.length || out.file) throw new Error('--falsify cannot be combined with URLs or --file — it is a separate mode.');
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test tests/agents/marketing-learner-cli.test.js tests/agents/marketing-learner.test.js`
Expected: PASS.

- [ ] **Step 6: Run the full suite, then commit**

Run: `npm test` → 0 fail.

```bash
WT=/Users/seanfillmore/Code/Claude/.claude/worktrees/marketing-learner-file-source
git -C $WT add agents/marketing-learner/index.js lib/marketing-learner.js tests/agents/
git -C $WT commit -m "feat(marketing-learner): --file mode and bare-YYYY --published

--file is a mode, not a batch member: combining it with URLs or --falsify is
an error. --author and --title are required because there is no metadata
endpoint for a local file — those two flags ARE the provenance.

--published accepts a bare YYYY for file sources only. A copyright page
carries a year; requiring 2025-01-01 would manufacture a false month and day,
which is the same invented-precision failure the one-date-many-URLs rule
already rejects. A video has a real upload date, so bare YYYY stays refused
there."
```

---

### Task 5: Cross-chunk consolidation and its guard

**Files:**
- Modify: `lib/marketing-learner.js` (append after `extractTactics`, ~line 407)
- Create: `tests/lib/consolidate-tactics.test.js`

**Interfaces:**
- Consumes: `validateExtraction`, `parseJsonBlock`, `EXTRACTION_MODEL` (existing, same file).
- Produces:
  - `buildConsolidationPrompt({ candidates, source }) → string`
  - `validateConsolidation(candidates, consolidated) → consolidated` (throws)
  - `consolidateTactics({ candidates, source, client, maxTokens = 16000 }) → { tactics: [...] }`

Each candidate is an extraction tactic with an added `chunk: { index, label }`.
Each consolidated tactic adds `mergedFrom: [{ candidateIndex, label }]`.

- [ ] **Step 1: Write the failing test**

Create `tests/lib/consolidate-tactics.test.js`:

```js
import { strict as assert } from 'node:assert';
import { buildConsolidationPrompt, validateConsolidation, consolidateTactics } from '../../lib/marketing-learner.js';

const candidate = (i, claim) => ({
  claim, mechanism: 'm', evidence: 'e',
  rscFit: { score: 7, reasoning: 'r' }, verdict: 'adopt',
  targetSkill: { name: 'marketing-offer-construction', action: 'edit', description: 'Use when …' },
  chunk: { index: i, label: `part ${i + 1} of 3` },
});
const CANDIDATES = [candidate(0, 'Bill weekly'), candidate(1, 'Use four-week cycles'), candidate(2, 'Waive the setup fee')];

const group = (claim, idxs) => ({
  claim, mechanism: 'm', evidence: 'e',
  rscFit: { score: 8, reasoning: 'r' }, verdict: 'adopt',
  targetSkill: { name: 'marketing-offer-construction', action: 'edit', description: 'Use when …' },
  mergedFrom: idxs.map((i) => ({ candidateIndex: i, label: CANDIDATES[i].chunk.label })),
});

// ── a legitimate merge passes ───────────────────────────────────────────────
{
  const ok = { tactics: [group('Bill every four weeks', [0, 1]), group('Waive the setup fee', [2])] };
  assert.equal(validateConsolidation(CANDIDATES, ok), ok);
}

// ── a dropped candidate throws and names it ─────────────────────────────────
{
  const dropped = { tactics: [group('Bill every four weeks', [0, 1])] };
  assert.throws(() => validateConsolidation(CANDIDATES, dropped),
    /dropped 1 candidate.*Waive the setup fee/s);
}

// ── a double-claimed candidate throws ───────────────────────────────────────
{
  const doubled = { tactics: [group('A', [0, 1]), group('B', [1, 2])] };
  assert.throws(() => validateConsolidation(CANDIDATES, doubled),
    /double-claimed.*Use four-week cycles/s);
}

// ── structural failures throw ───────────────────────────────────────────────
{
  assert.throws(() => validateConsolidation(CANDIDATES, {}), /tactics must be an array/);
  assert.throws(() => validateConsolidation(CANDIDATES, { tactics: [{ ...group('A', [0]), mergedFrom: [] }] }),
    /has no mergedFrom/);
  assert.throws(() => validateConsolidation(CANDIDATES, { tactics: [group('A', [0]), group('B', [1]), { ...group('C', [2]), mergedFrom: [{ candidateIndex: 9 }] }] }),
    /candidateIndex 9/);
}

// ── the prompt carries every candidate, indexed ─────────────────────────────
{
  const p = buildConsolidationPrompt({ candidates: CANDIDATES, source: { title: 'Book', creator: 'A', sourceType: 'file' } });
  for (let i = 0; i < CANDIDATES.length; i++) assert.ok(p.includes(`[${i}]`), `candidate ${i} is indexed`);
  assert.ok(p.includes('Bill weekly') && p.includes('Waive the setup fee'));
  assert.ok(/mergedFrom/.test(p), 'the required output field is named');
  assert.ok(/every candidate.*exactly one/is.test(p), 'the no-drop rule is stated');
}

// ── consolidateTactics: refuses truncated output ────────────────────────────
{
  const client = { messages: { create: async () => ({ stop_reason: 'max_tokens', content: [] }) } };
  await assert.rejects(
    () => consolidateTactics({ candidates: CANDIDATES, source: { title: 'B', creator: 'A' }, client }),
    /hit max_tokens/,
  );
}

// ── consolidateTactics: happy path returns validated output ─────────────────
{
  const payload = { tactics: [group('Bill every four weeks', [0, 1]), group('Waive the setup fee', [2])] };
  const client = { messages: { create: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(payload) }] }) } };
  const out = await consolidateTactics({ candidates: CANDIDATES, source: { title: 'B', creator: 'A' }, client });
  assert.equal(out.tactics.length, 2);
  assert.deepEqual(out.tactics[0].mergedFrom.map((m) => m.candidateIndex), [0, 1]);
}

// ── consolidateTactics: guard trip carries the payload for inspection ───────
{
  const bad = { tactics: [group('only one', [0])] };
  const client = { messages: { create: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(bad) }] }) } };
  await assert.rejects(
    () => consolidateTactics({ candidates: CANDIDATES, source: { title: 'B', creator: 'A' }, client }),
    (e) => /dropped 2 candidate/.test(e.message) && e.offendingPayload?.tactics?.length === 1,
  );
}

console.log('✓ consolidateTactics tests pass');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/lib/consolidate-tactics.test.js`
Expected: FAIL — `buildConsolidationPrompt is not a function`

- [ ] **Step 3: Write the implementation**

Append to `lib/marketing-learner.js` after `extractTactics`:

```js
export function buildConsolidationPrompt({ candidates, source }) {
  const block = candidates.map((t, i) => (
    `[${i}] (${t.chunk?.label ?? 'unknown excerpt'})\n` +
    `  Claim: ${t.claim}\n  Mechanism: ${t.mechanism}\n  Evidence: ${t.evidence ?? 'assertion only'}\n` +
    `  Verdict: ${t.verdict} — ${t.rscFit.score}/10: ${t.rscFit.reasoning}` +
    (t.targetSkill ? `\n  Target skill: ${t.targetSkill.name} (${t.targetSkill.action})` : '')
  )).join('\n\n');

  return `You are consolidating marketing tactics extracted from separate excerpts of ONE work.

Source: ${source.creator ?? 'unknown'} — "${source.title ?? 'untitled'}"

Because the work was processed in excerpts, the SAME tactic frequently appears more than
once: chapters restate their own points in summary blocks, closing chapters restate the
whole work, and consecutive excerpts overlap on purpose. Your job is to collapse those
restatements into one canonical tactic each.

## Candidates

${block}

## Rules

- Merge candidates that are the same tactic, INCLUDING near-variants worded differently.
  "Bill weekly" and "use four-week billing cycles" are one tactic, not two.
- Do NOT merge tactics that merely share a topic. Two distinct plays about pricing are two tactics.
- For each canonical tactic, keep the BEST-stated claim, mechanism, and evidence across the
  candidates it came from — usually the fullest statement, not the first.
- Keep the highest rscFit score among the merged candidates and write reasoning that holds
  for the merged whole.
- **Every candidate index must appear in exactly one canonical tactic's mergedFrom. Not zero,
  not two.** A candidate you think is worthless is still a candidate: keep it as its own
  tactic with verdict "reject" and a rejectReason. Dropping one is a hard error.
- Preserve verdict semantics: targetSkill is required when verdict is "adopt" and null when
  "reject"; rejectReason is required when "reject".

Return ONLY a JSON object, no prose around it:

{
  "tactics": [
    {
      "claim": "...",
      "mechanism": "...",
      "evidence": "...",
      "rscFit": { "score": 0, "reasoning": "..." },
      "verdict": "adopt" | "reject",
      "rejectReason": "required when reject, otherwise null",
      "targetSkill": { "name": "marketing-<topic-kebab>", "action": "create" | "edit", "description": "..." },
      "mergedFrom": [{ "candidateIndex": 0, "label": "the excerpt label from above" }]
    }
  ]
}`;
}

/**
 * Every candidate must land in exactly one merge group.
 *
 * This is code rather than persuasion for the same reason the falsified-claims
 * guard is: an LLM asked to merge a 60-item list can silently omit items and
 * still return well-formed, plausible output. No other guard would catch it —
 * validateSkillEdit's shrink floor only sees the final skill file, by which
 * point the dropped tactic never existed.
 */
export function validateConsolidation(candidates, consolidated) {
  if (!consolidated || !Array.isArray(consolidated.tactics)) {
    throw new Error('Consolidation result: tactics must be an array.');
  }

  const claimedBy = new Map(); // candidateIndex -> [groupIndex, …]
  consolidated.tactics.forEach((t, gi) => {
    if (!Array.isArray(t.mergedFrom) || !t.mergedFrom.length) {
      throw new Error(`Consolidated tactic ${gi} ("${t.claim}") has no mergedFrom — every canonical tactic must name the candidates it came from.`);
    }
    for (const m of t.mergedFrom) {
      const idx = m?.candidateIndex;
      if (!Number.isInteger(idx) || idx < 0 || idx >= candidates.length) {
        throw new Error(`Consolidated tactic ${gi} ("${t.claim}") references candidateIndex ${JSON.stringify(idx)}, which is not a candidate (valid: 0-${candidates.length - 1}).`);
      }
      if (!claimedBy.has(idx)) claimedBy.set(idx, []);
      claimedBy.get(idx).push(gi);
    }
  });

  const dropped = candidates.map((_, i) => i).filter((i) => !claimedBy.has(i));
  if (dropped.length) {
    throw new Error(
      `Consolidation dropped ${dropped.length} candidate tactic${dropped.length === 1 ? '' : 's'}: ` +
      dropped.map((i) => `[${i}] "${candidates[i].claim}"`).join(', ') +
      `. Every candidate must land in exactly one merge group.`,
    );
  }

  const doubled = [...claimedBy.entries()].filter(([, gs]) => gs.length > 1);
  if (doubled.length) {
    throw new Error(
      `Consolidation double-claimed ${doubled.length} candidate${doubled.length === 1 ? '' : 's'}: ` +
      doubled.map(([i, gs]) => `[${i}] "${candidates[i].claim}" appears in groups ${gs.join(' and ')}`).join('; ') + '.',
    );
  }

  validateExtraction(consolidated); // same tactic shape as a single-source extraction
  return consolidated;
}

/** One Opus call over the whole run's candidates, before anything touches a skill. */
export async function consolidateTactics({ candidates, source, client, maxTokens = 16000 }) {
  const prompt = buildConsolidationPrompt({ candidates, source });
  const res = await client.messages.create({
    model: EXTRACTION_MODEL,
    max_tokens: maxTokens,
    thinking: { type: 'adaptive' },
    messages: [{ role: 'user', content: prompt }],
  });

  if (res.stop_reason === 'max_tokens') {
    throw new Error(`Consolidation for "${source.title ?? 'untitled'}" hit max_tokens — output is truncated. Refusing to save.`);
  }

  const text = (res.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  const parsed = parseJsonBlock(text, `the consolidation response for "${source.title ?? 'untitled'}"`);
  try {
    return validateConsolidation(candidates, parsed);
  } catch (err) {
    // Same contract as extractTactics: the operator has already paid for this
    // call, so carry the raw payload out for the caller to persist.
    err.offendingPayload = parsed;
    throw err;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/lib/consolidate-tactics.test.js`
Expected: PASS, ending `✓ consolidateTactics tests pass`

- [ ] **Step 5: Run the full suite, then commit**

Run: `npm test` → 0 fail.

```bash
WT=/Users/seanfillmore/Code/Claude/.claude/worktrees/marketing-learner-file-source
git -C $WT add lib/marketing-learner.js tests/lib/consolidate-tactics.test.js
git -C $WT commit -m "feat(marketing-learner): cross-chunk consolidation with a no-drop guard

One Opus call over the whole run's candidates, before anything touches a
skill. This is the only step that can see duplicates spanning chunks — the
existing dedup compares against already-written skills, which cannot catch a
tactic restated three times inside one run.

validateConsolidation throws unless every candidate lands in exactly one merge
group. Code rather than persuasion: an LLM merging a 60-item list can silently
omit items and still return well-formed output, and no existing guard would
notice."
```

---

### Task 6: Wire the agent — dispatch, chunk loop, caching, report/PR

**Files:**
- Modify: `agents/marketing-learner/index.js` — imports, `loadVideo` (~line 130), `processVideo` (~line 287), `openPullRequest` body (~line 440), `main` (~line 460)
- Modify: `lib/marketing-learner.js` — `renderReport` (~line 413)
- Modify: `tests/agents/marketing-learner-cli.test.js`

**Interfaces:**
- Consumes: `loadTextFile`/`TextSourceError` (Task 1), `chunkText` (Task 2), generalized
  provenance (Task 3), `parseArgs`/`parsePublishedFlags` (Task 4), `consolidateTactics` (Task 5).
- Produces: `loadSource(item, opts)`, `processFile(item, opts)`, `chunkCachePath(...)`.

- [ ] **Step 1: Write the failing test**

Append to `tests/agents/marketing-learner-cli.test.js`:

```js
// ── cache key changes when the inventory changes ────────────────────────────
{
  const { chunkCacheKey } = await import('../../agents/marketing-learner/index.js');
  const a = chunkCacheKey({ chunkText: 'body', inventoryFingerprint: 'inv-1', constraintBlock: 'cb' });
  const b = chunkCacheKey({ chunkText: 'body', inventoryFingerprint: 'inv-2', constraintBlock: 'cb' });
  const c = chunkCacheKey({ chunkText: 'other', inventoryFingerprint: 'inv-1', constraintBlock: 'cb' });
  assert.match(a, /^[0-9a-f]{16}$/, 'short hex digest');
  assert.notEqual(a, b, 'a changed skill inventory must miss the cache — otherwise run 2 writes skills from an extraction that never saw them');
  assert.notEqual(a, c, 'changed chunk text misses');
  assert.equal(a, chunkCacheKey({ chunkText: 'body', inventoryFingerprint: 'inv-1', constraintBlock: 'cb' }), 'stable');
}

// ── report renders a file source without inventing a YouTube URL ────────────
{
  const { renderReport } = await import('../../lib/marketing-learner.js');
  const md = renderReport({
    extraction: { title: 'B', creator: 'A', summary: 's', tactics: [] },
    video: { sourceId: 'b', sourceType: 'file', title: 'B', creator: 'A', publishedAt: '2025' },
    skillsTouched: [],
  });
  assert.ok(!/youtube\.com/.test(md), 'no fabricated video URL for a book');
  assert.ok(/\*\*Source:\*\* book/.test(md));

  const vid = renderReport({
    extraction: { title: 'V', creator: 'C', summary: 's', tactics: [] },
    video: { sourceId: 'abc12345678', videoId: 'abc12345678', sourceType: 'video', title: 'V', creator: 'C', publishedAt: null },
    skillsTouched: [],
  });
  assert.ok(/youtube\.com\/watch\?v=abc12345678/.test(vid), 'video reports keep their URL');
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/agents/marketing-learner-cli.test.js`
Expected: FAIL — `chunkCacheKey` is not exported; the report still prints a YouTube URL.

- [ ] **Step 3: Generalize `renderReport`**

In `lib/marketing-learner.js`, replace the header lines of `renderReport`:

```js
  const L = [];
  L.push(`# ${extraction.title ?? video.title ?? video.sourceId ?? video.videoId}`, '');
  L.push(`**Creator:** ${extraction.creator ?? video.creator ?? 'unknown'}  `);
  L.push(video.sourceType === 'file'
    ? `**Source:** book — \`${video.sourceId}\`  `
    : `**Video:** https://www.youtube.com/watch?v=${video.videoId}  `);
  L.push(`**Published:** ${video.publishedAt ?? 'unknown (not supplied via --published)'}  `);
```

And in the adopted-tactic loop, surface the merge provenance when present (insert after the
`**Target skill:**` line):

```js
      if (t.mergedFrom?.length) {
        L.push(`**Merged from:** ${t.mergedFrom.map((m) => m.label).join('; ')}`, '');
      }
```

- [ ] **Step 4: Wire the agent**

In `agents/marketing-learner/index.js`:

**4a.** Extend imports:

```js
import { createHash } from 'node:crypto';
import { loadTextFile, TextSourceError } from '../../lib/text-source.js';
```
and add `chunkText, consolidateTactics, buildConstraintBlock` to the existing
`lib/marketing-learner.js` import list.

**4b.** Add the cache key helper next to `loadVideo`:

```js
/**
 * Cache key for one chunk's extraction.
 *
 * The skill inventory is in the hash deliberately. If skills changed between
 * runs the extraction prompt changed, so the cache MUST miss — otherwise run 2
 * writes skills from an extraction that never saw the current inventory and the
 * anti-duplication mechanism silently stops working.
 */
export function chunkCacheKey({ chunkText: body, inventoryFingerprint, constraintBlock }) {
  return createHash('sha256')
    .update(body).update(' ')
    .update(inventoryFingerprint).update(' ')
    .update(constraintBlock)
    .digest('hex')
    .slice(0, 16);
}
```

**4c.** Add the file loader beside `loadVideo`:

```js
function loadFile(item) {
  const source = loadTextFile(item.file, {
    author: item.author, title: item.title, publishedAt: item.publishedAt,
  });
  console.log(`  (${source.text.split(/\s+/).length.toLocaleString()} words from ${item.file})`);
  return source;
}
```

**4d.** Add `processFile`, mirroring `processVideo`. Place it directly after `processVideo`:

```js
async function processFile(item, { client, args }) {
  const source = loadFile(item);
  if (item.warning) console.warn(`  ⚠ ${item.warning}`);

  const chunks = chunkText(source.text, {
    maxWords: args.chunkWords, splitOn: args.splitOn,
  });
  console.log(`  ${chunks.length} chunk${chunks.length === 1 ? '' : 's'} at ${args.chunkWords} words`);

  const inventory = scanSkillInventory(SKILLS_DIR);
  const inventoryFingerprint = createHash('sha256')
    .update(inventory.map((s) => `${s.name} ${s.content}`).join(''))
    .digest('hex');
  const constraintBlock = buildConstraintBlock({ sourceType: 'file' });

  const cacheDir = join(CORPUS_DIR, source.sourceId, 'chunks');
  mkdirSync(cacheDir, { recursive: true });

  const candidates = [];
  for (const chunk of chunks) {
    const key = chunkCacheKey({ chunkText: chunk.text, inventoryFingerprint, constraintBlock });
    const cachePath = join(cacheDir, `${String(chunk.index).padStart(3, '0')}-${key}.json`);

    let extraction = null;
    if (!args.refetch && existsSync(cachePath)) {
      try {
        extraction = JSON.parse(readFileSync(cachePath, 'utf8'));
        console.log(`  ${chunk.label}: cached`);
      } catch {
        console.warn(`  ⚠ cached chunk at ${cachePath} is corrupt (partial write?) — re-extracting`);
      }
    }

    if (!extraction) {
      console.log(`  ${chunk.label}: extracting…`);
      try {
        extraction = await extractTactics({ video: source, inventory, chunk, client });
      } catch (err) {
        if (err.offendingPayload !== undefined) {
          const badPath = join(cacheDir, `invalid-${chunk.index}-${Date.now()}.json`);
          writeFileSync(badPath, JSON.stringify(err.offendingPayload, null, 2));
          console.error(`  ✗ schema validation failed — payload saved to ${relative(ROOT, badPath)}`);
        }
        throw err;
      }
      writeFileSync(cachePath, JSON.stringify(extraction, null, 2));
    }

    for (const t of extraction.tactics) {
      candidates.push({ ...t, chunk: { index: chunk.index, label: chunk.label } });
    }
  }

  console.log(`  ${candidates.length} candidate tactics across ${chunks.length} chunks — consolidating…`);

  const consolidatedPath = join(
    CORPUS_DIR, source.sourceId,
    `consolidated-${createHash('sha256').update(JSON.stringify(candidates)).digest('hex').slice(0, 16)}.json`,
  );

  let extraction;
  if (!args.refetch && existsSync(consolidatedPath)) {
    try {
      extraction = JSON.parse(readFileSync(consolidatedPath, 'utf8'));
      console.log('  (consolidation from cache)');
    } catch {
      console.warn('  ⚠ cached consolidation is corrupt — redoing');
    }
  }
  if (!extraction) {
    try {
      extraction = await consolidateTactics({ candidates, source, client });
    } catch (err) {
      if (err.offendingPayload !== undefined) {
        const badPath = join(CORPUS_DIR, source.sourceId, `invalid-consolidation-${Date.now()}.json`);
        writeFileSync(badPath, JSON.stringify(err.offendingPayload, null, 2));
        console.error(`  ✗ consolidation guard tripped — payload saved to ${relative(ROOT, badPath)}`);
      }
      throw err;
    }
    writeFileSync(consolidatedPath, JSON.stringify(extraction, null, 2));
  }
  console.log(`  ${extraction.tactics.length} canonical tactics after consolidation`);

  return finishSource({ source, extraction, args, client });
}
```

**4e.** Extract the shared tail of `processVideo` into `finishSource` so both paths write the
report, skills and mirror identically. Replace everything in `processVideo` from
`mkdirSync(REPORT_DIR, …)` onward with `return finishSource({ source: video, extraction, args, client });`
and add:

```js
async function finishSource({ source, extraction, args, client }) {
  mkdirSync(REPORT_DIR, { recursive: true });
  const extractionJsonPath = join(REPORT_DIR, `${source.sourceId}.json`);
  writeFileSync(extractionJsonPath, JSON.stringify(extraction, null, 2));

  const adopted = extraction.tactics.filter((t) => t.verdict === 'adopt');
  const skillsTouched = [];
  let writtenPaths = [extractionJsonPath];

  if (!args.extractOnly) {
    const inventory = scanSkillInventory(SKILLS_DIR);
    const bySkill = new Map();
    for (const t of adopted) {
      const name = t.targetSkill.name;
      if (!bySkill.has(name)) bySkill.set(name, []);
      bySkill.get(name).push({
        ...t,
        source: {
          creator: source.creator,
          title: source.title,
          locator: source.sourceType === 'file'
            ? `book, ${t.mergedFrom?.[0]?.label ?? 'unknown excerpt'}`
            : source.videoId,
        },
      });
    }

    for (const [name, tactics] of bySkill) {
      const existing = inventory.find((s) => s.name === name);
      const res = await writeSkill({
        name, description: tactics[0].targetSkill.description, tactics, existing, client,
      });
      skillsTouched.push({ name, action: res.action });
      writtenPaths.push(res.path);
      writtenPaths = syncMirrorIfTouched(writtenPaths, skillsTouched);
    }
  }

  const reportPath = join(REPORT_DIR, `${source.sourceId}.md`);
  writeFileSync(reportPath, renderReport({ extraction, video: source, skillsTouched }));
  writtenPaths.push(reportPath);

  return { video: source, extraction, skillsTouched, writtenPaths };
}
```

> **Note for the implementer:** `processVideo`'s existing skill-writing loop already does the
> grouping above with `videoId` hardcoded in `source`. Move it verbatim into `finishSource`
> and change only the `source` object shown here. Do not rewrite the rest of its logic.

**4f.** In `openPullRequest`, stop assuming a YouTube URL:

```js
      const title = r.video.title ?? r.video.sourceId;
      const link = r.video.sourceType === 'file'
        ? `\`${r.video.sourceId}\` (book)`
        : `https://www.youtube.com/watch?v=${r.video.videoId}`;
      return `## ${title}\n\n${link}\n\n| Score | Verdict | Claim | Reasoning |\n|---|---|---|---|\n${rows}`;
```

**4g.** In `main`, make the TranscriptAPI key conditional and dispatch on mode. Replace the
key check and the loop:

```js
  const env = loadEnv();
  const anthropicKey = env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) {
    console.error('ANTHROPIC_API_KEY is not set. Add it to .env.');
    process.exit(1);
  }
  const client = new Anthropic({ apiKey: anthropicKey });

  // A file source needs no transcript credits, so demanding the key would block
  // book runs on a credential they never use.
  let apiKey = null;
  if (!args.file) {
    apiKey = env.TRANSCRIPTAPI_KEY || process.env.TRANSCRIPTAPI_KEY;
    if (!apiKey) {
      console.error('TRANSCRIPTAPI_KEY is not set. Add it to .env.');
      process.exit(1);
    }
  }

  const results = [];
  if (args.file) {
    const [item] = parsePublishedFlags([args.file], args.published, { allowYearOnly: true });
    console.log(`\n▶ ${args.file}`);
    results.push(await processFile(
      { ...item, file: args.file, author: args.author, title: args.title },
      { client, args },
    ));
  } else {
    const items = parsePublishedFlags(args.urls, args.published, {});
    for (const item of items) {
      console.log(`\n▶ ${item.url}`);
      try {
        results.push(await processVideo(item, { client, apiKey, args }));
      } catch (err) {
        if (err instanceof TranscriptError && ['NOT_FOUND', 'NO_ENGLISH', 'RATE_LIMIT'].includes(err.code)) {
          console.warn(`  ⏭ skipped: ${err.message}`);
          continue;
        }
        throw err;
      }
    }
  }
```

Leave the notify block below unchanged except for its title fallback:
`r.video.title ?? r.video.sourceId`.

**4h.** Make `TextSourceError` fatal with a clean message rather than a stack trace — the
bottom-of-file handler already prints `err.message`, so no change is needed there.

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test tests/agents/marketing-learner-cli.test.js`
Expected: PASS.

- [ ] **Step 6: Verify the CLI rejects bad input without spending anything**

Run each; all must exit non-zero with a readable one-line message and no API call:
```bash
node agents/marketing-learner/index.js --file nope.txt --author A --title T
node agents/marketing-learner/index.js --file ~/Downloads/_OceanofPDF.com_00M_Money_Models_How_To_Make_Money_-_Alex_Hormozi.pdf --author A --title T
node agents/marketing-learner/index.js --file digitalassets/100m-money-models.txt
```
Expected messages: `No such file`, `--file must be .txt or .md`, `--file requires --author`.

- [ ] **Step 7: Run the full suite, then commit**

Run: `npm test` → 0 fail.

```bash
WT=/Users/seanfillmore/Code/Claude/.claude/worktrees/marketing-learner-file-source
git -C $WT add agents/marketing-learner/index.js lib/marketing-learner.js tests/agents/marketing-learner-cli.test.js
git -C $WT commit -m "feat(marketing-learner): wire the file source end to end

processFile chunks, extracts per chunk with a content-addressed cache, then
consolidates once before any skill is touched. Shared tail extracted to
finishSource so video and file paths write reports, skills and the mirror
identically.

The chunk cache key hashes the skill inventory alongside the chunk text: if
skills changed between runs the prompt changed, so the cache must miss.

TRANSCRIPTAPI_KEY is now required only for URL runs — a book needs no
transcript credits and should not be blocked on a credential it never uses.
Reports and PR bodies no longer fabricate a YouTube URL for a book."
```

---

### Task 7: End-to-end run on one chapter

**Files:**
- Create: `digitalassets/_chapter-test.txt` (scratch, gitignored by `digitalassets/*`)
- Modify: `docs/superpowers/specs/2026-07-28-marketing-learner-file-source-design.md` (record the result)

**Interfaces:** consumes everything above. Produces no new code.

Repo rule #4: one real end-to-end run on a **single chapter** before the full book.

- [ ] **Step 1: Cut one chapter**

The Continuity Discount chapter holds the 8.3% note and starts near line 4060.

```bash
WT=/Users/seanfillmore/Code/Claude/.claude/worktrees/marketing-learner-file-source
cd $WT
grep -n "^Continuity Discount Offers$\|^Waived Fee Offer$" digitalassets/100m-money-models.txt
```
Use the two line numbers as `START` and `END`:
```bash
sed -n "${START},$((END-1))p" digitalassets/100m-money-models.txt > digitalassets/_chapter-test.txt
wc -w digitalassets/_chapter-test.txt   # expect ~1500-2500 → 1 chunk
```

- [ ] **Step 2: Confirm it is one chunk and ignored by git**

```bash
node -e "import('./lib/marketing-learner.js').then(async m => {
  const { readFileSync } = await import('node:fs');
  console.log('chunks:', m.chunkText(readFileSync('digitalassets/_chapter-test.txt','utf8')).length);
});"
git -C $WT status --short   # must NOT list _chapter-test.txt
```
Expected: `chunks: 1`, and a clean status.

- [ ] **Step 3: Extract-only run — no skills, no PR**

```bash
npm run learn -- --file digitalassets/_chapter-test.txt \
  --author "Alex Hormozi" --title "Money Models Chapter Test" \
  --published 2025 --extract-only
```
Expected: word count and `1 chunk` logged; one extraction; consolidation runs; report at
`data/reports/marketing-learner/money-models-chapter-test.md`.

Verify before continuing:
```bash
git -C $WT status --short          # only the report + extraction JSON, NO .claude/skills changes
grep -c "8.3\|four-week\|weekly" data/reports/marketing-learner/money-models-chapter-test.md
```
The weekly-billing tactic must appear. If it does not, stop — the chunking or prompt is
dropping the single highest-value note in the book.

- [ ] **Step 4: Re-run to prove the cache is free**

```bash
time npm run learn -- --file digitalassets/_chapter-test.txt \
  --author "Alex Hormozi" --title "Money Models Chapter Test" \
  --published 2025 --extract-only
```
Expected: `cached` and `(consolidation from cache)` logged, run finishes in seconds, no
Anthropic call. This is the property that makes the report-first gate nearly free.

- [ ] **Step 5: Skill-writing run with `--no-pr`**

```bash
npm run learn -- --file digitalassets/_chapter-test.txt \
  --author "Alex Hormozi" --title "Money Models Chapter Test" \
  --published 2025 --no-pr
```
Expected: chunk + consolidation cached (no extraction cost); one or more skills written.

Verify the provenance line is the book form, not a video form:
```bash
git -C $WT diff --stat .claude/skills/
git -C $WT diff .claude/skills/ | grep '^\+.*\*Source:'
```
Expected: `*Source: Alex Hormozi — "Money Models Chapter Test" (book, part 1 of 1)*`.
No `(n/a)`, no bare `(null)`.

- [ ] **Step 6: Revert the trial-run skill edits**

The chapter test is a rehearsal, not a real ingest — its skill edits must not ship.

```bash
git -C $WT reset                              # unstage first; checkout restores from the index
git -C $WT checkout -- .claude/skills/
git -C $WT status --short                     # skills clean
rm -f digitalassets/_chapter-test.txt
rm -rf data/marketing-corpus/money-models-chapter-test
rm -f data/reports/marketing-learner/money-models-chapter-test.*
```

> `git checkout <path>` restores from the **index**, so it will not undo staged work — hence
> the `git reset` first. This has already bitten once on this feature.

- [ ] **Step 7: Record the result in the spec and commit**

Add to the spec's Testing section:

```markdown
**End-to-end rehearsal, <DATE>.** One chapter (Continuity Discount Offers, ~N words,
1 chunk) run three ways: `--extract-only`, again to prove the cache, then `--no-pr`.
The weekly-billing tactic was extracted; provenance rendered as
`*Source: Alex Hormozi — "…" (book, part 1 of 1)*`; the second run made no Anthropic
call. Trial skill edits reverted.
```

```bash
WT=/Users/seanfillmore/Code/Claude/.claude/worktrees/marketing-learner-file-source
git -C $WT add docs/superpowers/specs/2026-07-28-marketing-learner-file-source-design.md
git -C $WT commit -m "docs: record the single-chapter end-to-end rehearsal

Repo rule #4 — one real run before any bulk use. Extract-only, cache replay,
and --no-pr skill write all verified on one chapter; trial skill edits
reverted."
```

- [ ] **Step 8: Open the PR**

```bash
WT=/Users/seanfillmore/Code/Claude/.claude/worktrees/marketing-learner-file-source
git -C $WT push -u origin feature/marketing-learner-file-source
git -C $WT log --oneline origin/main..HEAD
gh pr create --repo seanfillmore/Claude --head feature/marketing-learner-file-source \
  --title "Marketing learner: file source for books and long-form text" \
  --body "$(cat <<'EOF'
Adds a second front door to `agents/marketing-learner` so books run through the
same extraction/scoring/merge pipeline as YouTube transcripts. Spec:
`docs/superpowers/specs/2026-07-28-marketing-learner-file-source-design.md`.

## What's here

- `lib/text-source.js` — the file seam, sibling to `lib/transcript-source.js`
- `chunkText` — word-budget packing over paragraph boundaries, 200-word overlap
- `consolidateTactics` + `validateConsolidation` — one call over the whole run's
  candidates before any skill is touched, guarded so a dropped tactic is a hard error
- Provenance generalized to a locator; the video form is byte-identical, so the 8
  existing skills see no diff churn
- `--file` / `--author` / `--title` / `--chunk-words` / `--split-on`; bare-`YYYY`
  `--published` for files only

## Verification

- `npm test` — 0 fail
- Single-chapter end-to-end rehearsal per repo rule #4: extract-only, cache replay
  (no API call), and `--no-pr` skill write. Trial edits reverted.

## Not in this PR

The full book run. Run 1 is `--extract-only`; read
`data/reports/marketing-learner/100m-money-models.md` before letting it write skills.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-Review

**Spec coverage.** Seam → T1. Chunking → T2. Cross-chunk dedup + guard → T5. Provenance →
T3. `--published` for files → T4. Caching → T6. CLI → T4/T6. Error-handling table → T1
(source errors), T5 (guard trip), T6 (corrupt cache, offending payloads). Testing section →
every task's test step plus T7. `digitalassets/` → already committed. Non-goals hold: no PDF
parsing, no new deps, the two unrelated defects untouched.

**Placeholders.** None — every code step carries real code, every test step real assertions,
every command a concrete expected result. The two spots that cannot be literal are `START`/`END`
in T7 Step 1 (line numbers the operator greps) and `<DATE>`/`N` in T7 Step 7, both with the
exact command that produces them.

**Type consistency.** `sourceId`/`sourceType`/`videoId`/`locator` are used identically in
T1, T3, T6. `chunk` is `{ index, total, label, text }` in T2 and consumed with those names
in T3 and T6. `mergedFrom` is `[{ candidateIndex, label }]` in T5 and read with those names
in T6's report and locator. `chunkCacheKey` takes `{ chunkText, inventoryFingerprint,
constraintBlock }` in both its test and its implementation.

One naming collision to watch: T6 imports `chunkText` (the function) into a scope where
`chunkCacheKey` takes a `chunkText` **property**. The implementation destructures it as
`{ chunkText: body }` to avoid shadowing.
