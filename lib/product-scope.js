// lib/product-scope.js
// Single source of truth for "is this keyword on-brand for Real Skin Care?".
// Extracted from content-strategist so any agent (e.g. pipeline-prioritizer) can
// gate ideas against product scope without importing an agent module.

export const PRODUCT_SCOPE_TERMS = [
  'deodorant', 'antiperspirant',
  'toothpaste', 'tooth paste', 'oral',
  'lotion', 'moisturizer', 'moisturiser',
  'cream', 'body butter',
  'soap',
  'lip balm', 'lip',
  'coconut oil',
];

export function isInProductScope(keyword) {
  const kw = (keyword || '').toLowerCase();
  return PRODUCT_SCOPE_TERMS.some((t) => kw.includes(t));
}
