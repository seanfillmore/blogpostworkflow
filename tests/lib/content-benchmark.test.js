import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { computeCompetitorBenchmark } from '../../lib/content-benchmark.js';

const pages = [
  { word_count: 1200, headings: [{ tag: 'h2', text: 'A' }, { tag: 'h2', text: 'B' }, { tag: 'h3', text: 'c' }] },
  { word_count: 1800, headings: [{ tag: 'h2', text: 'A' }, { tag: 'h2', text: 'B' }, { tag: 'h2', text: 'C' }, { tag: 'h2', text: 'D' }] },
  { word_count: 2400, headings: [{ tag: 'h2', text: 'A' }] },
];

test('computeCompetitorBenchmark: median word count + avg h2 + target', () => {
  const b = computeCompetitorBenchmark(pages);
  assert.equal(b.count, 3);
  assert.equal(b.medianWordCount, 1800);          // middle of [1200,1800,2400]
  assert.equal(b.avgH2, 2.33);                     // (2+4+1)/3 rounded to 2 dp
  // target = round(median to nearest 100), clamped 800..3000
  assert.equal(b.targetWordCount, 1800);
});

test('computeCompetitorBenchmark: even count averages the two middles', () => {
  const b = computeCompetitorBenchmark([{ word_count: 1000, headings: [] }, { word_count: 2000, headings: [] }]);
  assert.equal(b.medianWordCount, 1500);
});

test('computeCompetitorBenchmark: target clamped to [800,3000]', () => {
  assert.equal(computeCompetitorBenchmark([{ word_count: 200, headings: [] }]).targetWordCount, 800);
  assert.equal(computeCompetitorBenchmark([{ word_count: 9000, headings: [] }]).targetWordCount, 3000);
});

test('computeCompetitorBenchmark: empty/missing → null', () => {
  assert.equal(computeCompetitorBenchmark([]), null);
  assert.equal(computeCompetitorBenchmark(null), null);
});

test('computeCompetitorBenchmark: ignores pages with no word_count', () => {
  const b = computeCompetitorBenchmark([{ headings: [] }, { word_count: 1500, headings: [{tag:'h2',text:'a'}] }]);
  assert.equal(b.count, 1);
  assert.equal(b.medianWordCount, 1500);
});
