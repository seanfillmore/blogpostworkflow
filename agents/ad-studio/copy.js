// agents/ad-studio/copy.js
//
// Stage 2: exact per-zone ad copy plus the claim metadata the gate in claims.js checks.
// Copy is where revenue is made, so this runs on the flagship model.

/**
 * @param {{format:object, product:object, pdpBody:string, persona?:object, tactics?:string[]}} args
 * @returns {string}
 */
export function buildCopyPrompt({ format, product, pdpBody, persona, tactics }) {
  const zoneList = format.zones
    .map(z => {
      const cap = format.zoneCapacity?.[z];
      return cap ? `  - ${z} (maximum ${cap} items — the layout cannot carry more)` : `  - ${z}`;
    })
    .join('\n');
  return `You are writing the copy for a single static ad for Real Skin Care.

FORMAT: ${format.key} — ${format.name}
AWARENESS LEVEL: ${format.awareness}
LAYOUT: ${format.layoutBrief}

PRODUCT: ${product.title} (${product.handle}) — ${product.priceLabel}

PRODUCT PAGE COPY (a source you may cite as "pdp"):
${pdpBody}

${persona ? `BUYER: ${persona.name}\nWHAT THEY ALREADY TRIED: ${(persona.angles || []).join('; ')}` : ''}

${tactics && tactics.length ? `COPY TACTICS AVAILABLE:\n${tactics.map(t => `  - ${t}`).join('\n')}` : ''}

Fill exactly these zones:
${zoneList}

RULES:
- Write the literal strings that will be rendered into the image. No placeholders.
- Headlines are short enough to read at phone size in one second.
- Never claim a manufacturing origin other than "made in the USA".
- Do not invent counts, percentages, volumes, timeframes, awards or third-party endorsements.
- EVERY factual statement must be traceable. For each, set factual: true, name a sourceId
  from: pdp, catalog, brandKit, reviews — and quote the exact supporting phrase in evidence.
  The evidence must be a CONTIGUOUS, VERBATIM SUBSTRING copied from that ONE named source —
  never assembled, never joined from two places, never reworded, and never spanning two
  separate facts. It is checked before anything renders, by exact substring match, and
  there is no override — a paraphrased or synthesized quote fails the gate and stops the
  run entirely, including every OTHER concept's copy already written.
- If an ad line combines two facts (e.g. an ingredient count AND a price), split it into
  TWO claims in the claims array, each with its own sourceId and its own verbatim evidence
  quote — one claim per fact, never one evidence string built by concatenating both. For
  example "6 CLEAN INGREDIENTS — $30" is two claims: the ingredient count sourced against
  catalog with its own quote, and the price sourced against catalog with its own separate
  quote — not one evidence string joining a title fragment and a price with a dash.
- Pure persuasion with no factual assertion is fine: set factual: false and omit sourceId.

Respond with JSON only, no commentary:
{
  "zones": { ${format.zones.map(z => `"${z}": ...`).join(', ')} },
  "claims": [
    { "zone": "...", "text": "...", "factual": true, "sourceId": "pdp", "evidence": "..." }
  ]
}
Zones that hold a list (items, rows) take an array of strings; all others take a string.`;
}

/** Pull a JSON object out of a raw model response that may be fenced or chatty. */
function extractJson(raw) {
  const s = String(raw || '').trim();
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : s;
  try {
    return JSON.parse(candidate);
  } catch {
    const first = candidate.indexOf('{');
    const last = candidate.lastIndexOf('}');
    if (first !== -1 && last > first) {
      try { return JSON.parse(candidate.slice(first, last + 1)); } catch { /* fall through */ }
    }
    return null;
  }
}

/**
 * @param {string} raw
 * @returns {{zones:Record<string,string|string[]>, claims:object[]}}
 */
export function parseCopyResponse(raw, format = null) {
  const obj = extractJson(raw);
  if (!obj) throw new Error('ad-studio: could not parse copy response as JSON');
  if (!obj.zones || typeof obj.zones !== 'object') throw new Error('ad-studio: copy response missing "zones"');
  if (!Array.isArray(obj.claims)) throw new Error('ad-studio: copy response missing "claims"');

  // EMPTY IS NOT VALID COPY. The shape was checked and the content never was, so a
  // response of {"headline": "", "attribution": "", "trustLine": ""} sailed through: the
  // claim gate had zero claims to validate and therefore trivially passed, three plates
  // were rendered and paid for, and the comp pass filled the vacuum by INVENTING ad copy
  // ("Real Skin Care for Real People") that no source had ever supported.
  //
  // That is the worst failure mode available to this pipeline — the claim gate exists
  // precisely to stop unsourced copy, and an empty response walks around it rather than
  // through it. It happened on `testimonial`, whose entire purpose is quoting a real
  // customer (2026-08-16).
  //
  // Throwing here is right and cheap: nothing has been rendered yet at this point, so the
  // cost is one wasted copy call rather than three wasted image calls plus an ad nobody
  // can use. buildConcepts isolates it to the one concept, so the rest of the run stands.
  const zones = obj.zones;
  const declared = Array.isArray(format?.zones) && format.zones.length ? format.zones : Object.keys(zones);
  const empty = declared.filter(z => {
    const v = zones[z];
    if (Array.isArray(v)) return v.filter(x => String(x ?? '').trim()).length === 0;
    return !String(v ?? '').trim();
  });
  if (empty.length) {
    throw new Error(
      `ad-studio: copy response has empty zone(s): ${empty.join(', ')}. An empty zone is not ` +
      `copy — it renders a blank ad and gives the claim gate nothing to check, so the comp ` +
      `pass invents text instead. Refusing before anything is rendered.`
    );
  }

  return { zones, claims: obj.claims };
}

/**
 * Hard cap on array-valued zones, applied AFTER the copy call as a backstop to the
 * capacity hint buildCopyPrompt already puts in front of the model. The prompt is a
 * request; this is the enforcement — a model that ignores the instruction (or asks
 * for more anyway) must not be able to push an over-long list into a paid render.
 *
 * Real incident this fixes: a format asked for 6 listItems and 4 bottomBar items:
 * the layout only had room for 4 and 3 respectively, so the image model rendered a
 * short list and silently rewrote the bottom bar, dropping several factual strings
 * that had already cleared the claim gate. The verification gate correctly rejected
 * every attempt — three paid renders burned per target for copy the layout could
 * never have carried in the first place.
 *
 * String-valued zones and zones with no declared capacity are returned unchanged.
 * Every truncation is logged — a silent one reads as full coverage when it isn't.
 *
 * @param {Record<string,string|string[]>} zones
 * @param {{key:string, zoneCapacity?:Record<string,number>}} format
 * @returns {{zones:Record<string,string|string[]>, dropped:{zone:string, items:string[]}[]}}
 */
export function enforceZoneCapacity(zones, format) {
  const capacities = format?.zoneCapacity;
  if (!capacities) return { zones, dropped: [] };

  const outZones = { ...zones };
  const dropped = [];

  for (const [zone, cap] of Object.entries(capacities)) {
    const value = outZones[zone];
    if (!Array.isArray(value) || value.length <= cap) continue;

    const kept = value.slice(0, cap);
    const removed = value.slice(cap);
    outZones[zone] = kept;
    dropped.push({ zone, items: removed });

    console.warn(
      `ad-studio: truncated zone "${zone}" for format "${format.key}" from ${value.length} ` +
      `to ${cap} item(s) — the layout cannot carry more. Dropped: ${JSON.stringify(removed)}`
    );
  }

  return { zones: outZones, dropped };
}

/**
 * Flatten zone values into the ordered list of strings that should appear in the render.
 * Consumed by the verification gate.
 * @param {Record<string,string|string[]>} zones
 * @returns {string[]}
 */
export function expectedStrings(zones) {
  const out = [];
  for (const value of Object.values(zones || {})) {
    if (Array.isArray(value)) out.push(...value.filter(v => typeof v === 'string' && v.trim()));
    else if (typeof value === 'string' && value.trim()) out.push(value);
  }
  return out;
}
