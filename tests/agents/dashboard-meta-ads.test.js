// tests/agents/dashboard-meta-ads.test.js
import { strict as assert } from 'node:assert';
import { readAllDashboardSource } from '../helpers/dashboard-source.js';

const src = readAllDashboardSource();

// New constants
assert.ok(src.includes('META_ADS_INSIGHTS_DIR'), 'must define insights dir constant');
assert.ok(src.includes('CREATIVE_JOBS_DIR'), 'must define jobs dir constant');
assert.ok(src.includes('CREATIVE_PACKAGES_DIR'), 'must define packages dir constant');

// Job cleanup on startup
assert.ok(src.includes('creative-jobs') && src.includes('7 * 86400'), 'must clean up old job files on startup');

// API routes
assert.ok(src.includes('/api/meta-ads-insights'), 'must have meta-ads-insights endpoint');
assert.ok(src.includes('/api/generate-creative'), 'must have generate-creative endpoint');
assert.ok(src.includes('/api/creative-packages/'), 'must have creative-packages status endpoint');
assert.ok(src.includes('download'), 'must have download endpoint');
assert.ok(src.includes('application/zip'), 'must serve ZIP files');

// Tab — the live tab is "My Meta Ads"; "Ad Intelligence" is a disabled
// placeholder pill kept for future use.
assert.ok(src.includes("switchTab('my-meta-ads'"), 'must have my-meta-ads tab button');
assert.ok(src.includes('tab-my-meta-ads'), 'must have my-meta-ads tab panel');
assert.ok(src.includes('renderMyMetaAdsTab'), 'must have renderMyMetaAdsTab function');
assert.ok(src.includes('tab-ad-intelligence'), 'must keep Ad Intelligence placeholder panel');

console.log('✓ dashboard meta-ads tests pass');
