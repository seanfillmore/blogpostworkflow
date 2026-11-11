/**
 * Close-out for `needs_decision[]` rows: the items a producer has given up on and
 * the old recap asked Sean to decide.
 *
 * POLICY: one retry, then a close-out. A close-out marks the item dismissed or
 * withheld in its producer's own record, stamped `closed_by: 'recap-reviewer'`
 * with the reason. It NEVER deletes a file and NEVER publishes anything.
 *
 * One handler per producer. Each was chosen by reading what the producer's row
 * means and what its own code does with the item afterwards:
 *
 * agents/queue-autoapply (rows from lib/queue-autoapply.js `decide()`)
 *   editor-gate-exhausted  RETRY: re-arm exactly one gate attempt
 *                          (gate_attempts = MAX - 1). The next queue-autoapply run
 *                          sends the item through its own editor gate AND its
 *                          repair loop (lib/edit-gate-repair.js), which is the
 *                          producer regenerating the revision. CLOSE (a later
 *                          day, still exhausted): dismiss in the queue file.
 *   health-claim           CLOSE at once: the stored copy trips the claim gate
 *                          and cannot be regenerated in place, so a re-check
 *                          would fail identically. Dismissing is the
 *                          regeneration path: a dismissed item is not "active"
 *                          (performance-engine/lib/queue.js activeSlugs), so the
 *                          analyzer may re-file it with fresh, gated copy.
 *   not-auto-appliable     CLOSE at once: the trigger is outside the auto-apply
 *                          policy, so pending forever is a silent stall.
 *   create-page            ONLY YOU: creating a commercial page is the decision
 *                          CLAUDE.md reserves for a human (62 collections for 9
 *                          products). Neither creating nor dismissing it is ours.
 *
 * agents/indexing-fixer (rows from lib/indexing-escalation.js)
 *   indexing-api-exhausted RETRY: one content-quality refresh of that post
 *                          (`node agents/refresh-runner/index.js <slug>`, the same
 *                          step indexing-fixer runs for crawled-not-indexed; the
 *                          runner honours the winner lock, edit gate and holds).
 *                          CLOSE: stamp `indexing_escalation_closed` on the post's
 *                          state ("accept it stays unindexed", the producer's own
 *                          second option). The page stays live and untouched.
 *
 * agents/content-strategist (rows from lib/duplicate-flag.js)
 *   possible-duplicate     CLOSE at once, record only. The topic is already
 *                          WITHHELD (not proposed, nothing deleted) by the
 *                          producer; that is the conservative outcome, and the
 *                          producer re-derives the list every run, so it has no
 *                          per-item file to stamp. The close-out is recorded in
 *                          the reviewer's state. No retry: re-running the
 *                          strategist REPLACES the calendar.
 *
 * agents/amazon-account-health never reaches here: lib/recap-review.js routes it
 * to only-you (an Amazon appeal needs a human).
 */
import { MAX_GATE_ATTEMPTS } from '../../lib/queue-autoapply.js';

export const DECISION_SOURCES = Object.freeze({
  queue: 'agents/queue-autoapply/index.js',
  indexing: 'agents/indexing-fixer/index.js',
  duplicate: 'agents/content-strategist/index.js',
});

export const REARM_GATE_ATTEMPTS = MAX_GATE_ATTEMPTS - 1;
const REFRESH_TIMEOUT_MS = 20 * 60_000;

const onlyYou = (row, why) => ({
  action: 'only-you',
  reason: [why, row?.label, row?.last_gate_reason].filter(Boolean).join(' — '),
});

function retryThenClose(row, ctx, retry, close) {
  if (!ctx.retriedOn) return { action: 'retry', ...retry };
  if (ctx.retriedOn >= ctx.today) return { action: 'wait', reason: 'retried today; checked again tomorrow' };
  return { action: 'close', ...close };
}

const HANDLERS = {
  [DECISION_SOURCES.queue](row, ctx) {
    switch (row.decision) {
      case 'editor-gate-exhausted':
        return retryThenClose(row, ctx,
          { how: 'rearm-queue', reason: 'one more editor-gate attempt, with queue-autoapply\'s repair loop' },
          { how: 'dismiss-queue', reason: 'the editor gate still failed after one more attempt with repair; dismissed (the analyzer may re-file it)' });
      case 'health-claim':
        return { action: 'close', how: 'dismiss-queue', reason: 'stored copy trips the health-claim gate and cannot be regenerated in place; dismissed so the producer can re-file it with fresh, gated copy' };
      case 'not-auto-appliable':
        return { action: 'close', how: 'dismiss-queue', reason: 'its trigger is outside the auto-apply policy, so it would sit pending forever; dismissed' };
      case 'create-page':
        return onlyYou(row, 'creating a commercial page stays a human decision');
      default:
        return onlyYou(row, `unknown queue decision "${row.decision}"`);
    }
  },
  [DECISION_SOURCES.indexing](row, ctx) {
    if (row.decision !== 'indexing-api-exhausted') return onlyYou(row, `unknown indexing decision "${row.decision}"`);
    return retryThenClose(row, ctx,
      { how: 'refresh-post', reason: 'one content-quality refresh, then Google gets another look' },
      { how: 'stamp-indexing-closed', reason: 'still unindexed after repeated submissions and a refresh; accepted as unindexed (page left live)' });
  },
  [DECISION_SOURCES.duplicate](row) {
    if (row.decision !== 'possible-duplicate') return onlyYou(row, `unknown strategist decision "${row.decision}"`);
    return { action: 'close', how: 'record-only', reason: 'left withheld: an existing page already ranks for it (nothing written, nothing dropped)' };
  },
};

/**
 * @param {object} row  a needs_decision row with `source` stamped
 * @param {{today:string, retriedOn?:string, closedOn?:string}} ctx
 * @returns {{action:'retry'|'close'|'wait'|'only-you'|'already-closed', how?:string, reason:string}}
 */
export function planDecision(row, ctx = {}) {
  const handler = HANDLERS[row?.source];
  if (!handler) return onlyYou(row, 'no automatic handler for this producer');
  if (!String(row?.slug || '').trim()) return onlyYou(row, 'the row names no item');
  if (ctx.closedOn) return { action: 'already-closed', reason: `closed out on ${ctx.closedOn}` };
  return handler(row, ctx);
}

/**
 * Carry out a retry or close plan. Throws on failure so the caller reports it.
 * @returns {Promise<string>} evidence line
 */
export async function executeDecision(plan, row, deps, { now = new Date().toISOString() } = {}) {
  const slug = row.slug;
  switch (plan.how) {
    case 'rearm-queue':
      await deps.rearmQueueItem(slug);
      return `data/performance-queue/${slug}.json: gate_attempts set to ${REARM_GATE_ATTEMPTS}`;
    case 'dismiss-queue':
      await deps.dismissQueueItem(slug, plan.reason);
      return `data/performance-queue/${slug}.json: status dismissed (closed_by recap-reviewer)`;
    case 'refresh-post': {
      const r = await deps.exec('node', ['agents/refresh-runner/index.js', slug], { timeout: REFRESH_TIMEOUT_MS });
      if (r.code !== 0) throw new Error(`refresh-runner ${r.timedOut ? 'timed out' : `exited ${r.code}`}: ${String(r.stderr || r.stdout || '').trim().slice(-400)}`);
      return `refresh-runner ${slug} exited 0`;
    }
    case 'stamp-indexing-closed':
      await deps.stampPostState(slug, {
        indexing_escalation_closed: { closed_by: 'recap-reviewer', reason: plan.reason, at: now },
      });
      return `data/posts/${slug} state: indexing_escalation_closed`;
    case 'record-only':
      return 'recorded in data/reports/recap-reviewer/state.json';
    default:
      throw new Error(`unknown decision action "${plan.how}"`);
  }
}
