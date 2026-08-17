// lib/ad-brief-plan.js
//
// WHICH ANGLES GET BRIEFED, AND FOR WHICH PRODUCTS — the pure decisions that have to give
// the same answer in two places: inside agents/ad-brief/index.js, which acts on them, and
// inside the dashboard's /api/ad-brief routes, which have to TELL THE OPERATOR what a click
// is about to do before it costs anything.
//
// Extracted from agents/ad-brief/index.js on 2026-08-17, and extracted rather than
// re-implemented for two specific reasons:
//
//   1. A second copy would drift. The Briefs tab used to default to whichever product came
//      first out of the manifest — `coconut-oil-deodorant` — which the cluster guard then
//      refused, so the first click on the new tab was always a failed job. The fix is for
//      the browser to be told which products are briefable, computed by the SAME code that
//      does the refusing. A route that re-derived "is this covered" would be one edit away
//      from disagreeing with the agent about it.
//   2. The route cannot simply import the agent. `agents/ad-brief/index.js` pulls in
//      Anthropic and the whole of `agents/ad-studio/index.js` (@google/genai, sharp) at
//      module load, and the dashboard is ONE PM2 process on a 961 MB box serving every tab.
//      Nothing here imports a client or touches the network.
//
// Everything in this module is a pure function of data passed in. `FORMATS` is a static,
// I/O-free data table (agents/ad-studio/formats.js) and is the only import.

import { FORMATS } from '../agents/ad-studio/formats.js';
import { SKIN_CLUSTER_HANDLES } from './voice-of-customer.js';

/**
 * Which product handles each personas.json `cluster` value covers.
 *
 * personas.json carries a top-level `cluster` and NO per-persona product linkage — the
 * only handle list that exists today is voice-of-customer's own SKIN_CLUSTER_HANDLES.
 * Deliberately a closed map: a cluster absent here is a cluster this agent has no
 * evidence for, and it must abort rather than guess.
 */
export const CLUSTER_HANDLES = {
  skin: SKIN_CLUSTER_HANDLES,
};

/**
 * The awareness join.
 *
 * formats.js tags each format problem|solution|product. Persona angles carry the finer
 * five-level scale. `unaware` and `most-aware` map to NULL because no format covers them
 * — 4 of the 15 angles on file are unrenderable today, and by the headroom argument in
 * lib/ad-brief-score.js those are among the most valuable angles we hold. Null is
 * deliberate: mapping them to the nearest format would silently render a broad angle as
 * a narrow one and hide the gap. See the spec's "Known gap".
 */
export const AWARENESS_TO_FORMAT_AWARENESS = {
  'unaware': null,
  'problem-aware': 'problem',
  'solution-aware': 'solution',
  'product-aware': 'product',
  'most-aware': null,
};

/**
 * Which formats can carry this angle. `proposed` is the first match in FORMATS'
 * declaration order, which is curated rather than arbitrary; the rest are offered as
 * alternatives so the operator can override in one click.
 *
 * NOTE that being offered as an alternative is not the same as being SELECTABLE. A brief's
 * copy is written for the proposed format's zone list, and lib/ad-brief.js's
 * selectableFormats/chooseFormat refuse a switch to a format with a different zone shape —
 * which, today, is all of them. See that function's docstring.
 */
export function formatsForAngle(angle, formats = FORMATS) {
  const want = AWARENESS_TO_FORMAT_AWARENESS[angle?.awareness] ?? null;
  if (!want) return { proposed: null, alternatives: [] };
  const keys = formats.filter(f => f.awareness === want).map(f => f.key);
  return { proposed: keys[0] ?? null, alternatives: keys.slice(1) };
}

const PRODUCT_WORDS = /\b(soap|bar|lotion|cream|deodorant|toothpaste|balm|wash)\b/gi;

/**
 * Is this angle about this product?
 *
 * personas.json is cluster-scoped, so without this a lotion-specific angle ("The first
 * lotion that didn't react") would be briefed against bar soap and produce nonsense — at
 * one Opus call apiece. An angle naming NO product word stays relevant to everything,
 * which is the common case and the safe default.
 */
export function angleRelevance(angle, product) {
  const text = `${angle?.label || ''} ${angle?.proof || ''} ${angle?.objection_addressed || ''}`;
  const named = [...new Set((text.match(PRODUCT_WORDS) || []).map(w => w.toLowerCase()))];
  if (!named.length) return true;
  const target = `${product?.handle || ''} ${product?.title || ''}`.toLowerCase();
  return named.some(w => target.includes(w));
}

/**
 * Flatten every persona's angles into { persona, angle } pairs. personas.json has no
 * cross-persona angle-id collisions (p1a1, p2a1, ... — the persona id is baked into the
 * angle id), so this list is safe to filter by bare angle id.
 */
export function allPersonaAngles(personasData) {
  return (personasData?.personas || []).flatMap(persona =>
    (persona.angles || []).map(angle => ({ persona, angle }))
  );
}

/**
 * Is this product covered by the personas we actually hold evidence for? Returns the
 * verdict as DATA rather than as a throw, because the dashboard has to render "this product
 * exists but cannot be briefed, and here is why" for 7 of 11 catalogue products — filtering
 * them out silently would hide the gap, and throwing per product would make the /products
 * route a loop of try/catch.
 *
 * `reason` is operator-facing and always names the remedy.
 */
export function clusterCoverage(handle, personasData, clusterHandles = CLUSTER_HANDLES) {
  const cluster = personasData?.cluster || null;
  const handles = cluster ? clusterHandles[cluster] : undefined;
  if (!handles) {
    return {
      covered: false,
      cluster,
      handles: [],
      reason: `data/context/personas.json declares cluster "${cluster || 'unknown'}", which has no handle list — ` +
        `run agents/voice-of-customer for it before briefing anything.`,
    };
  }
  if (!handles.includes(handle)) {
    return {
      covered: false,
      cluster,
      handles,
      reason: `no voice-of-customer personas cover "${handle}" — data/context/personas.json covers the ` +
        `"${cluster}" cluster (${handles.join(', ')}). Run agents/voice-of-customer for this product's ` +
        `cluster first; briefing never falls back to another cluster's personas and never invents one.`,
    };
  }
  return { covered: true, cluster, handles, reason: null };
}

/**
 * The cluster guard, as the agent enforces it. Extracted to a pure, exported function so it
 * is directly testable — main()'s abort message is exactly this error. Now a thin throw
 * around clusterCoverage() so the abort and the dashboard's "unavailable, because…" label
 * can never disagree.
 *
 * Never falls back to another cluster's personas and never invents one: fabricated audience
 * reasoning underneath a claim-gated ad is what this whole pipeline exists to prevent.
 */
export function assertClusterCoverage(handle, personasData, clusterHandles = CLUSTER_HANDLES) {
  const verdict = clusterCoverage(handle, personasData, clusterHandles);
  if (!verdict.covered) {
    const handles = verdict.handles.length ? verdict.handles.join(', ') : '(no handles for this cluster)';
    throw new Error(
      `ad-brief: "${handle}" is not covered by the "${verdict.cluster || 'unknown'}" cluster's personas ` +
      `(data/context/personas.json covers: ${handles}). ` +
      `Run agents/voice-of-customer for "${handle}"'s cluster before briefing it — this agent never ` +
      `falls back to another cluster's personas and never invents one.`
    );
  }
}

/**
 * WHAT A GENERATE CLICK IS ABOUT TO DO, before it does it.
 *
 * Same selection agents/ad-brief/index.js's main() performs (cluster guard, then either the
 * named `--angles` or every angle passing angleRelevance) and the same per-angle format
 * resolution, so `copyCalls` is exactly the "Would make N Anthropic copy call(s)" line the
 * agent's own --dry-run prints. This is what the Briefs panel shows beside its Generate and
 * Dry run buttons: the cheapest action must be the one you get by accident, and a button
 * that spends Opus money per angle with no number next to it is the opposite of that.
 *
 * Costs nothing to call: no network, no LLM, no disk beyond the personas data handed in.
 */
export function planBriefs({ personasData, product, angleIds = [], formats = FORMATS } = {}) {
  const coverage = clusterCoverage(product?.handle, personasData);
  if (!coverage.covered) {
    return { covered: false, reason: coverage.reason, angles: [], angleCount: 0, copyCalls: 0 };
  }

  const all = allPersonaAngles(personasData);
  let selected;
  if (angleIds.length) {
    const byId = new Map(all.map(pa => [pa.angle.id, pa]));
    const missing = angleIds.filter(id => !byId.has(id));
    if (missing.length) {
      return {
        covered: true,
        reason: `unknown angle id(s): ${missing.join(', ')}`,
        angles: [], angleCount: 0, copyCalls: 0,
      };
    }
    selected = angleIds.map(id => byId.get(id));
  } else {
    selected = all.filter(({ angle }) => angleRelevance(angle, product));
  }

  const angles = selected.map(({ persona, angle }) => {
    const { proposed } = formatsForAngle(angle, formats);
    return {
      angleId: angle.id,
      personaId: persona.id,
      personaName: persona.name || persona.id,
      label: angle.label || null,
      awareness: angle.awareness || null,
      format: proposed,
    };
  });

  return {
    covered: true,
    reason: null,
    angles,
    angleCount: angles.length,
    // One copy call per angle THAT HAS A FORMAT. An angle whose awareness level no format
    // covers is recorded as a brief with no render target and costs nothing — same rule
    // generateBriefs applies, and the same count its --dry-run prints.
    copyCalls: angles.filter(a => a.format).length,
  };
}
