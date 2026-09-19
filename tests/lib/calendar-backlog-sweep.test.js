import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DROP, FLAG, KEEP, INELIGIBLE, EXPECTED,
  planSweep, decideItem, eligibility, selfSlugsFor, oldestFirst,
  renderPlanLines, expectationNote, renderSweepDigest,
} from '../../lib/calendar-backlog-sweep.js';
import {
  AUTO_COVERED, POSSIBLE_DUPLICATE, UNCOVERED,
  TIER_EXACT, TIER_RANKED_PHRASE, TIER_AUTHORED_SEMANTIC,
} from '../../lib/ranked-coverage.js';

// A calendar re-plan REPLACES the calendar, and between 2026-08-19 and
// 2026-08-21 that cleared 12 of the 19 scheduled items with the only trace
// eight `[SKIP]` lines in an unattended cron log. Everything below exists so a
// sweep can only ever reach a pure idea, and only on the one coverage tier
// measured at a zero false-positive rate.

const item = (over = {}) => ({
  slug: 'best-sls-free-toothpaste',
  keyword: 'best sls free toothpaste',
  publish_date: null,
  added_at: '2026-04-15T20:19:51.334Z',
  ...over,
});

const rankedMatch = (over = {}) => ({
  tier: TIER_EXACT,
  query: 'best sls free toothpaste',
  page: 'https://www.realskincare.com/blogs/news/toothpaste-without-sls',
  slug: 'toothpaste-without-sls',
  clicks: 12,
  impressions: 1400,
  position: 4.2,
  ...over,
});

const exactCoverage = (over = {}) => ({
  status: AUTO_COVERED,
  tier: TIER_EXACT,
  match: rankedMatch(over.match),
  matches: over.matches ?? [rankedMatch(over.match)],
  selfMatches: [],
});

const flaggedCoverage = (tier = TIER_RANKED_PHRASE) => ({
  status: POSSIBLE_DUPLICATE,
  tier,
  match: tier === TIER_AUTHORED_SEMANTIC
    ? { tier, keyword: 'best soap to use on new tattoo', slug: 'best-soap-for-tattoos', source: 'post', similarity: 0.6, threshold: 0.6 }
    : rankedMatch({ tier }),
  matches: [],
  selfMatches: [],
});

const uncovered = () => ({ status: UNCOVERED, tier: null, match: null, matches: [], selfMatches: [] });

// ── what may be dropped ─────────────────────────────────────────────────────

test('the exact ranked-query tier is dropped, naming the page and the rule', () => {
  const d = decideItem({ item: item(), status: 'pending', coverage: exactCoverage() });
  assert.equal(d.verdict, DROP);
  assert.match(d.reason, /toothpaste-without-sls/);
  assert.match(d.reason, /position 4\.2, 1400 impressions/);
  assert.equal(d.match.slug, 'toothpaste-without-sls');
});

test('a POSSIBLE_DUPLICATE is never dropped — both flagged tiers', () => {
  for (const tier of [TIER_RANKED_PHRASE, TIER_AUTHORED_SEMANTIC]) {
    const d = decideItem({ item: item(), status: 'pending', coverage: flaggedCoverage(tier) });
    assert.equal(d.verdict, FLAG, `${tier} must flag, never drop`);
    assert.match(d.reason, /NOT dropped/);
  }
});

test('an uncovered idea is kept', () => {
  assert.equal(decideItem({ item: item(), status: 'pending', coverage: uncovered() }).verdict, KEEP);
});

test('AUTO_COVERED from any tier other than exact is KEPT, not dropped', () => {
  // Belt and braces: only tier 1 may cover silently today. If a future tier is
  // ever allowed to, this sweep must not start deleting on it by inheritance.
  const coverage = { ...exactCoverage(), tier: TIER_AUTHORED_SEMANTIC };
  const d = decideItem({ item: item(), status: 'pending', coverage });
  assert.equal(d.verdict, KEEP);
  assert.match(d.reason, /only the exact ranked-query tier may drop/);
});

// ── what may not be touched ─────────────────────────────────────────────────

test('an item with a publish_date is never touched, even when exactly covered', () => {
  const d = decideItem({ item: item({ publish_date: '2026-10-01T15:00:00.000Z' }), status: 'pending', coverage: exactCoverage() });
  assert.equal(d.verdict, INELIGIBLE);
  assert.match(d.reason, /scheduled for 2026-10-01/);
});

test('an item that has since gained a brief, content or a draft is never touched', () => {
  for (const status of ['briefed', 'written', 'draft', 'scheduled', 'published', 'unknown']) {
    const d = decideItem({ item: item(), status, coverage: exactCoverage() });
    assert.equal(d.verdict, INELIGIBLE, `status "${status}" must be ineligible`);
    assert.match(d.reason, /not "pending"/);
  }
});

test('planSweep never even classifies an ineligible item', () => {
  let asked = 0;
  const plan = planSweep({
    items: [item({ slug: 'dated', publish_date: '2026-10-01T15:00:00.000Z' }), item({ slug: 'briefed-already' })],
    statusOf: (i) => (i.slug === 'briefed-already' ? 'briefed' : 'pending'),
    classify: () => { asked++; return exactCoverage(); },
  });
  assert.equal(asked, 0);
  assert.equal(plan.drop.length, 0);
  assert.equal(plan.ineligible.length, 2);
  assert.equal(plan.backlog, 0);
});

test('a status function that throws makes the item ineligible rather than droppable', () => {
  const plan = planSweep({
    items: [item()],
    statusOf: () => { throw new Error('unreadable'); },
    classify: () => exactCoverage(),
  });
  assert.equal(plan.ineligible.length, 1);
  assert.equal(plan.drop.length, 0);
});

// ── self-match ──────────────────────────────────────────────────────────────

test('selfSlugsFor carries BOTH spellings — the calendar slug and the keyword slug', () => {
  const s = selfSlugsFor({ slug: 'best-schmidts-deodorant', keyword: "best schmidt's deodorant" });
  assert.ok(s.has('best-schmidts-deodorant'));
  assert.ok(s.has('best-schmidt-s-deodorant'));
});

test('a match against the item\'s own calendar slug is not a duplicate', () => {
  const coverage = exactCoverage({ match: { slug: 'best-sls-free-toothpaste' } });
  const d = decideItem({ item: item(), status: 'pending', coverage });
  assert.equal(d.verdict, KEEP);
  assert.match(d.reason, /self-match/);
});

test('a match against the item\'s keyword slug is not a duplicate either', () => {
  const it = item({ slug: 'some-other-dir', keyword: "best schmidt's deodorant" });
  const coverage = exactCoverage({ match: { slug: 'best-schmidt-s-deodorant' } });
  assert.equal(decideItem({ item: it, status: 'pending', coverage }).verdict, KEEP);
});

test('a self-match alongside a real external match still drops, on the external one', () => {
  const coverage = exactCoverage({
    matches: [rankedMatch({ slug: 'best-sls-free-toothpaste' }), rankedMatch({ slug: 'toothpaste-without-sls' })],
  });
  const d = decideItem({ item: item(), status: 'pending', coverage });
  assert.equal(d.verdict, DROP);
  assert.equal(d.match.slug, 'toothpaste-without-sls');
});

test('a match whose page could not be resolved to a slug still counts as external', () => {
  const coverage = exactCoverage({ matches: [rankedMatch({ slug: null })] });
  assert.equal(decideItem({ item: item(), status: 'pending', coverage }).verdict, DROP);
});

// ── ordering, reporting, digest ─────────────────────────────────────────────

test('oldestFirst orders by added_at, undated last', () => {
  const rows = [
    { item: { added_at: '2026-06-01T00:00:00Z' }, slug: 'b' },
    { item: {}, slug: 'undated' },
    { item: { added_at: '2026-04-01T00:00:00Z' }, slug: 'a' },
  ];
  assert.deepEqual(oldestFirst(rows).map((r) => r.slug), ['undated', 'a', 'b']);
});

test('every row is printed with its slug and its reason', () => {
  const plan = planSweep({
    items: [item(), item({ slug: 'keeper', keyword: 'glass skin routine' })],
    statusOf: () => 'pending',
    classify: (i) => (i.slug === 'keeper' ? uncovered() : exactCoverage()),
  });
  const text = renderPlanLines(plan).join('\n');
  assert.match(text, /best-sls-free-toothpaste/);
  assert.match(text, /toothpaste-without-sls/);
  assert.match(text, /keeper/);
  assert.match(text, /KEEP — 1/);
});

test('expectationNote is loud when the live corpus disagrees with the measurement', () => {
  const empty = { backlog: 0, drop: [], flag: [], keep: [], ineligible: [], rows: [], considered: 0 };
  const note = expectationNote(empty);
  assert.equal(note.matches, false);
  assert.match(note.line, /DISAGREES/);
  assert.match(note.line, new RegExp(String(EXPECTED.drop)));
});

test('expectationNote is quiet when the run matches the measurement', () => {
  const plan = {
    backlog: EXPECTED.backlog,
    drop: new Array(EXPECTED.drop).fill({}),
    flag: new Array(EXPECTED.flag).fill({}),
    keep: new Array(EXPECTED.keep).fill({}),
    ineligible: [], rows: [], considered: EXPECTED.backlog,
  };
  assert.equal(expectationNote(plan).matches, true);
});

test('the digest is a success row for an ordinary sweep, and an error only when an archive failed', () => {
  const plan = planSweep({ items: [item()], statusOf: () => 'pending', classify: () => exactCoverage() });
  const ok = renderSweepDigest({ plan, archived: plan.drop, applied: true, restoreCommand: 'x --restore' });
  assert.equal(ok.status, 'success');
  assert.equal(ok.immediate, undefined);
  assert.match(ok.body, /Not deleted/);
  assert.match(ok.body, /restore/);

  const bad = renderSweepDigest({ plan, archived: [], failed: [{ slug: 'x', error: 'disk full' }], applied: true });
  assert.equal(bad.status, 'error');
  assert.match(bad.body, /left on the calendar/);
});

test('the digest names the flagged items as needing a decision, never as dropped', () => {
  const plan = planSweep({ items: [item()], statusOf: () => 'pending', classify: () => flaggedCoverage() });
  const d = renderSweepDigest({ plan, archived: [], applied: true });
  assert.match(d.body, /need your decision/);
});

test('eligibility checks the publish_date before the status', () => {
  // A dated item that is also mid-pipeline must report the loudest rule first.
  const e = eligibility({ publish_date: '2026-10-01' }, 'briefed');
  assert.equal(e.eligible, false);
  assert.match(e.reason, /scheduled/);
});
