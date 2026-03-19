import { strict as assert } from 'assert';
import { readFileSync } from 'fs';

const src = readFileSync('agents/dashboard/index.js', 'utf8');

assert.ok(src.includes('GOOGLE_ADS_SNAPSHOTS_DIR'), 'must define snapshot dir constant');
assert.ok(src.includes("switchTab('ads'"), 'must have ads tab button');
assert.ok(src.includes('tab-ads'), 'must have tab-ads panel');
assert.ok(src.includes('renderAdsTab'), 'must have renderAdsTab function');
assert.ok(src.includes('Ad Spend'), 'must have Ad Spend KPI card');
assert.ok(src.includes('ROAS'), 'must have ROAS KPI card');

console.log('✓ dashboard ads tab tests pass');
