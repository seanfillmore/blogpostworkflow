// tests/agents/duplicate-flag-wiring.test.js
//
// The wiring half. lib/duplicate-flag.js decides; these are the two agents
// acting on the decision, each in the ONE way its blast radius permits.
//
// Source scans rather than behavioural tests where the agent cannot be driven:
// `agents/content-strategist/index.js` calls an LLM inside `main()` and
// `process.exit`s at import without credentials, so the filter is exercised
// through the pure `decideProposal` and the WIRING is pinned by scanning the
// file — the same technique tests/agents/seo-copy-writers-gated.test.js uses.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { computePlan } from '../../lib/pipeline-priority.js';
import { buildDigestHtml } from '../../agents/daily-summary/index.js';
import { duplicateDecisions } from '../../lib/duplicate-flag.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = (p) => readFileSync(join(ROOT, p), 'utf8');

const MATCH = {
  query: 'best soap for tattoos',
  page: 'https://www.realskincare.com/blogs/news/best-soap-for-tattoos-what-to-use-for-safe-healing-2',
  slug: 'best-soap-for-tattoos-what-to-use-for-safe-healing-2',
  position: 9.1,
  impressions: 972,
};

// ── pipeline-prioritizer: DEMOTE, never drop ─────────────────────────────────

const CFG = {
  base: { intentMult: { transactional: 1.4, commercial: 1.2, informational: 1.0 },
          volumeDivisor: 100, volumeCap: 50, kdEasyThreshold: 5, kdEasyBonus: 10, impressionsDivisor: 50 },
  buffer: { target: 2, days: 7 },
  maxPromotionsPerRun: 1,
  clusterSpacingDays: 14, clusterSpacingMax: 2, refreshCooldownDays: 45,
  hysteresisRuns: 2, backlogLowWater: 5, strongThreshold: 30,
  signals: {
    unmapped: { minImpressions: 500, strongImpressions: 3000, perImpression: 0.01, cap: 40 },
    rank_drop: { strongPositions: 5, perPosition: 3, cap: 40 },
    revenue_cluster: { minDelta: 25, strongDelta: 100, perDollar: 0.2, cap: 30 },
    competitor_gap: { boost: 15, cap: 30 },
    ai_gap: { boost: 12, cap: 24 },
  },
};

function inputs(over = {}) {
  return {
    backlog: [], signals: [], bufferReady: 0, takenSlots: new Set(),
    clusterRecent: {}, refreshRecent: {}, coveredIndex: new Set(), rejections: [],
    today: '2026-09-19', now: new Date('2026-09-19T12:00:00-07:00'), cfg: CFG, ...over,
  };
}

test('a flagged backlog idea is DEMOTED below a clean one — and still present', () => {
  // The whole rule in one assertion: the flagged idea outscores the clean one
  // and still loses the single promotion slot, while remaining in `scored`.
  const plan = computePlan(inputs({
    backlog: [
      { slug: 'dupe', keyword: 'dupe', volume: 9000, kd: 2, search_intent: 'commercial', task_type: 'new', status_override: null, possible_duplicate: true, duplicate_of: MATCH },
      { slug: 'clean', keyword: 'clean', volume: 100, kd: 40, search_intent: 'informational', task_type: 'new', status_override: null },
    ],
  }));
  const dupe = plan.scored.find((i) => i.slug === 'dupe');
  const clean = plan.scored.find((i) => i.slug === 'clean');
  assert.ok(dupe, 'never dropped from the plan');
  assert.ok(dupe.priority_score > clean.priority_score, 'it genuinely scores higher');
  assert.equal(plan.promotions.length, 1);
  assert.equal(plan.promotions[0].slug, 'clean', 'the clean idea takes the slot anyway');
});

test('a flagged idea still promotes when nothing clean is left — demoted, not blocked', () => {
  // A strict order plus a cap can become a block by arithmetic. It does not here:
  // with no clean competitor the flagged idea takes the slot.
  const plan = computePlan(inputs({
    backlog: [{ slug: 'dupe', keyword: 'dupe', volume: 9000, kd: 2, search_intent: 'commercial', task_type: 'new', status_override: null, possible_duplicate: true }],
  }));
  assert.equal(plan.promotions.length, 1);
  assert.equal(plan.promotions[0].slug, 'dupe');
});

test('a rush override still beats the demotion — a human instruction outranks a heuristic', () => {
  const plan = computePlan(inputs({
    backlog: [
      { slug: 'dupe', keyword: 'dupe', volume: 9000, kd: 2, search_intent: 'commercial', task_type: 'new', status_override: 'rush', possible_duplicate: true },
      { slug: 'clean', keyword: 'clean', volume: 8000, kd: 2, search_intent: 'commercial', task_type: 'new', status_override: null },
    ],
  }));
  assert.equal(plan.promotions[0].slug, 'dupe');
});

test('a flagged SIGNAL is still injected, and carries the flag onto the idea', () => {
  const plan = computePlan(inputs({
    signals: [{ type: 'unmapped', key: 'best soap for tattoos what to use for safe healing', taskType: 'new',
      cluster: null, strength: 4000, label: 'unmapped 4000 impr · possible duplicate',
      possibleDuplicate: true, duplicateOf: MATCH }],
  }));
  assert.equal(plan.injections.length, 1, 'injected, never dropped');
  assert.equal(plan.injections[0].possible_duplicate, true, 'the flag persists onto the calendar item');
  assert.deepEqual(plan.injections[0].duplicate_of, MATCH);
});

test('nothing flagged → the ordering is byte-identical to before', () => {
  const plan = computePlan(inputs({
    backlog: [
      { slug: 'a', keyword: 'a', volume: 9000, kd: 2, search_intent: 'commercial', task_type: 'new', status_override: null },
      { slug: 'b', keyword: 'b', volume: 100, kd: 40, search_intent: 'informational', task_type: 'new', status_override: null },
    ],
  }));
  assert.equal(plan.promotions[0].slug, 'a');
});

test('pipeline-prioritizer reads the flag off the report and never filters on it', () => {
  const s = src('agents/pipeline-prioritizer/index.js');
  assert.match(s, /from '\.\.\/\.\.\/lib\/duplicate-flag\.js'/, 'uses the shared library');
  assert.match(s, /possibleDuplicate: flagged/, 'the signal carries the flag');
  // The demotion must not become a drop. `continue`ing on the flag inside the
  // unmapped loop is the shape that would turn this ranker into a second place
  // that silently deletes a topic.
  assert.doesNotMatch(s, /if\s*\(\s*(flagged|isFlagged\([^)]*\))\s*\)\s*continue/, 'never skips a flagged row');
});

test('the prioritizer still runs end to end with the change in place', () => {
  // --dry-run writes nothing. This is the same smoke check
  // tests/agents/pipeline-prioritizer.test.js already performs; it exists here
  // because the backlog mapping and the report payload both gained fields.
  const out = execFileSync('node', ['agents/pipeline-prioritizer/index.js', '--dry-run'], { cwd: ROOT, encoding: 'utf8' });
  assert.match(out, /Prioritizer|backlog_depth/i);
});

// ── content-strategist: WITHHOLD, never discard ──────────────────────────────

test('content-strategist withholds a flagged topic instead of proposing it', () => {
  const s = src('agents/content-strategist/index.js');
  assert.match(s, /from '\.\.\/\.\.\/lib\/duplicate-flag\.js'/, 'uses the shared library');
  assert.match(s, /decideProposal\(item, duplicateIndex, \{ committed \}\)/, 'the filter consults the decision');
  assert.match(s, /if \(dup\.withhold\)/);
  assert.match(s, /withheldDuplicates\.push/, 'a withheld topic is recorded, never merely skipped');
  assert.match(s, /return false;/, 'and is kept out of the brief queue');
});

test('a withheld topic is visible THREE ways — console, notification, needs_decision', () => {
  const s = src('agents/content-strategist/index.js');
  assert.match(s, /\[WITHHELD\] possible duplicate/, 'console');
  assert.match(s, /withheldDigest\(withheldDuplicates/, 'deferred notification');
  assert.match(s, /needs_decision: needsDecision/, 'the digest decision block');
  assert.match(s, /duplicateDecisions\(withheldDuplicates\)/);
});

test('the report is written on EVERY run, so "withheld nothing" differs from "did not run"', () => {
  const s = src('agents/content-strategist/index.js');
  const write = s.indexOf("writeFileSync(join(REPORTS_DIR, 'latest.json')");
  assert.ok(write > 0, 'the report is written');
  const guarded = s.slice(Math.max(0, write - 400), write);
  assert.doesNotMatch(guarded, /if \(withheldDuplicates\.length\)\s*\{[^}]*$/, 'not behind a "something was withheld" guard');
});

test('the withholding never deletes anything', () => {
  const s = src('agents/content-strategist/index.js');
  // No new deletion path may ride along with a gate. CLAUDE.md records
  // --drop-non-earning permanently destroying three paid-for briefs.
  assert.doesNotMatch(s, /unlinkSync/, 'no file deletion anywhere in this agent');
  assert.doesNotMatch(s, /post-kill/, 'never kills a post');
});

test('the withholding notification is deferred and never an error', () => {
  // Comment lines are stripped: this file DESCRIBES both forbidden forms in
  // prose, and a scan that cannot tell code from the rule it states is useless.
  const code = src('lib/duplicate-flag.js')
    .split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  assert.doesNotMatch(code, /immediate:\s*true/);
  assert.doesNotMatch(code, /status:\s*'error'/);
  assert.match(code, /status: 'info'/, 'a finding, not a failure');
});

test('a flagged topic already on the calendar is NOT withheld, and the agent says so', () => {
  const s = src('agents/content-strategist/index.js');
  assert.match(s, /committedTopics\(existingCalendarItems\)/);
  assert.match(s, /\[KEPT\]/, 'the exemption is reported, not silent');
});

// ── scope boundary: calendar-coverage is untouched ───────────────────────────

test('lib/calendar-coverage.js knows nothing about this flag', () => {
  // PR #919 drew this boundary and pinned it for gsc-opportunity. Restated for
  // the clearing path itself: calendar-coverage decides what is CLEARED from an
  // existing calendar, CLAUDE.md records it over-firing and destroying 12 of 19
  // scheduled items, and this change alters only what gets PROPOSED.
  const s = src('lib/calendar-coverage.js');
  assert.doesNotMatch(s, /duplicate-flag/);
  assert.doesNotMatch(s, /possible_duplicate/);
});

test('the withhold skip records no matchedSlug — it must not mis-attribute a clearing', () => {
  // classifyClearedItems joins a skip to a cleared item by `matchedSlug`.
  // Setting it to the RANKED page's slug would let this filter take the blame
  // for a disappearance it did not cause.
  const s = src('agents/content-strategist/index.js');
  const line = s.split('\n').find((l) => l.includes("reason: 'possible_duplicate'"));
  assert.ok(line, 'the skip is recorded');
  assert.doesNotMatch(line, /matchedSlug/);
});

// ── the digest renders it, in the ONE existing block ─────────────────────────

const DIGEST_ROOT = mkdtempSync(join(tmpdir(), 'digest-dupe-'));
function withStrategistReport(needsDecision, extra = {}) {
  const dir = join(DIGEST_ROOT, String(Math.random()).slice(2));
  mkdirSync(join(dir, 'data', 'reports', 'content-strategist'), { recursive: true });
  writeFileSync(
    join(dir, 'data', 'reports', 'content-strategist', 'latest.json'),
    JSON.stringify({ generated_at: new Date().toISOString(), needs_decision: needsDecision }),
  );
  for (const [agent, rows] of Object.entries(extra)) {
    mkdirSync(join(dir, 'data', 'reports', agent), { recursive: true });
    writeFileSync(join(dir, 'data', 'reports', agent, 'latest.json'),
      JSON.stringify({ generated_at: new Date().toISOString(), needs_decision: rows }));
  }
  return dir;
}

const WITHHELD = duplicateDecisions([{
  keyword: 'best soap for tattoos what to use for safe healing',
  slug: null,
  evidence: { ...MATCH },
}]);

test('a withheld topic reaches the human, naming the page it would duplicate', () => {
  const html = buildDigestHtml(
    '2026-09-19', [], [], [], null, null, null, null,
    'https://dash', [], null, null, { dataRoot: withStrategistReport(WITHHELD) },
  );
  assert.match(html, /best soap for tattoos what to use for safe healing/, 'the topic is named');
  assert.match(html, /write it anyway, or drop the topic/, 'the DECISION is stated');
  assert.match(html, /best-soap-for-tattoos-what-to-use-for-safe-healing-2/, 'the page it would duplicate');
  assert.match(html, /position 9\.1/);
  assert.match(html, /972 impressions/);
});

test('it extends the ONE "Needs your decision" block, never a parallel one', () => {
  const html = buildDigestHtml(
    '2026-09-19', [], [], [], null, null, null, null,
    'https://dash', [], null, null,
    { dataRoot: withStrategistReport(WITHHELD, { 'queue-autoapply': [{ slug: 'q', title: 'queue item', decision: 'editor-gate-exhausted', label: 'rewrite it, or write it off' }] }) },
  );
  assert.equal((html.match(/Needs your decision/g) || []).length, 1, 'one block');
  assert.match(html, /queue item/, 'the other producer still renders');
  assert.match(html, /best soap for tattoos/, 'and so does this one');
});

test('withholding nothing renders no section', () => {
  const html = buildDigestHtml(
    '2026-09-19', [], [], [], null, null, null, null,
    'https://dash', [], null, null, { dataRoot: withStrategistReport([]) },
  );
  assert.ok(!/Needs your decision/i.test(html), 'silent when empty');
});

test('the strategist report is gitignored — it is regenerable machine output', () => {
  // Same hazard as the thirteen untracked on 2026-09-06: a tracked, cron-written
  // report can be REVERTED by a deploy and every consumer reads that as current.
  let ignored = true;
  try { execFileSync('git', ['check-ignore', '-q', '--', 'data/reports/content-strategist/latest.json'], { cwd: ROOT }); }
  catch { ignored = false; }
  assert.equal(ignored, true, 'add data/reports/content-strategist/latest.json to .gitignore');
});
