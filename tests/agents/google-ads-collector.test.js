import { strict as assert } from 'assert';
import { existsSync } from 'fs';

// Agent file exists
assert.ok(existsSync('agents/google-ads-collector/index.js'), 'agent file missing');

// Usage pattern check — file should import from lib/google-ads.js
const { readFileSync } = await import('fs');
const src = readFileSync('agents/google-ads-collector/index.js', 'utf8');
assert.ok(src.includes('fetchDailySnapshot'), 'must call fetchDailySnapshot');
assert.ok(src.includes('yesterdayPT'), 'must default to yesterday');
assert.ok(src.includes('google-ads'), 'snapshot dir must be google-ads');

console.log('✓ google-ads-collector structure tests pass');
