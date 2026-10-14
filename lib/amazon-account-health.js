/**
 * Amazon Account Health — the pure half of agents/amazon-account-health.
 *
 * Reads Amazon's GET_V2_SELLER_PERFORMANCE_REPORT (schema
 * `accountHealthReport-2020-11-18` in amzn/selling-partner-api-models) and
 * answers two questions: is any marketplace account at risk, and is any policy
 * violation open?
 *
 * WHY THIS EXISTS. On 2026-08-04 Amazon removed the Geranium deodorant
 * (B0B687ZWZ6) for a Restricted Products violation. Nothing in the fleet saw it
 * for ten weeks, and the open violation is what silently blocked Remote
 * Fulfillment enrollment for Amazon.ca and Amazon.com.br ("Your listings are
 * suspended"). Account Health is a Seller Central page nobody opens unprompted,
 * so the check has to come to the digest.
 *
 * No I/O here, so every rule is testable without stubbing the SP-API.
 */

export const MARKETPLACES = {
  ATVPDKIKX0DER: 'Amazon.com',
  A2EUQ1WTGCTBG2: 'Amazon.ca',
  A1AM78C64UM0Y8: 'Amazon.com.mx',
  A2Q3Y263D00KWC: 'Amazon.com.br',
};

// Listing-level violation metrics in the report, with the name Seller Central
// shows for each. Order is the order they are reported in.
export const VIOLATION_METRICS = {
  restrictedProductPolicyViolations: 'Restricted Products Policy violations',
  listingPolicyViolations: 'Listing Policy violations',
  productSafetyCustomerComplaints: 'Product Safety customer complaints',
  foodAndProductSafetyIssues: 'Food and Product Safety issues',
  productAuthenticityCustomerComplaints: 'Product Authenticity customer complaints',
  productConditionCustomerComplaints: 'Product Condition customer complaints',
  receivedIntellectualPropertyComplaints: 'Received Intellectual Property complaints',
  suspectedIntellectualPropertyViolations: 'Suspected Intellectual Property violations',
  // Present in the live report (2026-10-14) though absent from the published
  // 2020-11-18 schema. Same ListingLevelViolation shape.
  customerProductReviewsPolicyViolations: 'Customer Product Reviews Policy violations',
  otherPolicyViolations: 'Other Policy violations',
  documentRequests: 'Document requests',
};

export const marketName = (id) => MARKETPLACES[id] || id;

/**
 * The schema lists `ahrStatus` as required but declares the property as
 * `accountHealthRatingStatus`; its own example uses `ahrStatus`. Accept both,
 * and return null rather than guess when neither is present.
 */
export function ratingStatus(ahr) {
  if (!ahr || typeof ahr !== 'object') return null;
  return ahr.ahrStatus || ahr.accountHealthRatingStatus || null;
}

/** Report JSON → { statuses[], markets[] } with only what the checks need. */
export function summarize(report) {
  const statuses = (report?.accountStatuses || []).map((s) => ({
    marketplaceId: s.marketplaceId,
    status: s.status || null,
  }));
  const markets = (report?.performanceMetrics || []).map((m) => {
    const violations = [];
    for (const [key, label] of Object.entries(VIOLATION_METRICS)) {
      const v = m[key];
      if (!v || typeof v !== 'object') continue;
      violations.push({
        key,
        label,
        defectsCount: Number.isFinite(Number(v.defectsCount)) ? Number(v.defectsCount) : null,
        status: v.status || null,
      });
    }
    const warnings = (m.warningStates || [])
      .filter((w) => w?.status === 'BAD')
      .map((w) => w.warningType);
    // Also live-only: `policyViolationWarnings: { warningsCount }`.
    const pvw = Number(m.policyViolationWarnings?.warningsCount);
    if (pvw > 0) warnings.push(`${pvw} policy violation warning${pvw > 1 ? 's' : ''}`);
    return {
      marketplaceId: m.marketplaceId,
      ahrStatus: ratingStatus(m.accountHealthRating),
      ahrScore: m.accountHealthRating?.ahrScore ?? null,
      violations,
      warnings,
    };
  });
  return { statuses, markets };
}

/** A violation metric is open when Amazon says BAD or counts any defect. */
export const isOpen = (v) => v.status === 'BAD' || (v.defectsCount ?? 0) > 0;

/**
 * Everything a human must act on, split by urgency.
 *
 * - `urgent`: a marketplace account not NORMAL, or a rating that is WARNED.
 *   That is the state that precedes deactivation, so it is emailed at once.
 * - `open`: every open violation metric, each carrying the date it was first
 *   seen. `firstSeen` comes from the previous run's rows, so a violation that
 *   has been open for weeks says so instead of looking new every morning.
 */
export function findings(summary, previous = null, now = new Date().toISOString()) {
  const urgent = [];
  for (const s of summary.statuses) {
    if (s.status && s.status !== 'NORMAL') {
      urgent.push(`${marketName(s.marketplaceId)} account status is ${s.status}`);
    }
  }
  for (const m of summary.markets) {
    if (m.ahrStatus && m.ahrStatus !== 'GREAT') {
      urgent.push(`${marketName(m.marketplaceId)} Account Health Rating is ${m.ahrStatus}`);
    }
  }

  const seen = new Map(
    (previous?.open || []).map((o) => [`${o.marketplaceId}|${o.key}`, o]),
  );
  const open = [];
  for (const m of summary.markets) {
    for (const v of m.violations.filter(isOpen)) {
      const prior = seen.get(`${m.marketplaceId}|${v.key}`);
      open.push({
        marketplaceId: m.marketplaceId,
        key: v.key,
        label: v.label,
        defectsCount: v.defectsCount,
        status: v.status,
        firstSeen: prior?.firstSeen || now,
        isNew: !prior || (v.defectsCount ?? 0) > (prior.defectsCount ?? 0),
      });
    }
  }
  return { urgent, open };
}

/**
 * True when today's at-risk set differs from the previous run's. The immediate
 * email fires on a CHANGE only: the first live run (2026-10-14) found Amazon.ca
 * and Amazon.com.br DEACTIVATED while a reactivation was already pending, and an
 * email every morning for a state the operator is waiting on is noise that
 * trains people to ignore the one that matters. The digest still lists it daily.
 */
export function urgentChanged(urgent, previous) {
  const prev = new Set(previous?.urgent || []);
  return urgent.length !== prev.size || urgent.some((u) => !prev.has(u));
}

/**
 * Rows for the digest's "Needs your decision" section — the same row shape
 * queue-autoapply, indexing-fixer and content-strategist emit, so
 * agents/daily-summary keeps one renderer.
 */
export function needsDecisionRows(open) {
  return open.map((o) => ({
    title: `Amazon ${o.label}: ${o.defectsCount ?? '?'} on ${marketName(o.marketplaceId)}`,
    label: 'Open Seller Central > Account Health, then fix the listing and appeal, or delete it.',
    trigger: 'amazon-account-health',
    created_at: o.firstSeen,
  }));
}

/** Plain-text digest body. */
export function renderBody(summary, { urgent, open }) {
  const lines = [];
  if (urgent.length) {
    lines.push('ACCOUNT AT RISK:');
    for (const u of urgent) lines.push(`- ${u}`);
    lines.push('');
  }
  for (const m of summary.markets) {
    const status = summary.statuses.find((s) => s.marketplaceId === m.marketplaceId)?.status || 'unknown';
    lines.push(`${marketName(m.marketplaceId)}: account ${status}, rating ${m.ahrStatus || 'not reported'}${m.ahrScore != null ? ` (${m.ahrScore})` : ''}`);
    const mine = open.filter((o) => o.marketplaceId === m.marketplaceId);
    if (!mine.length) lines.push('  no open policy violations');
    for (const o of mine) {
      lines.push(`  ${o.isNew ? 'NEW ' : ''}${o.label}: ${o.defectsCount ?? '?'} (open since ${o.firstSeen.slice(0, 10)})`);
    }
    if (m.warnings.length) lines.push(`  warnings: ${m.warnings.join(', ')}`);
  }
  return lines.join('\n');
}
