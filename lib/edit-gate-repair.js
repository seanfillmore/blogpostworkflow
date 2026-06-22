// lib/edit-gate-repair.js
//
// Canonical editorial-gate repair loop — shared by the daily pipeline
// (calendar-runner) and the dashboard's "Fix blockers" action so the two never
// drift. Reads the editor report, routes each blocker reason to the repair
// agent that can actually fix it, re-runs the editor, and loops a few times
// before giving up (never auto-kills).
//
// The same philosophy as lib/editor-remediation.js: one place decides what a
// blocker means and how to fix it, imported everywhere, so a fix in the pipeline
// is the same fix the dashboard offers.

import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { getEditorReportPath, ROOT } from './posts.js';
import { isPassing, firstBlockerReason, parseEditorBlockers } from './editor-remediation.js';

/**
 * Map a blocker reason (the human sentence from the editor report) to the repair
 * agent command(s) that can address it. Pure routing — no side effects.
 * @returns {Array<{label: string, cmd: string}>}
 */
export function repairCommandsFor(slug, reason) {
  const lower = (reason || '').toLowerCase();
  const repairs = [];

  if (lower.includes('competitor') || lower.includes('brand name') || lower.includes('brand guideline')) {
    repairs.push({ label: 'faq-rewriter', cmd: `node agents/faq-rewriter/index.js --slug ${slug}` });
  }
  if (lower.includes('internal link') || lower.includes('orphan') || lower.includes('cross-link')) {
    repairs.push({ label: 'internal-linker', cmd: `node agents/internal-linker/index.js --slug ${slug}` });
  }
  // Uncited health/statistical claims (the YMYL credibility gate) — find and add
  // verified authoritative citations. content-remediator below then softens any
  // residual claims citation-finder couldn't source.
  if (lower.includes('unsourced') || lower.includes('uncited') || lower.includes('citation')
      || lower.includes('credibility') || (lower.includes('lack') && lower.includes('source')) || lower.includes('claim')) {
    repairs.push({ label: 'citation-finder', cmd: `node agents/citation-finder/index.js --slug ${slug}` });
  }
  if (lower.includes('answer') || lower.includes('answer-first')) {
    repairs.push({ label: 'answer-first-rewriter', cmd: `node agents/answer-first-rewriter/index.js ${slug}` });
  }
  if (lower.includes('broken link') || lower.includes('404')) {
    repairs.push({ label: 'link-repair', cmd: `node agents/link-repair/index.js ${slug}` });
  }
  if (lower.includes('schema') || lower.includes('structured data')) {
    repairs.push({ label: 'schema-injector', cmd: `node agents/schema-injector/index.js --slug ${slug}` });
  }
  // Content-substance blockers (ingredient accuracy, brand voice, topical
  // relevance, factual concerns, generic "needs work") — the mechanical repairs
  // above can't fix prose, so revise the content to address what the editor flagged.
  if (lower.includes('ingredient') || lower.includes('voice') || lower.includes('topical')
      || lower.includes('factual') || lower.includes('accuracy') || lower.includes('overstated')
      || lower.includes('tone') || lower.includes('readability')) {
    repairs.push({ label: 'content-remediator', cmd: `node agents/content-remediator/index.js --slug ${slug}` });
  }

  // Fallback: if no specific repair matched the reason, revise the content
  // (a content-remediator pass is the broadest single fix).
  if (repairs.length === 0) {
    repairs.push({ label: 'content-remediator', cmd: `node agents/content-remediator/index.js --slug ${slug}` });
  }

  return repairs;
}

/** Read the editor report's verdict for a post. */
export function checkEditGate(slug) {
  const reportPath = getEditorReportPath(slug);
  if (!existsSync(reportPath)) return { pass: true };
  const report = readFileSync(reportPath, 'utf8');
  if (!isPassing(report)) return { pass: false, reason: firstBlockerReason(report) };
  return { pass: true };
}

// Default command runner: execute synchronously, inheriting stdio. Callers that
// need dry-run, log capture, or SSE streaming pass their own `run`.
function defaultRun(cmd, label, { log }) {
  log(`  ▶  ${label}`);
  try {
    execSync(cmd, { stdio: 'inherit', cwd: ROOT });
    return true;
  } catch (err) {
    log(`  ✗  ${label} failed (exit ${err.status})`);
    return false;
  }
}

/**
 * Run the repair agents matched to a blocker reason, then re-run the editor.
 * @param {object} opts
 * @param {(cmd:string,label:string,ctx:{log:Function})=>boolean} [opts.run] runner
 * @param {Function} [opts.log] logger
 */
export function attemptRepair(slug, reason, { run = defaultRun, log = console.log } = {}) {
  // Route on EVERY concrete section blocker, not just the single `reason`. The
  // `reason` is firstBlockerReason(), which prefers the OVERALL QUALITY summary —
  // a vague sentence ("two blockers that must be resolved") that lacks the
  // keywords repairCommandsFor() matches on, so it fell through to the
  // content-remediator fallback and never ran link-repair / citation-finder for a
  // 404 CTA or uncited claims. Parsing all sections fixes the targeting.
  const reportPath = getEditorReportPath(slug);
  const report = existsSync(reportPath) ? readFileSync(reportPath, 'utf8') : '';
  const blockers = parseEditorBlockers(report).filter((b) => !/overall quality/i.test(b.section));

  // Build a deduped command list from each blocker's section + note.
  const byLabel = new Map();
  const sources = blockers.length ? blockers.map((b) => `${b.section} ${b.note}`) : [reason];
  for (const src of sources) {
    for (const r of repairCommandsFor(slug, src)) {
      if (!byLabel.has(r.label)) byLabel.set(r.label, r);
    }
  }
  const repairs = [...byLabel.values()];
  log(`  🔧 Attempting ${repairs.length} repair(s): ${repairs.map((r) => r.label).join(', ')}`);
  for (const { label, cmd } of repairs) {
    run(cmd, `repair (${label}): ${slug}`, { log });
  }
  run(`node agents/editor/index.js data/posts/${slug}/content.html`, `edit (re-check): ${slug}`, { log });
}

/**
 * Run the editorial gate, auto-repairing up to maxAttempts times before giving
 * up. Each attempt revises the post and re-runs the editor; escalate to a human
 * after repeated failure — never auto-kill.
 * @returns {{gate: {pass:boolean, reason?:string}, attempts:number}}
 */
export function runEditGateWithRepair(slug, { maxAttempts = 3, run, log = console.log } = {}) {
  let gate = checkEditGate(slug);
  let attempts = 0;
  while (!gate.pass && attempts < maxAttempts) {
    attempts += 1;
    log(`  🔧 Editorial repair attempt ${attempts}/${maxAttempts}: ${gate.reason}`);
    attemptRepair(slug, gate.reason, { run, log });
    gate = checkEditGate(slug);
  }
  return { gate, attempts };
}
