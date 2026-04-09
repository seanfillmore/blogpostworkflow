/**
 * Shared answer-first heuristic. Used by:
 *   - agents/answer-first-rewriter — to flag posts that need rewriting
 *   - agents/blog-post-writer — to throw if a freshly written post fails
 *
 * Pulls the first substantive <p> from a body_html string and checks
 * whether it leads with the answer to the question implied by the title.
 */
import * as cheerio from 'cheerio';

const STOPWORDS = new Set([
  'the','and','for','with','that','this','from','into','best','your','what',
  'how','why','when','where','about','vs','or','of','to','in','on','a','an',
  'is','are','use','using','natural','organic','clean',
]);

const FACTUAL_PATTERN = /\b(is|are|was|were|works|uses|contains|means|refers to|happens when|occurs|defined as|stops|kills|cleans|soothes|prevents|protects|helps|reduces|removes|fights|blocks|softens|moisturizes|hydrates|nourishes|seals|locks|forms|made of|made with|made from|consist|comes from|come from|the best)\b/i;

export function extractFirstBodyParagraph(html) {
  const $ = cheerio.load(html);
  $('section').remove();
  const skip = (text) => {
    const t = text.trim();
    if (!t) return true;
    if (t.length < 40) return true;
    if (/^Updated [A-Z]/.test(t)) return true;
    if (/^Transparency note/i.test(t)) return true;
    if (/Editorial Team/i.test(t) && t.length < 250) return true;
    if (/^By the/i.test(t)) return true;
    return false;
  };
  let found = null;
  $('p').each((_, el) => {
    const text = $(el).text();
    if (skip(text)) return;
    found = { text: text.trim(), html: $.html(el) };
    return false;
  });
  return found;
}

function firstNWords(text, n) {
  return text.split(/\s+/).slice(0, n).join(' ');
}

export function checkAnswerFirst(html, { title = '', keyword = '' } = {}) {
  const intro = extractFirstBodyParagraph(html);
  const reasons = [];
  if (!intro) {
    return { passes: false, intro: null, reasons: ['No intro paragraph found'] };
  }
  const first60 = firstNWords(intro.text, 60).toLowerCase();
  const firstSentence = intro.text.split(/(?<=[.!?])\s+/)[0] || '';

  const kw = (keyword || '').toLowerCase().trim();
  const kwTokens = kw.split(/\s+/).filter((t) => t.length > 3);
  if (kwTokens.length === 0) {
    const titleTokens = (title || '').toLowerCase()
      .replace(/[^a-z0-9 ]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 3 && !STOPWORDS.has(t));
    kwTokens.push(...titleTokens.slice(0, 4));
  }
  const kwHit = kw && first60.includes(kw);
  const tokenHits = kwTokens.filter((t) => first60.includes(t)).length;
  const looseHit = kwTokens.length > 0 && tokenHits / kwTokens.length >= 0.5;
  if (!kwHit && !looseHit) {
    const label = keyword || `title nouns (${kwTokens.join(', ')})`;
    reasons.push(`Topic terms not in first 60 words (${label})`);
  }

  if (/^(you |your |imagine |picture |let'?s )/i.test(firstSentence)) {
    reasons.push('Opens with second-person/anecdotal hook (e.g. "You finally...")');
  }
  if (firstSentence.trim().endsWith('?')) {
    reasons.push('Opens with a rhetorical question instead of a direct answer');
  }
  if (!FACTUAL_PATTERN.test(intro.text.split(/(?<=[.!?])\s+/).slice(0, 2).join(' '))) {
    reasons.push('First two sentences contain no definitional or factual statement');
  }

  return { passes: reasons.length === 0, intro, reasons };
}
