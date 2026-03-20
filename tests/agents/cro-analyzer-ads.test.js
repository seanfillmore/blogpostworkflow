import { strict as assert } from 'assert';
import { readFileSync } from 'fs';

const src = readFileSync('agents/cro-analyzer/index.js', 'utf8');

assert.ok(src.includes('GOOGLE_ADS_DIR'), 'must define GOOGLE_ADS_DIR');
assert.ok(src.includes("loadRecentSnapshots(GOOGLE_ADS_DIR)"), 'must load google ads snapshots');
assert.ok(src.includes('Google Ads Performance'), 'must include Google Ads block in prompt');
assert.ok(src.includes('Google Ads:'), 'must mention Google Ads in system prompt');

console.log('✓ cro-analyzer google ads integration tests pass');
