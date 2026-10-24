// agents/ad-batch/meta-copy.js
//
// The Meta ad copy for a finished batch: ~4 primary texts and ~4 headlines that run
// around the batch's images, written to `<batch dir>/meta-copy.md`. The Social tab's
// caption writer (lib/social-ingest.js) grounds every suggested caption in this file,
// so without it captions know only the image headline.
//
// Nothing here is a new gate. Every string passes, in one two-attempt budget run by
// lib/seo-copy-gate-loop.js's gateGeneratedCopy:
//   - the commercial health-claim gate (lib/seo-copy-health-gate.js, COMMERCIAL_SURFACE),
//     which gateGeneratedCopy applies itself;
//   - ad-concepts' gateCopy (agents/ad-concepts/copy.js): the AD health gate, the claim
//     gate (agents/ad-studio/claims.js: every factual claim quotes its source verbatim),
//     competitor names, sibling-scent conflicts and "antiperspirant";
//   - three checks this surface adds, because a Meta text is longer than a plate: no em or
//     en dash anywhere, no price or discount at all, and every number in a field must sit
//     inside the evidence of a factual claim cited for that field. The last one is what
//     keeps "7-ingredient base" honest on a scent with 8: the claim gate alone only proves
//     the quote exists somewhere.
//
// Sources are the ones Ad Studio and ad-concepts already cite (live PDP body, the catalog
// entry, screened 4-5 star reviews). The catalog entry is extended with two files we hold
// and already treat as truth: config/ingredients.json (ingredient lists BY PRODUCT AND
// SCENT, so the count stated is the count for the scent pictured) and the operator-approved
// brand facts in config/press-facts.json, minus anything carrying a price, a percentage or
// a review count, which this copy may not state.
//
// Failure policy: one retry naming the violations; a second failure writes NO file and is
// recorded. A copy failure never fails the batch. An existing meta-copy.md is never
// overwritten (a human may have edited it) unless the caller passes rewrite.

import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { LLM_MODELS } from '../../config/llm-models.js';
import { gateGeneratedCopy } from '../../lib/seo-copy-gate-loop.js';
import { COMMERCIAL_SURFACE, SEO_COPY_COMPLIANCE_RULE } from '../../lib/seo-copy-health-gate.js';
import { parseMetaCopy } from '../../lib/social-ingest.js';
import { buildClaimRules, buildVariantBlock } from '../ad-studio/copy.js';
import { normalizeForMatch } from '../ad-studio/claims.js';
import { HEADLINE_MAX_CHARS } from '../ad-studio/flexible.js';
import { gateCopy, FLEXIBLE_CLAIMS_RULE } from '../ad-concepts/copy.js';

export const META_COPY_FILE = 'meta-copy.md';
export const PRIMARY_TEXT_TARGET = 4;
export const HEADLINE_TARGET = 4;
export const MIN_ITEMS = 3;
export const MAX_ITEMS = 5;
// A Meta primary text shows ~125 characters before "See more". Longer texts are allowed
// up to this ceiling; at least one must fit the fold entirely.
export const PRIMARY_TEXT_MAX_CHARS = 300;
export const PRIMARY_TEXT_FOLD_CHARS = 125;
export { HEADLINE_MAX_CHARS };

const DASH_RE = /[–—]/;
const PRICE_RE = /\$\s?\d|\d\s?%|\bpercent\b|\b\d+\s?(?:dollars?|bucks)\b|\b(?:discount|coupon|promo code|on sale|half off|\d+\s?off)\b/i;
const NUM_RE = /\d+(?:[.,]\d+)?/g;
const PRESS_FACT_EXCLUDE_RE = /[$%]|\breviews?\b|\bsubscri/i;

// ── sources ─────────────────────────────────────────────────────────────────

/**
 * Ingredient facts as plain sentences, so a writer can quote one verbatim. Keyed on the
 * handle (config/ingredients.json's shopify_handle) and the scent id. A scent that adds
 * nothing to the base says so, which is what lets "7 ingredients" be true of Pure
 * Unscented and false of Coconut Breeze.
 */
export function ingredientFacts(ingredients, handle, variant) {
  const entry = Object.values(ingredients || {}).find((e) => e?.shopify_handle === handle);
  if (!entry || !Array.isArray(entry.base_ingredients)) return [];
  const name = entry.name || handle;
  const base = entry.base_ingredients;
  const facts = [`The ${name} base formula has ${base.length} ingredients: ${base.join(', ')}.`];
  const v = (entry.variations || []).find((x) => x.id === variant);
  if (v) {
    const oils = v.essential_oils || [];
    const all = [...base, ...oils];
    facts.push(oils.length
      ? `${name} in ${v.name} has ${all.length} ingredients in total: ${all.join(', ')}.`
      : `${name} in ${v.name} has ${all.length} ingredients in total, nothing added to the base: ${all.join(', ')}.`);
  }
  return facts;
}

export function siblingVariants(ingredients, handle, variant) {
  if (!variant) return [];
  const entry = Object.values(ingredients || {}).find((e) => e?.shopify_handle === handle);
  return (entry?.variations || []).map((v) => v.id).filter((id) => id && id !== variant).sort();
}

/** Brand facts the operator approved for outreach, minus prices, percentages and review counts. */
export function brandFacts(pressFacts) {
  return (pressFacts?.brand?.facts || []).map(String).filter((f) => f.trim() && !PRESS_FACT_EXCLUDE_RE.test(f));
}

const slugify = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/**
 * Where the ad sends people. A `landing` in the batch file wins (a full realskincare.com
 * URL or a path). Otherwise a single product goes to its PDP. A set goes to the bundle in
 * config/bundles.json whose components are exactly the set's products (and scents, when
 * every item names one); with no such bundle it falls back to the first product's PDP and
 * says so.
 */
export function resolveLanding({ landing = null, items, catalog = {}, bundles = [], siteUrl }) {
  const site = String(siteUrl || 'https://www.realskincare.com').replace(/\/$/, '');
  if (landing) return { url: /^https?:\/\//i.test(landing) ? landing : `${site}/${landing.replace(/^\//, '')}`, source: 'batch file', handle: null };
  const pdp = (h) => catalog[h]?.url || `${site}/products/${h}`;
  if (items.length === 1) return { url: pdp(items[0].handle), source: 'product page', handle: items[0].handle };
  const want = items.map((i) => `${i.handle}/${i.variant || ''}`).sort().join('|');
  const wantHandles = items.map((i) => i.handle).sort().join('|');
  const scoped = items.every((i) => i.variant);
  for (const b of bundles || []) {
    for (const v of b.variants || []) {
      const comps = v.components || [];
      if (comps.length !== items.length) continue;
      const handles = comps.map((c) => c.product).sort().join('|');
      const exact = comps.map((c) => `${c.product}/${slugify(c.variant)}`).sort().join('|');
      if (scoped ? exact === want : handles === wantHandles) return { url: pdp(b.handle), source: `bundle ${b.handle}`, handle: b.handle };
    }
  }
  return { url: pdp(items[0].handle), source: 'first product page (no bundle matches this set)', handle: items[0].handle };
}

// ── prompt / parse ──────────────────────────────────────────────────────────

/**
 * @param {{ title:string, items:Array<{handle,variant,title}>, variant:string|null, concepts:Array<{headline,subhead,dir}>,
 *           landing:{url}, pdpBodies:Array<{handle,body}>, catalogEntry:object, reviews:string[], sourceIds:string[] }} o
 */
export function buildMetaCopyPrompt({ title, items, variant, concepts, landing, pdpBodies = [], catalogEntry, reviews = [], sourceIds }) {
  const isSet = items.length > 1;
  const conceptLines = concepts.map((c, i) => `  ${i + 1}. on-image headline: "${c.headline}"${c.subhead ? `, with the line "${c.subhead}"` : ''}`);
  return `You are writing the Meta ad copy for a batch of static ads for Real Skin Care.

THE JOB OF THIS AD: sell the product. The reader should want to buy it.

${isSet ? `PRODUCT: a SET, ${title}, which is ${items.map((i) => `${i.title}${i.variant ? ` (${i.variant})` : ''}`).join(' plus ')}. Every image shows the whole set, so the copy sells the SET, not one product in it.` : `PRODUCT: ${title}${variant ? ` (${variant})` : ''}`}
LANDING PAGE: ${landing.url}
${buildVariantBlock(isSet ? null : variant)}
THE IMAGES. Each folder of images carries one of these on-image headlines, set into the picture:
${conceptLines.join('\n')}

You write the fields Meta renders AROUND those images: the PRIMARY TEXT (above the image)
and the HEADLINE (below it). Map the copy onto the images: each image headline should have
at least one primary text that continues its idea and at least one headline that echoes it,
so the ad and the image say the same thing. Never contradict an image headline.

PRODUCT PAGE COPY (a source you may cite as "pdp"):
${pdpBodies.map((p) => (isSet ? `[${p.handle}]\n${p.body}` : p.body)).join('\n\n') || '(none)'}

PRODUCT FACTS (a source you may cite as "catalog"). Ingredient counts here are BY SCENT: quote
the count for the scent named above, never a different scent's count:
${JSON.stringify(catalogEntry, null, 1)}

${reviews.length ? `CUSTOMER REVIEWS (a source you may cite as "reviews"), real, verbatim, 4 and 5 star:
${reviews.slice(0, 6).map((r, i) => `  [${i + 1}] ${String(r).slice(0, 400)}`).join('\n')}
` : ''}
Write exactly ${PRIMARY_TEXT_TARGET} primary texts and exactly ${HEADLINE_TARGET} headlines.

- Primary texts: each ${PRIMARY_TEXT_MAX_CHARS} characters or fewer, written as one paragraph (no line breaks).
  Meta shows about the first ${PRIMARY_TEXT_FOLD_CHARS} characters before "See more", so the hook must land
  inside them. At least one primary text must be ${PRIMARY_TEXT_FOLD_CHARS} characters or fewer in total.
- Headlines: each ${HEADLINE_MAX_CHARS} characters or fewer.
- Each primary text is a complete small ad: a first sentence that stops a scroller (a specific
  observation, a contrast, a question the buyer is already asking), then the concrete reason to
  believe it, then a short close that sends them to the landing page. Specific beats general:
  name the real ingredient, the real texture, the real use (heels, hands, elbows), never "amazing results".
- If the product facts include a money-back guarantee, one text should close on it; it removes the main hesitation.
- The texts must be genuinely DIFFERENT ANGLES, and so must the headlines. Meta pairs every
  text with every headline and learns which wins; two phrasings of one idea teach it nothing.
- Plain human voice. No em dashes or en dashes anywhere (use commas, periods or colons). No emoji. No links.
- No price, dollar amount, percentage, discount, sale or offer of any kind.
- Every number you write (an ingredient count, a size, a number of days) must be quoted in the
  "evidence" of a factual claim for that same field.
- RSC sells a DEODORANT, never an antiperspirant. Never call any of our products an antiperspirant.

RULES:
${buildClaimRules({ sourceIds, unit: 'field' })}

${SEO_COPY_COMPLIANCE_RULE}

${FLEXIBLE_CLAIMS_RULE}

Respond with JSON only, no commentary:
{
  "primaryTexts": ["...", "...", "...", "..."],
  "headlines": ["...", "...", "...", "..."],
  "pairing": [ { "image": 1, "primaryTexts": [1, 4], "headlines": [1] } ],
  "claims": [
    { "zone": "primaryText1", "text": "...", "factual": true, "sourceId": "catalog", "evidence": "..." }
  ]
}
In claims, "zone" is one of primaryText1..primaryText${PRIMARY_TEXT_TARGET}, headline1..headline${HEADLINE_TARGET}.
In pairing, "image" is the number of the on-image headline in the list above.`;
}

function extractJson(raw) {
  const s = String(raw || '').trim();
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : s;
  try { return JSON.parse(candidate); } catch { /* fall through */ }
  const a = candidate.indexOf('{');
  const b = candidate.lastIndexOf('}');
  if (a !== -1 && b > a) { try { return JSON.parse(candidate.slice(a, b + 1)); } catch { /* fall through */ } }
  return null;
}

const oneLine = (s) => String(s || '').replace(/\s+/g, ' ').trim();

/** Validate shape and Meta's limits. Throws a message the retry prompt can quote. */
export function parseMetaCopyResponse(raw, { conceptCount = 0 } = {}) {
  const obj = extractJson(raw);
  if (!obj) throw new Error('the response was not JSON');
  const list = (key, max) => {
    if (!Array.isArray(obj[key])) throw new Error(`the response has no "${key}" array`);
    const clean = obj[key].map(oneLine);
    if (clean.length < MIN_ITEMS || clean.length > MAX_ITEMS) throw new Error(`write ${key === 'headlines' ? HEADLINE_TARGET : PRIMARY_TEXT_TARGET} ${key} (got ${clean.length})`);
    clean.forEach((s, i) => { if (!s) throw new Error(`${key}[${i}] is empty`); });
    if (new Set(clean.map((s) => s.toLowerCase())).size !== clean.length) throw new Error(`the ${key} are not distinct`);
    const long = clean.filter((s) => s.length > max);
    if (long.length) throw new Error(`${key} over ${max} characters: ${long.map((s) => `"${s}" (${s.length})`).join('; ')}`);
    return clean;
  };
  const primaryTexts = list('primaryTexts', PRIMARY_TEXT_MAX_CHARS);
  const headlines = list('headlines', HEADLINE_MAX_CHARS);
  if (!primaryTexts.some((t) => t.length <= PRIMARY_TEXT_FOLD_CHARS)) {
    throw new Error(`at least one primary text must be ${PRIMARY_TEXT_FOLD_CHARS} characters or fewer (shortest is ${Math.min(...primaryTexts.map((t) => t.length))})`);
  }
  const idx = (arr, n) => (Array.isArray(arr) ? [...new Set(arr.map(Number).filter((x) => Number.isInteger(x) && x >= 1 && x <= n))] : []);
  const pairing = (Array.isArray(obj.pairing) ? obj.pairing : [])
    .map((p) => ({ image: Number(p?.image), primaryTexts: idx(p?.primaryTexts, primaryTexts.length), headlines: idx(p?.headlines, headlines.length) }))
    .filter((p) => Number.isInteger(p.image) && p.image >= 1 && p.image <= conceptCount && (p.primaryTexts.length || p.headlines.length));
  return { primaryTexts, headlines, pairing, claims: Array.isArray(obj.claims) ? obj.claims : [] };
}

export function metaCopyZones({ primaryTexts, headlines }) {
  const z = {};
  primaryTexts.forEach((t, i) => { z[`primaryText${i + 1}`] = t; });
  headlines.forEach((h, i) => { z[`headline${i + 1}`] = h; });
  return z;
}

// ── checks ──────────────────────────────────────────────────────────────────

/** Numbers in a field that no factual claim for that field quotes in its evidence. */
export function unsourcedNumbers(fields, claims) {
  const out = [];
  for (const [zone, text] of Object.entries(fields)) {
    const evidence = (claims || [])
      .filter((c) => c && typeof c === 'object' && c.zone === zone && c.factual !== false && c.evidence)
      .map((c) => normalizeForMatch(c.evidence)).join(' ');
    const have = new Set(evidence.match(NUM_RE) || []);
    for (const n of new Set(String(text).match(NUM_RE) || [])) if (!have.has(n)) out.push({ zone, n });
  }
  return out;
}

/**
 * Everything this surface checks beyond the commercial health gate, as gate-loop
 * violations. `ctx` is gateCopy's: { sourceIndex, competitorNames, variant, siblingVariants }.
 */
export function metaCopyViolations(fields, claims, ctx) {
  const hits = [];
  const g = gateCopy(fields, claims, ctx);
  for (const r of g.reasons) hits.push({ field: 'copy', category: 'ad-gate', why: r, match: '' });
  for (const [k, v] of Object.entries(fields)) {
    if (DASH_RE.test(v)) hits.push({ field: k, category: 'dash', why: 'em or en dash; use a comma, period or colon', match: v.match(DASH_RE)[0] });
    const p = String(v).match(PRICE_RE);
    if (p) hits.push({ field: k, category: 'price', why: 'no price, percentage or discount in this copy', match: p[0] });
  }
  for (const u of unsourcedNumbers(fields, claims)) {
    hits.push({ field: u.zone, category: 'unsourced-number', why: `the number ${u.n} is not quoted in the evidence of a factual claim for ${u.zone}`, match: u.n });
  }
  return hits;
}

/**
 * Write the copy through the shared two-attempt gate loop. Model errors propagate; the
 * caller (writeBatchMetaCopy) turns them into a recorded failure.
 * @returns {Promise<{ok:boolean, copy?:object, violations:object[], attempts:number}>}
 */
export async function generateMetaCopy({ anthropic, model = LLM_MODELS.standard, prompt, conceptCount, gateCtx }) {
  let current = null;
  const generate = async (constraint) => {
    const content = constraint
      ? `${prompt}\n\nYOUR PREVIOUS ATTEMPT WAS REJECTED FOR:\n${constraint}\nFix every one and return the whole JSON again.`
      : prompt;
    const msg = await anthropic.messages.create({ model, max_tokens: 3000, messages: [{ role: 'user', content }] });
    if (msg.stop_reason === 'max_tokens') { current = { error: 'the response was cut off at the token limit' }; return current; }
    const text = (msg.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    try { current = parseMetaCopyResponse(text, { conceptCount }); } catch (e) { current = { error: e.message }; }
    return current;
  };
  const r = await gateGeneratedCopy(generate, {
    extract: (res) => (res?.error ? {} : metaCopyZones(res)),
    surface: COMMERCIAL_SURFACE,
    extraChecks: [
      {
        check: () => (current?.error ? [{ field: 'response', category: 'malformed', why: current.error, match: '' }] : []),
        constraint: (hits) => hits.map((h) => `- ${h.why}`).join('\n'),
      },
      {
        check: (fields) => (current?.error ? [] : metaCopyViolations(fields, current.claims, gateCtx)),
        constraint: (hits) => {
          const lines = hits.map((h) => `- ${h.field === 'copy' ? '' : `${h.field}: `}${h.why}${h.match ? ` ("${h.match}")` : ''}`);
          if (hits.some((h) => /unsourced|evidence|sourceId/.test(h.why) || h.category === 'unsourced-number')) lines.push(FLEXIBLE_CLAIMS_RULE);
          return lines.join('\n');
        },
      },
    ],
  });
  return r.ok
    ? { ok: true, copy: r.proposed, violations: [], attempts: r.attempts }
    : { ok: false, copy: null, violations: r.violations, attempts: r.attempts };
}

// ── file ────────────────────────────────────────────────────────────────────

const joinNums = (ns) => {
  const a = [...ns].sort((x, y) => x - y).map(String);
  return a.length > 1 ? `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}` : a[0];
};

/** The markdown lib/social-ingest.js reads: numbered lists under "Primary texts" and "Headlines". */
export function renderMetaCopyMarkdown({ title, landing, concepts, copy, generatedAt }) {
  const folder = (c, i) => (c.dir ? basename(c.dir) : `${String(i + 1).padStart(2, '0')} ${c.headline}`);
  const pairLines = (copy.pairing || []).map((p) => {
    const c = concepts[p.image - 1];
    const parts = [];
    if (p.primaryTexts.length) parts.push(`primary text${p.primaryTexts.length > 1 ? 's' : ''} ${joinNums(p.primaryTexts)}`);
    if (p.headlines.length) parts.push(`headline${p.headlines.length > 1 ? 's' : ''} ${joinNums(p.headlines)}`);
    return `- ${folder(c, p.image - 1)}: ${parts.join(', ')}`;
  });
  const claimLines = (copy.claims || []).filter((c) => c && typeof c === 'object' && c.factual !== false && c.sourceId)
    .map((c) => `- ${c.zone}: "${oneLine(c.text)}" from ${c.sourceId}: "${oneLine(c.evidence)}"`);
  return [
    `# ${title}: Meta copy`,
    '',
    `Landing page: ${landing.url}`,
    `Written by agents/ad-batch on ${generatedAt.slice(0, 10)}. Every factual claim was checked against the product page, the product facts files or customer reviews, and the copy passed the commercial health-claim gate. Edit freely: ad-batch never overwrites this file unless run with --rewrite-copy.`,
    '',
    '## Primary texts',
    '',
    ...copy.primaryTexts.map((t, i) => `${i + 1}. ${t}`),
    '',
    '## Headlines',
    '',
    ...copy.headlines.map((h, i) => `${i + 1}. ${h}`),
    '',
    ...(pairLines.length ? ['## Which copy goes with which image folder', '', ...pairLines, ''] : []),
    ...(claimLines.length ? ['## Sources for each claim', '', ...claimLines, ''] : []),
  ].join('\n');
}

/**
 * Load the sources for a batch's product or set. Fetches are injected.
 * deps: { root, catalog, ingredients, pressFacts, bundles, siteUrl, competitorNames,
 *         fetchPdpBody(handle), fetchReviews(handle), selectReviews(reviews) }
 */
export async function loadMetaCopySources({ items, landing, deps, log = () => {} }) {
  const pdpBodies = [];
  for (const it of items) {
    try { const body = await deps.fetchPdpBody(it.handle); if (body) pdpBodies.push({ handle: it.handle, body }); }
    catch (err) { log(`  meta copy: no product page body for ${it.handle} (${err.message}); continuing without it`); }
  }
  let raw = [];
  for (const it of items) {
    try { raw.push(...((await deps.fetchReviews(it.handle)) || [])); } catch { /* reviews are optional */ }
  }
  const reviews = deps.selectReviews ? deps.selectReviews(raw) : raw;
  const strip = (e) => (e ? { title: e.title, url: e.url } : null);
  const products = Object.fromEntries(items.map((it) => [it.handle, {
    ...strip(deps.catalog[it.handle]),
    scent: it.variant || null,
    ingredients: ingredientFacts(deps.ingredients, it.handle, it.variant),
  }]));
  const catalogEntry = { products, ...(landing.handle && items.length > 1 && deps.catalog[landing.handle] ? { set: strip(deps.catalog[landing.handle]) } : {}), brand_facts: brandFacts(deps.pressFacts) };
  return { pdpBodies, reviews, catalogEntry };
}

/**
 * Write `<batchDir>/meta-copy.md` for a finished batch, and return the outcome for run.json.
 * Never throws.
 *
 * @param {object} o
 * @param {string} o.batchDir
 * @param {object} o.record   the run record (or run.json): product, concepts[], landing?
 * @param {boolean} [o.rewrite]
 * @param {object} o.deps      loadMetaCopySources deps + { anthropic, now?() }
 */
export async function writeBatchMetaCopy({ batchDir, record, rewrite = false, deps, log = console.log }) {
  const path = join(batchDir, META_COPY_FILE);
  const now = (deps.now ? deps.now() : new Date()).toISOString();
  const base = { path, at: now };
  try {
    if (existsSync(path) && !rewrite) {
      log(`Meta copy: ${META_COPY_FILE} already exists, left as it is (pass --rewrite-copy to replace it).`);
      return { ...base, status: 'kept-existing' };
    }
    const concepts = (record.concepts || []).filter((c) => (c.kept ?? 1) > 0 && c.headline);
    if (!concepts.length) return { ...base, status: 'skipped', reason: 'no concept kept an image' };
    const p = record.product || {};
    const items = (p.items?.length ? p.items : [{ handle: p.handle, variant: p.variant }])
      .map((i) => ({ handle: i.handle, variant: i.variant || null, title: deps.catalog[i.handle]?.title || i.handle }));
    const isSet = items.length > 1;
    const variants = [...new Set(items.map((i) => i.variant))];
    const variant = variants.length === 1 ? variants[0] : null;
    const landing = resolveLanding({ landing: record.landing || null, items, catalog: deps.catalog, bundles: deps.bundles, siteUrl: deps.siteUrl });
    const title = p.title || items.map((i) => i.title).join(' + ');

    log('\nWriting the Meta copy for this batch...');
    const { pdpBodies, reviews, catalogEntry } = await loadMetaCopySources({ items, landing, deps, log });
    const sourceIndex = {
      ...(pdpBodies.length ? { pdp: pdpBodies.map((b) => b.body).join('\n') } : {}),
      catalog: catalogEntry,
      ...(reviews.length ? { reviews: reviews.join(' ') } : {}),
    };
    const siblings = isSet || !variant ? [] : siblingVariants(deps.ingredients, items[0].handle, variant);
    const prompt = buildMetaCopyPrompt({
      title, items: items.map((i) => ({ ...i, title: i.title })), variant: isSet ? null : variant, concepts, landing,
      pdpBodies, catalogEntry, reviews, sourceIds: Object.keys(sourceIndex),
    });
    const gateCtx = { sourceIndex, competitorNames: deps.competitorNames || [], variant, siblingVariants: siblings };
    const r = await generateMetaCopy({ anthropic: deps.anthropic, prompt, conceptCount: concepts.length, gateCtx });
    if (!r.ok) {
      const reason = r.violations.map((v) => `${v.field}: ${v.why}${v.match ? ` ("${v.match}")` : ''}`).join('; ');
      log(`⚠ Meta copy failed the gates twice, no ${META_COPY_FILE} written: ${reason}\n  Social captions will be grounded in the image headlines only.`);
      return { ...base, status: 'failed', reason, attempts: r.attempts, landing: landing.url };
    }
    const md = renderMetaCopyMarkdown({ title, landing, concepts, copy: r.copy, generatedAt: now });
    const back = parseMetaCopy(md);
    if (JSON.stringify(back) !== JSON.stringify({ primaryTexts: r.copy.primaryTexts, headlines: r.copy.headlines })) {
      log(`⚠ Meta copy did not round-trip through the Social parser, no ${META_COPY_FILE} written.`);
      return { ...base, status: 'failed', reason: 'markdown did not round-trip through lib/social-ingest.js parseMetaCopy', attempts: r.attempts };
    }
    let backup = null;
    if (existsSync(path)) { backup = join(batchDir, `meta-copy.previous-${now.replace(/[:.]/g, '-')}.md`); copyFileSync(path, backup); }
    writeFileSync(path, md);
    log(`Meta copy: ${r.copy.primaryTexts.length} primary texts, ${r.copy.headlines.length} headlines → ${path}${backup ? ` (previous copy kept at ${basename(backup)})` : ''}`);
    return { ...base, status: 'written', attempts: r.attempts, landing: landing.url, landingSource: landing.source, primaryTexts: r.copy.primaryTexts, headlines: r.copy.headlines, claims: r.copy.claims, ...(backup ? { previous: backup } : {}) };
  } catch (err) {
    log(`⚠ Meta copy step failed, no ${META_COPY_FILE} written: ${err.message}`);
    return { ...base, status: 'failed', reason: err.message };
  }
}

/** The real deps for writeBatchMetaCopy, read from the repo. Network fetchers are lazy. */
export async function defaultMetaCopyDeps({ root, anthropic, env = process.env }) {
  const load = (p) => JSON.parse(readFileSync(join(root, p), 'utf8'));
  const studio = await import('../ad-studio/index.js');
  const { selectQuotableReviews } = await import('../ad-studio/health-claims.js');
  const siteUrl = load('config/site.json').url;
  return {
    anthropic,
    catalog: load('data/brand/product-catalog.json').products || {},
    ingredients: load('config/ingredients.json'),
    pressFacts: load('config/press-facts.json'),
    bundles: load('config/bundles.json').bundles || [],
    competitorNames: load('config/competitors.json').map((c) => c.name),
    siteUrl,
    fetchPdpBody: (handle) => studio.fetchPdpBody(siteUrl, handle),
    fetchReviews: (handle) => studio.fetchAdReviews(handle, { env }),
    selectReviews: selectQuotableReviews,
  };
}

