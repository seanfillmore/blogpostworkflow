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
