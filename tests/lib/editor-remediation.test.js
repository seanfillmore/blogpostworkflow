import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isPassing,
  parseEditorBlockers,
  contentBlockers,
  firstBlockerReason,
  formatBlockersForPrompt,
} from '../../lib/editor-remediation.js';

// Real saved editor reports use markdown-bold "**VERDICT:** Needs Work".
const FAILING = `# Editor Report

## 1. TOPICAL RELEVANCE
**VERDICT:** Pass
**NOTES:** On topic.

## 2. INGREDIENT ACCURACY
**VERDICT:** Needs Work
**NOTES:** Lists baking soda but the product spec has no baking soda — correct the ingredient list.

## 3. LINK HEALTH
**VERDICT:** BLOCKER — 2 Broken Links
**NOTES:** Two dead external links in references.

## 4. OVERALL QUALITY
**VERDICT:** Needs Work
**NOTES:** Fix the ingredient list and broken links, then ready.
`;

const PASSING = `# Editor Report

## 1. TOPICAL RELEVANCE
**VERDICT:** Pass
**NOTES:** On topic.

## 2. OVERALL QUALITY
**VERDICT:** Excellent
**NOTES:** Ready to publish.
`;

// ── isPassing: must handle the real **VERDICT:** bold format ───────────────────
test('isPassing returns false for a real bold "Needs Work" report (the gate bug)', () => {
  assert.equal(isPassing(FAILING), false);
});
test('isPassing returns true when nothing is Needs Work', () => {
  assert.equal(isPassing(PASSING), true);
});
test('isPassing tolerates non-bold and extra whitespace', () => {
  assert.equal(isPassing('VERDICT: Needs   Work'), false);
  assert.equal(isPassing('**VERDICT:**  Needs Work — minor'), false);
});
test('isPassing catches the VALUE-bolded "VERDICT: **Needs Work**" format (gate-bypass bug)', () => {
  // The editor emits both styles. The old regex required ** right after the
  // colon, so this value-bolded form slipped through and the gate passed it.
  assert.equal(isPassing('VERDICT: **Needs Work**'), false);
  assert.equal(isPassing('## 2c. Uncited Claims\nVERDICT: **BLOCKER**\n## Overall\nVERDICT: **Needs Work**'), false);
});
test('isPassing on empty/missing report is passing (no report = no blocker)', () => {
  assert.equal(isPassing(''), true);
  assert.equal(isPassing(null), true);
});

// ── parseEditorBlockers ───────────────────────────────────────────────────────
test('parseEditorBlockers extracts only problem sections with their notes', () => {
  const blockers = parseEditorBlockers(FAILING);
  const sections = blockers.map((b) => b.section.toLowerCase());
  assert.ok(sections.includes('ingredient accuracy'));
  assert.ok(sections.includes('link health'));
  assert.ok(sections.includes('overall quality'));
  assert.ok(!sections.includes('topical relevance')); // Pass → excluded
  const ing = blockers.find((b) => /ingredient/i.test(b.section));
  assert.match(ing.note, /baking soda/);
});

// ── contentBlockers: only substance sections the remediator should revise ──────
test('contentBlockers excludes mechanical sections (link health) but keeps content ones', () => {
  const content = contentBlockers(parseEditorBlockers(FAILING)).map((b) => b.section.toLowerCase());
  assert.ok(content.includes('ingredient accuracy'));
  assert.ok(content.includes('overall quality'));
  assert.ok(!content.includes('link health')); // links handled by link-repair, not content revision
});

// ── firstBlockerReason: prefer OVERALL QUALITY note ───────────────────────────
test('firstBlockerReason prefers the OVERALL QUALITY note', () => {
  assert.match(firstBlockerReason(FAILING), /ingredient list and broken links/i);
});
test('firstBlockerReason falls back when no report', () => {
  assert.equal(firstBlockerReason(''), 'See editor report.');
});

// ── formatBlockersForPrompt ───────────────────────────────────────────────────
test('formatBlockersForPrompt lists section + note lines', () => {
  const text = formatBlockersForPrompt(contentBlockers(parseEditorBlockers(FAILING)));
  assert.match(text, /INGREDIENT ACCURACY/i);
  assert.match(text, /baking soda/);
});

// ── reconcileOverallQuality: the summary must not dead-end an otherwise-clean post ──
import { reconcileOverallQuality } from '../../lib/editor-remediation.js';

const REPORT_ONLY_OVERALL_FAILS = `## 4. Year Accuracy
**VERDICT:** Pass
**NOTES:** none

---
## 5. Factual Concerns
**VERDICT:** Pass
**NOTES:** within threshold

---
## 9. Overall Quality
**VERDICT:** Needs Work
**NOTES:** The factual-concerns blocker and year references prevent publication.
`;

test('reconcileOverallQuality: flips Overall to Pass when no concrete section blocks', () => {
  const out = reconcileOverallQuality(REPORT_ONLY_OVERALL_FAILS);
  assert.equal(isPassing(out), true);
  assert.match(out, /OVERALL QUALITY[\s\S]*VERDICT:\*{0,2}\s*Pass/i);
});

const REPORT_REAL_SECTION_BLOCKS = `## 5. Factual Concerns
**VERDICT:** BLOCKER
**NOTES:** 3 uncited claims

---
## 9. Overall Quality
**VERDICT:** Needs Work
**NOTES:** Fix the citations.
`;

test('reconcileOverallQuality: leaves report unchanged when a concrete section blocks', () => {
  const out = reconcileOverallQuality(REPORT_REAL_SECTION_BLOCKS);
  assert.equal(out, REPORT_REAL_SECTION_BLOCKS); // untouched
  assert.equal(isPassing(out), false);           // still fails on Factual Concerns
});

test('reconcileOverallQuality: no-op when Overall already passes', () => {
  const clean = `## 9. Overall Quality\n**VERDICT:** Excellent\n**NOTES:** great\n`;
  assert.equal(reconcileOverallQuality(clean), clean);
});
