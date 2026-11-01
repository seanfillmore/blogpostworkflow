// tests/lib/duplicate-flag.test.js
//
// The `possible_duplicate` flag (lib/ranked-coverage.js, PR #919) had no
// downstream effect at all: agents/pipeline-prioritizer and
// agents/content-strategist both read `unmapped[]` and treated a flagged row
// exactly like a clean one. These are the rules that changed that, and the two
// properties that keep the change safe:
//
//   DEMOTE, NEVER DROP   in the agent that ranks work
//   WITHHOLD, NEVER DISCARD  in the agent that spends money on it
//
// Fixtures are the real 2026-09-06 incident: the `-3` duplicate of the tattoo
// winner, which was proposed as net-new because neither keyword contains the
// other.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDuplicateIndex, lookupDuplicate, decideProposal, committedTopics,
  duplicateDecisions, DECISION_LABELS, renderWithheldLines, withheldDigest,
  duplicateEvidence, isFlagged, evidenceLine, normalizeKeyword, slugKey,
} from '../../lib/duplicate-flag.js';

const WINNER_PAGE = 'https://www.realskincare.com/blogs/news/best-soap-for-tattoos-what-to-use-for-safe-healing-2';
const MATCH = {
  query: 'best soap for tattoos',
  page: WINNER_PAGE,
  slug: 'best-soap-for-tattoos-what-to-use-for-safe-healing-2',
  position: 9.1,
  impressions: 972,
};
const DUPE_KEYWORD = 'best soap for tattoos what to use for safe healing';

function report(over = {}) {
  return {
    generated_at: '2026-09-19T13:30:00Z',
    unmapped: [
      { keyword: 'aluminum free deodorant', impressions: 800, possible_duplicate: undefined },
      { keyword: DUPE_KEYWORD, impressions: 400, possible_duplicate: true, ranked_match: MATCH },
    ],
    ranked_coverage: {
      available: true,
      disarmed: null,
      possible_duplicates: [{ keyword: DUPE_KEYWORD, match: MATCH }],
    },
    ...over,
  };
}

// ── the index ────────────────────────────────────────────────────────────────

test('a flagged row is found by keyword and by slug; a clean row is not found', () => {
  const idx = buildDuplicateIndex(report());
  assert.equal(idx.available, true);
  assert.equal(idx.disarmed, null);
  assert.ok(lookupDuplicate(DUPE_KEYWORD, idx), 'exact keyword');
  assert.ok(lookupDuplicate('  Best Soap FOR Tattoos   What To Use For Safe Healing ', idx), 'normalised');
  assert.ok(lookupDuplicate(slugKey(DUPE_KEYWORD), idx), 'as a slug');
  assert.equal(lookupDuplicate('aluminum free deodorant', idx), null, 'clean row is never a hit');
});

test('the evidence survives the lookup — page, query, position, impressions', () => {
  const { evidence } = lookupDuplicate(DUPE_KEYWORD, buildDuplicateIndex(report()));
  assert.equal(evidence.slug, MATCH.slug);
  assert.equal(evidence.page, WINNER_PAGE);
  assert.equal(evidence.query, 'best soap for tattoos');
  assert.equal(evidence.position, 9.1);
  assert.equal(evidence.impressions, 972);
});

test('the complete list is read too, because unmapped[] is CAPPED at 25 by the producer', () => {
  // A flagged topic must not slip through purely because 25 other candidates
  // outranked it that morning.
  const idx = buildDuplicateIndex(report({ unmapped: [] }));
  assert.equal(idx.available, true);
  assert.ok(lookupDuplicate(DUPE_KEYWORD, idx));
});

test('matching is EXACT — a reworded variant is a miss, deliberately', () => {
  // Widening a coverage match is, per CLAUDE.md, "precisely how planned content
  // gets killed silently". Unknown-means-allow is the safety property here, not
  // a gap; the prompt section is what discourages the rewording.
  const idx = buildDuplicateIndex(report());
  assert.equal(lookupDuplicate('best soaps for a new tattoo and safe healing', idx), null);
});

test('a flag carried as an OBJECT is read the same way as the boolean + ranked_match pair', () => {
  // A second (semantic) tier is in flight through the same field. The contract
  // read here is "the row says it is a possible duplicate and carries the
  // collision", not one exact literal.
  const row = { keyword: 'x', possible_duplicate: { ...MATCH } };
  assert.equal(isFlagged(row), true);
  assert.equal(duplicateEvidence(row).query, 'best soap for tattoos');
  const idx = buildDuplicateIndex({ unmapped: [row], ranked_coverage: { possible_duplicates: [] } });
  assert.equal(lookupDuplicate('x', idx).evidence.slug, MATCH.slug);
});

// ── fail open ────────────────────────────────────────────────────────────────

test('FAIL OPEN: a missing report withholds nothing and SAYS SO', () => {
  const idx = buildDuplicateIndex(null);
  assert.equal(idx.available, false);
  assert.match(idx.disarmed, /OFF this run/);
  assert.equal(lookupDuplicate(DUPE_KEYWORD, idx), null);
  assert.equal(decideProposal({ keyword: DUPE_KEYWORD }, idx).withhold, false);
});

test('FAIL OPEN: an unreadable report is the same as a missing one', () => {
  // The caller catches the JSON parse failure and passes null; this asserts the
  // degradation, not the try/catch.
  for (const bad of [undefined, null, 'not an object', 42]) {
    const idx = buildDuplicateIndex(bad);
    assert.equal(idx.available, false);
    assert.equal(decideProposal({ keyword: DUPE_KEYWORD }, idx).withhold, false);
  }
});

test('FAIL OPEN: a report predating the gate is DISARMED, not silently clean', () => {
  const idx = buildDuplicateIndex({ generated_at: 'x', unmapped: [{ keyword: 'a', impressions: 9 }] });
  assert.equal(idx.available, false);
  assert.match(idx.disarmed, /no ranked_coverage block/);
});

test('an upstream-disarmed gate repeats the producer\'s own reason verbatim', () => {
  const idx = buildDuplicateIndex(report({
    unmapped: [], ranked_coverage: { disarmed: 'no GSC snapshot rows — ranked-query coverage is OFF this run', possible_duplicates: [] },
  }));
  assert.equal(idx.available, false);
  assert.match(idx.disarmed, /no GSC snapshot rows/);
});

test('a run that flagged nothing is CLEAN, not disarmed', () => {
  const idx = buildDuplicateIndex(report({ unmapped: [{ keyword: 'a', impressions: 9 }], ranked_coverage: { available: true, disarmed: null, possible_duplicates: [] } }));
  assert.equal(idx.available, false, 'nothing to match against');
  assert.equal(idx.disarmed, null, 'but the gate ran — that distinction is the point');
});

test('rows with no flag never produce a hit — the other fail-open direction', () => {
  // "everything is a duplicate" would silently halt content proposals, which is
  // strictly worse than the hazard being fixed.
  const idx = buildDuplicateIndex(report({
    unmapped: [{ keyword: 'a' }, { keyword: 'b' }], ranked_coverage: { possible_duplicates: [] },
  }));
  assert.equal(lookupDuplicate('a', idx), null);
  assert.equal(lookupDuplicate('b', idx), null);
});

// ── the proposal decision ────────────────────────────────────────────────────

test('a flagged topic is WITHHELD from proposal, with its evidence', () => {
  const idx = buildDuplicateIndex(report());
  const d = decideProposal({ keyword: DUPE_KEYWORD, slug: slugKey(DUPE_KEYWORD) }, idx);
  assert.equal(d.withhold, true);
  assert.equal(d.flagged, true);
  assert.equal(d.evidence.slug, MATCH.slug);
});

test('a clean topic is proposed unchanged', () => {
  const d = decideProposal({ keyword: 'aluminum free deodorant' }, buildDuplicateIndex(report()));
  assert.equal(d.withhold, false);
  assert.equal(d.flagged, false);
});

test('a flagged topic ALREADY on the calendar is left alone — withholding it would CLEAR it', () => {
  // The scope boundary. content-strategist REPLACES the calendar with what
  // survives its filters, so withholding a committed item deletes it — and
  // clearing belongs to lib/calendar-coverage.js, which has over-fired and
  // destroyed planned content before.
  const committed = committedTopics([
    { slug: slugKey(DUPE_KEYWORD), keyword: DUPE_KEYWORD, status: 'pending', publish_date: '2026-10-01' },
  ]);
  const d = decideProposal({ keyword: DUPE_KEYWORD }, buildDuplicateIndex(report()), { committed });
  assert.equal(d.withhold, false, 'never withheld');
  assert.equal(d.flagged, true, 'but still reported as flagged');
  assert.equal(d.exempt, 'already_scheduled');
});

test('a `review` idea is NOT a commitment — that exemption would disarm the check', () => {
  // gsc-opportunity pushes the flagged candidate straight into the ideas inbox
  // as `status: review`. Counting that as "already on the calendar" would exempt
  // every flagged topic from the filter built to catch it.
  const committed = committedTopics([
    { slug: slugKey(DUPE_KEYWORD), keyword: DUPE_KEYWORD, status: 'review' },
  ]);
  assert.equal(committed.size, 0);
  assert.equal(decideProposal({ keyword: DUPE_KEYWORD }, buildDuplicateIndex(report()), { committed }).withhold, true);
});

// ── the decision surface ─────────────────────────────────────────────────────

test('a withheld topic becomes a needs_decision row in queue-autoapply\'s shape', () => {
  const [row] = duplicateDecisions([{ keyword: DUPE_KEYWORD, slug: null, evidence: { ...MATCH } }]);
  for (const field of ['slug', 'title', 'trigger', 'created_at', 'decision', 'reason', 'label', 'last_gate_reason']) {
    assert.ok(field in row, `needs_decision rows must carry ${field}`);
  }
  assert.equal(row.decision, 'possible-duplicate');
  assert.equal(row.label, DECISION_LABELS['possible-duplicate']);
  assert.match(row.label, /write it anyway, or drop the topic/, 'the DECISION, not just the item');
  assert.equal(row.title, DUPE_KEYWORD);
  assert.equal(row.url, WINNER_PAGE);
});

test('the evidence is re-examinable without re-running anything: page, position, impressions', () => {
  const [row] = duplicateDecisions([{ keyword: DUPE_KEYWORD, evidence: { ...MATCH } }]);
  assert.match(row.last_gate_reason, /best-soap-for-tattoos-what-to-use-for-safe-healing-2/, 'names the page');
  assert.match(row.last_gate_reason, /position 9\.1/);
  assert.match(row.last_gate_reason, /972 impressions/);
  assert.match(row.last_gate_reason, /NOT proposed this run and nothing was deleted/, 'says what did NOT happen');
});

test('created_at is NULL rather than today — a fabricated zero is the invisibility this avoids', () => {
  // lib/indexing-escalation.js: re-stamping the date every run reports "stuck 0
  // days" every morning, which is how an item stuck since August stays invisible.
  const [row] = duplicateDecisions([{ keyword: DUPE_KEYWORD, evidence: { ...MATCH } }]);
  assert.equal(row.created_at, null);
});

test('a flagged row with unreadable evidence still becomes a decision, and says so', () => {
  const [row] = duplicateDecisions([{ keyword: 'x', evidence: null }]);
  assert.equal(row.decision, 'possible-duplicate');
  assert.match(row.last_gate_reason, /evidence not recorded/);
});

test('nothing withheld → no rows, no notification', () => {
  assert.deepEqual(duplicateDecisions([]), []);
  assert.equal(withheldDigest([]), null);
  assert.deepEqual(renderWithheldLines([]), []);
});

test('the notification is DEFERRED and never an error — withholding is the policy working', () => {
  const d = withheldDigest([{ keyword: DUPE_KEYWORD, evidence: { ...MATCH } }], { proposed: 4 });
  assert.equal(d.status, 'info', 'never "error" — the agent did not break');
  assert.equal(d.immediate, undefined, 'never immediate: true');
  assert.match(d.subject, /withheld/i);
  assert.match(d.body, /Nothing was deleted/);
  assert.match(d.body, /best-soap-for-tattoos-what-to-use-for-safe-healing-2/);
});

test('an exempt (already-scheduled) topic is named in the notification too', () => {
  const d = withheldDigest([{ keyword: 'a', evidence: null }], {
    proposed: 1, exempt: [{ keyword: DUPE_KEYWORD, evidence: { ...MATCH } }],
  });
  assert.match(d.body, /ALREADY on the calendar/);
  assert.match(d.body, /never what gets cleared/);
});

// ── small surface ────────────────────────────────────────────────────────────

test('normalizeKeyword and slugKey are stable', () => {
  assert.equal(normalizeKeyword('  Best   Soap '), 'best soap');
  assert.equal(slugKey('Best Soap for Tattoos!'), 'best-soap-for-tattoos');
});

test('evidenceLine degrades rather than throwing on partial evidence', () => {
  assert.match(evidenceLine(null), /evidence not recorded/);
  assert.match(evidenceLine({ page: WINNER_PAGE }), /position unknown/);
  assert.match(evidenceLine({ slug: 's', position: 3, impressions: 10, query: 'q' }), /data\/posts\/s already ranks for "q" — position 3\.0, 10 impressions/);
});
