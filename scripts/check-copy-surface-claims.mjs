#!/usr/bin/env node
//
// DAILY CLAIMS GATE for the two surfaces no agent gate can reach — DETECT ONLY.
//
//   node scripts/check-copy-surface-claims.mjs
//
// WHY THIS EXISTS
//   `lib/seo-copy-health-gate.js` screens what agents GENERATE. It has never seen
//   a theme template or a product image alt, and on 2026-09-03 both turned out to
//   carry live blocking-tier claims on pages with an Add-to-Cart button — found by
//   hand, while verifying something else, four months after the August claim
//   sweeps that were supposed to have cleaned the corpus.
//
//   These surfaces are edited by a human in the Shopify admin, so no writer-side
//   gate can ever cover them. A timer is the only thing that can.
//
// IT CAN NEVER FIX ANYTHING
//   `GATE_ARGS` is frozen, `--apply` is refused with exit 64, and this file
//   contains no write of any kind. Remediating a claim is a judgement call per
//   string — the standing rule for a testimonial is to SWAP it for a compliant
//   review, never to edit a customer's words — and that is not something to run
//   unattended at 12:35 in the morning.
//
// THE SEVERITY SPLIT
//   blocking-tier hit  → NEEDS A HUMAN. A cosmetic naming a disease or a drug on a
//                        live commercial page is the unapproved-drug shape the whole
//                        gate exists to prevent. Renders in the digest's Failures block.
//   advisory only      → ROUTINE. The advisory tier is `toxicity` and
//                        `regulatory-reference`, both of which this brand writes
//                        legitimately and deliberately. A daily failure row for
//                        copy we have chosen to keep is how a digest stops being read.
//   unreadable surface → NEEDS A HUMAN. Silent otherwise.
//
// Always exits 0 so cron has nothing to say the digest does not — the single
// exception is refusing a write flag, which is a usage error rather than a finding.
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { notify } from '../lib/notify.js';
import { isDirectRun } from '../lib/is-direct-run.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Frozen and pinned by a test, so a scheduled run can never acquire a write flag. */
export const GATE_ARGS = Object.freeze(['--json']);

export function refuseWriteFlags(argv) {
  const banned = argv.filter((a) => ['--apply', '--fix', '--write'].includes(a));
  return banned.length ? banned : null;
}

export function classify(exitCode, parsed) {
  if (exitCode === 3) {
    return { status: 'error', subject: 'Copy-surface claims gate: a surface could not be read' };
  }
  const blocking = parsed?.findings?.blocking?.length ?? 0;
  const advisory = parsed?.findings?.advisory?.length ?? 0;
  if (blocking > 0) {
    return {
      status: 'error',
      subject: `Copy-surface claims: ${blocking} BLOCKING on live theme/alt copy`,
      blocking,
      advisory,
    };
  }
  return {
    status: 'success',
    subject: advisory
      ? `Copy-surface claims: clean (${advisory} advisory)`
      : 'Copy-surface claims: clean',
    blocking: 0,
    advisory,
  };
}

export function renderBody(parsed, verdict) {
  const c = parsed?.counts ?? {};
  const lines = [
    `Theme ${parsed?.theme_id ?? '?'} · ${c.templates ?? 0} templates, ${c.templateScanned ?? 0} of ${c.templateStrings ?? 0} strings gated · ${c.imagesWithAlt ?? 0} of ${c.images ?? 0} images with alt text`,
    '',
  ];
  const blocking = parsed?.findings?.blocking ?? [];
  if (blocking.length) {
    lines.push(`BLOCKING (${blocking.length}) — a cosmetic may not name a disease or a drug on a live commercial page:`);
    for (const f of blocking.slice(0, 30)) lines.push(`  [${f.category}] ${f.field} — "${f.match}"`);
    if (blocking.length > 30) lines.push(`  … and ${blocking.length - 30} more`);
    lines.push('');
    lines.push('Remediate by hand. For a testimonial, SWAP it for a compliant review rather than editing a customer\'s words.');
  } else {
    lines.push('No blocking-tier claims on either surface.');
  }
  if (verdict.advisory) {
    lines.push('', `${verdict.advisory} advisory-tier hits (toxicity / regulatory-reference) — reported, not blocking.`);
  }
  return lines.join('\n');
}

async function main() {
  const banned = refuseWriteFlags(process.argv.slice(2));
  if (banned) {
    console.error(`This gate is DETECT ONLY. Refusing: ${banned.join(', ')}`);
    process.exit(64);
  }

  let stdout = '';
  let exitCode = 0;
  try {
    stdout = execFileSync(
      process.execPath,
      [join(ROOT, 'scripts/check-uncovered-copy-surfaces.mjs'), ...GATE_ARGS],
      { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }
    );
  } catch (err) {
    exitCode = typeof err.status === 'number' ? err.status : 3;
    stdout = err.stdout || '';
  }

  let parsed = null;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    exitCode = 3;
  }

  const verdict = classify(exitCode, parsed);
  const body = renderBody(parsed, verdict);
  console.log(verdict.subject);
  console.log(body);

  await notify({
    subject: verdict.subject,
    body,
    status: verdict.status,
    agent: 'copy-surface-claims-gate',
  });
}

if (isDirectRun(import.meta.url)) {
  main().catch(async (err) => {
    // Never exit non-zero: the digest is the channel, not cron's mailer.
    console.error(err.message);
    await notify({
      subject: 'Copy-surface claims gate: the gate itself failed',
      body: String(err.stack || err.message),
      status: 'error',
      agent: 'copy-surface-claims-gate',
    }).catch(() => {});
  });
}
