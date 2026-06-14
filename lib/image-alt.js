// lib/image-alt.js
// Build descriptive, keyword-anchored alt text for a hero image. Deterministic
// (no extra LLM call) — derived from the creative-director scene + target keyword.

export function buildImageAlt({ keyword, title, scene } = {}) {
  const kw = (keyword || title || 'product').trim();
  let base = (scene || '').replace(/\s+/g, ' ').trim();
  if (base) {
    const firstWord = kw.toLowerCase().split(' ')[0];
    if (kw && firstWord && !base.toLowerCase().includes(firstWord)) base = `${kw} — ${base}`;
  } else {
    base = title ? `${kw}: ${title}` : kw;
  }
  if (base.length <= 125) return base;
  return base.slice(0, 122).replace(/\s+\S*$/, '') + '…';
}
