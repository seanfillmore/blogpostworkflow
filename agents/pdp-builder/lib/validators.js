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
  const collected = new Set();
  for (const c of (AI_CITATIONS.competitors || [])) {
    if (c.name) collected.add(c.name.toLowerCase());
    for (const a of (c.aliases || [])) collected.add(a.toLowerCase());
  }
  // Drop any term whose lowercased form is contained in another term in this list.
  // Example: Native = name "Native" + aliases ["native deodorant", "native"] →
  // collected = {"native", "native deodorant"}. The bare "native" gets dropped because
  // "native deodorant" contains it. Net effect: "in their native habitat" (legitimate
  // English usage) no longer false-flags as a competitor mention, but "Better than
  // Native deodorant" still flags via the longer, brand-specific term. This rule
  // only applies to COMPETITOR_TERMS — GENERIC_BLOCKLIST intentionally keeps both
  // bare ("skincare") and qualified ("natural skincare") forms.
  const all = [...collected];
  return all.filter((term) => !all.some((other) => other !== term && other.includes(term)));
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
 * Build a regex that matches `term` as a complete token (not embedded in
 * another word) for single-word terms, and as a literal substring for
 * multi-word / hyphenated / apostrophe-containing terms.
 *
 * Why: short single-word competitor names like "native" (P&G deodorant brand)
 * substring-matched into common English words like "alternative" — false
 * positive. Word boundaries fix this for short tokens. Multi-word terms
 * ("tom's of maine") and hyphenated prefix patterns ("peg-") are left as
 * substring matches because they don't embed inside other words naturally
 * and we want them to match flexibly.
 *
 * Returns a RegExp with the global flag — caller can use .exec() in a loop
 * or .test() for a one-shot check.
 */
function buildTermRegex(term) {
  const escaped = term.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
  if (/[\s\-']/.test(term)) {
    // Multi-word, hyphenated, or apostrophe-containing — substring match
    return new RegExp(escaped, 'g');
  }
  // Single-word — use word boundary to avoid false positives
  return new RegExp(`\\b${escaped}\\b`, 'g');
}

function containsTermAsWord(text, term) {
  return buildTermRegex(term).test(text);
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

  const allowed = [];
  for (const ing of (spec.base_ingredients || [])) allowed.push(ing.toLowerCase());
  for (const variation of (spec.variations || [])) {
    for (const oil of (variation.essential_oils || [])) allowed.push(oil.toLowerCase());
  }

  // Bidirectional substring match — same matcher as prompt-builder.js's
  // relevantIngredientStories. Handles drift like "Wildcrafted Myrrh" (foundation)
  // ↔ "wildcrafted myrrh powder" (config) without requiring exact alignment.
  const fabricated = [];
  for (const claimed of (claimedIngredients || [])) {
    const c = claimed.toLowerCase();
    const matched = allowed.some((a) => a === c || a.includes(c) || c.includes(a));
    if (!matched) fabricated.push(claimed);
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
 * Scans product-mode marketing prose (body_html) for ingredient mentions
 * we never use. Cluster mode validates structured ingredientCards[].name
 * directly; this is the equivalent gate for prose where ingredient mentions
 * are unstructured.
 *
 * Distinguishes positive claims ("contains fluoride") from brand-positioning
 * negations ("fluoride-free", "no fluoride", "without fluoride") via a small
 * window check around each match. Negated mentions are allowed.
 *
 * Returns { valid, flagged: [{ term, context }] }.
 */
export function validateNoFabricatedIngredients({ text }) {
  const NEGATION_MARKERS = [
    'no ', 'without ', 'free of ', 'free from ', '-free', ' not ', 'does not', "doesn't", "don't",
    // Comparison-style negations: "softer than enamel, unlike the hydrated silica..." frames
    // an ingredient we explicitly don't use. Same for "instead of" and "rather than" substitution patterns.
    'unlike ', 'instead of ', 'rather than ',
  ];
  const FABRICATION_BLOCKLIST = [
    'fluoride',
    'sodium fluoride',
    'stannous fluoride',
    'hydroxyapatite',
    'nano-hydroxyapatite',
    'sodium lauryl sulfate',
    'sls',
    'sodium laureth sulfate',
    'sles',
    'hydrated silica',
    'sodium saccharin',
    'aspartame',
    'sucralose',
    'glycerin',
    'sorbitol',
    'propylene glycol',
    'cetylpyridinium chloride',
    'triclosan',
    'parabens',
    'methylparaben',
    'propylparaben',
    'phthalates',
    'titanium dioxide',
    'peg-',
    'mineral oil',
    'petroleum',
    'petrolatum',
    'aluminum',
    'aluminum chlorohydrate',
  ];

  const stripped = (text || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const lower = stripped.toLowerCase();

  const flagged = [];
  for (const term of FABRICATION_BLOCKLIST) {
    const re = buildTermRegex(term);
    let m;
    while ((m = re.exec(lower)) !== null) {
      const idx = m.index;
      // Check surrounding window for negation markers
      const winStart = Math.max(0, idx - 40);
      const winEnd = Math.min(lower.length, idx + term.length + 20);
      const window = lower.slice(winStart, winEnd);
      const negated = NEGATION_MARKERS.some((mk) => window.includes(mk));
      if (!negated) {
        // Capture readable context for the report
        const ctxStart = Math.max(0, idx - 30);
        const ctxEnd = Math.min(stripped.length, idx + term.length + 30);
        flagged.push({ term, context: stripped.slice(ctxStart, ctxEnd) });
        break; // one flag per term is enough
      }
    }
  }

  return { valid: flagged.length === 0, flagged };
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
    if (containsTermAsWord(lower, term)) errors.push(`${field}: contains competitor term "${term}"`);
  }
  for (const term of GENERIC_BLOCKLIST) {
    if (containsTermAsWord(lower, term)) errors.push(`${field}: contains generic-blocklist term "${term}"`);
  }
  return { valid: errors.length === 0, errors };
}
