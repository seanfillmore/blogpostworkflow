// agents/ad-studio/copy.js
//
// Stage 2: exact per-zone ad copy plus the claim metadata the gate in claims.js checks.
// Copy is where revenue is made, so this runs on the flagship model.

/**
 * @param {{format:object, product:object, pdpBody:string, persona?:object, tactics?:string[]}} args
 * @returns {string}
 */
export function buildCopyPrompt({ format, product, pdpBody, persona, tactics }) {
  const zoneList = format.zones.map(z => `  - ${z}`).join('\n');
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
  The evidence must appear verbatim in that source; it is checked before anything renders and
  there is no override.
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
export function parseCopyResponse(raw) {
  const obj = extractJson(raw);
  if (!obj) throw new Error('ad-studio: could not parse copy response as JSON');
  if (!obj.zones || typeof obj.zones !== 'object') throw new Error('ad-studio: copy response missing "zones"');
  if (!Array.isArray(obj.claims)) throw new Error('ad-studio: copy response missing "claims"');
  return { zones: obj.zones, claims: obj.claims };
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
