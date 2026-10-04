/**
 * Evidence for structure slots: review screening, verbatim quote picking, deterministic
 * template slots and gated model slots. Reviews are only ever quoted verbatim (a whole-sentence
 * prefix of the original, never edited); the model picks an index and never writes the quote.
 */
import { findHealthClaims } from '../ad-studio/health-claims.js';
import { findProductCategoryMisnomers } from '../../lib/product-category-terms.js';
import { variantConflicts, namedCompetitors, checkClaimsSourced } from './concepts.js';
import { gateCopy } from './copy.js';

/** Condition words a cosmetic review must not carry into an ad (beyond the shared gate). */
export const DISEASE_EXTRA = Object.freeze(['diabetic', 'diabetes', 'cuts', 'wound', 'wounds', 'burn', 'burns', 'rash', 'psoriasis', 'eczema', 'dermatitis']);
const DISEASE_EXTRA_RE = new RegExp(`\\b(?:${DISEASE_EXTRA.join('|')})\\b`, 'i');
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
    else if (health.length) reason = `health claim: ${health.map(h => h.match).join(', ')}`;
    else if (cond) reason = `condition word: ${cond[0]}`;
    else if (findProductCategoryMisnomers(t).length) reason = 'product category misnomer';
    else if (conflicts.length) reason = conflicts[0];
    else if (named.length) reason = `names a competitor: ${named.join(', ')}`;
    if (reason) dropped.push({ text, reason }); else kept.push(text);
  }
  return { kept, dropped };
}

/** Longest prefix of whole sentences within maxChars; null when even the first is too long. */
export function truncateAtSentence(text, maxChars) {
  const s = String(text ?? '');
  const ends = [];
  const re = /[.!?]+(?=\s|$)/g;
  let m;
  while ((m = re.exec(s))) ends.push(m.index + m[0].length);
  if (!ends.length || ends[ends.length - 1] < s.trimEnd().length) ends.push(s.trimEnd().length); // trailing unpunctuated tail counts as a sentence
  let best = null;
  for (const e of ends) { if (e <= maxChars && e > 0) best = e; else break; }
  return best === null ? null : s.slice(0, best);
}

export function buildQuotePickPrompt({ structure, reviews }) {
  const list = (reviews || []).map((r, i) => `[${i}] ${r}`).join('\n');
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

export function quoteFromPick(reviews, index, maxChars) {
  const r = (reviews || [])[index];
  if (r === undefined) throw new Error(`ad-concepts: no review at index ${index}`);
  const q = truncateAtSentence(r, maxChars);
  if (!q) throw new Error(`ad-concepts: review ${index} has no whole sentence within ${maxChars} chars`);
  return q;
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const nounOf = (ctx) => String(ctx.productNoun || ctx.product?.productNoun || ctx.product?.noun || (typeof ctx.product === 'string' ? ctx.product : '') || '').trim();

/**
 * Deterministic template slots. Strings only; nothing here is model-written.
 * ctx: { product | productNoun, facts?: string[], sourceIndex?, competitorNames?, labels?: string[] }
 */
export function templateSlot(structure, slotName, ctx = {}) {
  const slot = structure?.slots?.[slotName];
  if (!slot && slotName !== 'theirsRows') throw new Error(`structure "${structure?.id}" has no slot "${slotName}"`);
  const noun = nounOf(ctx);
  const needNoun = () => { if (!noun) throw new Error('templateSlot needs a productNoun'); return cap(noun); };
  if (structure.id === 'they-think-we-sell' && (slotName === 'left' || slotName === 'right')) {
    return `${needNoun()} ${slotName === 'left' ? 'they think we sell' : 'we actually sell'}`;
  }
  if (slotName === 'title') return `Ours vs ${structure.rows?.theirsLabel || 'typical'}`;
  if (slotName === 'theirsRows') return theirsRows(structure, ctx);
  if (slotName === 'oursRows') {
    const max = slot.maxRows || 3;
    const ok = (ctx.facts || []).filter(f => !/—/.test(f) && (!ctx.sourceIndex || checkClaimsSourced([{ text: f, sourceId: pickSource(f, ctx.sourceIndex) }], ctx.sourceIndex).ok));
    return ok.slice(0, max);
  }
  if (slotName === 'labels') return ctx.labels || [];
  if (slot.template) return slot.template.replace('{category}', needNoun());
  throw new Error(`slot "${slotName}" of "${structure.id}" is not a template slot`);
}

function pickSource(text, sourceIndex) {
  for (const id of Object.keys(sourceIndex || {})) {
    if (checkClaimsSourced([{ text, sourceId: id }], sourceIndex).ok) return id;
  }
  return Object.keys(sourceIndex || {})[0];
}

function theirsRows(structure, ctx) {
  const rows = structure.rows?.theirs || [];
  const bad = rows.filter(r => namedCompetitors(r, ctx.competitorNames || []).length);
  if (bad.length) throw new Error(`theirs rows name a brand: ${bad.join(', ')}`);
  return rows;
}

const textOf = (msg) => (msg?.content || []).filter(b => b.type === 'text').map(b => b.text).join('');

function buildSlotPrompt({ structure, slotName, slot, evidence, retryNote }) {
  const ev = Array.isArray(evidence) ? evidence.map(e => `- ${e}`).join('\n') : String(evidence || '');
  return `Write the "${slotName}" text for a static ad built on the structure "${structure.name || structure.id}".
Style: ${slot.style || 'short, plain, concrete'}. At most ${slot.maxWords} words. No em dash. No health claim. Never name a competitor brand. Our product is never an antiperspirant.
Any statement of fact must be listed in "claims" as an exact verbatim quote from a source, with its sourceId.
Evidence:
${ev}
${retryNote ? `\nYOUR PREVIOUS ATTEMPT WAS REJECTED:\n${retryNote}\nFix exactly that.\n` : ''}
Return ONLY: {"text":"","claims":[{"text":"","sourceId":""}]}`;
}

export async function fillModelSlot({ anthropic, model, structure, slotName, evidence, sourceIndex, competitorNames = [], variant = null, siblingVariants = [] }) {
  const slot = structure?.slots?.[slotName];
  if (!slot || slot.source !== 'model') throw new Error(`slot "${slotName}" of "${structure?.id}" is not a model slot`);
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
    if (!reasons.length) return text;
    retryNote = reasons.join('\n');
  }
  throw new Error(`ad-concepts: slot "${slotName}" failed the gate twice: ${reasons.join('; ')}`);
}
