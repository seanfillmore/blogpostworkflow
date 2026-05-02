// agents/pdp-builder/lib/validators.js
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..', '..');

// Reuse the same exclusion config as the existing product-optimizer (see
// docs/superpowers/specs/2026-05-02-pdp-builder-design.md "Decision log").
// Brand terms are allowed in our own title/copy (we're Real Skin Care), but
// competitor and generic-umbrella terms are blocked everywhere.
const SITE_CONFIG = JSON.parse(readFileSync(join(ROOT, 'config', 'site.json'), 'utf8'));
const AI_CITATIONS = JSON.parse(readFileSync(join(ROOT, 'config', 'ai-citation-prompts.json'), 'utf8'));

const GENERIC_BLOCKLIST = (SITE_CONFIG.generic_keyword_blocklist || []).map((t) => t.toLowerCase());
const COMPETITOR_TERMS = (() => {
  const out = new Set();
  for (const c of (AI_CITATIONS.competitors || [])) {
    if (c.name) out.add(c.name.toLowerCase());
    for (const a of (c.aliases || [])) out.add(a.toLowerCase());
  }
  return [...out];
})();

// ── Length bounds — these are tuned from the competitor research in the spec.
const LENGTH_BOUNDS = {
  seoTitle:        { min: 50, max: 70, unit: 'chars' },
  metaDescription: { min: 140, max: 160, unit: 'chars' },
  bodyHtml:        { min: 120, max: 180, unit: 'words' },
  ingredientStory: { min: 40, max: 60, unit: 'words' },
  mechanismBlock:  { min: 80, max: 100, unit: 'words' },
  founderBlock:    { min: 60, max: 80, unit: 'words' },
  faqAnswer:       { min: 30, max: 80, unit: 'words' },
};

function wordCount(s) {
  return (s || '').trim().split(/\s+/).filter(Boolean).length;
}

function stripHtml(s) {
  return (s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Verifies every claimed ingredient is present in `config/ingredients.json`
 * for the named cluster. Returns { valid, fabricated: string[] }.
 *
 * Throws if the cluster doesn't exist in ingredientsByCluster (caller bug).
 */
export function validateIngredients({ cluster, claimedIngredients, ingredientsByCluster }) {
  const spec = ingredientsByCluster[cluster];
  if (!spec) throw new Error(`validateIngredients: cluster "${cluster}" not found in ingredientsByCluster`);

  const allowed = new Set();
  for (const ing of (spec.base_ingredients || [])) allowed.add(ing.toLowerCase());
  for (const variation of (spec.variations || [])) {
    for (const oil of (variation.essential_oils || [])) allowed.add(oil.toLowerCase());
  }

  const fabricated = [];
  for (const claimed of (claimedIngredients || [])) {
    if (!allowed.has(claimed.toLowerCase())) fabricated.push(claimed);
  }

  return { valid: fabricated.length === 0, fabricated };
}

/**
 * Checks lengths of generated content against the scaffold bounds.
 * Returns { valid, errors: string[] }. Empty/missing fields are skipped.
 */
export function validateLengths(content) {
  const errors = [];
  if (content.seoTitle != null) {
    const len = content.seoTitle.length;
    const b = LENGTH_BOUNDS.seoTitle;
    if (len < b.min || len > b.max) errors.push(`seoTitle ${len} ${b.unit} outside ${b.min}-${b.max}`);
  }
  if (content.metaDescription != null) {
    const len = content.metaDescription.length;
    const b = LENGTH_BOUNDS.metaDescription;
    if (len < b.min || len > b.max) errors.push(`metaDescription ${len} ${b.unit} outside ${b.min}-${b.max}`);
  }
  if (content.bodyHtml != null) {
    const wc = wordCount(stripHtml(content.bodyHtml));
    const b = LENGTH_BOUNDS.bodyHtml;
    if (wc < b.min || wc > b.max) errors.push(`bodyHtml ${wc} ${b.unit} outside ${b.min}-${b.max}`);
  }
  if (Array.isArray(content.ingredientCards)) {
    for (const [i, card] of content.ingredientCards.entries()) {
      const wc = wordCount(card.story || '');
      const b = LENGTH_BOUNDS.ingredientStory;
      if (wc < b.min || wc > b.max) errors.push(`ingredientCards[${i}] story ${wc} ${b.unit} outside ${b.min}-${b.max}`);
    }
  }
  if (content.mechanismBlock != null) {
    const wc = wordCount(content.mechanismBlock);
    const b = LENGTH_BOUNDS.mechanismBlock;
    if (wc < b.min || wc > b.max) errors.push(`mechanismBlock ${wc} ${b.unit} outside ${b.min}-${b.max}`);
  }
  if (content.founderBlock != null) {
    const wc = wordCount(content.founderBlock);
    const b = LENGTH_BOUNDS.founderBlock;
    if (wc < b.min || wc > b.max) errors.push(`founderBlock ${wc} ${b.unit} outside ${b.min}-${b.max}`);
  }
  if (Array.isArray(content.faq)) {
    for (const [i, qa] of content.faq.entries()) {
      const wc = wordCount(qa.answer || '');
      const b = LENGTH_BOUNDS.faqAnswer;
      if (wc < b.min || wc > b.max) errors.push(`faq[${i}] answer ${wc} ${b.unit} outside ${b.min}-${b.max}`);
    }
  }
  return { valid: errors.length === 0, errors };
}

/**
 * Checks generated text for competitor and generic-blocklist terms.
 * Brand terms (Real Skin Care, etc.) are intentionally NOT blocked here —
 * those are our own brand and SHOULD appear in our copy.
 */
export function validateBrandTermExclusion({ text, field }) {
  const lower = (text || '').toLowerCase();
  const errors = [];
  for (const term of COMPETITOR_TERMS) {
    if (lower.includes(term)) errors.push(`${field}: contains competitor term "${term}"`);
  }
  for (const term of GENERIC_BLOCKLIST) {
    if (lower.includes(term)) errors.push(`${field}: contains generic-blocklist term "${term}"`);
  }
  return { valid: errors.length === 0, errors };
}
