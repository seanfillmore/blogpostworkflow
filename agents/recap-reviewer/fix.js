/**
 * Unit C: at most ONE autonomous fix session per run.
 *
 * createFixCheckout -> runFixSession -> shipFix (only on verdict `fixed`).
 * The session runs as the unprivileged `recapfix` user in a fresh clone
 * (lib/fix-session.js); shipFix is the gate (lib/fix-ship.js).
 *
 * Cleanup: the fix checkout, its bundle and the root ship clone are removed after
 * any terminal outcome EXCEPT a session timeout, which is left for the next
 * morning to inspect (index.js removes it two days later). Every process the
 * `recapfix` user still has is killed once the session returns.
 *
 * Post-deploy verification: a REAL re-run only for a job on the re-run allowlist
 * (lib/recap-jobs.js isRerunnable, the same gate Unit A uses). Every other job
 * (scheduler.js, daily-summary, outreach, publishing) would send, post or write
 * live data a second time, so it is verified by its next scheduled run.
 *
 * A fix that ends reverted, not deployed, or with shipFix throwing changed main
 * (and maybe production) and may finish after the 13:00 recap, so it also sends
 * an immediate notify stating the production state.
 */
import { basename } from 'node:path';
import { isRerunnable, RERUN_TIMEOUT_MS } from '../../lib/recap-jobs.js';
import { buildFixPrompt } from '../../lib/fix-session.js';

export { RERUN_TIMEOUT_MS };
export const SHIP_ROOT = '/root/recap-ship';

async function alert(deps, status, subject, lines) {
  try {
    await deps.notify({ subject, body: lines.join('\n'), status, category: 'ops', immediate: true });
  } catch { /* the outcome is still in the report */ }
}

const tail = (s, n = 800) => { const t = String(s || '').trim(); return t.length > n ? `…${t.slice(-n)}` : t; };

export function fixName(source, today) {
  const base = String(source || 'unknown').replace(/\/index\.js$/, '').replace(/\.m?js$/, '');
  return `${base}-${today}`.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 60);
}

/**
 * @param {{item:object, command:string|null, splitCommand:Function, deps:object, today:string, timeoutMs?:number}} args
 * @returns {Promise<{bucket:'resolved'|'unresolved'|'onlyYou', result:string, evidence:string, cleanup:boolean}>}
 */
export async function runFixUnit({ item, command, splitCommand, deps, today, timeoutMs }) {
  const source = item.source || '';
  let checkout;
  try {
    checkout = await deps.createFixCheckout(fixName(source, today));
  } catch (e) {
    return { bucket: 'unresolved', result: 'could not create the fix checkout', evidence: e.message };
  }
  const name = basename(checkout).replace(/^fix-/, '');
  const cleanup = async () => {
    for (const p of [checkout, `${checkout}.bundle`, `${SHIP_ROOT}/${name}`, `${SHIP_ROOT}/${name}.bundle`]) {
      try { await deps.removeDir(p); } catch { /* best effort */ }
    }
  };

  const logTail = await deps.logTail(source).catch(() => '');
  const session = await deps.runFixSession({ worktree: checkout, prompt: buildFixPrompt({ item, logTail, command: command || '' }), ...(timeoutMs ? { timeoutMs } : {}) });
  // Nothing the session started may outlive it (a dev server, a stray test run).
  try { await deps.reapFixUser?.(); } catch { /* best effort */ }
  const summary = session?.summary || '';
  if (summary === 'timed out') {
    return { bucket: 'unresolved', result: 'fix session timed out; checkout kept for tomorrow', evidence: checkout };
  }

  let outcome;
  if (session?.verdict === 'fixed') {
    const rerun = (!isRerunnable(source) || !command) ? null : async () => {
      const [cmd, ...args] = splitCommand(command);
      const r = await deps.exec(cmd, args, { timeout: RERUN_TIMEOUT_MS });
      return { ok: r.code === 0, output: `${r.stdout || ''}\n${r.stderr || ''}` };
    };
    try {
      const ship = await deps.shipFix({ worktree: checkout, item, session, rerun });
      const pr = ship?.pr?.number ? `PR #${ship.pr.number}` : 'no PR';
      const others = ship?.otherCommits?.length ? ` Also deployed: ${ship.otherCommits.join('; ')}.` : '';
      switch (ship?.outcome) {
        case 'deployed':
          outcome = {
            bucket: 'resolved',
            result: `fixed, ${pr} merged and deployed${ship.verify === 'next-scheduled-run' ? ' (verified by its next scheduled run)' : ''}`,
            evidence: `${summary}${others}`,
          };
          break;
        case 'reverted': {
          const rev = ship.revertPr?.number ? `#${ship.revertPr.number}` : 'a revert';
          outcome = { bucket: 'unresolved', result: `fix ${pr} deployed but failed verification and was reverted by ${rev}`, evidence: (ship.problems || []).join('; ') };
          await alert(deps, 'info', `Recap fix ${pr} reverted`, [
            `${item.subject}: the automatic fix ${pr} was merged and deployed, failed verification, and was reverted by ${rev}.`,
            `Production: the revert is deployed; the server runs main without the fix.`,
            `Why: ${outcome.evidence || '(no detail)'}`,
          ]);
          break;
        }
        case 'not-deployed':
          outcome = { bucket: 'unresolved', result: `fix ${pr} merged but the deploy never landed; reverted on main`, evidence: ship.message || (ship.problems || []).join('; ') };
          await alert(deps, 'info', `Recap fix ${pr} never deployed`, [
            `${item.subject}: the automatic fix ${pr} was merged, but the deploy never pulled it, and main was reverted${ship.revertPr?.number ? ` by #${ship.revertPr.number}` : ''}.`,
            `Production: ${ship.message || 'server unchanged'}.`,
            `Why: ${(ship.problems || []).join('; ') || '(no detail)'}`,
          ]);
          break;
        case 'too-late':
          outcome = { bucket: 'unresolved', result: 'fix ready but past the 13:45 UTC merge cutoff; retried tomorrow', evidence: summary };
          break;
        default:
          outcome = { bucket: 'unresolved', result: 'fix refused by the ship checks', evidence: (ship?.problems || [`outcome ${ship?.outcome}`]).join('; ') };
      }
    } catch (e) {
      outcome = { bucket: 'unresolved', result: 'fix ship failed', evidence: e.message };
      // shipFix's error message states what main and the server hold.
      await alert(deps, 'error', `Recap fix for ${item.subject} failed while shipping`, [
        `${item.subject}: shipping the automatic fix failed.`,
        e.message,
      ]);
    }
  } else if (session?.verdict === 'external') {
    outcome = { bucket: 'onlyYou', result: summary || 'needs an outside fix (credentials or a service)', evidence: tail(item.detail) };
  } else {
    const label = session?.verdict === 'gate' ? 'a gate correctly refused' : 'no code fix found';
    outcome = { bucket: 'unresolved', result: `fix session: ${label}: ${summary || '(no summary)'}`, evidence: tail(item.detail) };
  }
  await cleanup();
  return outcome;
}
