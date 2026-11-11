import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCrontab, isRerunnable, NEVER_RERUN, collectorFor, feedNameOf } from '../../lib/recap-jobs.js';

const CRON = `# comment
MAILTO=""

15 13 * * * cd "/root/seo-claude" && /usr/bin/node agents/gsc-collector/index.js >> data/reports/scheduler/gsc-collector.log 2>&1
55 12 * * * cd "/root/seo-claude" && /usr/bin/node agents/trybe-review/index.js --apply >> data/reports/scheduler/trybe-review.log 2>&1
40 12 * * * cd "/root/seo-claude" && /usr/bin/node scripts/check-post-meta-drift.mjs >> data/reports/scheduler/post-meta-gate.log 2>&1
`;

test('parseCrontab keys on script, keeps args, strips log', () => {
  const m = parseCrontab(CRON);
  assert.equal(m.size, 3);
  assert.deepEqual(m.get('agents/gsc-collector/index.js'), { schedule: '15 13 * * *', command: '/usr/bin/node agents/gsc-collector/index.js' });
  assert.equal(m.get('agents/trybe-review/index.js').command, '/usr/bin/node agents/trybe-review/index.js --apply');
  assert.equal(m.get('scripts/check-post-meta-drift.mjs').schedule, '40 12 * * *');
});
test('parseCrontab ignores junk and empty input', () => {
  assert.equal(parseCrontab('').size, 0);
  assert.equal(parseCrontab(undefined).size, 0);
  assert.equal(parseCrontab('MAILTO=x\n# 1 2 3 4 5 node a.js').size, 0);
});
test('isRerunnable allowlist', () => {
  for (const s of ['scripts/check-post-meta-drift.mjs', 'agents/gsc-collector/index.js', 'agents/shopify-collector/index.js',
    'agents/rank-tracker/index.js', 'agents/post-performance/index.js', 'agents/seo-impact/index.js', 'agents/gsc-opportunity/index.js',
    'agents/quick-win-targeter/index.js', 'agents/indexing-checker/index.js', 'agents/keyword-index-builder/index.js', 'agents/trybe-review/index.js']) {
    assert.equal(isRerunnable(s), true, s);
  }
  for (const s of ['agents/blog-post-writer/index.js', 'scripts/remediate-x.mjs', 'agents/publish-drift/index.js', '', undefined, null]) {
    assert.equal(isRerunnable(s), false, String(s));
  }
});
test('NEVER_RERUN entries are never rerunnable', () => {
  for (const s of ['agents/creator-outreach/index.js', 'agents/press-outreach/index.js', 'agents/ugc-reels/index.js', 'agents/social-poster/index.js',
    'agents/instagram-dm/index.js', 'agents/founder-notes/index.js', 'agents/amazon-review-requests/index.js', 'agents/publisher/index.js',
    'agents/calendar-runner/index.js', 'agents/meta-optimizer/index.js', 'agents/queue-autoapply/index.js']) {
    assert.ok(NEVER_RERUN.has(s), s);
    assert.equal(isRerunnable(s), false, s);
  }
  assert.equal(isRerunnable('scripts/check-x.mjs'), true);
});
test('collectorFor pins every checkSystemHealth feed', () => {
  const cases = {
    'Data feed "rank-snapshots" is stale': 'agents/rank-tracker/index.js',
    'Data feed "gsc" is stale': 'agents/gsc-collector/index.js',
    'Data feed "ga4" is missing': 'agents/ga4-collector/index.js',
    'Data feed "clarity" is stale': 'agents/clarity-collector/index.js',
    'Data feed "shopify" is stale': 'agents/shopify-collector/index.js',
    'Data feed "google-ads" is stale': 'agents/google-ads-collector/index.js',
    'Analysis report "gsc-opportunity report" is stale': 'agents/gsc-opportunity/index.js',
    'Analysis report "quick-wins report" is stale': 'agents/quick-win-targeter/index.js',
    'Analysis report "seo-impact report" is stale': 'agents/seo-impact/index.js',
    'Analysis report "publish-drift report" is stale': 'agents/publish-drift/index.js',
    'Analysis report "pipeline-prioritizer report" is missing': 'agents/pipeline-prioritizer/index.js',
  };
  for (const [t, s] of Object.entries(cases)) assert.equal(collectorFor(t), s, t);
});
test('collectorFor unknown -> null', () => {
  assert.equal(collectorFor('Data feed "nope" is stale'), null);
  assert.equal(collectorFor('2 leftover git stashes on the server'), null);
  assert.equal(collectorFor(undefined), null);
});

test('M2: feedNameOf reads the feed name, ignoring the stale/missing wording', () => {
  assert.equal(feedNameOf('Data feed "gsc" is stale (6 days old)'), 'gsc');
  assert.equal(feedNameOf('Data feed "gsc" is missing'), 'gsc');
  assert.equal(feedNameOf('Analysis report "seo-impact report" is 5 days old'), 'seo-impact report');
  assert.equal(feedNameOf('2 leftover git stashes'), null);
});

test('C1: scheduler.js and daily-summary are never rerunnable', () => {
  assert.equal(isRerunnable('scheduler.js'), false);
  assert.equal(isRerunnable('agents/daily-summary/index.js'), false);
});
