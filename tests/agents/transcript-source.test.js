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

// ── fetchTranscript (network layer) ─────────────────────────────────────────
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

// ── 429 persists through all retries: RATE_LIMIT classification ──────────────
{
  const impl = makeFetch([
    { status: 429, body: { detail: 'slow down' } },
    { status: 429, body: { detail: 'still slow' } },
    { status: 429, body: { detail: 'still slow' } },
  ]);
  const caught = await fetchTranscript('dQw4w9WgXcQ', { apiKey: 'k', fetchImpl: impl, backoffMs: 1 }).catch((e) => e);
  assert.equal(caught.code, 'RATE_LIMIT', 'exhausted retries on 429 produces RATE_LIMIT code');
  assert.equal(caught.status, 429, 'status is preserved');
  assert.equal(impl.calls.length, 3, 'exhausted all 3 attempts');
}

console.log('✓ transcript-source pure-helper tests pass');
