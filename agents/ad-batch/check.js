// agents/ad-batch/check.js
//
// One vision read per render, then a deterministic verdict. The model only
// TRANSCRIBES and COUNTS; every pass/fail decision is made here in code, because an
// LLM asked "is the spelling right?" auto-corrects on the way out (CLAUDE.md: Haiku
// passed "TTHAN THE FORMLA").
//
// What fails a render (Sean, 2026-10-06: "flexible while not being deceptive"):
//   - the headline/subhead words are not all there, in order, spelled right
//   - the product's NAME lines on the label are wrong (brand, product name, scent)
//   - the wrong number of OUR product, or the product clearly does not match the photos
//   - invented claims in extra text: review counts, stars, "dermatologist tested", ...
//   - a clearly malformed hand
// What does NOT fail: other generic products or props, prop text, tiny volume/URL
// print, garbled micro rim text.

import { checkSeoCopyFields, COMMERCIAL_SURFACE } from '../../lib/seo-copy-health-gate.js';

export function tokens(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[‘’‛′]/g, "'")
    .replace(/'/g, '')
    .split(/[^a-z0-9+]+/)
    .filter(Boolean);
}

/** Index where `needle` occurs as a contiguous run inside `hay`, or -1. */
export function findRun(hay, needle) {
  if (!needle.length) return 0;
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

/** Label strings that must read right: words, not volume figures or URLs. */
export function requiredLabelStrings(labelStrings) {
  return labelStrings.filter(s => !/\d/.test(s) && !/\.(com|net|co)\b/i.test(s));
}

const INVENTED_CLAIM_RE = /(\b\d[\d,]*\s*\+?\s*(five[- ]star\s*)?(reviews?|ratings?|stars?|customers?)\b|★|\bfive[- ]stars?\b|\bdermatologist|\bclinical|\bcertified\b|\btested\b|\baward|#\s*1\b|\bbest[- ]?sell|\bguarantee|\d+\s*%|\$\s*\d|\bfda\b)/i;

export function inventedClaims(extraText) {
  const hits = [];
  const t = String(extraText || '');
  const m = t.match(INVENTED_CLAIM_RE);
  if (m) hits.push(`invented claim "${m[0].trim()}"`);
  const gate = checkSeoCopyFields({ text: t }, { surface: COMMERCIAL_SURFACE });
  for (const b of gate.blocking) hits.push(`"${b.match}" (${b.why})`);
  return hits;
}

const isSet = (product) => Array.isArray(product?.items) && product.items.length > 1;

/** The check for a SET: one reference image per product, then the ad; each product read on its own. */
function setCheckPrompt(product) {
  const n = product.items.length;
  const refs = product.items.map((p, i) => `Image ${i + 1} is a REFERENCE photo of product ${i + 1}: ${p.title}.`).join('\n');
  return `${refs}
Image ${n + 1} is an AD to check. It should show these ${n} products together, one of each.

Answer about Image ${n + 1} ONLY, as JSON, transcribing letter by letter exactly as rendered. Do NOT correct spelling, do NOT fill in words you cannot see.

{
  "lettering": ["every line of text in the ad that is NOT printed on one of our products, in reading order"],
  "products": [
${product.items.map((p, i) => `    { "product": ${i + 1}, "count": <how many units of the product in Image ${i + 1} appear>, "label_text": ["every line printed on that product's label, as rendered; [] if not visible"], "matches_reference": "MATCH" | "MISMATCH" | "CANNOT_TELL", "mismatch_reason": "<if MISMATCH: what differs in shape, closure, color, label layout or graphics; else empty>" }`).join(',\n')}
  ],
  "hands_present": true | false,
  "hand_defect": "<describe any clearly malformed hand (extra or missing fingers, fused or impossible anatomy); else empty>"
}

Give exactly ${n} entries in "products", in the order of the reference images. Count only units of OUR products; ignore other generic bottles, jars or props. "matches_reference" is about the physical product only: shape, closure, color, label LAYOUT and graphics. Lighting, gloss and angle differences are never a mismatch, and neither is tiny print (curved rim text, small circular badges, addresses, fine print, volume figures), which nobody can read at ad size. Answer with the JSON only.`;
}

export function checkPrompt({ product, shown }) {
  if (isSet(product)) return setCheckPrompt(product);
  const what = shown === 'unwrapped'
    ? 'a bare, unlabelled bar of soap like the one in the REFERENCE photo'
    : `the Real Skin Care product shown in the REFERENCE photo (${product.title})`;
  return `Image 1 is a REFERENCE photo of our product. Image 2 is an AD to check.

Answer about Image 2 ONLY, as JSON, transcribing letter by letter exactly as rendered. Do NOT correct spelling, do NOT fill in words you cannot see.

{
  "lettering": ["every line of text in the ad that is NOT printed on the product itself, in reading order"],
  "label_text": ["every line printed on our product's label, as rendered; [] if none"],
  "our_product_count": <how many units of ${what} appear>,
  "matches_reference": "MATCH" | "MISMATCH" | "CANNOT_TELL",
  "mismatch_reason": "<if MISMATCH: what differs in shape, closure, color, label layout or graphics; else empty>",
  "hands_present": true | false,
  "hand_defect": "<describe any clearly malformed hand (extra or missing fingers, fused or impossible anatomy); else empty>"
}

Count only units of OUR product; ignore other generic bottles, jars or props. "matches_reference" is about the physical product only: shape, closure, color, label LAYOUT and graphics. Lighting, gloss and angle differences are never a mismatch, and neither is tiny print (curved rim text around a label edge, addresses, fine print, volume figures), which nobody can read at ad size. Answer with the JSON only.`;
}

export function parseCheck(text) {
  const m = String(text || '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

/**
 * Deterministic verdict from the transcription.
 * @returns {{ok:boolean, reasons:string[], notes:string[]}}
 */
export function decide({ read, concept, product, shown }) {
  const reasons = [];
  const notes = [];
  if (!read) return { ok: false, reasons: ['vision check returned no readable answer'], notes };

  const lettering = Array.isArray(read.lettering) ? read.lettering.join(' ') : String(read.lettering || '');
  const hay = tokens(lettering);
  let leftover = [...hay];
  for (const [name, text] of [['headline', concept.headline], ['subhead', concept.subhead]]) {
    if (!text) continue;
    const need = tokens(text);
    const at = findRun(leftover, need);
    if (at < 0) reasons.push(`${name} not rendered exactly (wanted "${text}", read "${lettering}")`);
    else leftover.splice(at, need.length);
  }
  const extra = leftover.join(' ');
  // Claims are screened on the RAW lettering (minus Sean's own copy), because tokens()
  // drops symbols such as ★ that are the claim.
  let raw = lettering;
  for (const t of [concept.headline, concept.subhead]) {
    if (t) raw = raw.replace(new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'ig'), ' ');
  }
  const symbolClaim = /[★☆⭐]/.test(raw);
  if (extra || symbolClaim) {
    const claims = inventedClaims(symbolClaim ? raw : extra);
    if (claims.length) reasons.push(`extra text with ${claims.join('; ')}`);
    else notes.push(`other text in scene: "${extra}"`);
  }

  if (isSet(product)) {
    const rows = Array.isArray(read.products) ? read.products : [];
    product.items.forEach((item, i) => {
      const name = item.title.split(/[|—–]/)[0].trim();
      const row = rows.find(r => Number(r?.product) === i + 1) || rows[i];
      if (!row) { reasons.push(`no reading for product ${i + 1} (${name})`); return; }
      const label = tokens((row.label_text || []).join(' '));
      for (const s of requiredLabelStrings(item.labelStrings)) {
        if (findRun(label, tokens(s)) < 0) reasons.push(`${name}: label missing or misspelled "${s}" (read "${(row.label_text || []).join(' / ')}")`);
      }
      const c = Number(row.count);
      if (Number.isFinite(c) && c !== 1) reasons.push(`${name}: ${c} units, expected 1`);
      if (row.matches_reference === 'MISMATCH') reasons.push(`${name} does not match the photos: ${row.mismatch_reason || 'unspecified'}`);
    });
  } else if (shown !== 'unwrapped') {
    const label = tokens((read.label_text || []).join(' '));
    for (const s of requiredLabelStrings(product.labelStrings)) {
      if (findRun(label, tokens(s)) < 0) reasons.push(`label missing or misspelled "${s}" (read "${(read.label_text || []).join(' / ')}")`);
    }
  } else if ((read.label_text || []).length) {
    reasons.push(`bare bar shows text: "${read.label_text.join(' / ')}"`);
  }

  if (!isSet(product)) {
    const n = Number(read.our_product_count);
    const want = product.unitCount || 1;
    if (Number.isFinite(n) && n !== want) reasons.push(`${n} units of our product, expected ${want}`);
    if (read.matches_reference === 'MISMATCH') reasons.push(`product does not match the photos: ${read.mismatch_reason || 'unspecified'}`);
  }
  if (read.hand_defect && String(read.hand_defect).trim()) reasons.push(`malformed hand: ${read.hand_defect}`);
  if (read.hands_present) notes.push('hands in frame');
  return { ok: reasons.length === 0, reasons, notes };
}
