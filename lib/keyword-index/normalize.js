/**
 * Canonical keyword key derivation.
 *
 * `normalize` produces the canonical keyword text used as the
 * `keyword` field. `slug` produces the URL-safe key used as the
 * object key in keyword-index.json.
 *
 * Both must be idempotent and stable so the same logical query from
 * GSC and Amazon collapses to the same entry.
 */

export function normalize(s) {
  if (!s) return '';
  let out = String(s).toLowerCase();
  // Strip leading/trailing punctuation (anything that isn't word, apostrophe, hyphen)
  out = out.replace(/^[^\w']+|[^\w']+$/gu, '');
  // Collapse internal whitespace (spaces, tabs, newlines) to single space
  out = out.replace(/\s+/g, ' ');
  return out.trim();
}

export function slug(s) {
  return normalize(s)
    .replace(/'/g, '')           // drop apostrophes for URL safety
    .replace(/[^\w\s-]/g, '')    // drop other punctuation
    .replace(/\s+/g, '-')        // spaces → hyphens
    .replace(/-+/g, '-');        // collapse double-hyphens
}
