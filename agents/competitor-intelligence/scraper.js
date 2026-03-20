// agents/competitor-intelligence/scraper.js
import { load } from 'cheerio';

/**
 * Extract SEO and structural signals from raw HTML.
 * slugTokens: array of tokens from the matched store slug (for keyword presence checks).
 */
export function extractPageStructure(html, slugTokens) {
  const $ = load(html);
  const tokens = slugTokens.map(t => t.toLowerCase());

  const h1 = $('h1').first().text().trim();
  const h2s = $('h2').map((_, el) => $(el).text().trim()).get();
  const h3s = $('h3').map((_, el) => $(el).text().trim()).get();

  // Section order heuristic
  const sectionKeywords = ['hero', 'benefit', 'ingredient', 'review', 'faq', 'feature', 'cta', 'description'];
  const sectionOrder = [];
  $('section, [class*="section"], [id]').each((_, el) => {
    const cls = ($(el).attr('class') || '') + ' ' + ($(el).attr('id') || '');
    for (const kw of sectionKeywords) {
      if (cls.toLowerCase().includes(kw) && !sectionOrder.includes(kw)) {
        sectionOrder.push(kw);
      }
    }
  });

  // CTA text
  let cta_text = '';
  $('button, a').each((_, el) => {
    if (cta_text) return;
    const cls = ($(el).attr('class') || '').toLowerCase();
    const text = $(el).text().trim();
    if (/cart|buy|shop|add/i.test(cls) || /add to cart|buy now|shop now/i.test(text)) {
      cta_text = text;
    }
  });

  // Description word count
  let descWords = 0;
  $('p, [class*="description"]').each((_, el) => {
    const text = $(el).text().trim();
    const wc = text.length > 0 ? text.split(/\s+/).length : 0;
    if (wc > descWords) descWords = wc;
  });

  // Benefit format
  let benefit_format = 'prose';
  const lists = $('ul, ol');
  if (lists.length > 0) {
    const hasImages = lists.find('img, svg').length > 0;
    benefit_format = hasImages ? 'icon-bullets' : 'bullets';
  }

  // Keyword presence
  const h1Lower = h1.toLowerCase();
  const firstP = $('p').first().text().toLowerCase();
  const keyword_in_h1 = tokens.length > 0 && tokens.every(t => h1Lower.includes(t));
  const keyword_in_first_paragraph = tokens.length > 0 && tokens.every(t => firstP.includes(t));

  return {
    h1, h2s, h3s,
    section_order: sectionOrder,
    cta_text,
    description_words: descWords,
    benefit_format,
    keyword_in_h1,
    keyword_in_first_paragraph,
    conversion_patterns: [],
    recommended_changes: [],
  };
}
