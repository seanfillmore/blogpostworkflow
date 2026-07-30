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

// ── a single paragraph over budget is hard-split on word boundaries ─────────
// Auto-generated YouTube transcripts arrive as one unbroken blob with no blank
// lines and almost no punctuation, so "never split a paragraph" made chunking a
// no-op for exactly the sources that need it: a 9,794-word transcript came back
// as one chunk and overflowed the extraction token cap.
{
  const out = chunkText(words(500, 'z'), { maxWords: 100, overlapWords: 0 });
  assert.ok(out.length >= 5, `oversized paragraph splits, got ${out.length} chunks`);
  for (const c of out) {
    assert.ok(c.text.split(/\s+/).filter(Boolean).length <= 100, 'no chunk exceeds the budget');
  }
  const total = out.reduce((n, c) => n + c.text.split(/\s+/).filter(Boolean).length, 0);
  assert.equal(total, 500, 'no words are dropped or duplicated when overlap is 0');
}

// ── hard-split still carries overlap between the pieces ─────────────────────
{
  const out = chunkText(words(300, 'z'), { maxWords: 100, overlapWords: 10 });
  assert.ok(out.length >= 3, 'still splits with overlap on');
  for (const c of out) {
    assert.ok(
      c.text.split(/\s+/).filter(Boolean).length <= 110,
      'a chunk may carry the overlap tail on top of the budget, but no more',
    );
  }
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
