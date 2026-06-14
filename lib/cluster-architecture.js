// lib/cluster-architecture.js
// Pure: pick the "pillar" post of a cluster — the broadest, highest-authority page
// that supporting (spoke) posts should link to. Heuristic: most impressions, then
// best (lowest) position, then shortest (broadest) keyword.

export function identifyPillar(posts) {
  const list = (posts || []).filter(Boolean);
  if (!list.length) return null;
  const score = (p) => ({
    impr: p.impressions || 0,
    pos: (p.position == null ? Infinity : p.position),
    kwLen: (p.keyword || '').length,
  });
  return [...list].sort((a, b) => {
    const A = score(a), B = score(b);
    if (B.impr !== A.impr) return B.impr - A.impr;        // more impressions first
    if (A.pos !== B.pos) return A.pos - B.pos;            // better position
    return A.kwLen - B.kwLen;                              // shorter/broader keyword
  })[0];
}
