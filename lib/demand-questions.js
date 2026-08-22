// lib/demand-questions.js
//
// The pure brain for agents/demand-miner. No I/O, no network, no LLM — the same
// split lib/voice-of-customer.js and lib/seo-opportunities.js use, so all logic here
// is testable without stubbing anything.
//
// AWARENESS_LEVELS is imported, not redefined: this artifact exists to join to
// data/context/personas.json on `stage` and `persona_id`, and a second copy of the
// vocabulary would drift and break that join silently. The import is still pure —
// lib/voice-of-customer.js's only import (agents/ad-studio/health-claims.js) is
// itself I/O-free, and AWARENESS_LEVELS is a plain array constant with no
// module-scope side effects anywhere in that chain.

import { AWARENESS_LEVELS } from './voice-of-customer.js';

/**
 * Hard ceiling on seeds per run. Cost is ONE paid DataForSEO SERP call per seed, and
 * this agent runs unattended from cron. Without the cap a bad GSC week — a spike in
 * zero-click queries — silently becomes hundreds of paid calls nobody authorised.
 */
export const SEED_CAP = 40;

/**
 * Per-origin reserve, derived from SEED_CAP rather than hardcoded so a future change
 * to the cap keeps both halves consistent.
 *
 * A real gsc-query-miner run yields ~253 impression leaks against this 40-seed cap
 * (measured on the production server: `gsc-query-mining-report.md` reported "showing
 * 30 of 253"; `untapped-candidates.json` carried 116 entries). Cap applied naively to
 * `[...leakSeeds, ...personaSeeds]` — leaks first — means leaks alone fill all 40
 * seeds on every real run: persona_objection is starved to zero, every seed carries
 * `persona_id: null`, and the persona join on stage + persona_id — the entire reason
 * this artifact exists, called "the funnel matrix in embryo" in the spec — never
 * populates. Reserving each origin half the cap, with unused reserve flowing to the
 * other side, guarantees personas always get a share when they have anything to
 * offer, while a thin source still never wastes the ceiling.
 */
export const LEAK_RESERVE = Math.floor(SEED_CAP / 2);
export const PERSONA_RESERVE = SEED_CAP - LEAK_RESERVE;

/**
 * Derive the seed queries to harvest, from the two empirical sources.
 *
 * GSC leaks are taken highest-impression first: those are questions Google already
 * believes we answer and users already decline to click, so they carry the most signal
 * per call. Persona objections round-robin ACROSS personas rather than concatenating —
 * personas.json is rank-ordered, so a straight concat would spend the entire budget on
 * persona 1 and never reach the rest.
 *
 * The cap is enforced as a reserve per origin (LEAK_RESERVE / PERSONA_RESERVE), not a
 * single ordered slice: each origin's full deduped list is built first, each is capped
 * at its own reserve, and only if a reserve goes unused (the source is thinner than its
 * half) does the leftover budget flow to whichever origin still has entries beyond its
 * reserve. This is what stops an abundant leak feed from starving personas outright.
 *
 * Missing either source is a degradation, never a failure: `partial` is set and the run
 * continues on whatever is available. Both missing yields no seeds, which the caller
 * treats as "nothing to do", not as an error.
 */
export function deriveSeeds({ leaks, personas } = {}) {
  const haveLeaks = Array.isArray(leaks) && leaks.length > 0;
  const havePersonas = Array.isArray(personas) && personas.length > 0;
  const partial = !haveLeaks || !havePersonas;

  const seen = new Set();
  const take = (text) => {
    const t = typeof text === 'string' ? text.trim() : '';
    if (!t) return null;
    const key = t.toLowerCase();
    if (seen.has(key)) return null;
    seen.add(key);
    return t;
  };

  // Sort a copy — never mutate the caller's leaks array in place. Dedup (`take`) is
  // shared across both origins below, so a query appearing as both a leak and an
  // objection consumes only one seed.
  const leakSeeds = (haveLeaks ? [...leaks] : [])
    .sort((a, b) => b.impressions - a.impressions)
    .map((l) => take(l.query))
    .filter(Boolean)
    .map((text) => ({ text, origin: 'gsc_leak', personaId: null }));

  // Round-robin: one objection from each persona per pass, until all are exhausted.
  const queues = (havePersonas ? personas : []).map((p) => ({
    id: p.id,
    objections: (p.angles || []).map((a) => a && a.objection_addressed),
  }));
  const personaSeeds = [];
  for (let i = 0; queues.some((q) => i < q.objections.length); i++) {
    for (const q of queues) {
      if (i >= q.objections.length) continue;
      const text = take(q.objections[i]);
      if (text) personaSeeds.push({ text, origin: 'persona_objection', personaId: q.id });
    }
  }

  // Reserve each origin its half, then let unused reserve flow to whichever source
  // still has unused entries, until the cap is reached or both are exhausted.
  const leakTaken = leakSeeds.slice(0, LEAK_RESERVE);
  const personaTaken = personaSeeds.slice(0, PERSONA_RESERVE);

  const leakLeftover = leakSeeds.slice(LEAK_RESERVE);
  const personaLeftover = personaSeeds.slice(PERSONA_RESERVE);

  let remaining = SEED_CAP - leakTaken.length - personaTaken.length;
  const leakTopUp = leakLeftover.slice(0, remaining);
  remaining -= leakTopUp.length;
  const personaTopUp = personaLeftover.slice(0, remaining);

  const seeds = [...leakTaken, ...leakTopUp, ...personaTaken, ...personaTopUp].slice(0, SEED_CAP);

  return { seeds, partial };
}

/**
 * Fold every harvested SERP into one deduped question list.
 *
 * `seen_count` is how many DISTINCT SEEDS surfaced the same question — a crude but real
 * importance signal. The same question twice from one seed counts once; the same question
 * from two seeds counts twice. Attribution belongs to the first seed that surfaced it,
 * so a question stays traceable to where it was found.
 */
export function normalizeHarvest(harvestResults = []) {
  const byKey = new Map();

  for (const { seed, paa = [], relatedSearches = [] } of harvestResults) {
    const seedSeen = new Set();
    for (const item of [...paa, ...relatedSearches]) {
      const text = typeof item?.question === 'string' ? item.question.trim() : '';
      if (!text) continue;
      const key = text.toLowerCase().replace(/\s+/g, ' ');
      if (seedSeen.has(key)) continue;   // same seed, same question — one vote
      seedSeen.add(key);

      const existing = byKey.get(key);
      if (existing) { existing.seen_count += 1; continue; }
      byKey.set(key, {
        text,
        source: item.source,
        seed: seed.text,
        seed_origin: seed.origin,
        persona_id: seed.personaId ?? null,
        seen_count: 1,
      });
    }
  }

  return [...byKey.values()];
}

/**
 * Reject any stage outside the five awareness levels.
 *
 * The levels are IMPORTED from lib/voice-of-customer.js, never redefined here: this
 * artifact's whole purpose is to join to personas.json on `stage` and `persona_id`, and
 * a second copy of the vocabulary would drift and break that join silently.
 */
export function validateQuestions(questions = []) {
  for (const q of questions) {
    if (!AWARENESS_LEVELS.includes(q.stage)) {
      throw new Error(
        `invalid stage ${JSON.stringify(q.stage)} for question ${JSON.stringify(q.text)} — expected one of ${AWARENESS_LEVELS.join(', ')}`,
      );
    }
  }
  return questions;
}

/**
 * Render the human-readable, greppable artifact.
 *
 * Two rules carried from voice-of-customer.md, both for the benefit of someone grepping:
 * headings are STABLE across runs, and every entry is SELF-CONTAINED — a single grep hit
 * carries its stage, source, seed, persona and count without needing the lines around it.
 * Stages render in funnel order (AWARENESS_LEVELS), not alphabetically, so the document
 * reads from least to most aware.
 */
export function renderDemandQuestionsMarkdown({ questions = [], generatedAt, cluster, seedCount, partial } = {}) {
  const lines = [
    '# Demand questions',
    '',
    `Generated: ${generatedAt}`,
    `Cluster: ${cluster}`,
    `Seeds harvested: ${seedCount}`,
    `Partial run: ${partial ? 'yes' : 'no'}`,
    '',
    'What people ask before they know we exist. Harvested from Google People Also Ask',
    'and related searches, seeded from GSC impression leaks and persona objections.',
    'Grouped by funnel stage; `seen_count` is how many distinct seeds surfaced the same',
    'question.',
    '',
  ];

  for (const stage of AWARENESS_LEVELS) {
    const inStage = questions.filter((q) => q.stage === stage);
    if (inStage.length === 0) continue;
    lines.push(`## ${stage} (${inStage.length})`, '');
    // Highest-signal question first: seen_count is how many distinct seeds surfaced it.
    for (const q of [...inStage].sort((a, b) => b.seen_count - a.seen_count)) {
      const persona = q.persona_id ? `persona ${q.persona_id}` : 'no persona';
      // Collapse all whitespace runs — including \n and \r\n — to single spaces. q.text
      // and q.seed are arbitrary text (PAA/related-search questions, GSC queries, and
      // LLM-generated persona objections) with no newline guard upstream: normalizeHarvest
      // only collapses whitespace for its dedup key, never for the stored text. Left raw,
      // an embedded newline turns one entry into multiple physical lines — breaking the
      // self-contained-entry rule — or, worse, forges a fake "## "/"- **" line that
      // corrupts a structural grep of the whole document. String(...) so a non-string
      // value can't throw here, this late in a run.
      const text = String(q.text).replace(/\s+/g, ' ');
      const seed = String(q.seed).replace(/\s+/g, ' ');
      lines.push(`- **${text}** — stage: ${stage} · source: ${q.source} · seed: "${seed}" (${q.seed_origin}) · ${persona} · seen_count: ${q.seen_count}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
