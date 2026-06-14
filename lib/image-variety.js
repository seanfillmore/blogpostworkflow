// lib/image-variety.js
// Shot-type variety for blog hero images.
//
// The scene templates only vary the *surface* a product sits on, so every image
// ended up being "an object on a tabletop." This adds a SHOT-TYPE dimension —
// genuinely different compositions (action, macro, environmental, editorial) —
// that rotates across posts so consecutive heroes don't look alike.

/**
 * Distinct shot genres. `surface: true` means the shot is a still-life on one of
 * the SCENE_TEMPLATES surfaces; `surface: false` shots describe their own
 * composition/setting and don't use a template.
 */
export const SHOT_TYPES = [
  {
    key: 'flat-lay',
    surface: true,
    guidance: 'Overhead flat-lay — subject and props arranged on a surface, shot straight down. Pick a SCENE_TEMPLATE for the surface.',
  },
  {
    key: 'styled-angle',
    surface: true,
    guidance: 'Three-quarter still-life at a 30–45° angle on a surface, with depth and soft falloff. Pick a SCENE_TEMPLATE for the surface.',
  },
  {
    key: 'in-use',
    surface: false,
    guidance: 'Candid in-use moment — a person (hands, or shoulders-down/profile) actively using the subject in a real setting: applying lotion, brushing teeth, lathering soap, doing laundry. Lifestyle feel, natural light. Describe the real setting; SELECTED_TEMPLATE: NONE.',
  },
  {
    key: 'macro-detail',
    surface: false,
    guidance: 'Extreme close-up macro — texture and detail of the subject (lotion swirl, soap lather, balm sheen, brush bristles, water droplets). Shallow depth of field, fills the frame. SELECTED_TEMPLATE: NONE.',
  },
  {
    key: 'environmental',
    surface: false,
    guidance: 'Wide environmental shot — the real-world room or place where the topic lives (a sunlit bathroom vanity, a laundry nook, a gym bag, a vintage/historical scene for "history" topics), with the subject nestled naturally inside. SELECTED_TEMPLATE: NONE.',
  },
  {
    key: 'editorial-concept',
    surface: false,
    guidance: 'Editorial/conceptual composition that visually expresses the idea (an ingredient story, a before/after contrast, a visual metaphor). Magazine-cover styling, intentional negative space. SELECTED_TEMPLATE: NONE.',
  },
];

/**
 * Choose a working pool of items whose `key` hasn't been used recently. If
 * excluding all recent keys leaves fewer than `minPool`, forgive the OLDEST
 * exclusions first (keeping the most-recent ones out the longest) until the pool
 * is big enough. Falls back to all items if it still can't reach minPool.
 *
 * @param {Array<{key:string}>} items
 * @param {string[]} usedKeys ordered oldest→newest
 * @param {number} minPool
 */
export function pickPool(items, usedKeys = [], minPool = 3) {
  let exclude = [...usedKeys];
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const ex = new Set(exclude);
    const pool = items.filter((i) => !ex.has(i.key));
    if (pool.length >= minPool || exclude.length === 0) {
      return pool.length ? pool : items;
    }
    exclude.shift(); // forgive the oldest excluded key, then retry
  }
}

/**
 * Choose the shot-type shortlist for the next image. Enforces "no two
 * surface (flat-lay / styled-angle) shots in a row" — the model has a strong
 * flat-lay prior, so after any surface shot we restrict the pool to the
 * non-surface genres. This guarantees a real mix instead of endless tabletops.
 *
 * @param {string[]} usedShotTypes ordered oldest→newest
 */
export function shotTypePool(usedShotTypes = [], { minPool = 2 } = {}) {
  const last = usedShotTypes[usedShotTypes.length - 1];
  const lastWasSurface = SHOT_TYPES.find((s) => s.key === last)?.surface === true;
  const candidates = lastWasSurface ? SHOT_TYPES.filter((s) => !s.surface) : SHOT_TYPES;
  return pickPool(candidates, usedShotTypes, minPool);
}
