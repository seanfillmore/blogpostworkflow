/**
 * Unit C: at most ONE autonomous fix session per run.
 *
 * createFixCheckout -> runFixSession -> shipFix (only on verdict `fixed`).
 * The session runs as the unprivileged `recapfix` user in a fresh clone
 * (lib/fix-session.js); shipFix is the gate (lib/fix-ship.js).
 *
 * Cleanup: the fix checkout, its bundle and the root ship clone are removed after
 * any terminal outcome EXCEPT a session timeout, which is left for the next
 * morning to inspect.
 */
import { basename } from 'node:path';
import { NEVER_RERUN } from '../../lib/recap-jobs.js';
import { buildFixPrompt } from '../../lib/fix-session.js';

export const RERUN_TIMEOUT_MS = 20 * 60_000;
export const SHIP_ROOT = '/root/recap-ship';

const tail = (s, n = 800) => { const t = String(s || '').trim(); return t.length > n ? `…${t.slice(-n)}` : t; };

export function fixName(source, today) {
  const base = String(source || 'unknown').replace(/\/index\.js$/, '').replace(/\.m?js$/, '');
  return `${base}-${today}`.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 60);
}

/**
 * @param {{item:object, command:string|null, splitCommand:Function, deps:object, today:string}} args
 * @returns {Promise<{bucket:'resolved'|'unresolved'|'onlyYou', result:string, evidence:string, cleanup:boolean}>}
 */
export async function runFixUnit({ item, command, splitCommand, deps, today }) {
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
  const session = await deps.runFixSession({ worktree: checkout, prompt: buildFixPrompt({ item, logTail, command: command || '' }) });
  const summary = session?.summary || '';
  if (summary === 'timed out') {
    return { bucket: 'unresolved', result: 'fix session timed out after 45 minutes; checkout kept for tomorrow', evidence: checkout };
  }

  let outcome;
  if (session?.verdict === 'fixed') {
    const rerun = (!source || NEVER_RERUN.has(source) || !command) ? null : async () => {
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
        case 'reverted':
          outcome = { bucket: 'unresolved', result: `fix ${pr} deployed but failed verification and was reverted (${ship.revertPr?.number ? `#${ship.revertPr.number}` : 'revert'})`, evidence: (ship.problems || []).join('; ') };
          break;
        case 'not-deployed':
          outcome = { bucket: 'unresolved', result: `fix ${pr} merged but the deploy never landed; reverted on main`, evidence: ship.message || (ship.problems || []).join('; ') };
          break;
        case 'too-late':
          outcome = { bucket: 'unresolved', result: 'fix ready but past the 13:45 UTC merge cutoff; retried tomorrow', evidence: summary };
          break;
        default:
          outcome = { bucket: 'unresolved', result: 'fix refused by the ship checks', evidence: (ship?.problems || [`outcome ${ship?.outcome}`]).join('; ') };
      }
    } catch (e) {
      outcome = { bucket: 'unresolved', result: 'fix ship failed', evidence: e.message };
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
