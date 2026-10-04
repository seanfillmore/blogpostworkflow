/**
 * Evidence for structure slots: review screening, verbatim quote picking, deterministic
 * template slots and gated model slots. Reviews are only ever quoted verbatim (a whole-sentence
 * prefix of the original, never edited); the model picks an index and never writes the quote.
 */
import { findHealthClaims } from '../ad-studio/health-claims.js';
import { findProductCategoryMisnomers } from '../../lib/product-category-terms.js';
import { variantConflicts, namedCompetitors, checkClaimsSourced } from './concepts.js';
import { gateCopy } from './copy.js';

/** Condition words a cosmetic review must not carry into an ad (beyond the shared gate). Regex source strings, plural-tolerant. */
// Inflected (burning, sunburned, rashy, bleeding, scarring, blistered). "cuts?" stays a whole
// word so "haircuts" is kept.
export const DISEASE_EXTRA = Object.freeze(['diabetic', 'diabetes', 'cuts?', 'wounds?', 'burn\\w*', 'sunburn\\w*', 'rash\\w*', 'bleed\\w*', 'psoriasis', 'eczema', 'dermatitis', 'scar\\w*', 'blister\\w*', 'scrapes?', 'stinging', 'clear(?:s|ed)?\\s+up']);
const DISEASE_EXTRA_RE = new RegExp(`\\b(?:${DISEASE_EXTRA.join('|')})\\b`, 'i');
const SUBJECT_RE = /\bantiperspirants?\b|\bover[- ]the[- ]counter\b|\bOTC\b/i;
const MIN_REVIEW_CHARS = 25;

const wordCount = (s) => String(s || '').trim().split(/\s+/).filter(Boolean).length;
const isTitleOnly = (t) => /\|/.test(t) || (wordCount(t) <= 4 && !/[.!?]/.test(t));

export function screenReviews(reviews, { variant = null, siblingVariants = [], competitorNames = [] } = {}) {
  const kept = [];
  const dropped = [];
  for (const raw of reviews || []) {
    const text = String(raw ?? '');
    const t = text.trim();
    let reason = null;
    const health = findHealthClaims(t);
    const cond = t.match(DISEASE_EXTRA_RE);
    const conflicts = variantConflicts(t, { variant, siblingVariants });
    const named = namedCompetitors(t, competitorNames);
    if (t.length < MIN_REVIEW_CHARS) reason = `too short (${t.length} chars)`;
    else if (isTitleOnly(t)) reason = 'product title, not a review';
    else if (/—/.test(t)) reason = 'em dash';
    else if (SUBJECT_RE.test(t)) reason = 'about antiperspirant or OTC (our product is a deodorant)';
    else if (health.length) reason = `health claim: ${health.map(h => h.match).join(', ')}`;
    else if (cond) reason = `condition word: ${cond[0]}`;
    else if (findProductCategoryMisnomers(t).length) reason = 'product category misnomer';
    else if (conflicts.length) reason = conflicts[0];
    else if (named.length) reason = `names a competitor: ${named.join(', ')}`;
    if (reason) dropped.push({ text, reason }); else kept.push(t);
  }
  return { kept, dropped };
}

export class NoQuoteError extends Error {
  constructor(msg) { super(msg); this.name = 'NoQuoteError'; }
}

/** Quotes are WHOLE reviews only: the ones whose full trimmed text fits. */
export function quotableReviews(reviews, maxChars) {
  return (reviews || []).map(r => String(r ?? '').trim()).filter(r => r && r.length <= maxChars);
}

export function buildQuotePickPrompt({ structure, reviews, maxChars }) {
  const offered = quotableReviews(reviews, maxChars);
  if (!offered.length) throw new NoQuoteError(`no review fits ${maxChars} chars whole; the quote slot cannot be filled`);
  const list = offered.map((r, i) => `[${i}] ${r}`).join('\n');
  return `Pick the ONE customer review below that best fits this ad structure: "${structure?.name || structure?.id || ''}". Prefer a specific, concrete, warm review about feel or everyday use. You only choose; you never edit or rewrite a review.

${list}

Return ONLY: {"index": <number>}`;
}

export function parseQuotePick(text, n) {
  const s = String(text || '');
  const a = s.indexOf('{'); const b = s.lastIndexOf('}');
  let idx;
  try { idx = JSON.parse(s.slice(a, b + 1)).index; } catch { throw new Error('ad-concepts: quote pick was not parseable JSON'); }
  if (!Number.isInteger(idx) || idx < 0 || idx >= n) throw new Error(`ad-concepts: quote pick index ${idx} is out of range (0..${n - 1})`);
  return idx;
}

/** index is into the OFFERED list (quotableReviews). Returns the whole trimmed review, verbatim. */
export function quoteFromPick(reviews, index, maxChars) {
  const offered = quotableReviews(reviews, maxChars);
  if (!offered.length) throw new NoQuoteError(`no review fits ${maxChars} chars whole; the quote slot cannot be filled`);
  if (!(index in offered)) throw new Error(`ad-concepts: no offered review at index ${index}`);
  return offered[index];
}

/** The model picks checklist rows BY INDEX from the offered (filtered, gated) list; code inserts them verbatim. */
export function buildRowPickPrompt({ structure, rows, min, max }) {
  const list = (rows || []).map((r, i) => `[${i}] ${r}`).join('\n');
  return `Pick the checklist rows for the "Ours" column of this ad structure: "${structure?.name || structure?.id || ''}". Choose ${min === max ? min : `${min} to ${max}`} rows from the list below: the clearest, most concrete product facts a shopper would care about, no two saying the same thing. You only choose; you never edit or rewrite a row.

${list}

Return ONLY: {"indices": [<number>, ...]}`;
}

export function parseRowPick(text, { n, min, max }) {
  const s = String(text || '');
  let idx;
  try { idx = JSON.parse(s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1)).indices; } catch { throw new Error('ad-concepts: row pick was not parseable JSON'); }
  if (!Array.isArray(idx) || idx.length < min || idx.length > max) throw new Error(`ad-concepts: row pick must name ${min}-${max} rows, got ${Array.isArray(idx) ? idx.length : 'none'}`);
  if (!idx.every(i => Number.isInteger(i) && i >= 0 && i < n)) throw new Error(`ad-concepts: row pick index out of range (0..${n - 1}): ${JSON.stringify(idx)}`);
  if (new Set(idx).size !== idx.length) throw new Error(`ad-concepts: row pick indices must be distinct: ${JSON.stringify(idx)}`);
  return idx;
}

// Words a "from the reviews" slot may add without the reviews saying them: grammar, and the
// negators that turn a review's "doesn't feel greasy" into "never greasy".
const SOURCE_STOPWORDS = new Set(['a', 'an', 'the', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'at', 'for', 'with', 'by', 'from', 'as', 'is', 'are', 'was', 'be', 'it', 'its', 'this', 'that', 'so', 'just', 'all', 'not', 'no', 'never', 'nothing', 'zero', 'you', 'your', 'we', 'our', 'i', 'my', 'me']);
const stems = (w) => {
  const out = new Set([w]);
  if (w.endsWith('ly') && w.length > 4) out.add(w.slice(0, -2));
  if (w.endsWith('bly') && w.length > 4) out.add(`${w.slice(0, -1)}e`);
  if (w.endsWith('ily') && w.length > 4) out.add(`${w.slice(0, -3)}y`);
  if (w.endsWith('es') && w.length > 4) out.add(w.slice(0, -2));
  if (w.endsWith('s') && w.length > 3) out.add(w.slice(0, -1));
  return out;
};
const wordsOf = (s) => String(s || '').toLowerCase().replace(/[\u2018\u2019]/g, "'").match(/[a-z0-9']+/g) || [];

/** Content words of `text` that the evidence never uses (case-insensitive, stopwords ignored, plural and -ly tolerated). */
export function unsourcedWords(text, evidenceText) {
  const have = new Set(wordsOf(evidenceText).flatMap(w => [...stems(w)]));
  const out = [];
  for (const w of wordsOf(text)) {
    if (SOURCE_STOPWORDS.has(w) || out.includes(w)) continue;
    if (![...stems(w)].some(x => have.has(x))) out.push(w);
  }
  return out;
}

/**
 * The comment card's underlined word: the headline's longest content word that is NOT the
 * product's own name or noun ("The winter moisturizer." on Coconut Moisturizer -> "winter", as
 * approved A underlined it). Falls back to the longest content word. Deterministic.
 */
export function emphasisWord(headline, avoid = []) {
  const tokens = String(headline || '').match(/[A-Za-z][A-Za-z'\u2019-]*/g) || [];
  const content = tokens.filter(t => !SOURCE_STOPWORDS.has(t.toLowerCase()));
  const avoidSet = new Set(avoid.flatMap(a => wordsOf(a)).flatMap(w => [...stems(w)]));
  const fresh = content.filter(t => ![...stems(t.toLowerCase())].some(x => avoidSet.has(x)));
  const pool = fresh.length ? fresh : content;
  return pool.reduce((best, t) => (t.length > best.length ? t : best), '') || null;
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const nounOf = (ctx) => String(ctx.productNoun || ctx.product?.productNoun || ctx.product?.noun || (typeof ctx.product === 'string' ? ctx.product : '') || '').trim();

const ROW_SOURCES = ['catalog', 'pdp'];

/** Every checklist row/label passes the copy gate; ours rows must also be sourced in catalog/pdp only. */
export function screenRows(rows, { sourceIndex = null, competitorNames, variant = null, siblingVariants = [], requireSourced = true } = {}) {
  if (!Array.isArray(competitorNames)) throw new Error('screenRows needs competitorNames (an array) so a brand can never be a row');
  let index = null;
  if (requireSourced) {
    if (!sourceIndex || typeof sourceIndex !== 'object') throw new Error('screenRows needs a sourceIndex to verify rows verbatim');
    index = Object.fromEntries(ROW_SOURCES.filter(k => k in sourceIndex).map(k => [k, sourceIndex[k]]));
  }
  const kept = []; const dropped = [];
  for (const row of rows || []) {
    const text = String(row ?? '').trim();
    const reasons = [];
    const gate = gateCopy({ row: text }, [], { sourceIndex: index || {}, competitorNames, variant, siblingVariants });
    reasons.push(...gate.reasons);
    if (!text) reasons.push('empty row');
    if (requireSourced && text) {
      const found = Object.keys(index).some(id => checkClaimsSourced([{ text, sourceId: id }], index).ok);
      if (!found) reasons.push('not found verbatim in the catalog or PDP');
    }
    if (reasons.length) dropped.push({ text, reason: reasons.join('; ') }); else kept.push(text);
  }
  return { kept, dropped };
}

/**
 * Deterministic template slots. Strings only; nothing here is model-written.
 * ctx: { product | productNoun, facts?, sourceIndex?, competitorNames, labels?, onDropped?(slotName, dropped[]) }
 */
export function templateSlot(structure, slotName, ctx = {}) {
  const slot = structure?.slots?.[slotName];
  if (!slot && slotName !== 'theirsRows') throw new Error(`structure "${structure?.id}" has no slot "${slotName}"`);
  const noun = nounOf(ctx);
  const needNoun = () => { if (!noun) throw new Error('templateSlot needs a productNoun'); return cap(noun); };
  const gateCtx = { competitorNames: ctx.competitorNames, variant: ctx.variant, siblingVariants: ctx.siblingVariants };
  if (structure.id === 'they-think-we-sell' && (slotName === 'left' || slotName === 'right')) {
    return `${needNoun()} ${slotName === 'left' ? 'they think we sell' : 'we actually sell'}`;
  }
  if (slotName === 'title') return `Ours vs ${structure.rows?.theirsLabel || 'typical'}`;
  // Rejected rows are reported, never silently dropped: the caller records them.
  const screened = (r) => { if (r.dropped.length) ctx.onDropped?.(slotName, r.dropped); return r.kept; };
  if (slotName === 'theirsRows') return screened(screenRows(structure.rows?.theirs || [], { ...gateCtx, requireSourced: false }));
  // The OFFERED list: every candidate that survived the gates. The model picks 3-4 by index.
  if (slotName === 'oursRows') return screened(screenRows(ctx.facts || [], { ...gateCtx, sourceIndex: ctx.sourceIndex }));
  if (slotName === 'labels') return screened(screenRows(ctx.labels || [], { ...gateCtx, requireSourced: false }));
  if (slot.template) return slot.template.replaceAll('{category}', needNoun());
  throw new Error(`slot "${slotName}" of "${structure.id}" is not a template slot`);
}

const textOf = (msg) => (msg?.content || []).filter(b => b.type === 'text').map(b => b.text).join('');

function buildSlotPrompt({ structure, slotName, slot, evidence, retryNote }) {
  const ev = Array.isArray(evidence) ? evidence.map(e => `- ${e}`).join('\n') : String(evidence || '');
  return `Write the "${slotName}" text for a static ad built on the structure "${structure.name || structure.id}".
Style: ${slot.style || 'short, plain, concrete'}. At most ${slot.maxWords} words. No em dash. No health claim. Never name a competitor brand. Our product is never an antiperspirant.
Any statement of fact must be listed in "claims" as an exact verbatim quote from a source, with its sourceId.${slot.sourceWords === 'reviews' ? '\nUse ONLY words that appear in the evidence below (the customers\' own wording); small grammar words and "never"/"not" are fine.' : ''}
Evidence:
${ev}
${retryNote ? `\nYOUR PREVIOUS ATTEMPT WAS REJECTED:\n${retryNote}\nFix exactly that.\n` : ''}
Return ONLY: {"text":"","claims":[{"text":"","sourceId":""}]}`;
}

export async function fillModelSlot({ anthropic, model, structure, slotName, evidence, sourceIndex, competitorNames = [], variant = null, siblingVariants = [] }) {
  const slot = structure?.slots?.[slotName];
  if (!slot || slot.source !== 'model') throw new Error(`slot "${slotName}" of "${structure?.id}" is not a model slot`);
  if (!Number.isFinite(slot.maxWords)) throw new Error(`slot "${slotName}" of "${structure.id}" declares no maxWords`);
  let retryNote = null;
  let reasons = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const msg = await anthropic.messages.create({ model, max_tokens: 400, messages: [{ role: 'user', content: buildSlotPrompt({ structure, slotName, slot, evidence, retryNote }) }] });
    if (msg.stop_reason === 'max_tokens') throw new Error('ad-concepts: the slot response was cut off at the token limit.');
    const s = textOf(msg);
    let o;
    try { o = JSON.parse(s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1)); } catch { o = null; }
    if (!o) { reasons = ['response was not parseable JSON']; retryNote = reasons.join('\n'); continue; }
    const text = String(o.text || '').trim();
    const claims = Array.isArray(o.claims) ? o.claims.filter(c => c && c.text).map(c => ({ text: String(c.text), sourceId: String(c.sourceId || '') })) : [];
    reasons = [];
    if (!text) reasons.push('empty text');
    if (wordCount(text) > slot.maxWords) reasons.push(`${slotName} has ${wordCount(text)} words (max ${slot.maxWords})`);
    const gate = gateCopy({ [slotName]: text }, claims, { sourceIndex, competitorNames, variant, siblingVariants });
    reasons.push(...gate.reasons);
    if (slot.sourceWords === 'reviews' && text) {
      const missing = unsourcedWords(text, Array.isArray(evidence) ? evidence.join(' ') : String(evidence || ''));
      if (missing.length) reasons.push(`words not in the review evidence: ${missing.join(', ')}. Use only the reviewers' own words`);
    }
    if (!reasons.length) return text;
    retryNote = reasons.join('\n');
  }
  throw new Error(`ad-concepts: slot "${slotName}" failed the gate twice: ${reasons.join('; ')}`);
}
