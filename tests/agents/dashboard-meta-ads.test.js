// tests/agents/dashboard-meta-ads.test.js
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';

const src = readFileSync('agents/dashboard/index.js', 'utf8');

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

// Tab
assert.ok(src.includes("switchTab('ad-intelligence'"), 'must have ad-intelligence tab button');
assert.ok(src.includes('tab-ad-intelligence'), 'must have tab panel');
assert.ok(src.includes('renderAdIntelligenceTab'), 'must have renderAdIntelligenceTab function');

console.log('✓ dashboard meta-ads tests pass');
