import { strict as assert } from 'node:assert';
import { readAllDashboardSource } from '../helpers/dashboard-source.js';

const src = readAllDashboardSource();

assert.ok(src.includes('GOOGLE_ADS_SNAPSHOTS_DIR'), 'must define snapshot dir constant');
assert.ok(src.includes("switchTab('ads'"), 'must have ads tab button');
assert.ok(src.includes('tab-ads'), 'must have tab-ads panel');
assert.ok(src.includes('renderAdsTab'), 'must have renderAdsTab function');
assert.ok(src.includes('Ad Spend'), 'must have Ad Spend KPI card');
assert.ok(src.includes('ROAS'), 'must have ROAS KPI card');

console.log('✓ dashboard ads tab tests pass');
