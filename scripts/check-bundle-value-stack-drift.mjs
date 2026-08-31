#!/usr/bin/env node
/**
 * Scheduled DETECTOR for bundle value-stack divergence. Fixes nothing, and
 * structurally cannot.
 *
 * WHAT IT IS
 * ──────────
 * `scripts/check-bundle-value-stacks.mjs` asks whether every bundle's
 * `bundle.value_stack` metafield renders ONE number — read-only, exiting 0/1/2.
 * That script is something a human runs. This wrapper puts the same question on
 * a timer and routes the answer into the 5 AM digest.
 *
 * WHY IT EXISTS
 * ─────────────
 * On 2026-08-30 the Coconut Reset lander was found showing "$180 of value … $59
 * in savings" in three places, "Total value $174 … You save $53" in a fourth,
 * and striking through $174 in its own buy box. Nothing was stale and nobody had
 * typed a wrong number: two Liquid blocks summed the same metafield under two
 * different rules, and the whole difference was one row — `Free shipping $6`,
 * which is neither digital nor product value.
 *
 * Two things make that worth a daily check rather than a one-off fix. It was
 * INVISIBLE — a computed contradiction on a live commercial page, months old,
 * with nothing anywhere reporting it. And it was NOT ISOLATED: the first run of
 * the checker found the identical row on `clean-swap` and `gift-box`, both
 * ACTIVE and published. Three of six bundles. A defect that spread silently
 * across a product line is exactly the shape a detector is for.
 *
 * WHY IT CAN NEVER FIX ANYTHING
 * ─────────────────────────────
 * The remedy for a divergence is a judgement about what counts as customer
 * value — is shipping worth $6 of anchor, or is it a free inclusion? — not a
 * number to recompute. A scheduled writer would resolve that unattended, on a
 * live commercial page, in whichever direction its author happened to prefer.
 * Compare `scripts/triage-orphan-briefs.mjs --drop-non-earning`, which ran
 * unattended on a fresh-but-wrong report and permanently destroyed three
 * paid-for briefs.
 *
 * So `GATE_ARGS` is a frozen empty constant, `--apply` is refused outright, and
 * the checker it spawns has no write path to reach even if this file were
 * edited — pinned from both sides by tests.
 *
 * WHAT EACH EXIT CODE MEANS HERE
 * ──────────────────────────────
 *   0  every bundle's stack totals its own compare-at price. Routine.
 *   1  a bundle diverges — a live page is stating two different values for the
 *      same box. Needs a human, because the fix is a pricing judgement.
 *   2  Shopify could not be read. Reported as a failure rather than passing
 *      quietly: a check that reads nothing and says "all consistent" is worse
 *      than no check at all.
 *
 * 1 and 2 render in the digest's Failures block (`status: 'error'`, which on
 * this fleet changes rendering ONLY — it never escalates to an email). Nothing
 * here is ever `immediate: true`.
 *
 * USAGE
 *   node scripts/check-bundle-value-stack-drift.mjs
 */

import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isDirectRun } from '../lib/is-direct-run.js';
import { notify } from '../lib/notify.js';

const ROOT = process.env.SEO_CLAUDE_ROOT || join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The ONLY arguments this ever hands the check script. Frozen, and pinned by a
 * test, so a scheduled run can never acquire a write flag by accident.
 */
export const GATE_ARGS = Object.freeze([]);

/** How much of the check's report to carry into the digest body. */
const BODY_LINES = 30;

/**
 * Exit code → what the digest should say about it.
 *
 * @param {number} code
 * @returns {{status:'success'|'error', headline:string, needsHuman:boolean, immediate:false}}
 */
export function classifyValueStackGateExit(code) {
  const base = { immediate: false };
  switch (code) {
    case 0:
      return {
        ...base,
        status: 'success',
        needsHuman: false,
        headline: 'Every bundle value stack totals its own Shopify compare-at price. One number per page.',
      };
    case 1:
      return {
        ...base,
        status: 'error',
        needsHuman: true,
        headline:
          'VALUE DIVERGENCE: a bundle\'s value_stack no longer totals its compare-at price, so its landing page is '
          + 'stating two different values for the same box. Every row that is not physical product value must carry '
          + 'amount: 0 — zero rather than deleted, so it still renders as a free inclusion. The offending rows are '
          + 'named below.',
      };
    case 2:
      return {
        ...base,
        status: 'error',
        needsHuman: true,
        headline:
          'REFUSED: Shopify could not be read, so nothing was checked. This is reported as a failure rather than a '
          + 'clean run on purpose — a check that reads nothing and reports "all consistent" is worse than no check.',
      };
    case 64:
      return {
        ...base,
        status: 'error',
        needsHuman: true,
        headline:
          'REFUSED an argument. GATE_ARGS is a frozen constant, so this means the scheduled call itself changed — '
          + 'check what it is now passing, and remember this gate may never write.',
      };
    default:
      return {
        ...base,
        status: 'error',
        needsHuman: true,
        headline:
          `Unexpected exit ${code} from scripts/check-bundle-value-stacks.mjs. The detector could not classify the `
          + 'result, which is itself the finding — read the output below.',
      };
  }
}

/** Last N non-empty lines of the check's report, for the digest body. */
function tail(text, lines = BODY_LINES) {
  const all = (text || '').trimEnd().split('\n');
  return all.length <= lines ? all.join('\n') : ['…', ...all.slice(-lines)].join('\n');
}

async function main(argv) {
  for (const forbidden of ['--apply', '--fix', '--write']) {
    if (argv.includes(forbidden)) {
      console.error(
        `REFUSED: ${forbidden}. This is a detector. Resolving a value divergence is a judgement about what counts as `
        + 'customer value, not a number to recompute, and it must never happen unattended on a live commercial page.',
      );
      return 64;
    }
  }

  const run = spawnSync(process.execPath, [join(ROOT, 'scripts', 'check-bundle-value-stacks.mjs'), ...GATE_ARGS], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  const output = `${run.stdout || ''}${run.stderr || ''}`;
  const code = run.status ?? -1;
  const verdict = classifyValueStackGateExit(code);

  console.log(output);
  console.log(`[bundle value-stack gate] exit ${code} — ${verdict.headline}`);

  await notify({
    subject: `Bundle value-stack gate — exit ${code}${verdict.needsHuman ? ' (needs a human)' : ''}`,
    status: verdict.status,
    category: 'pipeline',
    body: [
      verdict.headline,
      '',
      'Detector only — nothing was written to Shopify or to disk.',
      'Inspect by hand with (read-only, no apply path exists):',
      '  npm run check-value-stacks',
      '',
      '--- scripts/check-bundle-value-stacks.mjs ---',
      tail(output),
    ].join('\n'),
  });

  // Exit 0 whatever the gate said. This runs from cron, where a non-zero exit is
  // invisible; the digest row IS the report. The one exception is above:
  // refusing a write flag is a usage error, not a finding.
  return 0;
}

if (isDirectRun(import.meta.url)) {
  main(process.argv.slice(2)).then((c) => process.exit(c));
}
