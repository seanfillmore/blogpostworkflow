import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  suggestionFilePath,
  buildAlertEmailBody,
  parseSuggestionsResponse,
  loadRecentHistory,
  buildHistorySection,
} from '../../agents/ads-optimizer/index.js';

// suggestionFilePath
assert.equal(
  suggestionFilePath('2026-03-20', '/root/project'),
  '/root/project/data/ads-optimizer/2026-03-20.json'
);

// buildAlertEmailBody — includes spend, suggestion count, dashboard URL
const snap = { spend: 9.12, clicks: 16, conversions: 1, roas: 1.84 };
const suggestions = [
  { id: 's-001', type: 'keyword_pause', confidence: 'high', target: 'coconut oil lotion', rationale: 'Test reason.' },
  { id: 's-002', type: 'copy_rewrite', confidence: 'medium', target: 'Headline 4', adGroup: 'Natural Body Lotion', rationale: 'GSC signal.' },
];
const body = buildAlertEmailBody(snap, suggestions, 'http://localhost:4242');
assert.ok(body.includes('$9.12'), 'body must include spend');
assert.ok(body.includes('Suggestions:'), 'body must include suggestions header');
assert.ok(body.includes('localhost:4242'), 'body must include dashboard URL');
assert.ok(body.includes('[HIGH]'), 'body must include confidence badge');
assert.ok(body.includes('coconut oil lotion'), 'body must include target');

// parseSuggestionsResponse — valid JSON string
const raw = JSON.stringify({
  analysisNotes: 'Account healthy.',
  suggestions: [{ id: 's-001', type: 'keyword_pause', status: 'pending', confidence: 'high', adGroup: 'Coconut Lotion', target: 'foo', rationale: 'bar', proposedChange: { criterionResourceName: 'c/123' } }],
});
const parsed = parseSuggestionsResponse(raw);
assert.equal(parsed.analysisNotes, 'Account healthy.');
assert.equal(parsed.suggestions.length, 1);
assert.equal(parsed.suggestions[0].status, 'pending');

// parseSuggestionsResponse — Claude wraps in markdown code block
const wrapped = '```json\n' + raw + '\n```';
const parsed2 = parseSuggestionsResponse(wrapped);
assert.equal(parsed2.suggestions.length, 1);

// parseSuggestionsResponse — adds status: 'pending' when missing
const noStatus = JSON.stringify({
  analysisNotes: 'Test',
  suggestions: [{ id: 's-001', type: 'keyword_pause', confidence: 'high', target: 'test', rationale: 'test', proposedChange: {} }],
});
const parsed3 = parseSuggestionsResponse(noStatus);
assert.equal(parsed3.suggestions[0].status, 'pending', 'must default status to pending');

// parseSuggestionsResponse — invalid JSON throws
assert.throws(() => parseSuggestionsResponse('not json'), /JSON/);

console.log('✓ ads-optimizer pure function tests pass');

// ── loadRecentHistory ─────────────────────────────────────────────────────────

// Returns empty array when directory doesn't exist
assert.deepEqual(loadRecentHistory('/tmp/no-such-dir-ads-test-xyz123'), []);

// Setup: write two fake history files
const tmpDir = join(tmpdir(), 'ads-history-test-' + Date.now());
mkdirSync(tmpDir, { recursive: true });

const today = new Date().toISOString().slice(0, 10);
const oldDate = '2020-01-01'; // outside 30-day window

writeFileSync(join(tmpDir, `${today}.json`), JSON.stringify({
  suggestions: [
    { id: 's1', type: 'keyword_pause', target: 'cheap shampoo', status: 'rejected', rationale: 'Reject reason.' },
    { id: 's2', type: 'negative_add', target: 'free samples', status: 'applied', rationale: 'Applied reason.' },
    { id: 's3', type: 'bid_adjust', target: 'natural deodorant', status: 'pending', rationale: 'Pending.' },
  ],
}));
writeFileSync(join(tmpDir, `${oldDate}.json`), JSON.stringify({
  suggestions: [{ id: 's4', type: 'keyword_pause', target: 'old keyword', status: 'rejected', rationale: 'Old.' }],
}));

// Write a corrupted file — should be silently skipped
writeFileSync(join(tmpDir, `${today.slice(0, 7)}-15.json`), 'not valid json');

const history = loadRecentHistory(tmpDir, 30);

// Only returns non-pending suggestions within the 30-day window
assert.equal(history.length, 2, 'must return only non-pending suggestions within 30 days');
assert.ok(history.every(h => h.status !== 'pending'), 'must not include pending suggestions');
assert.ok(history.every(h => h.date === today), 'must not include suggestions outside 30-day window');

// Corrupted file must be silently skipped — valid entries still returned
assert.equal(history.length, 2, 'corrupted file must be silently skipped');

// History items have required shape
const h = history[0];
assert.ok('date' in h, 'must have date');
assert.ok('type' in h, 'must have type');
assert.ok('target' in h, 'must have target');
assert.ok('status' in h, 'must have status');
assert.ok('rationale' in h, 'must have rationale');

// ── buildHistorySection ───────────────────────────────────────────────────────

// Empty history → empty string
assert.equal(buildHistorySection([]), '');

// Populated history → markdown section with header
const section = buildHistorySection([
  { date: '2026-03-28', type: 'keyword_pause', target: 'cheap shampoo', status: 'rejected', rationale: 'Low intent.' },
  { date: '2026-03-29', type: 'negative_add', target: 'free samples', status: 'applied', rationale: 'Freebie intent.' },
]);
assert.ok(section.startsWith('### Previous Recommendation History'), 'must start with header');
assert.ok(section.includes('REJECTED'), 'must include uppercased status');
assert.ok(section.includes('cheap shampoo'), 'must include target');
assert.ok(section.includes('2026-03-28'), 'must include date');

// Cleanup
rmSync(tmpDir, { recursive: true });

console.log('✓ loadRecentHistory and buildHistorySection tests pass');

import { tagSuggestionsWithIndex, buildIndexDemandSection } from '../../agents/ads-optimizer/index.js';

// tagSuggestionsWithIndex — stamps validation_source when target matches
{
  const adsIdx = {
    keywords: {
      'natural-deodorant': { slug: 'natural-deodorant', keyword: 'natural deodorant', validation_source: 'amazon', amazon: { conversion_share: 0.12 } },
    },
  };
  const out = tagSuggestionsWithIndex([
    { id: '1', type: 'keyword_add', target: 'natural deodorant' },
    { id: '2', type: 'keyword_add', target: 'unknown query' },
  ], adsIdx);
  assert.equal(out[0].validation_source, 'amazon');
  assert.equal(out[0].amazon_conversion_share, 0.12);
  assert.equal(out[1].validation_source, undefined);
}

// buildIndexDemandSection — empty for no entries
assert.equal(buildIndexDemandSection([]), '');

// buildIndexDemandSection — renders markdown table
{
  const out = buildIndexDemandSection([
    { keyword: 'natural deodorant', amazon: { purchases: 280, conversion_share: 0.124 } },
  ]);
  assert.ok(out.includes('Amazon-Validated Demand'));
  assert.ok(out.includes('| natural deodorant | 280 | 12.4% |'));
}
