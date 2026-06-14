// lib/content-benchmark.js
// Pure: derive a data-driven depth benchmark from the competitor pages the
// content-researcher scrapes (each has word_count + headings[]). Grounds the
// brief's word-count / section-depth target in what actually ranks, instead of a
// guessed tier.

function median(nums) {
  const s = [...nums].sort((a, b) => a - b);
  const n = s.length;
  if (!n) return 0;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

export function computeCompetitorBenchmark(pages) {
  const valid = (pages || []).filter((p) => p && typeof p.word_count === 'number' && p.word_count > 0);
  if (!valid.length) return null;
  const words = valid.map((p) => p.word_count);
  const med = median(words);
  const h2counts = valid.map((p) => (p.headings || []).filter((h) => String(h.tag).toLowerCase() === 'h2').length);
  const avgH2 = Math.round((h2counts.reduce((a, b) => a + b, 0) / valid.length) * 100) / 100;
  const target = Math.min(3000, Math.max(800, Math.round(med / 100) * 100));
  return { count: valid.length, medianWordCount: med, avgH2, targetWordCount: target };
}
