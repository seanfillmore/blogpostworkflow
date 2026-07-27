# Marketing Learner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Point a command at a YouTube URL and get a reviewed pull request that creates or sharpens a project-level Claude Code marketing skill, plus a report scoring every tactic found — including the rejects and why.

**Architecture:** Three files. `lib/transcript-source.js` is the only code that knows TranscriptAPI exists (a seam, so yt-dlp can drop in later). `lib/marketing-learner.js` holds pure, network-free logic: CLI date parsing, the RSC constraint block, skill inventory scanning, skill rendering, and edit-safety guards. `agents/marketing-learner/index.js` orchestrates: fetch → Opus extraction → render skills → write report → branch and open a PR.

**Tech Stack:** Node 20+ ESM, `node --test` with bare `node:assert` assertions (repo convention — no `describe`/`it`), `@anthropic-ai/sdk` via the metered wrapper `lib/anthropic.js`, `gh` CLI for PRs.

**Spec:** `docs/superpowers/specs/2026-07-27-marketing-learner-design.md`

## Global Constraints

- **ESM only.** `package.json` has `"type": "module"`. Use `import`, never `require`.
- **Test style is bare assertions**, matching `tests/agents/rejected-keywords.test.js`: top-level `assert.*` calls, then `console.log('✓ <name> tests pass')` as the last line. Do NOT use `node:test`'s `describe`/`it`. Files still run under `npm test` (`node --test 'tests/**/*.test.js'`) because a file that exits 0 passes.
- **No new npm dependencies.** Use built-in `fetch`, `node:fs`, `node:path`.
- **No network in tests.** Inject `fetchImpl` and the Anthropic client; never hit a real API from a test.
- **Anthropic import path is `lib/anthropic.js`**, not `@anthropic-ai/sdk` directly — it meters token cost. Model is `claude-opus-5`.
- **`stop_reason === 'max_tokens'` must throw, never save.** Repo rule; truncated structured output is corrupt, not partial.
- **Branch, never commit to `main`.** Work happens on `feature/marketing-learner`, which already exists and is checked out.
- **Never print `TRANSCRIPTAPI_KEY`** in logs, errors, or test output.
- Verified API facts (probed live 2026-07-27, do not re-derive):
  - `/youtube/info` → `{ video_id, metadata: {title, author_name, author_url, thumbnail_url}, available_languages: [{code, name}] }`, costs 0 credits.
  - `/youtube/transcript` → `{ video_id, language, transcript, metadata, length_seconds, lengthText }`, costs 1 credit.
  - Manual English is code `en`; auto-generated is **`asr-en`**.
  - **`include_timestamp=false` is required** — it defaults true and applies even to `format=text`.
  - `404` body is `{ "detail": "..." }`. No credit-remaining headers exist on any response.

---

### Task 1: Transcript source — pure helpers

**Files:**
- Create: `lib/transcript-source.js`
- Test: `tests/agents/transcript-source.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `extractVideoId(urlOrId) -> string`, `pickLanguage(availableLanguages) -> string|null`, `normalizeTranscriptText(raw) -> string`, `class TranscriptError extends Error { status, code }`.

- [ ] **Step 1: Write the failing test**

Create `tests/agents/transcript-source.test.js`:

```js
import { strict as assert } from 'node:assert';
import {
  extractVideoId,
  pickLanguage,
  normalizeTranscriptText,
  TranscriptError,
} from '../../lib/transcript-source.js';

// ── extractVideoId ──────────────────────────────────────────────────────────
assert.equal(extractVideoId('dQw4w9WgXcQ'), 'dQw4w9WgXcQ', 'bare id passes through');
assert.equal(extractVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), 'dQw4w9WgXcQ', 'watch url');
assert.equal(extractVideoId('https://youtu.be/dQw4w9WgXcQ'), 'dQw4w9WgXcQ', 'short url');
assert.equal(extractVideoId('https://youtu.be/dQw4w9WgXcQ?t=42'), 'dQw4w9WgXcQ', 'short url with query');
assert.equal(extractVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLabc'), 'dQw4w9WgXcQ', 'watch url with extra params');
assert.throws(() => extractVideoId('https://example.com/video'), /Could not extract/, 'non-youtube url throws');

// ── pickLanguage ────────────────────────────────────────────────────────────
// Manual English wins over auto-generated.
assert.equal(
  pickLanguage([{ code: 'asr-en', name: 'English (auto-generated)' }, { code: 'en', name: 'English' }]),
  'en,asr-en',
  'manual listed before asr regardless of input order'
);
assert.equal(
  pickLanguage([{ code: 'asr-en', name: 'English (auto-generated)' }]),
  'asr-en',
  'asr-only is acceptable'
);
assert.equal(
  pickLanguage([{ code: 'en-GB', name: 'English (UK)' }, { code: 'de', name: 'German' }]),
  'en-GB',
  'regional English variants count as manual'
);
assert.equal(
  pickLanguage([{ code: 'de', name: 'German' }, { code: 'ja', name: 'Japanese' }]),
  null,
  'no English at all returns null'
);
assert.equal(pickLanguage([]), null, 'empty list returns null');

// ── normalizeTranscriptText ─────────────────────────────────────────────────
// Caption line-wrapping leaves newlines mid-sentence.
assert.equal(
  normalizeTranscriptText('You know the rules\nand so do I'),
  'You know the rules and so do I',
  'collapses wrap newlines into a space'
);
// Defensive: strip timestamps even though include_timestamp=false should prevent them.
assert.equal(
  normalizeTranscriptText('[1.36s] hello [18.64s] world'),
  'hello world',
  'strips timestamp markers defensively'
);
assert.equal(
  normalizeTranscriptText('  lots   of\n\n  space  '),
  'lots of space',
  'collapses runs of whitespace and trims'
);

// ── TranscriptError ─────────────────────────────────────────────────────────
const err = new TranscriptError('nope', { status: 404, code: 'NOT_FOUND' });
assert.equal(err.status, 404);
assert.equal(err.code, 'NOT_FOUND');
assert.ok(err instanceof Error, 'is a real Error');

console.log('✓ transcript-source pure-helper tests pass');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/agents/transcript-source.test.js`
Expected: FAIL — `Cannot find module '.../lib/transcript-source.js'`

- [ ] **Step 3: Write minimal implementation**

Create `lib/transcript-source.js`:

```js
/**
 * lib/transcript-source.js
 *
 * The ONLY file that knows TranscriptAPI exists. Exposes fetchTranscript(),
 * which returns a normalized shape. If the vendor dies or prices badly, a
 * yt-dlp implementation drops in behind the same signature without touching
 * the agent.
 *
 * API facts verified by live probe 2026-07-27 — see the spec.
 */

const BASE = 'https://transcriptapi.com/api/v2';

export class TranscriptError extends Error {
  constructor(message, { status = null, code = 'UNKNOWN' } = {}) {
    super(message);
    this.name = 'TranscriptError';
    this.status = status;
    this.code = code;
  }
}

/** Accepts a bare 11-char id, a watch URL, or a youtu.be short URL. */
export function extractVideoId(urlOrId) {
  const s = String(urlOrId).trim();
  if (/^[\w-]{11}$/.test(s)) return s;

  const patterns = [
    /[?&]v=([\w-]{11})/,          // watch?v=
    /youtu\.be\/([\w-]{11})/,     // youtu.be/
    /\/(?:embed|shorts|v)\/([\w-]{11})/, // /embed/ /shorts/ /v/
  ];
  for (const re of patterns) {
    const m = s.match(re);
    if (m) return m[1];
  }
  throw new TranscriptError(`Could not extract a YouTube video id from: ${s}`, { code: 'BAD_URL' });
}

/**
 * Build the comma-separated `language` priority list from /youtube/info's
 * available_languages. Manual English ("en", "en-GB") is preferred over
 * auto-generated ("asr-en") because ASR output is materially noisier.
 * Returns null when the video has no English track at all.
 */
export function pickLanguage(availableLanguages = []) {
  const codes = availableLanguages.map((l) => l.code).filter(Boolean);
  const isAsr = (c) => c.toLowerCase().startsWith('asr-');
  const isEnglish = (c) => /^(asr-)?en(-|$)/i.test(c);

  const english = codes.filter(isEnglish);
  const manual = english.filter((c) => !isAsr(c));
  const asr = english.filter(isAsr);
  const ordered = [...manual, ...asr];
  return ordered.length ? ordered.join(',') : null;
}

/**
 * Caption text arrives with line-wrap newlines mid-sentence. Timestamps are
 * stripped defensively — include_timestamp=false should already prevent them,
 * but the parameter defaults to true and a regression there would silently
 * poison every extraction prompt.
 */
export function normalizeTranscriptText(raw) {
  return String(raw ?? '')
    .replace(/\[\d+(?:\.\d+)?s\]\s*/g, '')
    .replace(/\s*\n\s*/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/agents/transcript-source.test.js`
Expected: PASS, with `✓ transcript-source pure-helper tests pass` in the output.

- [ ] **Step 5: Commit**

```bash
git add lib/transcript-source.js tests/agents/transcript-source.test.js
git commit -m "feat(marketing-learner): transcript-source pure helpers

extractVideoId, pickLanguage (manual en over asr-en), normalizeTranscriptText.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Transcript source — network layer

**Files:**
- Modify: `lib/transcript-source.js` (append)
- Modify: `tests/agents/transcript-source.test.js` (append)
- Modify: `.gitignore`

**Interfaces:**
- Consumes: `extractVideoId`, `pickLanguage`, `normalizeTranscriptText`, `TranscriptError` from Task 1.
- Produces: `fetchTranscript(urlOrId, { apiKey, fetchImpl }) -> Promise<{ videoId, title, creator, creatorUrl, durationSeconds, language, text }>`. Throws `TranscriptError` with `code` in `NO_KEY | AUTH | NO_CREDITS | NOT_FOUND | NO_ENGLISH | RATE_LIMIT | HTTP | BAD_URL`.

**Note on retries:** do NOT use `lib/retry.js` here. Its `RETRY_DELAY_MS` is 60 seconds, so three retries would hang an interactive CLI for three minutes. Use the short local backoff below. `withRetry` is still correct for the Anthropic call in Task 5.

- [ ] **Step 1: Write the failing test**

Append to `tests/agents/transcript-source.test.js`, **above** the final `console.log` line:

```js
import { fetchTranscript } from '../../lib/transcript-source.js';

// A fake fetch: returns queued responses in order, recording the URLs it saw.
function makeFetch(responses) {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    const next = responses.shift();
    if (!next) throw new Error(`unexpected extra fetch: ${url}`);
    return {
      status: next.status,
      ok: next.status >= 200 && next.status < 300,
      async json() { return next.body; },
      async text() { return JSON.stringify(next.body); },
    };
  };
  impl.calls = calls;
  return impl;
}

const INFO_OK = {
  status: 200,
  body: {
    video_id: 'dQw4w9WgXcQ',
    metadata: {
      title: 'Never Gonna Give You Up',
      author_name: 'Rick Astley',
      author_url: 'https://www.youtube.com/channel/UCuAXFkgsw1L7xaCfnd5JJOw',
      thumbnail_url: 'https://i.ytimg.com/x.webp',
    },
    available_languages: [{ code: 'en', name: 'English' }, { code: 'asr-en', name: 'English (auto-generated)' }],
  },
};

const TRANSCRIPT_OK = {
  status: 200,
  body: {
    video_id: 'dQw4w9WgXcQ',
    language: 'en',
    transcript: 'We are no strangers\nto love',
    metadata: {
      title: 'Never Gonna Give You Up',
      author_name: 'Rick Astley',
      author_url: 'https://www.youtube.com/channel/UCuAXFkgsw1L7xaCfnd5JJOw',
      thumbnail_url: 'https://i.ytimg.com/x.webp',
    },
    length_seconds: 213,
    lengthText: '3:33',
  },
};

// ── happy path ──────────────────────────────────────────────────────────────
{
  const impl = makeFetch([{ ...INFO_OK }, { ...TRANSCRIPT_OK }]);
  const out = await fetchTranscript('https://youtu.be/dQw4w9WgXcQ', { apiKey: 'k', fetchImpl: impl });

  assert.equal(out.videoId, 'dQw4w9WgXcQ');
  assert.equal(out.title, 'Never Gonna Give You Up');
  assert.equal(out.creator, 'Rick Astley');
  assert.equal(out.durationSeconds, 213);
  assert.equal(out.language, 'en');
  assert.equal(out.text, 'We are no strangers to love', 'text is normalized');

  assert.equal(impl.calls.length, 2, 'info then transcript');
  assert.ok(impl.calls[0].includes('/youtube/info'), 'free info call happens first');
  assert.ok(impl.calls[1].includes('include_timestamp=false'), 'MUST disable timestamps');
  assert.ok(impl.calls[1].includes('format=text'), 'requests plain text');
  assert.ok(impl.calls[1].includes('send_metadata=true'), 'requests metadata');
  assert.ok(impl.calls[1].includes('language=en%2Casr-en') || impl.calls[1].includes('language=en,asr-en'),
    'passes the manual-first priority list');
}

// ── no English track: must NOT spend a credit ───────────────────────────────
{
  const noEnglish = {
    status: 200,
    body: { ...INFO_OK.body, available_languages: [{ code: 'de', name: 'German' }] },
  };
  const impl = makeFetch([noEnglish]);
  await assert.rejects(
    () => fetchTranscript('dQw4w9WgXcQ', { apiKey: 'k', fetchImpl: impl }),
    (e) => e.code === 'NO_ENGLISH',
    'throws NO_ENGLISH'
  );
  assert.equal(impl.calls.length, 1, 'stops after the free info call — no credit spent');
}

// ── error classification ────────────────────────────────────────────────────
for (const [status, body, code] of [
  [401, { detail: 'bad key' }, 'AUTH'],
  [402, { detail: 'no credits' }, 'NO_CREDITS'],
  [404, { detail: 'Video x not found or unavailable' }, 'NOT_FOUND'],
  [500, { detail: 'boom' }, 'HTTP'],
]) {
  const impl = makeFetch([{ status, body }]);
  await assert.rejects(
    () => fetchTranscript('dQw4w9WgXcQ', { apiKey: 'k', fetchImpl: impl }),
    (e) => e.code === code && e.status === status,
    `status ${status} maps to ${code}`
  );
}

// ── missing key ─────────────────────────────────────────────────────────────
await assert.rejects(
  () => fetchTranscript('dQw4w9WgXcQ', { apiKey: '', fetchImpl: makeFetch([]) }),
  (e) => e.code === 'NO_KEY',
  'empty api key throws NO_KEY before any request'
);

// ── 429 retries then succeeds ───────────────────────────────────────────────
{
  const impl = makeFetch([
    { status: 429, body: { detail: 'slow down' } },
    { ...INFO_OK },
    { ...TRANSCRIPT_OK },
  ]);
  const out = await fetchTranscript('dQw4w9WgXcQ', { apiKey: 'k', fetchImpl: impl, backoffMs: 1 });
  assert.equal(out.videoId, 'dQw4w9WgXcQ', 'recovers after a 429');
  assert.equal(impl.calls.length, 3, 'retried the info call once');
}

// ── the key must never leak into an error message ───────────────────────────
{
  const impl = makeFetch([{ status: 401, body: { detail: 'bad key' } }]);
  const caught = await fetchTranscript('dQw4w9WgXcQ', { apiKey: 'SUPERSECRET', fetchImpl: impl }).catch((e) => e);
  assert.ok(!String(caught.message).includes('SUPERSECRET'), 'api key absent from error message');
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/agents/transcript-source.test.js`
Expected: FAIL — `fetchTranscript` is not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `lib/transcript-source.js`:

```js
/** Short backoff. lib/retry.js waits 60s per attempt, which is unusable in a CLI. */
const RETRY_STATUSES = new Set([408, 429, 503]);
const DEFAULT_BACKOFF_MS = 1000;

function classify(status, detail) {
  if (status === 401) return new TranscriptError('TranscriptAPI rejected the key (401). Check TRANSCRIPTAPI_KEY in .env.', { status, code: 'AUTH' });
  if (status === 402) return new TranscriptError(`TranscriptAPI is out of credits (402). ${detail ?? ''}`.trim(), { status, code: 'NO_CREDITS' });
  if (status === 404) return new TranscriptError(detail ?? 'Video not found or has no transcript.', { status, code: 'NOT_FOUND' });
  return new TranscriptError(`TranscriptAPI returned ${status}. ${detail ?? ''}`.trim(), { status, code: 'HTTP' });
}

async function request(path, { apiKey, fetchImpl, backoffMs }) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetchImpl(`${BASE}${path}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (res.ok) return res.json();

    let detail = null;
    try { detail = (await res.json())?.detail ?? null; } catch { /* non-JSON body */ }

    if (RETRY_STATUSES.has(res.status) && attempt < 2) {
      lastErr = classify(res.status, detail);
      await new Promise((r) => setTimeout(r, backoffMs * 3 ** attempt));
      continue;
    }
    throw classify(res.status, detail);
  }
  throw lastErr;
}

/**
 * Fetch a transcript. Calls the FREE /youtube/info first so that a video with
 * no English captions costs nothing — the common skip case must not burn a credit.
 */
export async function fetchTranscript(urlOrId, { apiKey, fetchImpl = fetch, backoffMs = DEFAULT_BACKOFF_MS } = {}) {
  if (!apiKey) {
    throw new TranscriptError('TRANSCRIPTAPI_KEY is not set. Add it to .env.', { code: 'NO_KEY' });
  }
  const videoId = extractVideoId(urlOrId);

  // 0 credits.
  const info = await request(`/youtube/info?video_url=${videoId}`, { apiKey, fetchImpl, backoffMs });
  const language = pickLanguage(info.available_languages);
  if (!language) {
    throw new TranscriptError(`No English captions available for ${videoId}.`, { status: 404, code: 'NO_ENGLISH' });
  }

  // 1 credit.
  const params = new URLSearchParams({
    video_url: videoId,
    format: 'text',
    include_timestamp: 'false',
    send_metadata: 'true',
    language,
  });
  const data = await request(`/youtube/transcript?${params}`, { apiKey, fetchImpl, backoffMs });
  const meta = data.metadata ?? info.metadata ?? {};

  return {
    videoId,
    title: meta.title ?? null,
    creator: meta.author_name ?? null,
    creatorUrl: meta.author_url ?? null,
    durationSeconds: data.length_seconds ?? null,
    language: data.language ?? language,
    text: normalizeTranscriptText(data.transcript),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/agents/transcript-source.test.js`
Expected: PASS.

- [ ] **Step 5: Gitignore the transcript cache**

Append to `.gitignore`:

```
# Marketing-learner transcript cache (large, re-fetchable, no review value)
data/marketing-corpus/
```

- [ ] **Step 6: Commit**

```bash
git add lib/transcript-source.js tests/agents/transcript-source.test.js .gitignore
git commit -m "feat(marketing-learner): TranscriptAPI network layer

Free /youtube/info pre-check so the no-captions skip costs no credit.
Short local backoff rather than lib/retry.js, whose 60s delay would hang
an interactive CLI for three minutes.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: CLI date parsing and the RSC constraint block

**Files:**
- Create: `lib/marketing-learner.js`
- Test: `tests/agents/marketing-learner.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `parsePublishedFlags(urls, publishedFlags, { today }) -> Array<{ url, publishedAt: string|null, warning: string|null }>`, `buildConstraintBlock() -> string`.

- [ ] **Step 1: Write the failing test**

Create `tests/agents/marketing-learner.test.js`:

```js
import { strict as assert } from 'node:assert';
import { parsePublishedFlags, buildConstraintBlock } from '../../lib/marketing-learner.js';

const TODAY = '2026-07-27';

// ── no dates supplied ───────────────────────────────────────────────────────
{
  const out = parsePublishedFlags(['https://youtu.be/aaaaaaaaaaa'], [], { today: TODAY });
  assert.equal(out.length, 1);
  assert.equal(out[0].publishedAt, null, 'absent flag is allowed');
  assert.equal(out[0].warning, null);
}

// ── one url, one date ───────────────────────────────────────────────────────
{
  const out = parsePublishedFlags(['https://youtu.be/aaaaaaaaaaa'], ['2026-03-14'], { today: TODAY });
  assert.equal(out[0].publishedAt, '2026-03-14');
  assert.equal(out[0].warning, null);
}

// ── counts match: pairs positionally ────────────────────────────────────────
{
  const out = parsePublishedFlags(
    ['https://youtu.be/aaaaaaaaaaa', 'https://youtu.be/bbbbbbbbbbb'],
    ['2026-03-14', '2025-11-02'],
    { today: TODAY }
  );
  assert.equal(out[0].publishedAt, '2026-03-14');
  assert.equal(out[1].publishedAt, '2025-11-02');
}

// ── one date, many urls: ERROR, not broadcast ───────────────────────────────
// A wrong-but-authoritative date silently skews scoring and nobody re-checks it.
assert.throws(
  () => parsePublishedFlags(['a', 'b'], ['2026-03-14'], { today: TODAY }),
  /one --published date for 2 URLs/,
  'refuses to broadcast a single date across videos'
);

// ── more dates than urls ────────────────────────────────────────────────────
assert.throws(
  () => parsePublishedFlags(['a'], ['2026-03-14', '2025-01-01'], { today: TODAY }),
  /2 --published dates for 1 URL/,
  'refuses surplus dates'
);

// ── malformed dates ─────────────────────────────────────────────────────────
assert.throws(() => parsePublishedFlags(['a'], ['03/14/2026'], { today: TODAY }), /YYYY-MM-DD/, 'wrong format');
assert.throws(() => parsePublishedFlags(['a'], ['2026-13-01'], { today: TODAY }), /not a real calendar date/, 'month 13');
assert.throws(() => parsePublishedFlags(['a'], ['2026-02-30'], { today: TODAY }), /not a real calendar date/, 'Feb 30 rolls over');

// ── future dates ────────────────────────────────────────────────────────────
assert.throws(() => parsePublishedFlags(['a'], ['2026-07-28'], { today: TODAY }), /in the future/, 'tomorrow rejected');

// ── old dates warn but do not throw ─────────────────────────────────────────
{
  const out = parsePublishedFlags(['a'], ['2021-01-01'], { today: TODAY });
  assert.equal(out[0].publishedAt, '2021-01-01', 'still accepted');
  assert.match(out[0].warning, /older than/, 'warns on stale video');
}
{
  const out = parsePublishedFlags(['a'], ['2024-01-01'], { today: TODAY });
  assert.equal(out[0].warning, null, 'inside the 4-year window: no warning');
}

// ── constraint block ────────────────────────────────────────────────────────
{
  const block = buildConstraintBlock();
  assert.match(block, /50\.46/, 'carries the settled AOV, not the stale $19 figure');
  assert.ok(!block.includes('$19'), 'must not cite the all-time AOV');
  assert.match(block, /retention/i, 'names retention as the binding constraint');
  assert.match(block, /solo operator/i, 'states the staffing constraint');
  assert.match(block, /Platform mechanics/, 'includes the decay table');
  assert.match(block, /Durable principle/, 'includes the decay table');
  assert.match(block, /18/, 'states the ~18mo platform-mechanics horizon');
}

console.log('✓ marketing-learner date + constraint tests pass');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/agents/marketing-learner.test.js`
Expected: FAIL — `Cannot find module '.../lib/marketing-learner.js'`

- [ ] **Step 3: Write minimal implementation**

Create `lib/marketing-learner.js`:

```js
/**
 * lib/marketing-learner.js
 *
 * Pure, network-free logic for the marketing-learner agent: CLI date parsing,
 * the RSC constraint block, skill inventory scanning, skill rendering, and
 * edit-safety guards.
 */

const STALE_YEARS = 4;

/**
 * Pair --published dates to URLs positionally.
 *
 * A single date with multiple URLs is an ERROR rather than a broadcast:
 * stamping one date across several videos produces confident, wrong,
 * authoritative-looking metadata that skews scoring and that nobody thinks
 * to re-check. No date at all is strictly safer than a wrong one.
 */
export function parsePublishedFlags(urls, publishedFlags = [], { today = null } = {}) {
  const dates = publishedFlags.filter((d) => d != null && d !== '');

  if (dates.length && dates.length !== urls.length) {
    throw new Error(
      `Got ${dates.length} --published date${dates.length === 1 ? '' : 's'} for ${urls.length} URL${urls.length === 1 ? '' : 's'}. ` +
      `Supply one date per URL in order, or none at all — a single date is not broadcast across videos.`
    );
  }

  const now = today ? new Date(`${today}T00:00:00Z`) : new Date();
  const staleCutoff = new Date(now);
  staleCutoff.setUTCFullYear(staleCutoff.getUTCFullYear() - STALE_YEARS);

  return urls.map((url, i) => {
    const raw = dates[i] ?? null;
    if (!raw) return { url, publishedAt: null, warning: null };

    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
      throw new Error(`--published "${raw}" must be in YYYY-MM-DD form.`);
    }
    const d = new Date(`${raw}T00:00:00Z`);
    // Round-tripping catches rollovers like 2026-02-30 -> 2026-03-02.
    if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== raw) {
      throw new Error(`--published "${raw}" is not a real calendar date.`);
    }
    if (d > now) {
      throw new Error(`--published "${raw}" is in the future.`);
    }
    const warning = d < staleCutoff
      ? `Video is older than ${STALE_YEARS} years (${raw}) — platform-mechanics tactics from it are probably obsolete.`
      : null;

    return { url, publishedAt: raw, warning };
  });
}

/**
 * The business reality every tactic is scored against. Figures are the settled
 * ones — note the AOV is the trailing-90d $50.46, NOT the all-time $19, which is
 * dragged down by a 2024 order spike and must never be used for decisions.
 */
export function buildConstraintBlock() {
  return `## Real Skin Care — operating reality

Score every tactic against these. They are measured, not aspirational.

- Shopify revenue ~$875/mo. Amazon ~$1,800/mo. Combined ~$2,700/mo.
- AOV $50.46 (trailing 90 days).
- Repeat rate 18-22.5%; repeat customers are ~45-52% of revenue.
  **Retention is the binding constraint, not traffic.**
- 12 SKUs. Natural deodorant, body care, oral care, lip balm.
- Solo operator. No team, no agency, no media buyer, no designer.
- Paid spend is gated behind a hard sequence: Tracking -> CRO -> Offer/AOV -> Traffic.
  A tactic that assumes working attribution or meaningful ad budget is premature.
- Prime directive is revenue, not rankings or traffic.

## Reject a tactic outright when it

- Requires staff, an agency, or a media buyer.
- Requires ad budget materially above current spend.
- Targets a platform Real Skin Care is not on.
- Is motivational framing with no stated mechanism — not actionable, not testable.
- Restates something an existing skill already covers (duplication degrades skill triggering).
- Depends on scale that does not exist here: a large list, high traffic, thousands of reviews.

## Staleness is not uniform

| Tactic class | Decay | Examples |
|---|---|---|
| Platform mechanics | Fast — treat anything older than ~18 months with suspicion | Ad account structure, algorithm behavior, placement names, attribution windows |
| Durable principle | Slow — age is nearly irrelevant | Offer construction, positioning, retention psychology, pricing logic |

A 2022 Meta campaign structure describes a system that no longer exists. A 2019 offer
principle is fine. When age is what drove a score down, \`rscFit.reasoning\` MUST name
which class the tactic falls into.`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/agents/marketing-learner.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/marketing-learner.js tests/agents/marketing-learner.test.js
git commit -m "feat(marketing-learner): --published parsing and RSC constraint block

One date for many URLs throws rather than broadcasting a confident wrong
date. Constraint block carries the settled \$50.46 AOV and the
platform-mechanics-vs-durable-principle decay table.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Skill inventory, rendering, and edit guards

**Files:**
- Modify: `lib/marketing-learner.js` (append)
- Modify: `tests/agents/marketing-learner.test.js` (append)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `parseFrontmatter(content) -> { name, description, body }`, `scanSkillInventory(skillsDir) -> Array<{ name, description, path, content }>`, `renderSkillMarkdown({ name, description, tactics }) -> string`, `validateSkillEdit(oldContent, newContent, { supersedes }) -> true` (throws otherwise).

A `tactic` here is `{ claim, mechanism, evidence, rscFit: { score, reasoning }, source: { creator, title, videoId } }`.

- [ ] **Step 1: Write the failing test**

Append to `tests/agents/marketing-learner.test.js`, **above** the final `console.log`:

```js
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseFrontmatter,
  scanSkillInventory,
  renderSkillMarkdown,
  validateSkillEdit,
} from '../../lib/marketing-learner.js';

// ── parseFrontmatter ────────────────────────────────────────────────────────
{
  const fm = parseFrontmatter('---\nname: marketing-offers\ndescription: Use when building offers\n---\n\nBody here.\n');
  assert.equal(fm.name, 'marketing-offers');
  assert.equal(fm.description, 'Use when building offers');
  assert.match(fm.body, /Body here/);
}
assert.throws(() => parseFrontmatter('no frontmatter at all'), /frontmatter/, 'missing frontmatter throws');

// ── scanSkillInventory ──────────────────────────────────────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), 'skills-'));
  mkdirSync(join(dir, 'marketing-offers'), { recursive: true });
  writeFileSync(join(dir, 'marketing-offers', 'SKILL.md'),
    '---\nname: marketing-offers\ndescription: Offer construction\n---\n\nStuff.\n');
  mkdirSync(join(dir, 'unrelated-skill'), { recursive: true });
  writeFileSync(join(dir, 'unrelated-skill', 'SKILL.md'),
    '---\nname: unrelated-skill\ndescription: Not marketing\n---\n\nStuff.\n');

  const inv = scanSkillInventory(dir);
  assert.equal(inv.length, 1, 'only marketing-* skills');
  assert.equal(inv[0].name, 'marketing-offers');
  assert.equal(inv[0].description, 'Offer construction');
  assert.match(inv[0].content, /Stuff/);
}
assert.deepEqual(scanSkillInventory(join(tmpdir(), 'definitely-does-not-exist-12345')), [],
  'absent skills dir returns empty, does not throw');

// ── renderSkillMarkdown ─────────────────────────────────────────────────────
{
  const md = renderSkillMarkdown({
    name: 'marketing-retention-flows',
    description: 'Use when building lifecycle email or replenishment flows',
    tactics: [{
      claim: 'Send replenishment at 60% of consumption cycle',
      mechanism: 'Reminds before the jar runs out, when intent is highest',
      evidence: 'Creator cites their own 3-store test',
      rscFit: { score: 8, reasoning: 'Retention is the binding constraint here' },
      source: { creator: 'Some Operator', title: 'Retention Playbook', videoId: 'abc12345678' },
    }],
  });

  assert.match(md, /^---\n/, 'starts with frontmatter');
  assert.match(md, /name: marketing-retention-flows/);
  assert.match(md, /description: Use when building lifecycle/);
  assert.match(md, /Send replenishment at 60%/, 'claim present');
  assert.match(md, /Some Operator/, 'provenance names the creator');
  assert.match(md, /abc12345678/, 'provenance carries the video id');
  const fm = parseFrontmatter(md);
  assert.equal(fm.name, 'marketing-retention-flows', 'output round-trips through the parser');
}

// ── validateSkillEdit ───────────────────────────────────────────────────────
const OLD = '---\nname: marketing-offers\ndescription: Offer construction\n---\n\n' + 'x'.repeat(1000);

// legitimate expansion
assert.equal(validateSkillEdit(OLD, OLD + '\n\nMore content here.'), true, 'growth is fine');

// frontmatter destroyed
assert.throws(() => validateSkillEdit(OLD, 'no frontmatter'), /frontmatter/, 'damaged frontmatter throws');

// renamed
assert.throws(
  () => validateSkillEdit(OLD, '---\nname: marketing-renamed\ndescription: Offer construction\n---\n\n' + 'x'.repeat(1000)),
  /name changed/,
  'renaming the skill throws'
);

// empty description
assert.throws(
  () => validateSkillEdit(OLD, '---\nname: marketing-offers\ndescription:\n---\n\n' + 'x'.repeat(1000)),
  /description/,
  'empty description throws'
);

// unexplained shrink
assert.throws(
  () => validateSkillEdit(OLD, '---\nname: marketing-offers\ndescription: Offer construction\n---\n\nshort'),
  /shrink/,
  'unexplained >25% shrink throws'
);

// explained shrink is allowed
assert.equal(
  validateSkillEdit(
    OLD,
    '---\nname: marketing-offers\ndescription: Offer construction\n---\n\nshort',
    { supersedes: 'Removed the 2019 Facebook bidding section; that auction no longer exists.' }
  ),
  true,
  'shrink with an explicit supersedes reason is allowed'
);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/agents/marketing-learner.test.js`
Expected: FAIL — `parseFrontmatter` is not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `lib/marketing-learner.js`:

```js
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const SHRINK_FLOOR = 0.75; // new content may not drop below 75% of old without a reason

/** Minimal YAML frontmatter reader — only `name` and `description` are needed. */
export function parseFrontmatter(content) {
  const m = String(content).match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) throw new Error('SKILL.md is missing YAML frontmatter (--- delimited block at the top).');
  const [, head, body] = m;
  const field = (key) => {
    const line = head.match(new RegExp(`^${key}:[ \\t]*(.*)$`, 'm'));
    return line ? line[1].trim() : '';
  };
  return { name: field('name'), description: field('description'), body };
}

/** Every marketing-* skill currently in the project, so the model edits instead of duplicating. */
export function scanSkillInventory(skillsDir) {
  if (!existsSync(skillsDir)) return [];
  const out = [];
  for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('marketing-')) continue;
    const path = join(skillsDir, entry.name, 'SKILL.md');
    if (!existsSync(path)) continue;
    const content = readFileSync(path, 'utf8');
    let fm;
    try { fm = parseFrontmatter(content); } catch { continue; }
    out.push({ name: fm.name || entry.name, description: fm.description, path, content });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Render a fresh SKILL.md. Every claim carries provenance so a tactic that later
 * proves wrong is traceable to its source and that source can be re-weighted.
 */
export function renderSkillMarkdown({ name, description, tactics = [] }) {
  const lines = [
    '---',
    `name: ${name}`,
    `description: ${description}`,
    '---',
    '',
    `# ${name.replace(/^marketing-/, '').replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())}`,
    '',
  ];

  for (const t of tactics) {
    lines.push(`## ${t.claim}`, '');
    lines.push(`**Why it works:** ${t.mechanism}`, '');
    if (t.evidence) lines.push(`**Evidence offered:** ${t.evidence}`, '');
    if (t.rscFit) lines.push(`**Fit here (${t.rscFit.score}/10):** ${t.rscFit.reasoning}`, '');
    const s = t.source ?? {};
    lines.push(`*Source: ${s.creator ?? 'unknown'} — "${s.title ?? 'untitled'}" (${s.videoId ?? 'n/a'})*`, '');
  }

  return lines.join('\n');
}

/**
 * Guard an LLM-authored replacement of an existing skill. The model returns whole
 * files rather than patches (applying model-generated diffs corrupts silently), so
 * the risk is wholesale loss rather than a bad hunk. Throws — never warns and writes.
 */
export function validateSkillEdit(oldContent, newContent, { supersedes = null } = {}) {
  const oldFm = parseFrontmatter(oldContent);
  const newFm = parseFrontmatter(newContent); // throws if frontmatter is damaged

  if (newFm.name !== oldFm.name) {
    throw new Error(`Skill name changed: "${oldFm.name}" -> "${newFm.name}". Names are stable identifiers.`);
  }
  if (!newFm.description) {
    throw new Error(`Skill "${newFm.name}" has an empty description — it would never trigger.`);
  }
  if (newContent.length < oldContent.length * SHRINK_FLOOR && !supersedes) {
    const pct = Math.round((1 - newContent.length / oldContent.length) * 100);
    throw new Error(
      `Refusing to shrink "${newFm.name}" by ${pct}% without an explicit supersedes reason ` +
      `(${oldContent.length} -> ${newContent.length} chars).`
    );
  }
  return true;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/agents/marketing-learner.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/marketing-learner.js tests/agents/marketing-learner.test.js
git commit -m "feat(marketing-learner): skill inventory, rendering, edit guards

Whole-file replacement plus validation rather than patch application.
Guards throw on frontmatter damage, rename, empty description, and
unexplained >25% shrink.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Extraction — prompt, Anthropic call, schema validation

**Files:**
- Modify: `lib/marketing-learner.js` (append)
- Modify: `tests/agents/marketing-learner.test.js` (append)

**Interfaces:**
- Consumes: `buildConstraintBlock` (Task 3), `scanSkillInventory` (Task 4).
- Produces: `buildExtractionPrompt({ video, inventory }) -> string`, `validateExtraction(obj) -> obj` (throws otherwise), `extractTactics({ video, inventory, client }) -> Promise<object>`.

`video` is `{ videoId, title, creator, durationSeconds, publishedAt, text }`.

- [ ] **Step 1: Write the failing test**

Append to `tests/agents/marketing-learner.test.js`, **above** the final `console.log`:

```js
import { buildExtractionPrompt, validateExtraction, extractTactics } from '../../lib/marketing-learner.js';

const VIDEO = {
  videoId: 'abc12345678',
  title: 'Retention Playbook',
  creator: 'Some Operator',
  durationSeconds: 1800,
  publishedAt: '2026-03-14',
  text: 'Send your replenishment email at sixty percent of the consumption cycle.',
};

// ── buildExtractionPrompt ───────────────────────────────────────────────────
{
  const p = buildExtractionPrompt({ video: VIDEO, inventory: [] });
  assert.match(p, /Retention Playbook/, 'includes the title');
  assert.match(p, /Some Operator/, 'includes the creator');
  assert.match(p, /2026-03-14/, 'includes the publish date');
  assert.match(p, /50\.46/, 'embeds the constraint block');
  assert.match(p, /sixty percent of the consumption cycle/, 'includes the transcript');
  assert.match(p, /recencySignals/, 'asks for the fallback recency field');
}
{
  const p = buildExtractionPrompt({ video: { ...VIDEO, publishedAt: null }, inventory: [] });
  assert.match(p, /publish date is unknown/i, 'says the date is unknown when absent');
}
{
  const p = buildExtractionPrompt({
    video: VIDEO,
    inventory: [{ name: 'marketing-offers', description: 'Offer construction', path: 'x', content: 'BODY_OF_EXISTING_SKILL' }],
  });
  assert.match(p, /marketing-offers/, 'lists the existing skill');
  assert.match(p, /BODY_OF_EXISTING_SKILL/, 'includes existing skill content so it edits rather than duplicates');
}

// ── validateExtraction ──────────────────────────────────────────────────────
const GOOD = {
  videoId: 'abc12345678',
  creator: 'Some Operator',
  title: 'Retention Playbook',
  summary: 'A talk about lifecycle email.',
  recencySignals: null,
  tactics: [
    {
      claim: 'Send replenishment at 60% of cycle',
      mechanism: 'Intent peaks before running out',
      evidence: 'assertion only',
      rscFit: { score: 8, reasoning: 'Retention is the constraint' },
      verdict: 'adopt',
      rejectReason: null,
      targetSkill: { name: 'marketing-retention-flows', action: 'create' },
    },
    {
      claim: 'Hire a media buyer',
      mechanism: 'Specialists beat generalists',
      evidence: 'assertion only',
      rscFit: { score: 1, reasoning: 'Solo operator' },
      verdict: 'reject',
      rejectReason: 'Requires staff',
      targetSkill: null,
    },
  ],
};
assert.equal(validateExtraction(GOOD), GOOD, 'valid payload returns itself');

assert.throws(() => validateExtraction({ ...GOOD, tactics: 'nope' }), /tactics must be an array/);
assert.throws(
  () => validateExtraction({ ...GOOD, tactics: [{ ...GOOD.tactics[0], verdict: 'maybe' }] }),
  /verdict must be/,
  'unknown verdict rejected'
);
assert.throws(
  () => validateExtraction({ ...GOOD, tactics: [{ ...GOOD.tactics[0], rscFit: { score: 42, reasoning: 'x' } }] }),
  /score must be/,
  'out-of-range score rejected'
);
assert.throws(
  () => validateExtraction({ ...GOOD, tactics: [{ ...GOOD.tactics[1], rejectReason: null }] }),
  /rejectReason is required/,
  'reject without a reason is rejected'
);
assert.throws(
  () => validateExtraction({ ...GOOD, tactics: [{ ...GOOD.tactics[0], targetSkill: null }] }),
  /targetSkill is required/,
  'adopt without a target skill is rejected'
);
assert.throws(
  () => validateExtraction({ ...GOOD, tactics: [{ ...GOOD.tactics[0], targetSkill: { name: 'retention', action: 'create' } }] }),
  /must start with "marketing-"/,
  'skill name must be namespaced'
);
assert.throws(
  () => validateExtraction({ ...GOOD, tactics: [{ ...GOOD.tactics[0], targetSkill: { name: 'marketing-x', action: 'delete' } }] }),
  /action must be/,
  'unknown action rejected'
);

// ── extractTactics ──────────────────────────────────────────────────────────
function fakeClient(response) {
  return { messages: { create: async () => response } };
}

// max_tokens must throw and never return a partial payload
await assert.rejects(
  () => extractTactics({
    video: VIDEO,
    inventory: [],
    client: fakeClient({ stop_reason: 'max_tokens', content: [{ type: 'text', text: '{}' }] }),
  }),
  /max_tokens/,
  'truncated output throws rather than saving'
);

// happy path, including fenced JSON
{
  const out = await extractTactics({
    video: VIDEO,
    inventory: [],
    client: fakeClient({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: '```json\n' + JSON.stringify(GOOD) + '\n```' }],
    }),
  });
  assert.equal(out.tactics.length, 2, 'parses JSON out of a fenced block');
}

// unparseable output
await assert.rejects(
  () => extractTactics({
    video: VIDEO,
    inventory: [],
    client: fakeClient({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'I am not JSON' }] }),
  }),
  /Could not parse/,
  'non-JSON output throws'
);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/agents/marketing-learner.test.js`
Expected: FAIL — `buildExtractionPrompt` is not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `lib/marketing-learner.js`:

```js
export const EXTRACTION_MODEL = 'claude-opus-5';
const VERDICTS = new Set(['adopt', 'reject']);
const ACTIONS = new Set(['create', 'edit']);

export function buildExtractionPrompt({ video, inventory = [] }) {
  const dateLine = video.publishedAt
    ? `Published: ${video.publishedAt}`
    : 'Published: the publish date is unknown — infer era from the transcript and report it in recencySignals.';

  const inventoryBlock = inventory.length
    ? inventory.map((s) => `### ${s.name}\n_${s.description}_\n\n${s.content}`).join('\n\n---\n\n')
    : '(no marketing skills exist yet — every adopted tactic will create one)';

  return `You are extracting marketing tactics from a video transcript for a specific small business.

${buildConstraintBlock()}

## Skills that already exist

Prefer editing an existing skill over creating a near-duplicate. Duplicate skills degrade
triggering accuracy, because Claude Code selects skills by matching their descriptions.

${inventoryBlock}

## The video

Title: ${video.title ?? 'unknown'}
Creator: ${video.creator ?? 'unknown'}
${dateLine}
Duration: ${video.durationSeconds ? Math.round(video.durationSeconds / 60) + ' minutes' : 'unknown'}

<transcript>
${video.text}
</transcript>

## Your task

Identify every distinct, actionable marketing tactic the creator advocates. For each one,
judge honestly whether it applies to THIS business. Most tactics from most videos will not.
Being generous helps nobody: a wrong tactic promoted into a skill silently degrades future work.

Return ONLY a JSON object, no prose around it:

{
  "videoId": "${video.videoId}",
  "creator": "...",
  "title": "...",
  "summary": "one paragraph: what this video is actually about",
  "recencySignals": "era cues found in the transcript (platform features, product names, explicit years), or null",
  "tactics": [
    {
      "claim": "what the creator asserts, in one sentence",
      "mechanism": "the causal story — why it supposedly works",
      "evidence": "what the creator offers as proof, or 'assertion only'",
      "rscFit": { "score": 0, "reasoning": "why this score, referencing a specific constraint above" },
      "verdict": "adopt" | "reject",
      "rejectReason": "required when verdict is reject, otherwise null",
      "targetSkill": { "name": "marketing-<topic-kebab>", "action": "create" | "edit" }
    }
  ]
}

Rules:
- targetSkill is null when verdict is "reject", and required when verdict is "adopt".
- targetSkill.name MUST start with "marketing-" and be kebab-case.
- Use action "edit" when one of the existing skills above is the right home; "create" otherwise.
- score is an integer 0-10.
- When age drove the score down, rscFit.reasoning must name the tactic class from the decay table.`;
}

export function validateExtraction(obj) {
  if (!obj || typeof obj !== 'object') throw new Error('Extraction result is not an object.');
  if (!Array.isArray(obj.tactics)) throw new Error('Extraction result: tactics must be an array.');

  for (const [i, t] of obj.tactics.entries()) {
    const at = `tactics[${i}]`;
    if (!t.claim) throw new Error(`${at}: claim is required.`);
    if (!VERDICTS.has(t.verdict)) throw new Error(`${at}: verdict must be "adopt" or "reject", got "${t.verdict}".`);

    const score = t.rscFit?.score;
    if (!Number.isInteger(score) || score < 0 || score > 10) {
      throw new Error(`${at}: rscFit.score must be an integer 0-10, got ${JSON.stringify(score)}.`);
    }
    if (!t.rscFit?.reasoning) throw new Error(`${at}: rscFit.reasoning is required.`);

    if (t.verdict === 'reject') {
      if (!t.rejectReason) throw new Error(`${at}: rejectReason is required when verdict is "reject".`);
    } else {
      if (!t.targetSkill) throw new Error(`${at}: targetSkill is required when verdict is "adopt".`);
      if (!String(t.targetSkill.name).startsWith('marketing-')) {
        throw new Error(`${at}: targetSkill.name must start with "marketing-", got "${t.targetSkill.name}".`);
      }
      if (!ACTIONS.has(t.targetSkill.action)) {
        throw new Error(`${at}: targetSkill.action must be "create" or "edit", got "${t.targetSkill.action}".`);
      }
    }
  }
  return obj;
}

export async function extractTactics({ video, inventory = [], client, maxTokens = 8000 }) {
  const prompt = buildExtractionPrompt({ video, inventory });
  const res = await client.messages.create({
    model: EXTRACTION_MODEL,
    max_tokens: maxTokens,
    messages: [{ role: 'user', content: prompt }],
  });

  // Repo rule: truncated structured output is corrupt, not partial.
  if (res.stop_reason === 'max_tokens') {
    throw new Error(`Extraction for ${video.videoId} hit max_tokens — output is truncated. Refusing to save.`);
  }

  const text = (res.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced ? fenced[1] : text).trim();

  let parsed;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start === -1 || end <= start) {
      throw new Error(`Could not parse JSON from the extraction response for ${video.videoId}.`);
    }
    try {
      parsed = JSON.parse(candidate.slice(start, end + 1));
    } catch {
      throw new Error(`Could not parse JSON from the extraction response for ${video.videoId}.`);
    }
  }
  return validateExtraction(parsed);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/agents/marketing-learner.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/marketing-learner.js tests/agents/marketing-learner.test.js
git commit -m "feat(marketing-learner): extraction prompt, call, and schema validation

max_tokens throws rather than saving a truncated payload. Existing skill
bodies go into the prompt so later videos edit rather than duplicate.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Report rendering

**Files:**
- Modify: `lib/marketing-learner.js` (append)
- Modify: `tests/agents/marketing-learner.test.js` (append)

**Interfaces:**
- Consumes: extraction objects from Task 5.
- Produces: `renderReport({ extraction, video, skillsTouched }) -> string`.

- [ ] **Step 1: Write the failing test**

Append to `tests/agents/marketing-learner.test.js`, **above** the final `console.log`:

```js
import { renderReport } from '../../lib/marketing-learner.js';

{
  const md = renderReport({
    extraction: GOOD,
    video: { ...VIDEO },
    skillsTouched: [{ name: 'marketing-retention-flows', action: 'create' }],
  });

  assert.match(md, /Retention Playbook/, 'names the video');
  assert.match(md, /abc12345678/, 'links or names the video id');
  assert.match(md, /2026-03-14/, 'shows the publish date');
  assert.match(md, /Send replenishment at 60% of cycle/, 'lists the adopted tactic');
  assert.match(md, /Hire a media buyer/, 'lists the REJECTED tactic too');
  assert.match(md, /Requires staff/, 'shows why it was rejected');
  assert.match(md, /marketing-retention-flows/, 'footer names skills touched');

  // The rejects are half the value — they must be a visible section, not a footnote.
  assert.match(md, /## Rejected/i, 'has a dedicated rejected section');
  assert.match(md, /## Adopted/i, 'has a dedicated adopted section');
}

// A video where nothing survived must still produce a useful report.
{
  const md = renderReport({
    extraction: { ...GOOD, tactics: [GOOD.tactics[1]] },
    video: { ...VIDEO },
    skillsTouched: [],
  });
  assert.match(md, /Hire a media buyer/, 'still lists the reject');
  assert.match(md, /No tactics adopted/i, 'says so plainly when nothing was adopted');
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/agents/marketing-learner.test.js`
Expected: FAIL — `renderReport` is not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `lib/marketing-learner.js`:

```js
/**
 * The rejects are a first-class output, not a debug artifact: "what is NOT
 * beneficial" is half of why this tool exists, and it is invisible in a skill diff.
 */
export function renderReport({ extraction, video, skillsTouched = [] }) {
  const adopted = extraction.tactics.filter((t) => t.verdict === 'adopt').sort((a, b) => b.rscFit.score - a.rscFit.score);
  const rejected = extraction.tactics.filter((t) => t.verdict === 'reject').sort((a, b) => b.rscFit.score - a.rscFit.score);

  const L = [];
  L.push(`# ${extraction.title ?? video.title ?? video.videoId}`, '');
  L.push(`**Creator:** ${extraction.creator ?? video.creator ?? 'unknown'}  `);
  L.push(`**Video:** https://www.youtube.com/watch?v=${video.videoId}  `);
  L.push(`**Published:** ${video.publishedAt ?? 'unknown (not supplied via --published)'}  `);
  if (extraction.recencySignals) L.push(`**Inferred era cues:** ${extraction.recencySignals}  `);
  L.push('', extraction.summary ?? '', '');
  L.push(`Found ${extraction.tactics.length} tactic${extraction.tactics.length === 1 ? '' : 's'}: ${adopted.length} adopted, ${rejected.length} rejected.`, '');

  L.push('## Adopted', '');
  if (!adopted.length) {
    L.push('_No tactics adopted from this video._', '');
  } else {
    for (const t of adopted) {
      L.push(`### ${t.claim} — ${t.rscFit.score}/10`, '');
      L.push(`**Why it works:** ${t.mechanism}`, '');
      L.push(`**Evidence:** ${t.evidence ?? 'assertion only'}`, '');
      L.push(`**Fit:** ${t.rscFit.reasoning}`, '');
      L.push(`**Target skill:** \`${t.targetSkill.name}\` (${t.targetSkill.action})`, '');
    }
  }

  L.push('## Rejected', '');
  if (!rejected.length) {
    L.push('_Nothing rejected._', '');
  } else {
    for (const t of rejected) {
      L.push(`### ${t.claim} — ${t.rscFit.score}/10`, '');
      L.push(`**Rejected because:** ${t.rejectReason}`, '');
      L.push(`**Fit reasoning:** ${t.rscFit.reasoning}`, '');
    }
  }

  L.push('## Skills touched', '');
  L.push(skillsTouched.length
    ? skillsTouched.map((s) => `- \`${s.name}\` (${s.action})`).join('\n')
    : '_None._');
  L.push('');

  return L.join('\n');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/agents/marketing-learner.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/marketing-learner.js tests/agents/marketing-learner.test.js
git commit -m "feat(marketing-learner): scoring report with a first-class rejects section

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Skill merge — whole-file replacement via LLM

**Files:**
- Modify: `lib/marketing-learner.js` (append)
- Modify: `tests/agents/marketing-learner.test.js` (append)

**Interfaces:**
- Consumes: `validateSkillEdit`, `parseFrontmatter` (Task 4).
- Produces: `mergeSkillContent({ existingContent, tactics, client }) -> Promise<{ content, supersedes }>`.

**Why an LLM call rather than appending:** naive appending makes a skill accrete duplicate
and contradictory claims forever, which is exactly the sprawl the design set out to avoid —
video #7 must *revise* what video #2 wrote, not stack on top of it. The spec's guards
(`validateSkillEdit`) exist precisely because the model returns whole files.

- [ ] **Step 1: Write the failing test**

Append to `tests/agents/marketing-learner.test.js`, **above** the final `console.log`:

```js
import { mergeSkillContent } from '../../lib/marketing-learner.js';

const EXISTING_SKILL = '---\nname: marketing-retention-flows\ndescription: Lifecycle email\n---\n\n'
  + '## Old claim\n\n' + 'y'.repeat(800);

const NEW_TACTICS = [{
  claim: 'Send replenishment at 60% of cycle',
  mechanism: 'Intent peaks before running out',
  evidence: 'assertion only',
  rscFit: { score: 8, reasoning: 'Retention is the constraint' },
  source: { creator: 'Some Operator', title: 'Retention Playbook', videoId: 'abc12345678' },
}];

function mergeClient(payload, stop = 'end_turn') {
  return { messages: { create: async () => ({ stop_reason: stop, content: [{ type: 'text', text: payload }] }) } };
}

// ── happy path ──────────────────────────────────────────────────────────────
{
  const merged = EXISTING_SKILL + '\n\n## Send replenishment at 60% of cycle\n\nBody.\n';
  const out = await mergeSkillContent({
    existingContent: EXISTING_SKILL,
    tactics: NEW_TACTICS,
    client: mergeClient(JSON.stringify({ content: merged, supersedes: null })),
  });
  assert.match(out.content, /Send replenishment/, 'new tactic present');
  assert.match(out.content, /Old claim/, 'existing content retained');
  assert.equal(out.supersedes, null);
}

// ── max_tokens must throw ───────────────────────────────────────────────────
await assert.rejects(
  () => mergeSkillContent({
    existingContent: EXISTING_SKILL,
    tactics: NEW_TACTICS,
    client: mergeClient('{}', 'max_tokens'),
  }),
  /max_tokens/,
  'truncated merge throws rather than writing a mangled skill'
);

// ── guard fires on unexplained shrink ───────────────────────────────────────
await assert.rejects(
  () => mergeSkillContent({
    existingContent: EXISTING_SKILL,
    tactics: NEW_TACTICS,
    client: mergeClient(JSON.stringify({
      content: '---\nname: marketing-retention-flows\ndescription: Lifecycle email\n---\n\ntiny',
      supersedes: null,
    })),
  }),
  /shrink/,
  'gutting a skill without a reason throws'
);

// ── explained shrink is allowed through the guard ───────────────────────────
{
  const out = await mergeSkillContent({
    existingContent: EXISTING_SKILL,
    tactics: NEW_TACTICS,
    client: mergeClient(JSON.stringify({
      content: '---\nname: marketing-retention-flows\ndescription: Lifecycle email\n---\n\ntiny',
      supersedes: 'Removed the 2019 bidding section; that auction no longer exists.',
    })),
  });
  assert.match(out.supersedes, /2019 bidding/, 'reason is carried out for the report');
}

// ── rename attempt is blocked by the guard ──────────────────────────────────
await assert.rejects(
  () => mergeSkillContent({
    existingContent: EXISTING_SKILL,
    tactics: NEW_TACTICS,
    client: mergeClient(JSON.stringify({
      content: '---\nname: marketing-renamed\ndescription: Lifecycle email\n---\n\n' + 'y'.repeat(900),
      supersedes: null,
    })),
  }),
  /name changed/,
  'the merge cannot rename the skill'
);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/agents/marketing-learner.test.js`
Expected: FAIL — `mergeSkillContent` is not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `lib/marketing-learner.js`:

```js
/**
 * Merge new tactics into an existing skill by asking the model for a COMPLETE
 * replacement file, then guarding the result.
 *
 * Whole-file replacement rather than patch application: applying model-generated
 * diffs corrupts silently and is very hard to notice after the fact. The failure
 * mode here is wholesale loss instead, which validateSkillEdit catches.
 */
export async function mergeSkillContent({ existingContent, tactics, client, maxTokens = 8000 }) {
  const fm = parseFrontmatter(existingContent);
  const tacticBlock = tactics.map((t) => (
    `- Claim: ${t.claim}\n  Mechanism: ${t.mechanism}\n  Evidence: ${t.evidence ?? 'assertion only'}\n` +
    `  Fit ${t.rscFit.score}/10: ${t.rscFit.reasoning}\n` +
    `  Source: ${t.source.creator} — "${t.source.title}" (${t.source.videoId})`
  )).join('\n');

  const prompt = `You maintain a Claude Code skill file. Integrate new tactics into it.

Current file:

<skill>
${existingContent}
</skill>

New tactics to integrate:

${tacticBlock}

Rules:
- Return the COMPLETE new file, not a diff.
- Keep the YAML frontmatter. The "name" MUST stay exactly "${fm.name}". You may sharpen "description".
- Where a new tactic refines, contradicts, or duplicates an existing claim, REVISE that
  section rather than appending a second copy. Avoiding duplication is the point of this step.
- Every claim keeps inline provenance in the form: *Source: Creator — "Title" (videoId)*
- Do not delete existing material unless it is genuinely superseded. If you do remove
  anything, say what and why in "supersedes".

Return ONLY JSON:
{ "content": "<the complete new SKILL.md>", "supersedes": "<what you removed and why, or null>" }`;

  const res = await client.messages.create({
    model: EXTRACTION_MODEL,
    max_tokens: maxTokens,
    messages: [{ role: 'user', content: prompt }],
  });
  if (res.stop_reason === 'max_tokens') {
    throw new Error(`Skill merge for "${fm.name}" hit max_tokens — refusing to write a truncated skill.`);
  }

  const text = (res.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = (fenced ? fenced[1] : text).trim();

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start === -1 || end <= start) throw new Error(`Could not parse JSON from the skill merge for "${fm.name}".`);
    parsed = JSON.parse(raw.slice(start, end + 1));
  }
  if (!parsed.content) throw new Error(`Skill merge for "${fm.name}" returned no content.`);

  const supersedes = parsed.supersedes ?? null;
  validateSkillEdit(existingContent, parsed.content, { supersedes }); // throws on damage
  return { content: parsed.content, supersedes };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/agents/marketing-learner.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/marketing-learner.js tests/agents/marketing-learner.test.js
git commit -m "feat(marketing-learner): LLM skill merge with edit guards

Whole-file replacement so later videos revise earlier claims instead of
stacking duplicates. Guarded by validateSkillEdit.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Agent — CLI, orchestration, and PR

**Files:**
- Create: `agents/marketing-learner/index.js`
- Modify: `package.json` (add the `learn` script)
- Test: `tests/agents/marketing-learner-cli.test.js`

**Interfaces:**
- Consumes: `fetchTranscript`, `extractVideoId`, `TranscriptError` (Tasks 1-2); `parsePublishedFlags` (Task 3); `scanSkillInventory`, `renderSkillMarkdown`, `parseFrontmatter` (Task 4); `extractTactics` (Task 5); `renderReport` (Task 6); `mergeSkillContent` (Task 7).
- Produces: `parseArgs(argv) -> { urls, published, extractOnly, noPr, refetch }`, and a `main()` that runs when the file is executed directly.

- [ ] **Step 1: Write the failing test**

Create `tests/agents/marketing-learner-cli.test.js`:

```js
import { strict as assert } from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { parseArgs } from '../../agents/marketing-learner/index.js';

// ── parseArgs ───────────────────────────────────────────────────────────────
{
  const a = parseArgs(['https://youtu.be/aaaaaaaaaaa']);
  assert.deepEqual(a.urls, ['https://youtu.be/aaaaaaaaaaa']);
  assert.deepEqual(a.published, []);
  assert.equal(a.extractOnly, false);
  assert.equal(a.noPr, false);
  assert.equal(a.refetch, false);
}
{
  const a = parseArgs(['https://youtu.be/aaaaaaaaaaa', '--published', '2026-03-14', '--no-pr']);
  assert.deepEqual(a.published, ['2026-03-14']);
  assert.equal(a.noPr, true);
}
{
  const a = parseArgs(['u1', '--published', '2026-03-14', 'u2', '--published', '2025-01-02']);
  assert.deepEqual(a.urls, ['u1', 'u2'], 'urls collected regardless of flag interleaving');
  assert.deepEqual(a.published, ['2026-03-14', '2025-01-02'], 'repeatable --published');
}
{
  const a = parseArgs(['u1', '--extract-only', '--refetch']);
  assert.equal(a.extractOnly, true);
  assert.equal(a.refetch, true);
}
assert.throws(() => parseArgs(['--published']), /--published requires/, 'dangling flag throws');
assert.throws(() => parseArgs([]), /at least one YouTube URL/, 'no urls throws');
assert.throws(() => parseArgs(['u1', '--bogus']), /Unknown flag/, 'unknown flag throws');

// ── wiring checks (structure, not behavior — the agent shells out and hits APIs) ──
const src = readFileSync('agents/marketing-learner/index.js', 'utf8');
assert.ok(existsSync('agents/marketing-learner/index.js'), 'agent file exists');
assert.ok(src.includes("from '../../lib/transcript-source.js'"), 'uses the transcript seam');
assert.ok(src.includes("from '../../lib/anthropic.js'"), 'uses the METERED Anthropic wrapper');
assert.ok(!src.includes("from '@anthropic-ai/sdk'"), 'must not import the SDK directly — that bypasses cost metering');
assert.ok(src.includes('mergeSkillContent'), 'merges into existing skills rather than appending');
assert.ok(src.includes('extractVideoId'), 'derives the cache key without spending a credit');
assert.ok(src.includes('notify'), 'notifies on completion');
assert.ok(src.includes('.claude/skills') || src.includes("'.claude'"), 'writes into the project skills dir');
assert.ok(!/TRANSCRIPTAPI_KEY[^\n]*console\.log/.test(src), 'never logs the api key');

// package.json script
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
assert.equal(pkg.scripts.learn, 'node agents/marketing-learner/index.js', 'npm run learn is wired');

console.log('✓ marketing-learner CLI tests pass');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/agents/marketing-learner-cli.test.js`
Expected: FAIL — `Cannot find module '.../agents/marketing-learner/index.js'`

- [ ] **Step 3: Write the agent**

Create `agents/marketing-learner/index.js`:

```js
#!/usr/bin/env node
/**
 * Marketing Learner
 *
 * Turns a YouTube marketing video into a reviewed pull request that creates or
 * sharpens a project-level Claude Code skill, plus a report scoring every tactic
 * found — including the rejects and why.
 *
 * Usage:
 *   node agents/marketing-learner/index.js <url> [<url>…]
 *     --published <YYYY-MM-DD>  Upload date. Optional but recommended — the API does
 *                               not provide it. Repeatable, pairs positionally with URLs.
 *     --extract-only            Fetch + extract + report. Do not touch skills or open a PR.
 *     --no-pr                   Write into the working tree. No branch, no PR.
 *     --refetch                 Ignore the transcript cache (costs a credit).
 *
 * Requires TRANSCRIPTAPI_KEY in .env.
 * Spec: docs/superpowers/specs/2026-07-27-marketing-learner-design.md
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import Anthropic from '../../lib/anthropic.js';
import { notify } from '../../lib/notify.js';
import { fetchTranscript, extractVideoId, TranscriptError } from '../../lib/transcript-source.js';
import {
  parsePublishedFlags,
  scanSkillInventory,
  renderSkillMarkdown,
  parseFrontmatter,
  extractTactics,
  mergeSkillContent,
  renderReport,
} from '../../lib/marketing-learner.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const SKILLS_DIR = join(ROOT, '.claude', 'skills');
const CORPUS_DIR = join(ROOT, 'data', 'marketing-corpus');
const REPORT_DIR = join(ROOT, 'data', 'reports', 'marketing-learner');

const FLAGS = { '--extract-only': 'extractOnly', '--no-pr': 'noPr', '--refetch': 'refetch' };

/** Repo convention: agents read .env themselves. There is no dotenv import anywhere here. */
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

export function parseArgs(argv) {
  const out = { urls: [], published: [], extractOnly: false, noPr: false, refetch: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--published') {
      const v = argv[++i];
      if (!v || v.startsWith('--')) throw new Error('--published requires a YYYY-MM-DD value.');
      out.published.push(v);
    } else if (FLAGS[a]) {
      out[FLAGS[a]] = true;
    } else if (a.startsWith('--')) {
      throw new Error(`Unknown flag: ${a}`);
    } else {
      out.urls.push(a);
    }
  }
  if (!out.urls.length) throw new Error('Provide at least one YouTube URL.');
  return out;
}

function git(args, opts = {}) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', ...opts }).trim();
}

/**
 * Cached fetch. The video id is derived from the URL WITHOUT calling the API, so a
 * cache hit costs zero credits — deriving it from a fetch response first would spend
 * a credit on every run and make the cache pointless.
 */
async function loadVideo(url, publishedAt, { refetch, apiKey }) {
  const videoId = extractVideoId(url);
  const dir = join(CORPUS_DIR, videoId);
  const cachePath = join(dir, 'video.json');

  if (!refetch && existsSync(cachePath)) {
    console.log('  (transcript from cache — 0 credits)');
    return { ...JSON.parse(readFileSync(cachePath, 'utf8')), publishedAt };
  }

  const fetched = await fetchTranscript(url, { apiKey });
  mkdirSync(dir, { recursive: true });
  writeFileSync(cachePath, JSON.stringify(fetched, null, 2));
  writeFileSync(join(dir, 'transcript.txt'), fetched.text);
  return { ...fetched, publishedAt };
}

/**
 * Create a new skill, or merge into an existing one via the LLM so later videos
 * revise earlier claims rather than stacking duplicates on top of them.
 */
async function writeSkill({ name, description, tactics, existing, client }) {
  const dir = join(SKILLS_DIR, name);
  const path = join(dir, 'SKILL.md');

  if (existing) {
    const { content, supersedes } = await mergeSkillContent({
      existingContent: existing.content,
      tactics,
      client,
    });
    writeFileSync(path, content);
    if (supersedes) console.log(`  ↻ ${name} superseded content: ${supersedes}`);
    return { path, action: 'edit' };
  }

  mkdirSync(dir, { recursive: true });
  writeFileSync(path, renderSkillMarkdown({ name, description, tactics }));
  return { path, action: 'create' };
}

async function processVideo(item, { client, apiKey, args }) {
  const video = await loadVideo(item.url, item.publishedAt, { refetch: args.refetch, apiKey });
  if (item.warning) console.warn(`  ⚠ ${item.warning}`);

  const inventory = scanSkillInventory(SKILLS_DIR);
  const extraction = await extractTactics({ video, inventory, client });

  mkdirSync(REPORT_DIR, { recursive: true });
  writeFileSync(join(REPORT_DIR, `${video.videoId}.json`), JSON.stringify(extraction, null, 2));

  const adopted = extraction.tactics.filter((t) => t.verdict === 'adopt');
  const skillsTouched = [];

  if (!args.extractOnly) {
    const bySkill = new Map();
    for (const t of adopted) {
      const key = t.targetSkill.name;
      if (!bySkill.has(key)) bySkill.set(key, { action: t.targetSkill.action, tactics: [] });
      bySkill.get(key).tactics.push({ ...t, source: { creator: video.creator, title: video.title, videoId: video.videoId } });
    }
    for (const [name, { tactics }] of bySkill) {
      const existing = inventory.find((s) => s.name === name);
      const description = existing
        ? parseFrontmatter(existing.content).description
        : `Use when working on ${name.replace(/^marketing-/, '').replace(/-/g, ' ')} for Real Skin Care.`;
      const { action } = await writeSkill({ name, description, tactics, existing, client });
      skillsTouched.push({ name, action });
    }
  }

  const report = renderReport({ extraction, video, skillsTouched });
  writeFileSync(join(REPORT_DIR, `${video.videoId}.md`), report);

  console.log(`  ${adopted.length} adopted, ${extraction.tactics.length - adopted.length} rejected`);
  return { video, extraction, skillsTouched };
}

function openPullRequest(results) {
  const touched = results.flatMap((r) => r.skillsTouched);
  if (!touched.length) {
    console.log('No skills changed — skipping the PR.');
    return null;
  }
  const topics = [...new Set(touched.map((s) => s.name.replace(/^marketing-/, '')))];
  const branch = topics.length === 1
    ? `feature/marketing-skill-${topics[0]}`
    : `feature/marketing-skills-${topics.length}-topics`;

  git(['checkout', '-b', branch]);
  git(['add', '.claude/skills', 'data/reports/marketing-learner']);
  git(['commit', '-m', `feat(skills): marketing tactics from ${results.length} video(s)\n\nCo-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`]);
  git(['push', '-u', 'origin', branch]);

  const body = results.map((r) => {
    const rows = r.extraction.tactics
      .sort((a, b) => b.rscFit.score - a.rscFit.score)
      .map((t) => `| ${t.rscFit.score}/10 | ${t.verdict} | ${t.claim} | ${t.rejectReason ?? t.rscFit.reasoning} |`)
      .join('\n');
    return `## ${r.video.title}\n\nhttps://www.youtube.com/watch?v=${r.video.videoId}\n\n| Score | Verdict | Claim | Reasoning |\n|---|---|---|---|\n${rows}`;
  }).join('\n\n');

  execFileSync('gh', ['pr', 'create', '--title', `Marketing skills: ${topics.join(', ')}`, '--body',
    `${body}\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)`],
    { cwd: ROOT, encoding: 'utf8', stdio: 'inherit' });
  return branch;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const apiKey = loadEnv().TRANSCRIPTAPI_KEY || process.env.TRANSCRIPTAPI_KEY;
  if (!apiKey) {
    console.error('TRANSCRIPTAPI_KEY is not set. Add it to .env.');
    process.exit(1);
  }
  const items = parsePublishedFlags(args.urls, args.published, {});
  const client = new Anthropic();

  const results = [];
  for (const item of items) {
    console.log(`\n▶ ${item.url}`);
    try {
      results.push(await processVideo(item, { client, apiKey, args }));
    } catch (err) {
      if (err instanceof TranscriptError && ['NOT_FOUND', 'NO_ENGLISH'].includes(err.code)) {
        console.warn(`  ⏭ skipped: ${err.message}`);
        continue; // one bad video must not kill the batch
      }
      throw err;
    }
  }

  if (!results.length) {
    console.log('\nNothing processed.');
    return;
  }
  if (!args.extractOnly && !args.noPr) openPullRequest(results);

  const adopted = results.reduce((n, r) => n + r.extraction.tactics.filter((t) => t.verdict === 'adopt').length, 0);
  const rejected = results.reduce((n, r) => n + r.extraction.tactics.filter((t) => t.verdict === 'reject').length, 0);
  await notify({
    subject: `Marketing learner: ${adopted} adopted, ${rejected} rejected`,
    body: results.map((r) => `${r.video.title}: ${r.skillsTouched.map((s) => s.name).join(', ') || 'no skills changed'}`).join('\n'),
    category: 'marketing-learner',
  });
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectRun) {
  main().catch((err) => { console.error(err.message); process.exit(1); });
}
```

- [ ] **Step 4: Add the npm script**

In `package.json`, add to `"scripts"` immediately after the `"voc-analyze"` line:

```json
    "learn": "node agents/marketing-learner/index.js",
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test tests/agents/marketing-learner-cli.test.js`
Expected: PASS.

Then run the whole suite to confirm nothing regressed:

Run: `npm test`
Expected: no new failures versus the pre-existing baseline.

- [ ] **Step 6: Commit**

```bash
git add agents/marketing-learner/index.js tests/agents/marketing-learner-cli.test.js package.json
git commit -m "feat(marketing-learner): agent CLI, orchestration, and PR automation

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Manual end-to-end verification

Repo rule #4: test a real run on ONE video before any batch use. This task writes no
production code — it proves the pipeline works against live APIs and records what it did.

**Files:**
- Create: `data/reports/marketing-learner/<videoId>.md` (generated, committed)

- [ ] **Step 1: Ask the operator for a real video**

Ask Sean for one marketing video URL and its upload date. Do not pick one unilaterally —
the whole tool is built around him choosing what is worth learning from.

- [ ] **Step 2: Dry run — extraction only, no skills, no PR**

```bash
node agents/marketing-learner/index.js "<url>" --published <YYYY-MM-DD> --extract-only
```

Expected: a transcript is fetched (1 credit), and `data/reports/marketing-learner/<videoId>.md`
appears with an Adopted section, a Rejected section, and per-tactic scores.

- [ ] **Step 3: Read the report and sanity-check the judgment**

Confirm by reading, not by assuming:
- Rejected tactics cite a real constraint (solo operator, budget, platform, scale).
- Adopted tactics are actually actionable for a 12-SKU solo DTC brand.
- If the video is older than ~18 months, platform-mechanics tactics were marked down and
  `rscFit.reasoning` names the tactic class.

If the judgment is bad, the fix is the constraint block or the prompt in
`lib/marketing-learner.js` — not the plumbing. Report what you saw rather than moving on.

- [ ] **Step 4: Full run on the same video**

```bash
node agents/marketing-learner/index.js "<url>" --published <YYYY-MM-DD> --no-pr
```

Expected: `.claude/skills/marketing-<topic>/SKILL.md` is created. The transcript is served
from cache, so this costs **0 additional credits**.

- [ ] **Step 5: Verify the generated skill**

```bash
cat .claude/skills/marketing-*/SKILL.md
```

Confirm: valid `---` frontmatter, a `name` matching the directory, a non-empty `description`
that would plausibly trigger, and provenance (creator + videoId) on every claim.

- [ ] **Step 6: Commit the verification artifacts**

```bash
git add .claude/skills data/reports/marketing-learner
git commit -m "test(marketing-learner): end-to-end verification on a real video

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 7: Report results to Sean**

State plainly: how many tactics were found, how many adopted, which skill was written, and
whether the scoring judgment looked sound. If it did not, say so — the first few videos
producing mediocre skills is an expected outcome, not a failure to hide.

---

## Notes for the implementer

- **`.claude/` is tracked in this repo** (not gitignored), so skills commit normally.
- `data/marketing-corpus/` is gitignored in Task 2; `data/reports/marketing-learner/` is NOT — reports are committed.
- The existing test suite has pre-existing failures unrelated to this work. Establish the baseline with `npm test` BEFORE Task 1 so you can tell your regressions from the inherited ones.
- Never print `TRANSCRIPTAPI_KEY`. The Task 2 test asserts it stays out of error messages.
- Credits are finite (100 on the free tier, 2 already spent probing). Tasks 1–8 use zero — every test is mocked. Only Task 9 spends, and only 1 credit thanks to the cache.
- The agent loads `.env` with its own local `loadEnv()`, matching `agents/voice-of-customer/index.js`. Do NOT `import 'dotenv/config'` — no agent in this repo does, even though dotenv is a dependency.
