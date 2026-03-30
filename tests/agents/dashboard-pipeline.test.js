import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';

const src = readFileSync('agents/dashboard/index.js', 'utf8');

assert.ok(src.includes('uploadKeywordZip'), 'must define uploadKeywordZip function');
assert.ok(src.includes('/upload/ahrefs-keyword-zip'), 'must have keyword zip upload endpoint');
assert.ok(src.includes('uploadContentGapZip'), 'must define uploadContentGapZip function');
assert.ok(src.includes('/upload/content-gap-zip'), 'must have content-gap zip upload endpoint');
assert.ok(src.includes('runGapAnalysis'), 'must define runGapAnalysis function');
assert.ok(src.includes('content-gap-card'), 'must have Content Gap Data card');
assert.ok(src.includes('run-log-agents-content-researcher-index-js'), 'must have content-researcher run-log element');
assert.ok(src.includes('run-log-agents-content-strategist-index-js'), 'must have content-strategist run-log element');
assert.ok(src.includes('CONTENT_GAP_DIR'), 'must define CONTENT_GAP_DIR constant');
assert.ok(src.includes('contentGapFiles'), 'must include contentGapFiles in data');

console.log('dashboard pipeline tests pass');
