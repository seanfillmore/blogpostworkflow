// agents/ad-batch/scenes.js
//
// Which scenes a headline gets: ~12 from the library, spread across families and
// rotated by least-recent use, plus a few generated fresh for that headline.
// Selection is pure; the fresh-scene call takes an injected client.

export const LIBRARY_SHARE = 12;
const DEFAULT_TYPE_STYLE = 'a typeface pairing that suits the scene, for example a flowing script with a bold serif';

function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

export function suitsCategory(scene, category) {
  const s = scene.suits || ['all'];
  return s.includes('all') || s.includes(category);
}

/**
 * Pick `n` library scenes for one headline.
 *
 * Order of preference: never used, then least recently used; ties broken by a hash of
 * (seed, id) so two headlines in one batch do not get identical sets. One scene per
 * family first, so a batch is never twelve beaches; then fill.
 *
 * @param {object} args
 * @param {{families:string[], scenes:object[]}} args.library
 * @param {string} args.category
 * @param {number} args.n
 * @param {Record<string,string>} [args.usage] scene id -> ISO time last used
 * @param {string} [args.seed] usually the headline
 * @param {Set<string>} [args.exclude] ids already taken (e.g. by an earlier headline this run)
 */
export function selectLibraryScenes({ library, category, n, usage = {}, seed = '', exclude = new Set() }) {
  const pool = library.scenes.filter(s => suitsCategory(s, category));
  const rank = (s) => [usage[s.id] || '', exclude.has(s.id) ? 1 : 0, hash(seed + '|' + s.id)];
  const sorted = [...pool].sort((a, b) => {
    const [ua, ea, ha] = rank(a); const [ub, eb, hb] = rank(b);
    if (ea !== eb) return ea - eb; // scenes another headline already took this run go last
    if (ua !== ub) return ua < ub ? -1 : 1; // '' (never used) sorts first
    return ha - hb;
  });
  // Deal round-robin across families (rotated by seed), best-ranked first within each,
  // so twelve scenes span seven families as evenly as the pool allows.
  const chosen = [];
  const families = library.families || [];
  const start = hash(seed) % Math.max(families.length, 1);
  const order = families.map((_, i) => families[(start + i) % families.length]);
  const queues = order.map(fam => sorted.filter(x => x.family === fam));
  const orphans = sorted.filter(x => !families.includes(x.family));
  while (chosen.length < n && queues.some(q => q.length)) {
    for (const q of queues) {
      if (chosen.length >= n) break;
      const s = q.shift();
      if (s) chosen.push(s);
    }
  }
  for (const s of orphans) { if (chosen.length >= n) break; chosen.push(s); }
  return chosen.map(s => ({ ...s, source: 'library' }));
}

/** Sean's own scene list for a batch: each line becomes a scene. */
export function customScenes(lines) {
  return lines.map((text, i) => ({
    id: `custom-${String(i + 1).padStart(2, '0')}`,
    family: 'custom',
    scene: text,
    typeStyle: DEFAULT_TYPE_STYLE,
    hands: /\bhands?\b/i.test(text),
    inUse: /\b(lather|lathering|shower|washing|in use)\b/i.test(text),
    source: 'custom',
  }));
}

export function freshScenePrompt({ product, concept, chosen, k, families }) {
  return `You are an art director planning scroll-stopping product ads for Meta.

Product: ${product.title} (Real Skin Care). Category: ${product.category}.
Headline that will be set on the ad: "${concept.headline}"${concept.subhead ? `\nSubhead: "${concept.subhead}"` : ''}

These scenes are already in the batch, so yours must be clearly DIFFERENT settings from all of them:
${chosen.map(s => `- ${s.scene}`).join('\n')}

Propose exactly ${k} NEW scenes that fit this product and the mood of this headline. Each is one photographic setting with props, light and palette, where the product sits as the hero. Rules:
- No people's faces. Hands are allowed but use them in at most one scene.
- No text, signs, labels or packaging of other brands in the scene.
- Nothing that implies a medical or clinical setting.
- Vary the families: ${families.join(', ')}.
- For each, give a typeStyle: the headline lettering that suits the scene (name a pairing, e.g. "a bold condensed sans paired with a light sans, white").

Answer with ONLY a JSON array, no prose:
[{"id":"kebab-case-name","family":"<one family>","scene":"<one or two sentences>","typeStyle":"<pairing>","hands":false,"inUse":false}]
"inUse" is true only when the product is visibly being used (lather, water running on it).`;
}

/** Parse and sanitise the model's fresh scenes. Returns [] on anything unusable. */
export function parseFreshScenes(text, { k, takenIds = new Set() } = {}) {
  const m = String(text || '').match(/\[[\s\S]*\]/);
  if (!m) return [];
  let arr;
  try { arr = JSON.parse(m[0]); } catch { return []; }
  if (!Array.isArray(arr)) return [];
  const out = [];
  const ids = new Set(takenIds);
  for (const s of arr) {
    if (!s || typeof s.scene !== 'string' || !s.scene.trim()) continue;
    let id = String(s.id || 'fresh').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'fresh';
    id = `fresh-${id}`;
    while (ids.has(id)) id += '-2';
    ids.add(id);
    out.push({
      id,
      family: String(s.family || 'fresh'),
      scene: s.scene.trim(),
      typeStyle: typeof s.typeStyle === 'string' && s.typeStyle.trim() ? s.typeStyle.trim() : DEFAULT_TYPE_STYLE,
      hands: !!s.hands,
      inUse: !!s.inUse,
      source: 'fresh',
    });
    if (out.length >= k) break;
  }
  return out;
}

/**
 * Generate k fresh scenes. On any failure, degrade to more library scenes and say why;
 * a batch is never lost because the planner hiccupped.
 */
export async function generateFreshScenes({ anthropic, model, product, concept, chosen, k, library }) {
  if (k <= 0) return { scenes: [], degraded: null };
  try {
    const res = await anthropic.messages.create({
      model,
      max_tokens: 2500,
      messages: [{ role: 'user', content: freshScenePrompt({ product, concept, chosen, k, families: library.families }) }],
    });
    const text = (res.content || []).map(c => c.text || '').join('');
    const scenes = parseFreshScenes(text, { k, takenIds: new Set(chosen.map(s => s.id)) });
    if (scenes.length) return { scenes, degraded: scenes.length < k ? `planner returned ${scenes.length} of ${k} fresh scenes` : null };
    return { scenes: [], degraded: 'planner returned no usable scenes' };
  } catch (err) {
    return { scenes: [], degraded: `planner failed: ${err.message}` };
  }
}
