// agents/ad-concepts/concepts.js
//
// Stage 1 of the concept-first pipeline (spec: docs/superpowers/specs/2026-10-03-ad-concepts-design.md).
// Pure: prompt builders, parsers, the free pre-gate, and the auto-pick. No I/O, no model calls.
import { findHealthClaims } from '../ad-studio/health-claims.js';
import { assertClaimsSourced, normalizeForMatch, sourceText } from '../ad-studio/claims.js';
import { findProductCategoryMisnomers } from '../../lib/product-category-terms.js';

export const FAMILIES = Object.freeze(['scale-gag', 'genre-parody', 'native-screenshot', 'product-art', 'identity-comedy']);
export const SCENE_TEXT = Object.freeze(['none', 'illegible-print']);
export const PEOPLE = Object.freeze(['none', 'hands', 'face']);
export const TYPE_BANDS = Object.freeze(['top', 'bottom']);
export const AWARENESS = Object.freeze(['unaware', 'problem', 'solution', 'product', 'most-aware']);
export const JUDGE_CRITERIA = Object.freeze(['thumbStop', 'oneSecondRead', 'productClarity', 'renderability', 'brandFit']);

const BEFORE_AFTER_RE = /\bbefore[\s-]*(?:and|&|\/|-)?[\s-]*after\b|\b(?:skin|face|body|underarms?|armpits?|teeth)\b[^.]{0,40}\b(?:improv\w*|clear(?:s|ed|er)?|transform\w*|heal\w*|whiter|smoother)\b/i;

const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);
const str = (v) => (typeof v === 'string' ? v.trim() : '');

export function normalizeFamily(f) {
  const s = str(f).toLowerCase();
  if (FAMILIES.includes(s)) return s;
  if (/^template:[a-z0-9-]+$/.test(s)) return s;
  return 'other';
}

export function normalizeConcept(r, i) {
  if (!r || typeof r !== 'object') return null;
  const title = str(r.title);
  const picture = str(r.picture);
  const anchor = str(r.anchor);
  const twist = str(r.twist);
  if (!title || !picture || !anchor || !twist) return null;
  const pick = (v, allowed, fallback) => (allowed.includes(str(v).toLowerCase()) ? str(v).toLowerCase() : fallback);
  // An unrecognised `people` value is read strictly as "a face is present": that is the
  // value that triggers human review, and silently reading it as "none" would skip it.
  const people = str(r.people) ? pick(r.people, PEOPLE, 'face') : 'none';
  return {
    id: slug(r.id) || slug(title) || `concept-${i + 1}`,
    title, picture, anchor, twist,
    family: normalizeFamily(r.family),
    productRole: str(r.productRole),
    sceneText: pick(r.sceneText, SCENE_TEXT, 'none'),
    people,
    typeBand: pick(r.typeBand, TYPE_BANDS, 'top'),
    awareness: pick(r.awareness, AWARENESS, 'solution'),
    headlineIdea: str(r.headlineIdea),
    claims: (Array.isArray(r.claims) ? r.claims : [])
      .filter(c => c && str(c.text))
      .map(c => ({ text: str(c.text), sourceId: str(c.sourceId) })),
    requested: r.requested === true,
  };
}

function extractJson(text) {
  const s = String(text || '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('ad-concepts: no JSON object in the model response');
  return JSON.parse(s.slice(start, end + 1));
}

export function parseConceptsResponse(text) {
  const obj = extractJson(text);
  const list = Array.isArray(obj.concepts) ? obj.concepts : [];
  const seen = new Map();
  const out = [];
  list.forEach((r, i) => {
    const c = normalizeConcept(r, i);
    if (!c) return;
    const n = (seen.get(c.id) || 0) + 1;
    seen.set(c.id, n);
    if (n > 1) c.id = `${c.id}-${n}`;
    out.push(c);
  });
  return out;
}

export function buildConceptPrompt({ product, catalogEntry, pdpBody, brandKit, persona, reviews = [], tactics = '', requested = [], count = 18, sourceIds = [] }) {
  const requestedBlock = requested.length
    ? `\nOPERATOR IDEAS. Include each of these as its own concept, faithful to the idea, with "requested": true:\n${requested.map((r, i) => `  ${i + 1}. ${r}`).join('\n')}\n`
    : '';
  // fetchAdReviews returns string[]; an object shape is accepted too.
  const reviewText = (r) => (typeof r === 'string' ? r : (r?.body || r?.text || ''));
  const reviewLines = (reviews || []).slice(0, 8).map(r => `  - "${String(reviewText(r)).slice(0, 240)}"`).join('\n');
  return `You are the creative director for Real Skin Care, generating ad CONCEPTS for one Meta flexible ad.
Product: ${product.title} (${product.handle}).

THE JOB. A concept is an IDEA for a single static image that stops a thumb mid-scroll. Generate ${count} concepts that differ in kind, not just wording. Each one needs a recognisable ANCHOR (something the viewer already knows) and a TWIST (the unexpected thing it turns out to be about). It must read in about one second, with one primary subject and room for at most four words of overlay type. Stock photography is a failed concept.

FAMILIES. Give every concept exactly one family:
  scale-gag         absurd exaggeration of scale or quantity
  genre-parody      a recognisable genre restaged (true crime, nature documentary, infomercial)
  native-screenshot it looks like a phone screenshot or a post, not an ad
  product-art       a beautiful, surreal product image
  identity-comedy   a joke about who the buyer is or wants to be
  template:<key>    one of the existing Ad Studio layouts, only when it is genuinely the best idea

RULES. A concept that breaks one is discarded before anyone sees it:
  - Jabs at a generic CATEGORY are fine ("your soap's ingredient list"). Never a named competitor, its brand, colours or packaging.
  - Real Skin Care sells a DEODORANT, never an antiperspirant. Never describe our product with the word.
  - No before/after imagery of skin, a body, a face, an underarm or teeth, and no claim to treat, heal or cure anything. This is a cosmetic.
  - Every fact a concept leans on goes in "claims": "text" must be an EXACT contiguous quote copied from the source named by "sourceId" (letter for letter, no paraphrase), and sourceId is one of: ${sourceIds.join(', ')}. Invent nothing.
  - No em dash anywhere in any field.
  - A native-screenshot concept always takes sceneText "illegible-print": a screenshot's interface text can only be hairline texture, because any readable character in the render fails the text gate.
  - Text in the scene is either none, or "illegible-print" (texture that reads as print from a distance with no readable characters). Overlay type is set later, in code, in the typeBand you name.

EVIDENCE
PDP:
${String(pdpBody || '').slice(0, 4000)}
Catalog: ${sourceText(catalogEntry || {}).slice(0, 1500)}
Brand: ${JSON.stringify({ voice: brandKit?.voice, palette: brandKit?.palette_hexes }).slice(0, 800)}
Persona: ${persona ? JSON.stringify(persona).slice(0, 2000) : 'none'}
Customer words:
${reviewLines || '  (none)'}

TACTICS YOU MAY DRAW ON, AND THE ONES YOU MUST NOT PROPOSE:
${tactics || '(none)'}
${requestedBlock}
Return ONLY this JSON:
{"concepts":[{"id":"kebab-slug","title":"","picture":"one sentence describing the image","anchor":"","twist":"","family":"","productRole":"","sceneText":"none|illegible-print","people":"none|hands|face","typeBand":"top|bottom","awareness":"unaware|problem|solution|product|most-aware","headlineIdea":"","claims":[{"text":"","sourceId":""}],"requested":false}]}`;
}

const NATIVE_NOT_A_BRAND = '(?![-\\u2010-\\u2015]|\\s+(?:feed|ads?|format|look|screenshot|post)\\b)';

// Competitor names are proper nouns: case-SENSITIVE on word boundaries. "Native" is also an
// ordinary word and one of our own family names ("native-screenshot"), so it is not counted
// when a hyphen or a format word follows it.
export function mentionsCompetitor(text, name) {
  if (!name) return false;
  const esc = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const tail = name === 'Native' ? NATIVE_NOT_A_BRAND : '';
  return new RegExp(`(?<![\\w])${esc}(?![\\w])${tail}`).test(text);
}

/** Every competitor name the text mentions, by the same rule the pre-gate uses. */
export function namedCompetitors(text, competitorNames = []) {
  return (competitorNames || []).filter(n => mentionsCompetitor(String(text || ''), n));
}

/** Claim text is its own evidence quote; the index is normalized to match. */
export function checkClaimsSourced(claims, sourceIndex) {
  const index = Object.fromEntries(Object.entries(sourceIndex || {}).map(([k, v]) => [k, normalizeForMatch(sourceText(v))]));
  const gateClaims = (claims || []).map(c => ({ zone: 'concept', text: c.text, factual: true, sourceId: c.sourceId, evidence: c.text }));
  try { assertClaimsSourced(gateClaims, index); } catch (e) {
    return { ok: false, reasons: [`unsourced claim: ${String(e.message).split('\n').slice(1).join(' ').trim()}`] };
  }
  return { ok: true, reasons: [] };
}

export function preGate(concept, { sourceIndex, competitorNames = [] }) {
  const reasons = [];
  const text = [concept.title, concept.picture, concept.anchor, concept.twist, concept.productRole, concept.headlineIdea, ...concept.claims.map(c => c.text)].join(' ');
  const health = findHealthClaims(text);
  if (health.length) reasons.push(`health claim: ${health.map(h => `"${h.match}" (${h.category})`).join(', ')}`);
  const misnomer = findProductCategoryMisnomers(text);
  if (misnomer.length) reasons.push(`product category: ${misnomer.map(m => m.match).join(', ')}`);
  const named = namedCompetitors(text, competitorNames);
  if (named.length) reasons.push(`names a competitor: ${named.join(', ')}`);
  if (BEFORE_AFTER_RE.test(text)) reasons.push('before/after imagery of skin or body');
  if (/\u2014/.test(text)) reasons.push('em dash');
  const claimCheck = checkClaimsSourced(concept.claims, sourceIndex);
  if (!claimCheck.ok) reasons.push(...claimCheck.reasons);
  return { ok: reasons.length === 0, reasons };
}

export function buildJudgePrompt(concepts) {
  const list = concepts.map((c, i) => `[${i}] ${c.title} (${c.family}): ${c.picture} Anchor: ${c.anchor}. Twist: ${c.twist}. Overlay idea: "${c.headlineIdea}".`).join('\n');
  return `You are judging static Meta ad concepts for a small natural skincare brand. You did NOT write them. Score each 1-5 on:
  thumbStop       does the anchor + twist stop a scrolling thumb?
  oneSecondRead   one subject, readable in a second, four words of overlay is enough
  productClarity  will the real product be clearly visible and recognisable?
  renderability   can an image model produce this convincingly in one frame?
  brandFit        natural, honest, a bit cheeky; never mean about the buyer
Be harsh: anything that would look like stock photography scores 1-2 on thumbStop.

${list}

Return ONLY: {"scores":[{"i":0,"thumbStop":0,"oneSecondRead":0,"productClarity":0,"renderability":0,"brandFit":0}]}`;
}

export function parseJudgeResponse(text, n) {
  const obj = extractJson(text);
  const rows = Array.isArray(obj.scores) ? obj.scores : [];
  const clamp = (v) => { const x = Math.round(Number(v)); return Number.isFinite(x) ? Math.min(5, Math.max(1, x)) : 1; };
  const out = [];
  for (const r of rows) {
    const i = Number(r?.i);
    if (!Number.isInteger(i) || i < 0 || i >= n || out.some(o => o.i === i)) continue;
    const scores = Object.fromEntries(JUDGE_CRITERIA.map(k => [k, clamp(r[k])]));
    out.push({ i, scores, total: Object.values(scores).reduce((a, b) => a + b, 0) });
  }
  return out;
}

export function pickConcepts(scored, { slots = 3 } = {}) {
  const picked = [];
  const used = new Set();
  const overflow = [];
  for (const c of scored.filter(c => c.requested)) {
    if (picked.length >= slots) { overflow.push(c); continue; }
    picked.push(c);
    used.add(c.family);
  }
  const rest = scored.filter(c => !c.requested).sort((a, b) => (b.total ?? 0) - (a.total ?? 0));
  const runnersUp = [...overflow];
  for (const c of rest) {
    if (picked.length < slots && !used.has(c.family)) { picked.push(c); used.add(c.family); }
    else runnersUp.push(c);
  }
  return { picked, runnersUp };
}

export function nextReplacement(runnersUp, usedFamilies) {
  return runnersUp.find(c => !usedFamilies.has(c.family)) || null;
}
