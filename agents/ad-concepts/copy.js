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
import { sellingVocabulary, findGoldenThread, splitPrimaryText, goldenThreadRetryNote, MIN_SELLING_VOCABULARY } from '../ad-studio/golden-thread.js';
import { checkClaimsSourced, namedCompetitors } from './concepts.js';

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

export function gateCopy(fields, claims, { sourceIndex, competitorNames = [] }) {
  const reasons = [];
  const entries = Object.entries(fields).filter(([, v]) => String(v || '').trim());
  for (const [k, v] of entries) if (/—/.test(v)) reasons.push(`em dash in ${k}`);
  // Same matcher as the concept pre-gate (case-sensitive proper nouns), so a concept that
  // passed cannot have a competitor written back into it by the copy call.
  for (const [k, v] of entries) {
    const named = namedCompetitors(v, competitorNames);
    if (named.length) reasons.push(`names a competitor: ${named.join(', ')} in ${k}. Jab at the category, never a named brand`);
  }
  try { assertNoHealthClaims(Object.fromEntries(entries)); } catch (e) { reasons.push(`health claim: ${String(e.message).split('\n').slice(1).map(l => l.trim()).filter(Boolean).join('; ') || firstLine(e)}`); }
  for (const [k, v] of entries) {
    if (findProductCategoryMisnomers(v).length) reasons.push(`product category in ${k}: our product is a deodorant or soap, never an antiperspirant`);
  }
  if ('headline' in fields && words(fields.headline) > HEADLINE_MAX_WORDS) reasons.push(`headline has ${words(fields.headline)} words (max ${HEADLINE_MAX_WORDS})`);
  if ('sub' in fields && words(fields.sub) > SUB_MAX_WORDS) reasons.push(`sub has ${words(fields.sub)} words (max ${SUB_MAX_WORDS})`);

  const list = claims || [];
  // Ad Studio shaped = it carries Ad Studio's own fields. Keying on `evidence` alone sent a
  // persuasion line ({ zone, text, factual: false }, no evidence: it needs none) down the
  // overlay path, which treats every claim as factual, so the live run on 2026-10-03 had a
  // rhetorical question rejected as "factual claim with no sourceId" twice. Overlay claims
  // never carry these fields (parseOverlayCopy keeps only text + sourceId). A factual:true
  // claim still needs sourceId AND a verbatim evidence quote: assertClaimsSourced is unchanged.
  // Only an OBJECT can be Ad Studio shaped. parseFlexibleCopyResponse passes claims through
  // unsanitised, so a bare string ("One fat") arrives here; it goes down the strict quote path
  // as { text } (no sourceId, so it is rejected with a reason) and can never throw.
  const isObj = (c) => typeof c === 'object' && c !== null;
  const isAdStudioShaped = (c) => isObj(c) && (c.evidence !== undefined || 'factual' in c || 'zone' in c);
  const adStudioShaped = list.filter(c => c && isAdStudioShaped(c));
  const quoteShaped = list.filter(c => c && !isAdStudioShaped(c)).map(c => (isObj(c) ? c : { text: String(c) }));
  if (quoteShaped.length) {
    const r = checkClaimsSourced(quoteShaped, sourceIndex);
    if (!r.ok) reasons.push(...r.reasons);
  }
  if (adStudioShaped.length) {
    const index = Object.fromEntries(Object.entries(sourceIndex || {}).map(([k, v]) => [k, normalizeForMatch(sourceText(v))]));
    // Only an explicit factual:false is persuasion. null, 0, "" or a missing field stay factual
    // and must be sourced: a label the model did not clearly set is not an exemption.
    try { assertClaimsSourced(adStudioShaped.map(c => ({ ...c, factual: c.factual !== false })), index); } catch (e) {
      reasons.push(`unsourced claim: ${String(e.message).split('\n').slice(1).join(' ').trim()}`);
    }
  }
  return { ok: reasons.length === 0, reasons };
}

export async function writeOverlayCopy({ anthropic, model, concept, product, pdpBody, sourceIndex, competitorNames = [] }) {
  let retryNote = null;
  let lastReasons = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const prompt = buildOverlayCopyPrompt({ concept, product, pdpBody, sourceIds: Object.keys(sourceIndex), retryNote });
    const copy = parseOverlayCopy(await call(anthropic, model, prompt));
    const gate = gateCopy({ headline: copy.headline, sub: copy.sub }, copy.claims, { sourceIndex, competitorNames });
    if (gate.ok && copy.headline) return { ok: true, copy };
    lastReasons = copy.headline ? gate.reasons : ['empty headline', ...gate.reasons];
    retryNote = lastReasons.join('\n');
  }
  return { ok: false, reasons: lastReasons };
}

/**
 * Ad Studio's flexible prompt says "the three images carry no text at all", which is true of
 * a plate and false of our finals: each carries a typeset headline (and maybe a sub). So the
 * pseudo-format name carries that headline, and this note overrides the stale sentence.
 */
export const FLEXIBLE_OVERLAY_NOTE = `IMPORTANT, OVERRIDING THE LINE ABOVE ABOUT THE IMAGES: these images DO carry overlay text. Each one shows the on-image headline quoted next to it in the list of images. The primary texts and headlines you write run around those images, so do not repeat an on-image headline verbatim and never contradict one.`;

/**
 * Appended to the flexible prompt and restated in any retry that hit an unsourced claim. The
 * model marked rhetorical questions ("Tried every lotion and still dry?") factual:true with no
 * sourceId on the first live run; the gate was right to reject that, the prompt never said so.
 */
export const FLEXIBLE_CLAIMS_RULE = `CLAIMS RULE: questions, hooks and persuasion lines are "factual": false and need no sourceId or evidence. Only a statement of fact about the product (what it contains, how it is made, what it costs) is "factual": true, and every factual:true claim MUST carry a sourceId and an "evidence" string that is an exact, verbatim quote copied from that source.`;

export async function writeFlexibleCopy({ anthropic, model, product, concepts, sourceIndex, pdpBody, persona = null, reviews = [], competitorNames = [] }) {
  const pseudo = concepts.map(c => ({
    format: {
      key: c.id,
      name: c.overlayHeadline ? `${c.title}, on-image headline: "${c.overlayHeadline}"${c.overlaySub ? ` with the line "${c.overlaySub}"` : ''}` : c.title,
      awareness: c.awareness || 'solution',
    },
  }));
  // A missing priceLabel used to reach the prompt as the literal word "undefined".
  const priced = { ...product, priceLabel: product.priceLabel || 'price on the product page' };
  const base = `${buildFlexibleCopyPrompt({ product: priced, concepts: pseudo, sourceIds: Object.keys(sourceIndex), persona, pdpBody, reviews })}\n\n${FLEXIBLE_OVERLAY_NOTE}\n\n${FLEXIBLE_CLAIMS_RULE}`;

  // Golden thread on the PRIMARY TEXTS, advisory, exactly as Ad Studio's writeFlexibleManifest:
  // it SHARES the one regeneration (never a third call), the second attempt ships whatever it
  // produced, and the finding is returned for flexible-ad.json. Disarmed below
  // MIN_SELLING_VOCABULARY rather than condemning every text.
  const selling = sellingVocabulary({ pdpBody, catalogEntry: null, persona });
  const findThreads = (texts) => selling.size < MIN_SELLING_VOCABULARY ? [] : texts
    .map((t, i) => ({ i, t, r: findGoldenThread({ ...splitPrimaryText(t), selling }) }))
    .filter(x => x.r.goldenThread);

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
    const gate = gateCopy(flexibleZones(parsed), parsed.claims, { sourceIndex, competitorNames });
    const threads = findThreads(parsed.primaryTexts);
    if (gate.ok && (threads.length === 0 || attempt === 1)) {
      return {
        ok: true, ...parsed,
        goldenThread: threads.map(x => ({ primaryText: x.i + 1, text: x.t, reason: x.r.reason, hookPremise: x.r.hookPremise, pivot: x.r.pivot, dominance: x.r.dominance })),
      };
    }
    lastReasons = gate.reasons;
    const parts = [...gate.reasons];
    if (gate.reasons.some(r => /unsourced claim|no sourceId|no evidence quote|evidence not found/.test(r))) parts.push(FLEXIBLE_CLAIMS_RULE);
    if (threads.length) parts.push(`${goldenThreadRetryNote(threads[0].r)}\nThe offending primary text was: "${threads[0].t}"`);
    note = parts.join('\n');
  }
  return { ok: false, reasons: lastReasons };
}
