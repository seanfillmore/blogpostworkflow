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
