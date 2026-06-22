// lib/editor-remediation.js
//
// Canonical reading of the editor report's verdict — shared by the publisher
// gate, the calendar-runner gate, and the content-remediator. Saved editor
// reports use markdown-bold "**VERDICT:** Needs Work"; the old inline gate regex
// (/VERDICT:\s*Needs Work/i) did NOT match that (the ** broke it), so the gate
// silently passed every post. Centralizing the logic here fixes both gates at
// once and keeps them from drifting apart again.

// A verdict word/phrase that means the section is a problem to fix.
const PROBLEM_VERDICT = /\b(blocker|needs\s+work|fail)\b/i;

// Tolerant "Needs Work" detector. Must match BOTH bold styles the editor emits:
//   **VERDICT:** Needs Work   (label-bolded — the PR #259 case)
//   VERDICT: **Needs Work**   (value-bolded — slipped through the old regex,
//                              which required the ** immediately after the colon,
//                              so the publisher/calendar gates passed blocked posts)
// Mirrors findBlockedPosts() in data-loader.js / daily-summary so the gate and the
// dashboard's blocked list agree on what counts as failing.
const NEEDS_WORK = /VERDICT[:*\s]*needs\s+work/i;

// Sections that represent CONTENT substance the content-remediator can revise.
// Mechanical issues (broken links, stale years, FAQ competitor names, schema)
// are handled by their own repair agents, not by rewriting prose.
const CONTENT_SECTION = /(topical relevance|brand voice|ingredient accuracy|factual|overall quality|cta quality|readability|formatting)/i;

/** Does the report pass the editorial gate? (No section is "Needs Work".) */
export function isPassing(reportMd) {
  return !NEEDS_WORK.test(reportMd || '');
}

/**
 * Extract the problem sections from an editor report.
 * @returns {Array<{section: string, verdict: string, note: string}>}
 */
export function parseEditorBlockers(reportMd) {
  const out = [];
  const re = /^#{2,6}\s+[\d.\s]*([^\n]+?)\s*\n+\*{0,2}VERDICT:\*{0,2}\s*([^\n]+?)\s*\n+\*{0,2}NOTES:\*{0,2}\s*([\s\S]*?)(?=\n#{1,6}\s|$)/gim;
  let m;
  while ((m = re.exec(reportMd || '')) !== null) {
    const section = m[1].trim();
    const verdict = m[2].trim();
    const note = m[3].trim().replace(/\s+/g, ' ');
    if (PROBLEM_VERDICT.test(verdict)) out.push({ section, verdict, note });
  }
  return out;
}

/** Subset of blockers the content-remediator should attempt to fix via revision. */
export function contentBlockers(blockers) {
  return (blockers || []).filter((b) => CONTENT_SECTION.test(b.section));
}

/** A concise human reason for the block — prefer the OVERALL QUALITY note. */
export function firstBlockerReason(reportMd) {
  const blockers = parseEditorBlockers(reportMd);
  if (!blockers.length) return 'See editor report.';
  const overall = blockers.find((b) => /overall quality/i.test(b.section));
  const pick = overall || blockers[0];
  return pick.note || pick.section || 'See editor report.';
}

/** Render blockers as a bullet list for an LLM revision prompt. */
export function formatBlockersForPrompt(blockers) {
  return (blockers || [])
    .map((b) => `- ${b.section.toUpperCase()} [${b.verdict}]: ${b.note}`)
    .join('\n');
}

/**
 * Overall Quality is a SUMMARY, not an independent gate. The LLM routinely marks
 * it "Needs Work" while echoing a concern that a deterministic section already
 * overrode (year accuracy) or that the citation gate governs (factual concerns) —
 * so a post whose every concrete section passes still dead-ends on the summary.
 *
 * This reconciles the report: if NO section other than Overall Quality is a
 * blocker, the Overall verdict is flipped to Pass (with a note). If a real
 * section blocker remains, the report is returned unchanged — the gate fails on
 * that section, as it should. Pure (string in, string out).
 */
export function reconcileOverallQuality(reportMd) {
  if (!reportMd) return reportMd;
  const realBlockers = parseEditorBlockers(reportMd).filter((b) => !/overall quality/i.test(b.section));
  if (realBlockers.length > 0) return reportMd; // a concrete section blocks — leave it

  // No concrete blocker remains. Neutralize an Overall Quality "Needs Work/Fail/
  // BLOCKER" so the summary can't dead-end an otherwise-passing post.
  return reportMd.replace(
    /(#{2,6}\s*[\d.\s]*OVERALL QUALITY[\s\S]*?\n+\*{0,2}VERDICT:\*{0,2}\s*)([^\n]+)/i,
    (m, head, verdict) => (PROBLEM_VERDICT.test(verdict)
      ? `${head}Pass\n**NOTE:** Overall summary reconciled to Pass — every concrete section passes (deterministic checks govern year/citations); no section-level blocker remains.`
      : m),
  );
}
