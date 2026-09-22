#!/usr/bin/env node
/**
 * Trybe Review — screens creator submissions for health claims and reports the
 * creator program in the 5 AM digest.
 *
 * Every pending Trybe submission's transcript goes through the same COMMERCIAL
 * claim gate the fleet's product copy uses (lib/seo-copy-health-gate.js). A
 * transcript that makes a claim the creator brief forbids gets a revision
 * request quoting the line. Everything else is left PENDING for a human: this
 * agent never approves and never rejects. See lib/trybe-review.js for why.
 *
 * Usage:
 *   node agents/trybe-review/index.js            # dry run: decide, report, send nothing
 *   node agents/trybe-review/index.js --apply    # send the revision requests (cron does this)
 *   node agents/trybe-review/index.js --json     # print the plan as JSON, send nothing
 *
 * Cron: DAILY_TRYBE_REVIEW, 12:55 UTC (scripts/setup-cron.sh), so the row lands
 * in the same morning's 13:00 UTC digest.
 *
 * Requires TRYBE_API_KEY in .env.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDirectRun } from '../../lib/is-direct-run.js';
import { notify } from '../../lib/notify.js';
import { listSubmissions, listCreatorPerformance, requestRevision } from '../../lib/trybe.js';
import { planReview, summarizePerformance, renderDigest } from '../../lib/trybe-review.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function loadEnv(root = ROOT) {
  try {
    const env = {};
    for (const line of readFileSync(join(root, '.env'), 'utf8').split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const idx = t.indexOf('=');
      if (idx === -1) continue;
      env[t.slice(0, idx).trim()] = t.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
    }
    return env;
  } catch { return {}; }
}

/**
 * One run. Dependencies are injectable so the orchestration is testable
 * without a network call or a digest write.
 */
export async function runReview({
  apiKey,
  apply = false,
  fetchImpl = fetch,
  send = requestRevision,
  log = console.log,
} = {}) {
  const pending = await listSubmissions({ status: 'pending', apiKey, fetchImpl });
  const plan = planReview(pending);

  const revised = [];
  const raced = [];
  const failed = [];
  if (apply) {
    for (const row of plan.revise) {
      try {
        await send(row.submission.id, row.comment, { apiKey, fetchImpl });
        revised.push(row);
        log(`  revision requested: ${row.submission.trybe_id || row.submission.id}`);
      } catch (err) {
        // Trybe answers 400 when the submission is no longer pending: somebody
        // reviewed it between our read and our write. That is not a failure.
        if (/HTTP 400/.test(err.message) && /pending/i.test(err.message)) raced.push(row);
        else failed.push({ ...row, error: err.message });
      }
    }
  }

  // Performance is reporting only; losing it must not lose the review above.
  let perf = null;
  try {
    perf = summarizePerformance(await listCreatorPerformance({ apiKey, fetchImpl }));
  } catch (err) {
    log(`  creator performance unavailable: ${err.message}`);
  }

  return { plan, revised, raced, failed, perf, apply };
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply') && !args.includes('--json');
  const env = loadEnv();
  const apiKey = env.TRYBE_API_KEY || process.env.TRYBE_API_KEY;

  console.log(`Trybe review${apply ? '' : ' (dry run)'}`);
  const run = await runReview({ apiKey, apply });

  if (args.includes('--json')) {
    const slim = (rows) => rows.map((r) => ({ id: r.submission.id, creator: r.submission.creator?.name, action: r.action, reason: r.reason, blocking: r.blocking?.map((b) => b.match), comment: r.comment }));
    console.log(JSON.stringify({ revise: slim(run.plan.revise), deferred: slim(run.plan.deferred), review: slim(run.plan.review), unchecked: slim(run.plan.unchecked), perf: run.perf }, null, 2));
    return;
  }

  const { subject, body } = renderDigest(run);
  console.log(`\n${subject}\n\n${body}`);
  // A claim found, or a failed revision request, is the agent doing its job:
  // 'info', never 'error' (see CLAUDE.md on digest severity). Only a crash in
  // main() below is an 'error'.
  if (apply) await notify({ subject, body, status: 'info', category: 'creators' });
}

if (isDirectRun(import.meta.url)) {
  main().catch(async (err) => {
    console.error(err);
    try {
      await notify({ subject: 'Trybe review failed', body: String(err?.stack || err), status: 'error', category: 'creators' });
    } catch { /* the console already has it */ }
    process.exit(1);
  });
}
