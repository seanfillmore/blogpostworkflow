import { strict as assert } from 'node:assert';
import {
  suggestionFilePath,
  buildAlertEmailBody,
  parseSuggestionsResponse,
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
