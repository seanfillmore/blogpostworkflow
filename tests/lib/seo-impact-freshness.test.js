import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import {
  SEO_IMPACT_RELPATH, SEO_IMPACT_MAX_AGE_DAYS, PRIORITY_TUNER_MAX_AGE_DAYS,
  freshnessOfReport, freshnessOfFile, staleNote, seoImpactPath,
} from '../../lib/seo-impact-freshness.js';
import { loadClusterHold, corroboratedClassification, holdBanner } from '../../lib/cluster-hold.js';
import { clusterStatus } from '../../lib/cluster-revenue.js';
import { triageOrphanBrief } from '../../lib/brief-triage.js';
import { selectWorkItems } from '../../agents/calendar-runner/index.js';
import { decide } from '../../lib/queue-autoapply.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = (rel) => readFileSync(join(ROOT, rel), 'utf8');

// The 2026-08-22 production report, trimmed to what the gates read. toothpaste is
// the cluster CLAUDE.md names as the $0 one, and it clears the post-PR-#624 bar.
const CLUSTERS = [
  { cluster: 'body lotion', revenue: 313.49, clicks: 35, pages: 20 },
  { cluster: 'toothpaste', revenue: 0, clicks: 663, pages: 24 },
];
const TOTALS = { organic_conversions: 8, organic_sessions: 1067 };
const report = (generated_at) => ({
  generated_at, window: { start: '2026-07-24', end: '2026-08-20' }, clusters: CLUSTERS, totals: TOTALS,
});
// Real Shopify product revenue over the same windows — the corroborating source,
// without which nothing is held at all and this file would prove nothing.
const SNAPSHOTS = {
  '2026-08-20.json': {
    orders: { count: 18, revenue: 1079.46 },   // AOV $59.97 — the corroboration floor
    topProducts: [{ title: 'Coconut Oil Body Lotion', revenue: 909 }, { title: 'Natural Deodorant', revenue: 170.46 }],
  },
};
const TODAY = '2026-08-23';

function hold({ generatedAt, today = TODAY }) {
  return loadClusterHold({
    root: '/fake',
    today,
    readJson: (p) => {
      if (p.endsWith(SEO_IMPACT_RELPATH)) return generatedAt === null ? null : report(generatedAt);
      const f = p.split('/').pop();
      return SNAPSHOTS[f] || { topProducts: [] };
    },
    readDir: () => Object.keys(SNAPSHOTS),
  });
}

// ── the policy itself ────────────────────────────────────────────────────────

test('the default threshold is 4 days, and it is the only default', () => {
  assert.equal(SEO_IMPACT_MAX_AGE_DAYS, 4);
});

test('a report generated today, yesterday, or up to the threshold is fresh', () => {
  for (const [date, age] of [['2026-08-23', 0], ['2026-08-22', 1], ['2026-08-19', 4]]) {
    const r = freshnessOfReport(report(`${date}T15:16:44.241Z`), { today: TODAY });
    assert.equal(r.status, 'ok', `${date} should be fresh`);
    assert.equal(r.ageDays, age);
  }
});

test('a report older than the threshold is stale', () => {
  const r = freshnessOfReport(report('2026-08-18T15:16:44.241Z'), { today: TODAY });
  assert.equal(r.status, 'stale');
  assert.equal(r.ageDays, 5);
  assert.equal(r.maxAgeDays, SEO_IMPACT_MAX_AGE_DAYS);
});

test('a report with no generated_at, or no report at all, is missing — never "fresh"', () => {
  assert.equal(freshnessOfReport(null, { today: TODAY }).status, 'missing');
  assert.equal(freshnessOfReport({ clusters: CLUSTERS }, { today: TODAY }).status, 'missing');
});

test('freshnessOfFile reads a latest.json off disk and agrees with freshnessOfReport', () => {
  const dir = mkdtempSync(join(tmpdir(), 'seo-impact-fresh-'));
  const p = join(dir, 'latest.json');
  writeFileSync(p, JSON.stringify(report('2026-08-18T15:16:44.241Z')));
  const onDisk = freshnessOfFile(p, { today: TODAY });
  assert.equal(onDisk.status, 'stale');
  assert.equal(onDisk.ageDays, 5);
  // A path that does not exist is missing, not an exception.
  assert.equal(freshnessOfFile(join(dir, 'nope.json'), { today: TODAY }).status, 'missing');
});

test('staleNote says how old, against what expectation, and stays empty when fresh', () => {
  assert.equal(staleNote(freshnessOfReport(report(`${TODAY}T09:00:00Z`), { today: TODAY })), '');
  const note = staleNote(freshnessOfReport(report('2026-08-01T09:00:00Z'), { today: TODAY }));
  assert.match(note, /22 days old/);
  assert.match(note, /2026-08-01/);
  assert.match(note, new RegExp(`${SEO_IMPACT_MAX_AGE_DAYS} days`));
});

test('seoImpactPath composes the one relpath every consumer holds on', () => {
  assert.equal(seoImpactPath('/root'), join('/root', SEO_IMPACT_RELPATH));
});

// ── FAIL SAFE: a stale report must never block or delete work ────────────────

test('a FRESH report still holds the $0 cluster — the fail-safe is not a blanket off switch', () => {
  const h = hold({ generatedAt: '2026-08-22T15:16:44.241Z' });
  assert.equal(h.available, true);
  assert.equal(h.stale, false);
  assert.deepEqual([...h.heldSet], ['toothpaste']);
});

test('a STALE report holds nothing, classifies nothing, and reports itself unavailable', () => {
  const h = hold({ generatedAt: '2026-08-01T15:16:44.241Z' });
  assert.equal(h.stale, true, 'the staleness is recorded, not swallowed');
  assert.equal(h.available, false, 'a stale report is as unusable as an absent one');
  assert.deepEqual(h.classified, {}, 'nothing may be stamped a dud on a stale window');
  assert.equal(h.heldSet.size, 0);
  assert.equal(h.freshness.ageDays, 22);
  assert.equal(h.generatedAt, '2026-08-01T15:16:44.241Z', 'the date survives so the banner can name it');
});

test('a stale report leaves every cluster "unproven" for the blocking consumers', () => {
  const classified = corroboratedClassification(hold({ generatedAt: '2026-08-01T15:16:44.241Z' }));
  assert.deepEqual(classified, {});
  assert.equal(clusterStatus(classified, 'toothpaste'), 'unproven');
});

test('brief-triage KEEPS a brief in the $0 cluster when the report is stale', () => {
  const fresh = corroboratedClassification(hold({ generatedAt: '2026-08-22T15:16:44.241Z' }));
  const stale = corroboratedClassification(hold({ generatedAt: '2026-08-01T15:16:44.241Z' }));
  const ctx = { publishedKeywords: [], rejectedKeywords: [], brandTerms: [], inScope: () => true };

  assert.equal(triageOrphanBrief('toothpaste for canker sores', { ...ctx, clusterRevenue: fresh }).keep, false,
    'a fresh report still drops it — otherwise this test proves nothing');
  assert.equal(triageOrphanBrief('toothpaste for canker sores', { ...ctx, clusterRevenue: stale }).keep, true,
    'unlinkSync on a months-old measurement is the bug this whole change exists to stop');
});

test('calendar-runner blocks nothing when the report is stale', () => {
  const items = [{ keyword: 'natural toothpaste recipe', category: 'Toothpaste', publishDate: new Date('2026-08-24') }];
  const opts = { now: new Date('2026-08-23'), bufferDays: 7, statusOf: () => 'briefed' };

  const withFresh = selectWorkItems(items, { ...opts, clusterRevenue: corroboratedClassification(hold({ generatedAt: '2026-08-22T15:16:44.241Z' })) });
  assert.equal(withFresh.blocked.length, 1, 'a fresh report does still block');

  const withStale = selectWorkItems(items, { ...opts, clusterRevenue: corroboratedClassification(hold({ generatedAt: '2026-08-01T15:16:44.241Z' })) });
  assert.equal(withStale.blocked.length, 0);
  assert.equal(withStale.workItems.length, 1);
});

test('queue-autoapply does not dismiss a collection-gap item on a stale report', () => {
  const item = { trigger: 'collection-gap', slug: 'toothpaste-collection', status: 'pending',
    signal_source: { keyword: 'natural toothpaste' } };
  const productCounts = new Map([['toothpaste-collection', 3]]);

  const fresh = decide(item, { clusters: corroboratedClassification(hold({ generatedAt: '2026-08-22T15:16:44.241Z' })), productCounts });
  assert.equal(fresh.action, 'dismiss');

  const stale = decide(item, { clusters: corroboratedClassification(hold({ generatedAt: '2026-08-01T15:16:44.241Z' })), productCounts });
  assert.equal(stale.action, 'skip', 'skip, not dismiss — nothing is decided on a stale measurement');
});

// ── VISIBILITY: a stale report is never silent ───────────────────────────────

test('holdBanner names staleness distinctly from absence, and says nothing is paused', () => {
  const banner = holdBanner(hold({ generatedAt: '2026-08-01T15:16:44.241Z' }));
  assert.match(banner, /stale/i);
  assert.match(banner, /22 days/);
  assert.match(banner, /2026-08-01/);
  assert.doesNotMatch(banner, /is missing/, 'a stale report is present but unusable — say which');
  assert.match(banner, /Nothing is (paused|blocked)/i);
});

test('an absent report still reports itself as missing, not stale', () => {
  const banner = holdBanner(hold({ generatedAt: null }));
  assert.match(banner, /is missing/);
});

// ── one policy, no private copies ────────────────────────────────────────────

test('the alert threshold is never looser than any blocking consumer tolerates', () => {
  // daily-summary's health check is the ONLY channel a stale report speaks
  // through. If it alerted later than a gate degraded, there would be a window
  // where work silently stopped and nothing said so — the whole bug class.
  const ds = src('agents/daily-summary/index.js');
  assert.match(ds, /SEO_IMPACT_MAX_AGE_DAYS/, 'daily-summary alerts on the shared threshold');
  assert.ok(!/'seo-impact report',\s*path:[^}]*maxAgeDays:\s*\d+/.test(ds),
    'no hardcoded number on the seo-impact health row');
});

test('every consumer of latest.json reads the shared policy, not a private number', () => {
  for (const rel of [
    'lib/cluster-hold.js',
    'agents/pipeline-prioritizer/index.js',
    'agents/priority-tuner/index.js',
    'agents/daily-summary/index.js',
    'agents/ad-brief/index.js',
    'agents/dashboard/lib/data-loader.js',
  ]) {
    assert.match(src(rel), /seo-impact-freshness\.js/, `${rel} must import the shared policy`);
  }
});

test('priority-tuner keeps its wider window, but as a named, justified constant', () => {
  assert.ok(PRIORITY_TUNER_MAX_AGE_DAYS > SEO_IMPACT_MAX_AGE_DAYS);
  const pt = src('agents/priority-tuner/index.js');
  assert.match(pt, /PRIORITY_TUNER_MAX_AGE_DAYS/);
  assert.ok(!/impactAge\s*>\s*35/.test(pt), 'the hand-rolled 35 is gone');
});

test('pipeline-prioritizer drops the revenue signal on the shared threshold and says so', () => {
  const pp = src('agents/pipeline-prioritizer/index.js');
  assert.ok(!/fresh\('seo-impact',\s*3,/.test(pp), 'the incidental 3 is gone');
  assert.match(pp, /fresh\('seo-impact',\s*SEO_IMPACT_MAX_AGE_DAYS/);
});

test('ad-brief degrades to a neutral commercial score rather than refusing to run', () => {
  const ab = src('agents/ad-brief/index.js');
  assert.match(ab, /freshnessOfReport|freshnessOfFile/);
  // The stale path must null the report out, which scoreCommercial already
  // treats as neutral — not throw, not exit. Ranking is not destructive.
  assert.ok(!/throw new Error\([^)]*stale/i.test(ab), 'a stale report must not stop a brief run');
});
