import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  summarize, findings, needsDecisionRows, renderBody, ratingStatus, isOpen, urgentChanged,
} from '../../lib/amazon-account-health.js';

const range = { reportingDateFrom: '2026-04-15T00:00Z', reportingDateTo: '2026-10-12T23:59Z' };
const metric = (defectsCount, status) => ({ reportingDateRange: range, defectsCount, status, targetValue: 0, targetCondition: 'EQUALS' });

// Shape follows accountHealthReport-2020-11-18 (amzn/selling-partner-api-models).
const REPORT = {
  accountStatuses: [
    { marketplaceId: 'ATVPDKIKX0DER', status: 'NORMAL' },
    { marketplaceId: 'A2EUQ1WTGCTBG2', status: 'NORMAL' },
  ],
  performanceMetrics: [
    {
      marketplaceId: 'ATVPDKIKX0DER',
      accountHealthRating: { ahrStatus: 'GREAT', reportingDateRange: range },
      restrictedProductPolicyViolations: metric(1, 'BAD'),
      listingPolicyViolations: metric(0, 'GOOD'),
      warningStates: [{ warningType: 'spammingSellerMessaging', status: 'GOOD' }],
    },
    {
      marketplaceId: 'A2EUQ1WTGCTBG2',
      accountHealthRating: { accountHealthRatingStatus: 'GREAT', reportingDateRange: range },
      restrictedProductPolicyViolations: metric(0, 'NONE'),
    },
  ],
};

test('ratingStatus accepts both spellings the schema uses', () => {
  assert.equal(ratingStatus({ ahrStatus: 'WARNED' }), 'WARNED');
  assert.equal(ratingStatus({ accountHealthRatingStatus: 'GREAT' }), 'GREAT');
  assert.equal(ratingStatus({}), null);
  assert.equal(ratingStatus(undefined), null);
});

test('a violation is open on BAD or on any defect, and not on GOOD/NONE at zero', () => {
  assert.equal(isOpen({ status: 'BAD', defectsCount: 0 }), true);
  assert.equal(isOpen({ status: 'GOOD', defectsCount: 2 }), true);
  assert.equal(isOpen({ status: 'NONE', defectsCount: 0 }), false);
  assert.equal(isOpen({ status: 'GOOD', defectsCount: null }), false);
});

test('the Geranium shape: one open restricted-products violation, nothing urgent', () => {
  const s = summarize(REPORT);
  const f = findings(s, null, '2026-10-13T12:05:00Z');
  assert.deepEqual(f.urgent, []);
  assert.equal(f.open.length, 1);
  assert.equal(f.open[0].key, 'restrictedProductPolicyViolations');
  assert.equal(f.open[0].isNew, true);
  const rows = needsDecisionRows(f.open);
  assert.match(rows[0].title, /Restricted Products Policy violations: 1 on Amazon\.com/);
  assert.equal(rows[0].created_at, '2026-10-13T12:05:00Z');
});

test('a violation already seen keeps its first-seen date and is not NEW', () => {
  const s = summarize(REPORT);
  const first = findings(s, null, '2026-10-13T12:05:00Z');
  const next = findings(s, { open: first.open }, '2026-10-14T12:05:00Z');
  assert.equal(next.open[0].firstSeen, '2026-10-13T12:05:00Z');
  assert.equal(next.open[0].isNew, false);
});

test('a rising defect count re-flags the violation as NEW', () => {
  const prev = { open: [{ marketplaceId: 'ATVPDKIKX0DER', key: 'restrictedProductPolicyViolations', defectsCount: 1, firstSeen: '2026-10-01T00:00:00Z' }] };
  const worse = structuredClone(REPORT);
  worse.performanceMetrics[0].restrictedProductPolicyViolations = metric(3, 'BAD');
  const f = findings(summarize(worse), prev, '2026-10-14T00:00:00Z');
  assert.equal(f.open[0].isNew, true);
  assert.equal(f.open[0].firstSeen, '2026-10-01T00:00:00Z');
});

test('an at-risk account or a WARNED rating is urgent', () => {
  const bad = structuredClone(REPORT);
  bad.accountStatuses[1].status = 'AT_RISK';
  bad.performanceMetrics[0].accountHealthRating = { ahrStatus: 'WARNED', reportingDateRange: range };
  const f = findings(summarize(bad));
  assert.deepEqual(f.urgent, ['Amazon.ca account status is AT_RISK', 'Amazon.com Account Health Rating is WARNED']);
});

test('a missing rating is not treated as urgent', () => {
  const r = structuredClone(REPORT);
  delete r.performanceMetrics[0].accountHealthRating;
  assert.deepEqual(findings(summarize(r)).urgent, []);
});

test('an empty report yields no findings rather than throwing', () => {
  const f = findings(summarize({}));
  assert.deepEqual(f, { urgent: [], open: [] });
  assert.equal(renderBody(summarize({}), f), '');
});

test('the body names each marketplace and the open violation', () => {
  const s = summarize(REPORT);
  const body = renderBody(s, findings(s, null, '2026-10-13T12:05:00Z'));
  assert.match(body, /Amazon\.com: account NORMAL, rating GREAT/);
  assert.match(body, /NEW Restricted Products Policy violations: 1 \(open since 2026-10-13\)/);
  assert.match(body, /Amazon\.ca: account NORMAL, rating GREAT\n  no open policy violations/);
});

// Trimmed from the first live report (2026-10-14). It carries two fields the
// published schema does not: customerProductReviewsPolicyViolations and
// policyViolationWarnings.
const LIVE_RANGE = { reportingDateFrom: '2026-04-18T00:00:00Z', reportingDateTo: '2026-10-14T23:59:59Z' };
const live = (defectsCount, status) => ({ reportingDateRange: LIVE_RANGE, status, targetValue: 0, targetCondition: 'EQUALS', defectsCount });
const LIVE = {
  accountStatuses: [
    { marketplaceId: 'A2EUQ1WTGCTBG2', status: 'DEACTIVATED' },
    { marketplaceId: 'ATVPDKIKX0DER', status: 'NORMAL' },
  ],
  performanceMetrics: [
    {
      marketplaceId: 'ATVPDKIKX0DER',
      accountHealthRating: { ahrStatus: 'GREAT', ahrScore: 372, reportingDateRange: LIVE_RANGE },
      restrictedProductPolicyViolations: live(1, 'BAD'),
      productSafetyCustomerComplaints: live(8, 'BAD'),
      foodAndProductSafetyIssues: live(8, 'BAD'),
      customerProductReviewsPolicyViolations: live(2, 'BAD'),
      otherPolicyViolations: live(0, 'GOOD'),
      policyViolationWarnings: { warningsCount: 3, reportingDateRange: LIVE_RANGE },
    },
    {
      marketplaceId: 'A2EUQ1WTGCTBG2',
      accountHealthRating: { ahrStatus: 'GREAT', ahrScore: 200, reportingDateRange: LIVE_RANGE },
      otherPolicyViolations: live(1, 'BAD'),
      policyViolationWarnings: { warningsCount: 0, reportingDateRange: LIVE_RANGE },
    },
  ],
};

test('live report: every BAD metric is open, including the unschema\'d reviews metric', () => {
  const f = findings(summarize(LIVE));
  assert.deepEqual(
    f.open.map((o) => `${o.marketplaceId}:${o.key}:${o.defectsCount}`),
    [
      'ATVPDKIKX0DER:restrictedProductPolicyViolations:1',
      'ATVPDKIKX0DER:productSafetyCustomerComplaints:8',
      'ATVPDKIKX0DER:foodAndProductSafetyIssues:8',
      'ATVPDKIKX0DER:customerProductReviewsPolicyViolations:2',
      'A2EUQ1WTGCTBG2:otherPolicyViolations:1',
    ],
  );
  assert.deepEqual(f.urgent, ['Amazon.ca account status is DEACTIVATED']);
});

test('live report: a non-zero policyViolationWarnings count is a warning, zero is not', () => {
  const s = summarize(LIVE);
  assert.deepEqual(s.markets[0].warnings, ['3 policy violation warnings']);
  assert.deepEqual(s.markets[1].warnings, []);
});

test('urgentChanged: emails on a new at-risk state, not on the same one again', () => {
  const urgent = ['Amazon.ca account status is DEACTIVATED'];
  assert.equal(urgentChanged(urgent, null), true);
  assert.equal(urgentChanged(urgent, { urgent }), false);
  assert.equal(urgentChanged([...urgent, 'Amazon.com account status is AT_RISK'], { urgent }), true);
  // Recovery is a change too; the agent only emails when the new set is non-empty.
  assert.equal(urgentChanged([], { urgent }), true);
});
