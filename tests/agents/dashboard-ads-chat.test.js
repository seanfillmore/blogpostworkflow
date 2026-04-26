import { strict as assert } from 'node:assert';
import { readAllDashboardSource } from '../helpers/dashboard-source.js';

// Smoke checks that the per-suggestion ads chat feature still exists somewhere
// in the dashboard codebase. The pre-refactor version of this test asserted
// many implementation-level details of the old monolithic dashboard/index.js
// (route ordering, specific variable names, comment text). After the dashboard
// was split into route + lib + public modules, those checks lost meaning.
// Keeping the high-signal feature-existence assertions only.

const src = readAllDashboardSource();

// Anthropic SDK is wired in somewhere
assert.ok(src.includes("from '@anthropic-ai/sdk'"), 'must import Anthropic SDK somewhere');
assert.ok(src.includes('new Anthropic('), 'must instantiate Anthropic client somewhere');

// Per-suggestion chat endpoint exists (matched via router pattern in routes/ads.js)
assert.ok(/url\.endsWith\(['"]\/chat['"]\)/.test(src), 'must register a /chat endpoint');
assert.ok(src.includes('/suggestion/'), 'must route per-suggestion paths');

// Concurrency guard for in-flight chat calls
assert.ok(src.includes('adsInFlight'), 'must guard concurrent ads chat calls');

// Claude tool surface
assert.ok(src.includes('approve_suggestion'), 'must define approve_suggestion tool');
assert.ok(src.includes('reject_suggestion'), 'must define reject_suggestion tool');
assert.ok(src.includes('update_suggestion'), 'must define update_suggestion tool');
assert.ok(src.includes('ALLOWED_UPDATE_FIELDS'), 'must validate update_suggestion fields');

// SSE close sentinel
assert.ok(src.includes('data: [DONE]'), 'must send DONE sentinel');

// Browser-side chat UI hooks
assert.ok(src.includes('toggleChat'), 'must have toggleChat function');
assert.ok(src.includes('sendChatMessage'), 'must have sendChatMessage function');
assert.ok(src.includes('btn-ads-discuss'), 'must have Discuss button for ads suggestions');

console.log('✓ ads suggestion chat feature exists');
