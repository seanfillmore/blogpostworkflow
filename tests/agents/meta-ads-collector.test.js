// tests/agents/meta-ads-collector.test.js
import { strict as assert } from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';

// File existence
assert.ok(existsSync('agents/meta-ads-collector/index.js'), 'agent file missing');

// Structural checks
const src = readFileSync('agents/meta-ads-collector/index.js', 'utf8');
assert.ok(src.includes('meta-ads-library'), 'must import meta-ads-library');
assert.ok(src.includes('config/meta-ads.json') || src.includes("'meta-ads'"), 'must load meta-ads config');
assert.ok(src.includes('searchByKeyword'), 'must call searchByKeyword');
assert.ok(src.includes('searchByPageId'), 'must call searchByPageId');
assert.ok(src.includes('snapshots/meta-ads-library'), 'must write to correct snapshot dir');
assert.ok(src.includes('notify'), 'must call notify');
assert.ok(src.includes('--date'), 'must support --date arg for smoke-testing specific dates');

console.log('✓ meta-ads-collector structural tests pass');
