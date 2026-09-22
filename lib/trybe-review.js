// lib/trybe-review.js
//
// The pure half of agents/trybe-review: what to do with a creator's Trybe
// submission, what to tell the creator, and what goes in the 5 AM digest.
// No I/O here, so every decision is something a test constructs.
//
// ── Why this exists ─────────────────────────────────────────────────────────────
//
// Creator videos are ADVERTISING for a cosmetic. A creator who says "this
// cleared up my eczema" on a video we approve and Trybe pushes to Meta as a
// whitelisted ad is an unapproved-drug claim with our name on it: the FTC holds
// an advertiser responsible for what an endorsement conveys, and FDA reads
// intended use from marketing including testimonials. That is the 2026-08-16
// Judge.me incident on a new surface. Before this agent the only screen was a
// human watching every video.
//
// ── The rule is the SEO gate's COMMERCIAL surface, imported, not re-declared ──
//
// `checkSeoCopyFields` with the default COMMERCIAL_SURFACE blocks exactly what
// the creator brief tells creators not to say: a named condition next to the
// product, heal/cure/treat/prevent, drug and clinical-backing language, "our
// antiperspirant", and toothpaste enamel/cavity claims. It passes what the
// brief allows: "dry, rough or sensitive skin", "safe for my kids", "not an
// antiperspirant, a deodorant". Measured on sample lines 2026-09-22 before
// wiring. A second copy of that vocabulary here would drift from the fleet's.
//
// ── What it deliberately does NOT do ────────────────────────────────────────────
//
// It never APPROVES. A clean transcript means "no claim in the spoken words",
// not "good content": on-screen text, captions and the visuals are invisible to
// it, and approving is a creative decision. It never REJECTS either: a claim is
// fixable, so the answer is a revision request that quotes the line, which
// keeps the creator and their work. And a submission with no transcript is
// reported as UNCHECKED, never as clean; silence is not evidence.

import { checkSeoCopyFields, COMMERCIAL_SURFACE } from './seo-copy-health-gate.js';

/** Per-run cap on revision requests, so a bad day cannot spam every creator. */
export const MAX_REVISIONS_PER_RUN = 10;

/** Quotes shown to a creator; more than this reads as a telling-off. */
const MAX_QUOTES = 3;

const REASONS = {
  disease: 'name a skin or health condition next to the product',
  therapeutic: 'say the product heals, treats or prevents something',
  drug: 'compare the product to a drug or medication',
  substantiation: 'claim medical or clinical backing (clinically proven, dermatologist recommended, FDA approved)',
  'systemic-absorption': 'say the ingredients are absorbed into the body',
  'oral-drug-claim': 'say the toothpaste repairs or strengthens teeth, or prevents cavities or gum disease',
  'product-category': 'call our deodorant an antiperspirant',
};
const DEFAULT_REASON = 'make a health claim';

export function transcriptText(submission) {
  return String(submission?.transcript?.text ?? '').trim();
}

/**
 * The sentence (or, for an unpunctuated transcript, a short window) that
 * carries a match, so the creator sees the line in context.
 */
export function quoteAround(text, match) {
  const lower = text.toLowerCase();
  const at = lower.indexOf(String(match).toLowerCase());
  if (at === -1) return String(match);
  const sentences = text.split(/(?<=[.!?])\s+/);
  let offset = 0;
  for (const s of sentences) {
    const start = text.indexOf(s, offset);
    const end = start + s.length;
    offset = end;
    if (at >= start && at < end && s.length <= 220) return s.trim();
  }
  const from = Math.max(0, at - 60);
  const to = Math.min(text.length, at + String(match).length + 60);
  return `${from > 0 ? '...' : ''}${text.slice(from, to).trim()}${to < text.length ? '...' : ''}`;
}

/** The comment Trybe shows the creator with the revision request. */
export function buildRevisionComment(text, blocking) {
  const reasons = [...new Set(blocking.map((b) => REASONS[b.category] || DEFAULT_REASON))];
  const quotes = [...new Set(blocking.map((b) => quoteAround(text, b.match)))].slice(0, MAX_QUOTES);
  const reasonLine = reasons.length === 1
    ? reasons[0]
    : `${reasons.slice(0, -1).join(', ')} or ${reasons[reasons.length - 1]}`;
  return [
    'Thanks for making this! We can\'t approve it quite yet because of one thing.',
    `Our products are cosmetics, so creator videos can't ${reasonLine}.`,
    `Here's the part that needs to change:`,
    ...quotes.map((q) => `"${q}"`),
    'Could you re-record or cut that bit? Talking about how it feels, how it smells, or how it fits into your routine is perfect. The "What to avoid" table in the creator brief has examples. Thank you!',
  ].join('\n');
}

/**
 * Decide one submission.
 *
 * @returns {{action: 'skip'|'unchecked'|'revise'|'review', reason?: string,
 *            blocking?: object[], advisory?: object[], comment?: string}}
 *   skip      not pending, so already reviewed by someone
 *   unchecked pending, but there are no spoken words to check
 *   revise    pending, and the transcript makes a claim the brief forbids
 *   review    pending, no claim in the spoken words; a human still approves
 */
export function decideSubmission(submission) {
  if (submission?.status !== 'pending') return { action: 'skip', reason: `status ${submission?.status}` };
  const text = transcriptText(submission);
  if (!text) {
    return {
      action: 'unchecked',
      reason: submission.media_type === 'video'
        ? 'no transcript: a silent video, or Trybe has not transcribed it yet'
        : `${submission.media_type || 'asset'}: nothing spoken to check`,
    };
  }
  const { blocking, advisory } = checkSeoCopyFields({ transcript: text }, { surface: COMMERCIAL_SURFACE });
  if (blocking.length) {
    return { action: 'revise', blocking, advisory, comment: buildRevisionComment(text, blocking) };
  }
  return { action: 'review', advisory };
}

/**
 * Plan the whole run BEFORE any write, so the cap is spent oldest-first and a
 * run that stops partway has already decided what it would have done.
 */
export function planReview(submissions, { maxRevisions = MAX_REVISIONS_PER_RUN } = {}) {
  const pending = (submissions || [])
    .filter((s) => s?.status === 'pending')
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  const plan = { revise: [], deferred: [], review: [], unchecked: [] };
  for (const s of pending) {
    const d = decideSubmission(s);
    const row = { submission: s, ...d };
    if (d.action === 'revise') {
      (plan.revise.length < maxRevisions ? plan.revise : plan.deferred).push(row);
    } else if (d.action === 'review') plan.review.push(row);
    else if (d.action === 'unchecked') plan.unchecked.push(row);
  }
  return plan;
}

// ── Performance ─────────────────────────────────────────────────────────────────

const PERF_FIELDS = [
  'earnings_cents', 'trybe_conversions', 'trybe_gmv_cents', 'new_submissions',
  'active_submissions', 'ads', 'spend_cents', 'purchases', 'purchase_value_cents',
];

export function summarizePerformance(rows) {
  const totals = Object.fromEntries(PERF_FIELDS.map((f) => [f, 0]));
  const active = [];
  let window = null;
  for (const r of rows || []) {
    const p = r?.performance || {};
    if (!window && p.start_date) window = { start: p.start_date, end: p.end_date };
    for (const f of PERF_FIELDS) totals[f] += Number(p[f]) || 0;
    if (PERF_FIELDS.some((f) => Number(p[f]) > 0)) {
      active.push({ name: r.creator?.name || r.creator?.id || 'unknown', ...Object.fromEntries(PERF_FIELDS.map((f) => [f, Number(p[f]) || 0])) });
    }
  }
  active.sort((a, b) => b.trybe_gmv_cents - a.trybe_gmv_cents || b.new_submissions - a.new_submissions);
  return { creators: (rows || []).length, window, totals, active };
}

const usd = (cents) => `$${((Number(cents) || 0) / 100).toFixed(2)}`;

// ── Digest ──────────────────────────────────────────────────────────────────────

function subLabel(s) {
  const products = (s.products || []).map((p) => p.name).join(', ') || 'no product tagged';
  return `${s.creator?.name || 'unknown creator'} · ${s.media_type || 'asset'} · ${products} (${s.trybe_id || s.id})`;
}

/**
 * @param {{plan, revised: object[], raced: object[], failed: object[],
 *          perf, apply: boolean}} run
 * @returns {{subject: string, body: string}}
 */
export function renderDigest({ plan, revised = [], raced = [], failed = [], perf, apply }) {
  const waiting = plan.review.length + plan.unchecked.length;
  const flagged = apply ? revised.length : plan.revise.length;
  const lines = [];

  lines.push(apply ? '' : 'DRY RUN: no revision requests were sent.');

  if (plan.revise.length || plan.deferred.length) {
    lines.push(`Claims found in ${plan.revise.length + plan.deferred.length} submission(s)${apply ? ', revision requested' : ''}:`);
    for (const r of [...plan.revise, ...plan.deferred]) {
      const words = [...new Set(r.blocking.map((b) => `"${b.match}"`))].join(', ');
      const state = plan.deferred.includes(r) ? ' (over the per-run cap, next run)' : '';
      lines.push(`  - ${subLabel(r.submission)}: ${words}${state}`);
    }
  }
  if (plan.review.length) {
    lines.push(`Ready for your review (no claim in the spoken words; on-screen text and captions are not checked):`);
    for (const r of plan.review) lines.push(`  - ${subLabel(r.submission)}`);
  }
  if (plan.unchecked.length) {
    lines.push(`Not checked, review by eye:`);
    for (const r of plan.unchecked) lines.push(`  - ${subLabel(r.submission)}: ${r.reason}`);
  }
  if (raced.length) {
    lines.push(`Already reviewed before this run could act: ${raced.map((r) => subLabel(r.submission)).join('; ')}`);
  }
  if (failed.length) {
    lines.push(`Revision request FAILED, review by hand:`);
    for (const f of failed) lines.push(`  - ${subLabel(f.submission)}: ${f.error}`);
  }
  if (!plan.revise.length && !plan.deferred.length && !waiting) lines.push('No submissions waiting for review.');

  if (perf) {
    const t = perf.totals;
    const win = perf.window ? `${perf.window.start} to ${perf.window.end}` : 'last 30 days';
    lines.push('');
    lines.push(`Creators: ${perf.creators} on the roster, ${perf.active.length} active (${win}).`);
    lines.push(`Creator sales ${usd(t.trybe_gmv_cents)} from ${t.trybe_conversions} order(s) · commission ${usd(t.earnings_cents)} · ${t.new_submissions} new submission(s) · ${t.ads} ad(s), ${usd(t.spend_cents)} spend.`);
    for (const c of perf.active.slice(0, 10)) {
      lines.push(`  - ${c.name}: ${usd(c.trybe_gmv_cents)} sales (${c.trybe_conversions} orders), ${usd(c.earnings_cents)} commission, ${c.new_submissions} submission(s), ${c.ads} ad(s)`);
    }
  } else {
    lines.push('', 'Creator performance could not be read this run.');
  }

  const perfPart = perf ? ` · ${usd(perf.totals.trybe_gmv_cents)} creator sales` : '';
  const subject = `Trybe creators: ${waiting} awaiting review · ${flagged} claim revision(s)${failed.length ? ` · ${failed.length} FAILED` : ''}${perfPart}`;
  return { subject, body: lines.filter((l, i) => i > 0 || l).join('\n') };
}
