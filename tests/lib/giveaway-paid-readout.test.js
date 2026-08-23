import test from 'node:test';
import assert from 'node:assert/strict';
import {
  REFERRAL_ASK_HOURS,
  KILL_MIN_MATURED,
  referralAskReach,
  referralParticipationGate,
  evaluateKillThreshold,
  paidReadoutLines,
} from '../../lib/giveaway/paid-readout.js';
import { CONFIRM_MATURITY_HOURS } from '../../lib/giveaway/summarize.js';
import { FLOW_DELAYS_HOURS } from '../../lib/giveaway/nurture-schedule.js';

const NOW = Date.parse('2026-08-22T12:00:00Z');
const hoursAgo = (h) => new Date(NOW - h * 3_600_000).toISOString();
const sub = (email, h) => ({ email, properties: { gv_entered_at: hoursAgo(h) } });

// ── REFERRAL_ASK_HOURS ────────────────────────────────────────────────────────

test('REFERRAL_ASK_HOURS is derived from the nudge cadence and the flow delay, not hardcoded', () => {
  assert.equal(REFERRAL_ASK_HOURS, CONFIRM_MATURITY_HOURS + FLOW_DELAYS_HOURS[1]);
});

// ── referralAskReach ──────────────────────────────────────────────────────────

test('counts only entrants who are confirmed AND old enough to have been asked', () => {
  const submitted = [
    sub('old-confirmed@x.com', REFERRAL_ASK_HOURS + 1),   // counts
    sub('old-unconfirmed@x.com', REFERRAL_ASK_HOURS + 1), // not confirmed
    sub('new-confirmed@x.com', 2),                        // too recent
  ];
  const confirmed = new Set(['old-confirmed@x.com', 'new-confirmed@x.com']);
  assert.equal(referralAskReach({ submitted, confirmedEmails: confirmed, now: NOW }), 1);
});

test('is inclusive at exactly the boundary', () => {
  const submitted = [sub('a@x.com', REFERRAL_ASK_HOURS)];
  assert.equal(
    referralAskReach({ submitted, confirmedEmails: new Set(['a@x.com']), now: NOW }),
    1,
  );
});

test('normalises case and whitespace when matching against the confirmed set', () => {
  const submitted = [{ email: '  Mixed@Case.COM ', properties: { gv_entered_at: hoursAgo(200) } }];
  assert.equal(
    referralAskReach({ submitted, confirmedEmails: new Set(['mixed@case.com']), now: NOW }),
    1,
  );
});

test('never assumes an undateable entrant has been asked', () => {
  const submitted = [
    { email: 'a@x.com', properties: {} },
    { email: 'b@x.com', properties: { gv_entered_at: 'not-a-date' } },
    { email: 'c@x.com' },
  ];
  const confirmed = new Set(['a@x.com', 'b@x.com', 'c@x.com']);
  assert.equal(referralAskReach({ submitted, confirmedEmails: confirmed, now: NOW }), 0);
});

test('empty input is zero, not a throw', () => {
  assert.equal(referralAskReach(), 0);
  assert.equal(referralAskReach({ submitted: [] }), 0);
});

// ── referralParticipationGate ─────────────────────────────────────────────────

test('does NOT fire before enough entrants have been asked — the 2026-08-22 false alarm', () => {
  // 88 entrants existed and the old gate fired at >= 50 of them. Almost none had
  // received the ask, because the ads were three days old.
  assert.equal(referralParticipationGate({ reach: 4, entrantsWithReferrals: 0 }), null);
});

test('fires once the ask has genuinely reached the minimum and nobody referred', () => {
  const line = referralParticipationGate({ reach: 50, entrantsWithReferrals: 0 });
  assert.match(line, /^GATE: zero referral participation across 50 entrant/);
  assert.match(line, /not a timing artifact/);
});

test('does not fire when anyone at all has referred', () => {
  assert.equal(referralParticipationGate({ reach: 500, entrantsWithReferrals: 1 }), null);
});

test('tolerates a missing or non-numeric reach', () => {
  assert.equal(referralParticipationGate({ entrantsWithReferrals: 0 }), null);
  assert.equal(referralParticipationGate({ reach: null, entrantsWithReferrals: 0 }), null);
});

// ── evaluateKillThreshold ─────────────────────────────────────────────────────

const cohortWith = (w) => ({ segments: { new: { windows: { 30: w } } } });

test('an unmatured window is not-readable, never a 0% kill', () => {
  const r = evaluateKillThreshold({
    cohort: cohortWith({ matured: 0, purchasers: 0, rate: null, note: 'no entrant is 30 days old yet' }),
    thresholdPct: 1.5,
  });
  assert.equal(r.verdict, 'not-readable');
  assert.equal(r.rate, null);
  assert.match(r.line, /no entrant is 30 days old yet/);
});

test('a matured but tiny sample is directional, never a kill', () => {
  const r = evaluateKillThreshold({
    cohort: cohortWith({ matured: 30, purchasers: 0, rate: 0 }),
    thresholdPct: 1.5,
  });
  assert.equal(r.verdict, 'not-readable');
  assert.equal(r.matured, 30);
  assert.match(r.line, /below the 100 needed/);
  assert.match(r.line, /do not act on it yet/);
});

test('kills once the sample is big enough and the rate is under the floor', () => {
  const r = evaluateKillThreshold({
    cohort: cohortWith({ matured: 200, purchasers: 1, rate: 0.5 }),
    thresholdPct: 1.5,
  });
  assert.equal(r.verdict, 'kill');
  assert.match(r.line, /KILL THRESHOLD BREACHED/);
  assert.match(r.line, /do not\s+raise budget/);
});

test('passes at exactly the threshold — the floor is inclusive', () => {
  const r = evaluateKillThreshold({
    cohort: cohortWith({ matured: KILL_MIN_MATURED, purchasers: 2, rate: 1.5 }),
    thresholdPct: 1.5,
  });
  assert.equal(r.verdict, 'ok');
  assert.match(r.line, /Kill threshold OK/);
});

test('reads the NEW segment, never the blended cohort', () => {
  // Blended looks healthy only because existing customers repurchase anyway.
  const cohort = {
    windows: { 30: { matured: 200, purchasers: 40, rate: 20 } },
    segments: { new: { windows: { 30: { matured: 200, purchasers: 1, rate: 0.5 } } } },
  };
  assert.equal(evaluateKillThreshold({ cohort, thresholdPct: 1.5 }).verdict, 'kill');
});

test('a missing cohort or threshold degrades instead of throwing', () => {
  assert.equal(evaluateKillThreshold({ cohort: null, thresholdPct: 1.5 }).verdict, 'not-readable');
  assert.equal(evaluateKillThreshold({}).verdict, 'not-readable');
  assert.equal(evaluateKillThreshold({ cohort: cohortWith({ matured: 500, rate: 0 }), thresholdPct: 0 }).line, null);
});

// ── paidReadoutLines ──────────────────────────────────────────────────────────

const SPEND = { spend: 110.14, impressions: 5341, leads: 469, costPerLead: 0.23, error: null };
const FUNNEL = {
  submitted: 316, confirmed: 88, unconfirmed: 228, confirmationRate: 0.28,
  matured: { submitted: 10, confirmed: 4, rate: 0.4 }, pending: 222, undateable: 0, maturityHours: 48,
};

test('reports spend, leads and cost per lead', () => {
  const text = paidReadoutLines({ spend: SPEND, funnel: FUNNEL }).join('\n');
  assert.match(text, /spend \$110\.14/);
  assert.match(text, /469 leads/);
  assert.match(text, /\$0\.23\/lead/);
});

test('reports cost per submission AND per confirmed, which are not the same number', () => {
  const text = paidReadoutLines({ spend: SPEND, funnel: FUNNEL }).join('\n');
  assert.match(text, /cost per submission \$0\.35/);   // 110.14 / 316
  assert.match(text, /per CONFIRMED \$1\.25/);          // 110.14 / 88
});

test('prefers the matured confirmation rate and says which one it used', () => {
  assert.match(paidReadoutLines({ spend: SPEND, funnel: FUNNEL }).join('\n'), /40% matured/);
  const raw = { ...FUNNEL, matured: { submitted: 0, confirmed: 0, rate: null } };
  assert.match(paidReadoutLines({ spend: SPEND, funnel: raw }).join('\n'), /28% raw/);
});

test('never divides by zero when nothing has confirmed yet', () => {
  const funnel = { ...FUNNEL, confirmed: 0, matured: { submitted: 0, confirmed: 0, rate: null } };
  const text = paidReadoutLines({ spend: SPEND, funnel }).join('\n');
  assert.match(text, /per CONFIRMED n\/a/);
  assert.doesNotMatch(text, /Infinity|NaN/);
});

test('says so when Meta is unreachable, has errored, or has not spent', () => {
  assert.match(paidReadoutLines({ spend: null }).join('\n'), /unavailable — could not read/);
  assert.match(paidReadoutLines({ spend: { error: 'token expired' } }).join('\n'), /unavailable — token expired/);
  assert.match(paidReadoutLines({ spend: { spend: 0, error: null } }).join('\n'), /no spend recorded yet/);
});

test('handles spend with no attributed leads without printing a bogus cost', () => {
  const text = paidReadoutLines({ spend: { spend: 12, impressions: 400, leads: 0, error: null } }).join('\n');
  assert.match(text, /no leads attributed yet/);
  assert.doesNotMatch(text, /\/lead/);
});

test('carries the kill-threshold line when one is supplied', () => {
  const kill = evaluateKillThreshold({
    cohort: cohortWith({ matured: 200, purchasers: 1, rate: 0.5 }),
    thresholdPct: 1.5,
  });
  assert.match(paidReadoutLines({ spend: SPEND, funnel: FUNNEL, kill }).join('\n'), /KILL THRESHOLD BREACHED/);
});
