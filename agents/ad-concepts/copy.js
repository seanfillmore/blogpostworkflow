// agents/ad-concepts/copy.js
//
// Overlay copy per concept and the ad-level flexible copy. Every string passes the same
// gates as Ad Studio's copy, plus the no-em-dash rule. Policy: one regeneration that
// names the failure, then give up (the caller replaces the concept).
//
// Claim gating has two shapes, because two callers write claims two ways:
//   - overlay claims are { text, sourceId }; the text is its own verbatim evidence quote,
//     checked by concepts.js's checkClaimsSourced (raw sourceIndex, normalized there).
//   - flexible claims arrive in Ad Studio's { zone, text, factual, sourceId, evidence }
//     shape (parseFlexibleCopyResponse passes them through untouched), so those go through
//     Ad Studio's own assertClaimsSourced against a normalized index.
import { assertNoHealthClaims } from '../ad-studio/health-claims.js';
import { assertClaimsSourced, normalizeForMatch, sourceText } from '../ad-studio/claims.js';
import { findProductCategoryMisnomers } from '../../lib/product-category-terms.js';
import { buildFlexibleCopyPrompt, parseFlexibleCopyResponse, flexibleZones } from '../ad-studio/flexible.js';
import { checkClaimsSourced } from './concepts.js';

export const HEADLINE_MAX_WORDS = 6;
export const SUB_MAX_WORDS = 12;

const textOf = (msg) => (msg?.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
const words = (s) => String(s || '').trim().split(/\s+/).filter(Boolean).length;
const firstLine = (e) => String(e?.message || e).split('\n')[0];

function extractJson(text) {
  const s = String(text || '');
  const a = s.indexOf('{'); const b = s.lastIndexOf('}');
  if (a === -1 || b <= a) throw new Error('ad-concepts: no JSON object in the copy response');
  return JSON.parse(s.slice(a, b + 1));
}

async function call(anthropic, model, content, maxTokens = 1500) {
  const msg = await anthropic.messages.create({ model, max_tokens: maxTokens, messages: [{ role: 'user', content }] });
  if (msg.stop_reason === 'max_tokens') throw new Error('ad-concepts: the copy response was cut off at the token limit.');
  return textOf(msg);
}

export function buildOverlayCopyPrompt({ concept, product, pdpBody, sourceIds, retryNote = null }) {
  return `Write the overlay type for one static ad image for ${product.title}.
The image: ${concept.picture}
Anchor: ${concept.anchor || ''}. Twist: ${concept.twist}. Draft idea: "${concept.headlineIdea}".

Rules:
  - headline: ${HEADLINE_MAX_WORDS} words or fewer. It completes the joke the picture sets up.
  - sub: optional, ${SUB_MAX_WORDS} words or fewer, plain and factual.
  - Every fact goes in "claims" with a sourceId from: ${sourceIds.join(', ')}. Invent nothing.
  - Each claim "text" is an EXACT contiguous quote copied from the source named by sourceId, letter for letter, no paraphrase.
  - No em dash. No health claim. Our product is a deodorant or soap, never an antiperspirant.
PDP:
${String(pdpBody || '').slice(0, 3000)}
${retryNote ? `\nYOUR PREVIOUS ATTEMPT WAS REJECTED:\n${retryNote}\nFix exactly that.\n` : ''}
Return ONLY: {"headline":"","sub":"","claims":[{"text":"","sourceId":""}]}`;
}

export function parseOverlayCopy(text) {
  const o = extractJson(text);
  return {
    headline: String(o.headline || '').trim(),
    sub: String(o.sub || '').trim(),
    claims: Array.isArray(o.claims) ? o.claims.filter(c => c && c.text).map(c => ({ text: String(c.text), sourceId: String(c.sourceId || '') })) : [],
  };
}

export function gateCopy(fields, claims, { sourceIndex }) {
  const reasons = [];
  const entries = Object.entries(fields).filter(([, v]) => String(v || '').trim());
  for (const [k, v] of entries) if (/—/.test(v)) reasons.push(`em dash in ${k}`);
  try { assertNoHealthClaims(Object.fromEntries(entries)); } catch (e) { reasons.push(`health claim: ${String(e.message).split('\n').slice(1).map(l => l.trim()).filter(Boolean).join('; ') || firstLine(e)}`); }
  for (const [k, v] of entries) {
    if (findProductCategoryMisnomers(v).length) reasons.push(`product category in ${k}: our product is a deodorant or soap, never an antiperspirant`);
  }
  if ('headline' in fields && words(fields.headline) > HEADLINE_MAX_WORDS) reasons.push(`headline has ${words(fields.headline)} words (max ${HEADLINE_MAX_WORDS})`);
  if ('sub' in fields && words(fields.sub) > SUB_MAX_WORDS) reasons.push(`sub has ${words(fields.sub)} words (max ${SUB_MAX_WORDS})`);

  const list = claims || [];
  const adStudioShaped = list.filter(c => c && c.evidence !== undefined);
  const quoteShaped = list.filter(c => c && c.evidence === undefined);
  if (quoteShaped.length) {
    const r = checkClaimsSourced(quoteShaped, sourceIndex);
    if (!r.ok) reasons.push(...r.reasons);
  }
  if (adStudioShaped.length) {
    const index = Object.fromEntries(Object.entries(sourceIndex || {}).map(([k, v]) => [k, normalizeForMatch(sourceText(v))]));
    try { assertClaimsSourced(adStudioShaped.map(c => ({ factual: true, ...c })), index); } catch (e) {
      reasons.push(`unsourced claim: ${String(e.message).split('\n').slice(1).join(' ').trim()}`);
    }
  }
  return { ok: reasons.length === 0, reasons };
}

export async function writeOverlayCopy({ anthropic, model, concept, product, pdpBody, sourceIndex }) {
  let retryNote = null;
  let lastReasons = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const prompt = buildOverlayCopyPrompt({ concept, product, pdpBody, sourceIds: Object.keys(sourceIndex), retryNote });
    const copy = parseOverlayCopy(await call(anthropic, model, prompt));
    const gate = gateCopy({ headline: copy.headline, sub: copy.sub }, copy.claims, { sourceIndex });
    if (gate.ok && copy.headline) return { ok: true, copy };
    lastReasons = copy.headline ? gate.reasons : ['empty headline', ...gate.reasons];
    retryNote = lastReasons.join('\n');
  }
  return { ok: false, reasons: lastReasons };
}

export async function writeFlexibleCopy({ anthropic, model, product, concepts, sourceIndex, pdpBody, persona = null, reviews = [] }) {
  const pseudo = concepts.map(c => ({ format: { key: c.id, name: c.title, awareness: c.awareness || 'solution' } }));
  const base = buildFlexibleCopyPrompt({ product, concepts: pseudo, sourceIds: Object.keys(sourceIndex), persona, pdpBody, reviews });
  let note = null;
  let lastReasons = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const content = note ? `${base}\n\nYOUR PREVIOUS ATTEMPT WAS REJECTED:\n${note}\nFix exactly that and return the whole JSON again.` : base;
    let parsed;
    try { parsed = parseFlexibleCopyResponse(await call(anthropic, model, content, 2000)); }
    catch (e) {
      if (/cut off/.test(e.message)) throw e;
      lastReasons = [firstLine(e)]; note = lastReasons[0]; continue;
    }
    const gate = gateCopy(flexibleZones(parsed), parsed.claims, { sourceIndex });
    if (gate.ok) return { ok: true, ...parsed };
    lastReasons = gate.reasons; note = gate.reasons.join('\n');
  }
  return { ok: false, reasons: lastReasons };
}
