// lib/operator-angles.js
//
// THE OPERATOR'S OVERLAY ON GENERATED PERSONA RESEARCH.
//
// `data/context/personas.json` is RESEARCH — written monthly by agents/voice-of-customer
// from real reviews and Reddit threads. Two things an operator legitimately needs to do to
// it cannot be done by editing it:
//
//   1. RETIRE an angle that is wrong or unusable.
//   2. ADD an angle the operator authored deliberately, rather than one mined from customers.
//
// Editing personas.json for either is wrong twice over. It is overwritten on the next
// monthly run, so the change silently reverts; and it makes authored copy indistinguishable
// from mined evidence inside the file every downstream reader treats as evidence. That
// second one is the same principle sanitizePersonas is built on — it REMOVES a violating
// angle and never rewrites one, because an agent editing research is the agent inventing
// research. An operator hand-editing it has the same effect on the file's meaning.
//
// So the overlay lives in its own file with its own provenance, and is applied at LOAD —
// the two places that read personas.json (agents/ad-brief's main() and the dashboard's
// ad-brief route) each hand the result straight to the existing consumers. Overlaying at
// load rather than at the flatten in allPersonaAngles() is deliberate: it needs no signature
// change anywhere, so there is no call site that can forget to pass it and silently serve a
// retired angle. Everything downstream — the flatten, planBriefs, the dry-run count, the
// dashboard's angle list — sees one already-overlaid object.
//
// WHAT THIS DOES NOT DO: it never edits an angle. There is no "patch the proof field"
// operation, because a half-authored, half-mined angle is exactly the ambiguity above. An
// angle is generated research or it is authored by a person, and `authored: true` records
// which on every angle this file adds.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const OVERLAY_RELPATH = ['data', 'context', 'operator-angles.json'];

/**
 * Read the overlay. A MISSING file is the normal no-overlay case and yields empty lists;
 * a malformed one throws, because a JSON syntax error silently degrading to "no
 * retirements" would quietly re-enable an angle somebody deliberately retired.
 */
export function loadOperatorAngles({ root, relpath = OVERLAY_RELPATH } = {}) {
  let raw;
  try {
    raw = readFileSync(join(root, ...relpath), 'utf8');
  } catch {
    return { retired: [], angles: [] };
  }
  const parsed = JSON.parse(raw);
  return { retired: parsed.retired || [], angles: parsed.angles || [] };
}

/**
 * Apply the overlay to loaded personas data, returning a NEW object.
 *
 * Retirement is by angle id and runs FIRST, so an overlay may retire an id and add a
 * replacement carrying different content in the same pass.
 *
 * An authored angle names the persona it belongs to. An unknown `personaId` THROWS rather
 * than being skipped: the failure mode of skipping is an operator authoring an angle,
 * seeing no error, and never learning it was dropped — while the run they were watching
 * spends money briefing everything except the thing they just wrote.
 */
export function applyOperatorOverlay(personasData, overlay) {
  const { retired = [], angles = [] } = overlay || {};
  if (!retired.length && !angles.length) return personasData;

  const retiredIds = new Set(retired.map(r => (typeof r === 'string' ? r : r?.id)).filter(Boolean));
  const byPersona = new Map();
  for (const a of angles) {
    if (!a?.personaId) throw new Error(`operator-angles: authored angle "${a?.id ?? '(no id)'}" is missing personaId`);
    if (!byPersona.has(a.personaId)) byPersona.set(a.personaId, []);
    byPersona.set(a.personaId, [...byPersona.get(a.personaId), { ...a, authored: true }]);
  }

  const known = new Set((personasData?.personas || []).map(p => p.id));
  for (const personaId of byPersona.keys()) {
    if (!known.has(personaId)) {
      throw new Error(
        `operator-angles: authored angle names persona "${personaId}", which is not in personas.json ` +
        `(known: ${[...known].join(', ') || 'none'}). The monthly voice-of-customer run may have renumbered ` +
        `the personas — re-point the angle rather than leaving it silently unbriefed.`
      );
    }
  }

  return {
    ...personasData,
    personas: (personasData?.personas || []).map(persona => {
      const kept = (persona.angles || []).filter(a => !retiredIds.has(a?.id));
      const added = byPersona.get(persona.id) || [];
      if (kept.length === (persona.angles || []).length && !added.length) return persona;
      return { ...persona, angles: [...kept, ...added] };
    }),
  };
}

/**
 * Load and apply in one call — what both personas.json readers actually want.
 */
export function overlayPersonas(personasData, { root } = {}) {
  if (!personasData) return personasData;
  return applyOperatorOverlay(personasData, loadOperatorAngles({ root }));
}
