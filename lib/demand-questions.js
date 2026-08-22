// lib/demand-questions.js
//
// The pure brain for agents/demand-miner. No I/O, no network, no LLM — the same
// split lib/voice-of-customer.js and lib/seo-opportunities.js use, so all logic here
// is testable without stubbing anything.
//
// NOTE for future edits: this file grows a top-of-file import block later (Task 4
// needs AWARENESS_LEVELS from ./voice-of-customer.js). Add imports here, not wherever
// a later append lands.

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
