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
import { SKIN_CLUSTER_HANDLES, sanitizePersonas } from './voice-of-customer.js';

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
 * which, today, is all of them except the giveaway pair below. See that function's docstring.
 *
 * `giveawayLive` gates the formats that declare requiresGiveaway (formats.js). It defaults
 * to FALSE, so every existing caller — and every path outside an open Entry Period — gets
 * byte-identical answers to the ones it got before giveaway formats existed. When it is
 * true, `giveaway-entry` precedes `offer-focused` in the table and therefore becomes the
 * PROPOSED format for a product-aware angle, with offer-focused as its alternative; the two
 * share a zone shape on purpose, so that alternative is genuinely one-click selectable.
 */
export function formatsForAngle(angle, formats = FORMATS, { giveawayLive = false } = {}) {
  const want = AWARENESS_TO_FORMAT_AWARENESS[angle?.awareness] ?? null;
  if (!want) return { proposed: null, alternatives: [] };
  const keys = formats
    .filter(f => f.awareness === want && (giveawayLive || !f.requiresGiveaway))
    .map(f => f.key);
  return { proposed: keys[0] ?? null, alternatives: keys.slice(1) };
}

const PRODUCT_WORDS = /\b(soap|bar|lotion|cream|deodorant|toothpaste|balm|wash)\b/gi;

/**
 * Words customers use interchangeably for the same underlying product get grouped into
 * one category: "bar" and "wash" are how a soap gets talked about without ever saying
 * "soap"; "cream" is how a lotion gets talked about without ever saying "lotion". Without
 * this, a decisive word (see angleRelevance below) only ever matches a product whose own
 * title happens to spell it the same way — and the real catalog title for coconut-soap is
 * "Moisturizing Coconut Soap", which contains "soap" but never the literal word "bar".
 */
const PRODUCT_CATEGORY = {
  soap: 'soap', bar: 'soap', wash: 'soap',
  lotion: 'lotion', cream: 'lotion',
  deodorant: 'deodorant',
  toothpaste: 'toothpaste',
  balm: 'balm',
};

function categoriesIn(text) {
  const words = (String(text || '').match(PRODUCT_WORDS) || []).map(w => w.toLowerCase());
  return new Set(words.map(w => PRODUCT_CATEGORY[w]));
}

/**
 * Is this angle about this product?
 *
 * personas.json is cluster-scoped, so without this a lotion-specific angle ("The first
 * lotion that didn't react") would be briefed against bar soap and produce nonsense — at
 * one Opus call apiece.
 *
 * WHAT DECIDES, AND WHY. The label is the angle's subject; `proof` and `objection_addressed`
 * are supporting prose that can name a DIFFERENT product in passing without being about it.
 * The live bug this fixes: "The winter survival cream" (label: cream) was briefed against
 * coconut-soap because its `proof` field happens to mention "hand soap users" as one more
 * data point about who likes the product — pooling all three fields into one set let that
 * incidental mention outvote the label. So:
 *
 *   1. If the label names a product category, THAT decides — full stop. Nothing in proof or
 *      objection_addressed can add to it or override it.
 *   2. Only when the label names nothing do proof and objection_addressed get consulted, and
 *      even then only a category BOTH fields independently name counts as decisive — a
 *      category named in only one of the two is exactly the "mentioned in passing" case this
 *      fix exists to stop trusting. Concretely: p1a1 ("After prescriptions failed") has no
 *      product word in its label or its proof, and its objection_addressed only reaches
 *      "lotion" inside a skeptical customer's rhetorical aside ("...so why would a coconut
 *      lotion?"); with nothing in proof to corroborate it, this must not narrow the angle to
 *      lotion — and, with the old pooled logic, it silently did.
 *   3. If neither step names anything decisive, the angle stays relevant to everything — the
 *      common case and the safe default.
 *
 * Categories, not raw words, are what gets compared on both sides (the angle's decisive set
 * and the product's own handle+title) — see PRODUCT_CATEGORY above.
 */
export function angleRelevance(angle, product) {
  const labelCategories = categoriesIn(angle?.label);
  const decisive = labelCategories.size
    ? labelCategories
    : new Set([...categoriesIn(angle?.proof)].filter(c => categoriesIn(angle?.objection_addressed).has(c)));
  if (!decisive.size) return true;
  const targetCategories = categoriesIn(`${product?.handle || ''} ${product?.title || ''}`);
  return [...decisive].some(c => targetCategories.has(c));
}

/**
 * Flatten every BRIEFABLE persona angle into { persona, angle } pairs. personas.json has no
 * cross-persona angle-id collisions (p1a1, p2a1, ... — the persona id is baked into the
 * angle id), so this list is safe to filter by bare angle id.
 *
 * "Briefable" excludes anything sanitizePersonas removes for a health claim. This is the
 * ONE flattening both the agent's main() and planBriefs() select from, so filtering here is
 * what keeps the dashboard's angle list, the dry-run count and the agent's actual spend
 * agreeing about which angles exist — the same single-source reasoning this whole module
 * exists for. A withheld angle would otherwise be offered in the Briefs tab, cost an Opus
 * call, and then be rejected by ad-studio's health-claims gate with the money already spent.
 */
export function allPersonaAngles(personasData) {
  const { personas } = sanitizePersonas(personasData?.personas || []);
  return personas.flatMap(persona =>
    (persona.angles || []).map(angle => ({ persona, angle }))
  );
}

/**
 * The angle ids allPersonaAngles withheld, so an "unknown angle id" message can say
 * "withheld" instead of "unknown" when an operator names one by hand. Without this the
 * only feedback for `--angles p1a1` on a claim-carrying angle is a message asserting the id
 * does not exist, which sends the reader looking for a typo that is not there.
 */
export function withheldAngleIds(personasData) {
  const live = new Set(allPersonaAngles(personasData).map(pa => pa.angle.id));
  return (personasData?.personas || [])
    .flatMap(p => (p.angles || []).map(a => a?.id))
    .filter(id => id && !live.has(id));
}

/** " (withheld for health claims: p1a1, p1a2)", or "" when none of the missing ids match. */
export function withheldNote(missingIds, personasData) {
  const withheld = new Set(withheldAngleIds(personasData));
  const hit = (missingIds || []).filter(id => withheld.has(id));
  if (!hit.length) return '';
  return ` — ${hit.join(', ')} exist(s) in personas.json but carries a health claim a cosmetic ` +
    `may not make, so it is withheld from briefing; see agents/ad-studio/health-claims.js`;
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
 *
 * `giveawayLive` is passed straight through to formatsForAngle. The caller decides it (the
 * dashboard route reads it from lib/giveaway-claim-source.js, the agent from the same
 * module) rather than this module reading a file, because everything here is a pure function
 * of what it is handed — that is the property that lets the route import it at all. It must
 * be the SAME answer the agent computes, or the panel would promise `offer-focused` and the
 * agent would spend the call on `giveaway-entry`: the exact drift this module exists to stop.
 */
export function planBriefs({ personasData, product, angleIds = [], formats = FORMATS, giveawayLive = false } = {}) {
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
        reason: `unknown angle id(s): ${missing.join(', ')}${withheldNote(missing, personasData)}`,
        angles: [], angleCount: 0, copyCalls: 0,
      };
    }
    selected = angleIds.map(id => byId.get(id));
  } else {
    selected = all.filter(({ angle }) => angleRelevance(angle, product));
  }

  const angles = selected.map(({ persona, angle }) => {
    const { proposed } = formatsForAngle(angle, formats, { giveawayLive });
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
