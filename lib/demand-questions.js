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
 * Derive the seed queries to harvest, from the two empirical sources.
 *
 * GSC leaks are taken highest-impression first: those are questions Google already
 * believes we answer and users already decline to click, so they carry the most signal
 * per call. Persona objections round-robin ACROSS personas rather than concatenating —
 * personas.json is rank-ordered, so a straight concat would spend the entire budget on
 * persona 1 and never reach the rest.
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

  // Sort a copy — never mutate the caller's leaks array in place.
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

  return { seeds: [...leakSeeds, ...personaSeeds].slice(0, SEED_CAP), partial };
}
