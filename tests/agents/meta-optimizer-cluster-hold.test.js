// tests/agents/meta-optimizer-cluster-hold.test.js
//
// meta-optimizer was the sixth agent PR #617 should have gated and did not.
// Its weekly budget is `--apply --limit 5`, and on the real 2026-08-23
// candidate pool FOUR of those five slots go to the one held cluster, while
// the site's biggest CTR opportunity sits fifth and only just makes the cut.
//
// The pure selector lives in agents/meta-optimizer/lib/hold.js rather than in
// index.js because importing that index runs loadEnv() and can process.exit —
// same reason lib/sort.js and lib/grounding.js are already split out.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadClusterHold, HOLD_FLAG } from '../../lib/cluster-hold.js';
import { SEO_IMPACT_RELPATH } from '../../lib/seo-impact-freshness.js';
import { holdFor, heldScenario, impactReport, SOLD_90D, PAGES_EARNED_90D } from '../helpers/cluster-fixtures.js';
import { holdMetaCandidates } from '../../agents/meta-optimizer/lib/hold.js';
import { sortByValidation } from '../../agents/meta-optimizer/lib/sort.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// One cluster dead on BOTH sources — its products sold $0.00 over the 90-day
// judging window AND its pages earned $0.00 over the same window. SYNTHETIC:
// production has no held cluster as of 2026-08-23. What is under test is the
// SELECTOR — that the hold is applied, and applied before the --limit cap.
const SCENARIO = heldScenario('toothpaste');
const CLUSTERS = SCENARIO.clusters;
const HOLD = holdFor({ ...SCENARIO, generatedAt: '2026-08-23T10:00:00Z' });

const EARNING = holdFor({
  clusters: CLUSTERS,
  sold: { ...SOLD_90D, toothpaste: 12.5 },
  earned: { ...PAGES_EARNED_90D, toothpaste: 0 },
});

// The top of the REAL 2026-08-23 low-CTR pool, verbatim from the production
// data/reports/gsc-opportunity/latest.json (impressions ≥100, CTR ≤5%), in
// source order. Held against a live simulation on 2026-08-23.
const DUD_KW = 'sls free toothpaste';
const WINNER_KW = 'best soap for tattoos';
const REAL_POOL = [
  { keyword: 'sls free toothpaste', impressions: 25300, ctr: 0.0074, validation_source: 'gsc_ga4' },
  { keyword: 'toothpaste without sls', impressions: 7724, ctr: 0.0074, validation_source: 'gsc_ga4' },
  { keyword: 'sls free toothpaste list', impressions: 6667, ctr: 0.0108, validation_source: 'gsc_ga4' },
  { keyword: 'coconut oil toothpaste', impressions: 2772, ctr: 0.0061, validation_source: 'amazon' },
  { keyword: 'best soap for tattoos', impressions: 2337, ctr: 0.0056, validation_source: null },
  { keyword: 'non sls toothpaste', impressions: 2016, ctr: 0.0084, validation_source: 'gsc_ga4' },
  { keyword: 'coconut oil deodorant', impressions: 1077, ctr: 0.0046, validation_source: 'amazon' },
  { keyword: 'no sls toothpaste', impressions: 1072, ctr: 0.0056, validation_source: 'gsc_ga4' },
  { keyword: 'what soap to use for tattoo', impressions: 1007, ctr: 0.0050, validation_source: null },
  { keyword: 'sls-free toothpaste', impressions: 937, ctr: 0.0064, validation_source: 'gsc_ga4' },
];

// ── the hold itself ──────────────────────────────────────────────────────────

test('meta-optimizer holds a low-CTR candidate in a $0 cluster', () => {
  const { kept, held } = holdMetaCandidates(
    [{ keyword: DUD_KW }, { keyword: WINNER_KW }], HOLD,
  );
  assert.deepEqual(kept.map((c) => c.keyword), [WINNER_KW]);
  assert.equal(held.length, 1);
  assert.equal(held[0].cluster, 'toothpaste');
  assert.match(held[0].reason, /stays live/i);
});

test('meta-optimizer clusters through the page URL when the query alone does not', () => {
  const pageForKeyword = () => 'https://x.com/blogs/news/best-toothpaste-without-sls-2026';
  const { held } = holdMetaCandidates([{ keyword: 'best options for 2026' }], HOLD, { pageForKeyword });
  assert.equal(held.length, 1, 'the page the rewrite would land on is what decides the cluster');
  assert.equal(held[0].cluster, 'toothpaste');
});

test(`meta-optimizer's ${HOLD_FLAG} rewrites a held candidate anyway`, () => {
  const out = holdMetaCandidates([{ keyword: DUD_KW }], HOLD, { includeHeld: true });
  assert.equal(out.kept.length, 1);
  assert.equal(out.held.length, 0);
  assert.equal(out.overridden.length, 1, 'the override is recorded, not hidden');
});

test('meta-optimizer optimizes the same queries again once the cluster earns', () => {
  const pool = [{ keyword: DUD_KW }, { keyword: WINNER_KW }];
  assert.equal(holdMetaCandidates(pool, EARNING).held.length, 0);
  assert.equal(holdMetaCandidates(pool, EARNING).kept.length, 2);
});

test('meta-optimizer with no hold context selects exactly what it always did', () => {
  const pool = [{ keyword: DUD_KW }, { keyword: WINNER_KW }];
  assert.equal(holdMetaCandidates(pool, null).kept.length, 2);
  assert.equal(holdMetaCandidates(pool, null).held.length, 0);
});

// ── the reason this gating matters: the cap ──────────────────────────────────

test('the hold is applied BEFORE the --limit cap, so held queries do not eat the budget', () => {
  const sorted = sortByValidation(REAL_POOL);
  const LIMIT = 5; // the weekly cron's `--apply --limit 5`

  // BEFORE: four of the five slots go to the held cluster, and the site's
  // biggest CTR opportunity does not make the cut at all — it is SIXTH.
  const before = sorted.slice(0, LIMIT).map((c) => c.keyword);
  assert.equal(before.filter((k) => k.includes('toothpaste')).length, 4);
  assert.ok(!before.includes(WINNER_KW), 'the tattoo winner is never reached ungated');
  assert.equal(sorted.findIndex((c) => c.keyword === WINNER_KW), 5, 'sixth — just outside the cap');

  // AFTER: held candidates are skipped and counted before the cap, so the
  // budget lands on clusters that earn.
  const { kept, held } = holdMetaCandidates(sorted, HOLD);
  const after = kept.slice(0, LIMIT).map((c) => c.keyword);
  assert.equal(after.filter((k) => k.includes('toothpaste')).length, 0);
  assert.equal(after[1], WINNER_KW, 'the tattoo winner moves from sixth (unreached) to second');
  assert.equal(held.length, 7, 'every held query is reported, not silently dropped');
});

// ── the freshness fail-safe composes ─────────────────────────────────────────

test('a stale seo-impact report holds nothing for meta-optimizer either', () => {
  const load = (generatedAt) => loadClusterHold({
    root: '/fake',
    today: '2026-08-23',
    readJson: (p) => (p.endsWith(SEO_IMPACT_RELPATH)
      ? impactReport({ generated_at: generatedAt, clusters: CLUSTERS, sold: SCENARIO.sold, earned: SCENARIO.earned })
      : null),
  });

  const fresh = load('2026-08-22T15:16:44.241Z');
  assert.equal(holdMetaCandidates([{ keyword: DUD_KW }], fresh).held.length, 1, 'a fresh report still holds');

  const stale = load('2026-08-01T15:16:44.241Z');
  assert.equal(stale.stale, true);
  assert.equal(holdMetaCandidates([{ keyword: DUD_KW }], stale).held.length, 0,
    'nothing is paused on a measurement nobody has refreshed');
});

// ── digest contract ──────────────────────────────────────────────────────────

test('meta-optimizer puts the held count in the subject and the lines in the digest body', () => {
  const src = readFileSync(join(ROOT, 'agents', 'meta-optimizer', 'index.js'), 'utf8');
  assert.match(src, /holdSummaryFragment/, 'held count belongs in the notify subject');
  assert.match(src, /renderHoldLines/, 'hold lines belong in the report the digest sends');
  assert.match(src, /renderDisagreementLines/, 'an attribution disagreement must reach the digest');
  assert.match(src, /holdBanner/, 'a hold is never invisible at the console either');
});

test('a hold never escalates: no immediate email, no error status on the hold path', () => {
  // Executable source only — this file's comments discuss `immediate: true` in
  // order to say the hold must never use it, and a naive scan counts the prose.
  const src = readFileSync(join(ROOT, 'agents', 'meta-optimizer', 'index.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  // The one `immediate: true` left is the unrecorded-A/B-baseline alarm, which
  // is a lost safety net, not a hold. A hold is deferred like everything else.
  const immediates = src.match(/immediate:\s*true/g) || [];
  assert.equal(immediates.length, 1, 'the hold must not add a second immediate send');
  assert.match(src, /unrecorded change on a locked winner/, 'and the one that exists is the A/B alarm');
});

test('the stale-years pass is deliberately NOT gated', () => {
  // A hold pauses unattended LLM/refresh SPEND. refreshStaleYears is a
  // deterministic regex with no model call, and leaving "2025" in the title of a
  // live indexed page is a degradation of the page — which a hold explicitly is
  // not allowed to cause.
  const src = readFileSync(join(ROOT, 'agents', 'meta-optimizer', 'index.js'), 'utf8');
  const staleYearsFn = src.slice(src.indexOf('async function runRefreshStaleYears'), src.indexOf('async function main'));
  assert.doesNotMatch(staleYearsFn, /holdMetaCandidates|heldCandidates/);
});
