/**
 * Turn the digest's problems into REVIEW ITEMS, each with one route to a fix.
 *
 * The recap reviewer reads the day's digest before it is sent. Everything that
 * would reach Sean as a problem (failed agents, health rows, stuck decisions,
 * flop verdicts, blocked drafts) becomes one item, deduplicated by key, so the
 * same failure written twice (`Creator outreach failed` twice on 2026-11-09)
 * is one re-run and one fix session, never two.
 *
 * Pure: no I/O. Re-running and fixing live elsewhere; this only decides WHICH.
 */
import { subjectStem, dropRecoveredFailures } from './digest-recovery.js';

// Order matters: an expired credential with a stack trace is still Sean's to
// fix, so external is checked first. Re-running or patching code cannot help.
const EXTERNAL = /\b401\b|\b403\b|invalid[_ ]?(api[_ ]?)?(key|token)|expired|access denied|missing scope|unauthori[sz]ed|refresh token/i;
// Amazon's Login With Amazon, as a whole word and in capitals only: /LWA/i
// matched "always" and "halfway" and sent ordinary bugs to Sean as credentials.
const EXTERNAL_CASED = /\bLWA\b/;
const CODE = /TypeError|ReferenceError|SyntaxError|is not a function|Cannot read propert|is not defined/;
const TRANSIENT = /ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN|socket hang up|timed? ?out|\b429\b|rate limit|\b50[234]\b|SIGKILL|out of memory/i;

/**
 * Rows the reviewer never takes as items. daily-summary's own "System health"
 * row repeats the health issues the reviewer reads directly from
 * checkSystemHealth(), so taking it too would review each issue twice.
 */
export const NOT_REVIEWED_SOURCES = Object.freeze(new Set(['agents/daily-summary/index.js']));

/** The digest rows the reviewer works: errors AND warnings, minus NOT_REVIEWED_SOURCES. */
export function isReviewedProblem(row) {
  return (row?.status === 'error' || row?.status === 'warning') && !NOT_REVIEWED_SOURCES.has(row?.source || '');
}

/**
 * Did a later row prove `row` (an error OR a warning) recovered? Same reporter
 * (lib/digest-recovery.js), later, and neither an error nor a warning: a
 * warning is only cleared by a clean run, never by another warning.
 */
export function recoveredBy(row, later = []) {
  const clean = (later || []).filter((r) => r?.status !== 'warning');
  return dropRecoveredFailures([{ ...row, status: 'error' }], clean).recovered.length > 0;
}

export function itemKey(row) {
  return `${row.source || ''}|${row.category || ''}|${subjectStem(row.subject)}`;
}

const utcDay = (r) => String(r.ts || '').slice(0, 10);

/**
 * @param {object} row
 * @param {{ priorDays?: object[] }} [opts] earlier-day rows with the same key
 * @returns {'external'|'code'|'transient'}
 */
export function classifyFailure(row, { priorDays = [] } = {}) {
  const text = `${row.subject || ''}\n${row.body || ''}`;
  if (EXTERNAL.test(text) || EXTERNAL_CASED.test(text)) return 'external';
  if (CODE.test(text)) return 'code';
  if (TRANSIENT.test(text)) return 'transient';
  // Unrecognised: give it one benefit-of-the-doubt day, then it is a bug.
  const days = new Set(priorDays.map(utcDay).filter(Boolean));
  return days.size >= 2 ? 'code' : 'transient';
}

const PRECEDENCE = ['external', 'code', 'transient'];

/**
 * Classify every row sharing one key and keep the strongest verdict
 * (external > code > transient): the first row of the day may be a timeout
 * while a later one carries the TypeError or the expired token.
 */
export function classifyRows(rows) {
  let best = 'transient';
  for (const row of rows) {
    // Every other row sharing the key is evidence for the "same failure on 2+ days" rule.
    const kind = classifyFailure(row, { priorDays: rows.filter((r) => r !== row) });
    if (PRECEDENCE.indexOf(kind) < PRECEDENCE.indexOf(best)) best = kind;
  }
  return best;
}

const FLOP_ROUTE = {
  'auto-refresh': 'count-only',
  locked: 'count-only',
  'not-indexed': 'count-only',
  demote: 'refresh',
  'no-demand': 'remove',
};

function healthRoute(title = '') {
  if (/^(Data feed|Analysis report) /i.test(title)) return 'collector-rerun';
  if (/git stash/i.test(title)) return 'stash-residual';
  if (/Edit freeze/i.test(title)) return 'only-you';
  return 'only-you'; // unknown health row: a human decides
}

function decisionSource(d) {
  return d.source || d.reporter || d.agent || '';
}

/**
 * @returns {Array<{key:string, kind:string, route:string, subject:string, detail:string, source:string, row:object}>}
 */
export function buildReviewItems({ errorRows = [], healthIssues = [], needsDecision = [], flops = [], blockedDrafts = [] } = {}) {
  const items = [];
  const seen = new Set();
  const push = (item) => {
    if (seen.has(item.key)) return;
    seen.add(item.key);
    items.push(item);
  };

  const problems = errorRows.filter((r) => !NOT_REVIEWED_SOURCES.has(r?.source || ''));
  for (const row of problems) {
    const key = itemKey(row);
    if (seen.has(key)) continue;
    const rows = problems.filter((r) => itemKey(r) === key);
    const kind = classifyRows(rows);
    // Only an ERROR row can claim the daily fix session; a warning that reads
    // like code is re-run (if allowlisted) or waits for its next run.
    const anyError = rows.some((r) => r?.status !== 'warning');
    const route = kind === 'external' ? 'only-you' : kind === 'code' && anyError ? 'fix-session' : 'rerun';
    push({ key, kind: 'failure', route, subject: row.subject || '', detail: row.body || '', source: row.source || '', row });
  }

  for (const h of healthIssues) {
    push({ key: `health|${subjectStem(h.title)}|${h.title}`, kind: 'health', route: healthRoute(h.title), subject: h.title || '', detail: h.detail || '', source: '', row: h });
  }

  for (const d of needsDecision) {
    const src = decisionSource(d);
    const route = /amazon-account-health/.test(src) ? 'only-you' : 'regenerate';
    push({ key: `decision|${src}|${d.slug || d.title || d.label || ''}`, kind: 'decision', route, subject: d.title || d.slug || '', detail: d.label || d.reason || '', source: src, row: d });
  }

  for (const f of flops) {
    push({ key: `flop|${f.slug || f.handle || f.title || ''}`, kind: 'flop', route: FLOP_ROUTE[f.action] || 'count-only', subject: f.title || f.slug || '', detail: f.action || '', source: 'agents/post-performance/index.js', row: f });
  }

  for (const b of blockedDrafts) {
    push({ key: `blocked-draft|${b.slug || b.title || ''}`, kind: 'blocked-draft', route: 'remediate-draft', subject: b.title || b.slug || '', detail: b.reason || '', source: '', row: b });
  }

  return items;
}
