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
  assert.equal(src.sourceKind, 'book', 'named a book unless told otherwise');
}

// ── sourceKind rides on the source, because provenance is downstream of it ───
{
  const p = join(dir, 'post.md');
  writeFileSync(p, 'A short essay someone pasted.\n');
  const src = loadTextFile(p, { author: 'Stefan Georgi', title: 'Secret #2', sourceKind: 'social post' });
  assert.equal(src.sourceKind, 'social post');
  assert.equal(src.sourceType, 'file', 'kind describes the work; type still describes the loader');
}

// ── every failure mode throws TextSourceError with a distinct code ───────────
{
  const cases = [
    ['MISSING', () => loadTextFile(join(dir, 'nope.txt'), { author: 'A', title: 'T' })],
    ['BAD_EXT', () => { const p = join(dir, 'book.pdf'); writeFileSync(p, 'x'); return loadTextFile(p, { author: 'A', title: 'T' }); }],
    ['EMPTY', () => { const p = join(dir, 'empty.txt'); writeFileSync(p, '   \n\n  '); return loadTextFile(p, { author: 'A', title: 'T' }); }],
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
