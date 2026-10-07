// agents/ad-batch/batch.js
//
// The batch file and the product it names. Pure apart from existsSync/readdirSync
// on the reference photo directories, which are injected for tests.

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { buildLabelStrings } from '../ad-studio/index.js';
import { checkSeoCopyFields, COMMERCIAL_SURFACE } from '../../lib/seo-copy-health-gate.js';

export const MIN_COUNT = 15;
export const MAX_COUNT = 20;
export const DEFAULT_COUNT = 16;

// Product category decides which library scenes suit it. Keyed on the handle, because
// that is what the manifest and the batch file both carry.
const CATEGORY_BY_HANDLE = {
  'coconut-moisturizer': 'skin',
  'coconut-lotion': 'skin',
  'sensitive-skin-starter-set': 'skin',
  'skincare-starter-set': 'skin',
  'coconut-soap': 'bath',
  'coconut-bar-soap-12-pack': 'bath',
  'organic-foaming-hand-soap': 'bath',
  'foam-soap-bundle': 'bath',
  'foam-soap-refill-32oz': 'bath',
  'coconut-oil-toothpaste': 'oral',
  'coconut-oil-deodorant': 'deodorant',
  'coconut-oil-lip-balm': 'lip',
};

export function categoryFor(handle) {
  return CATEGORY_BY_HANDLE[handle] || 'all';
}

/**
 * Validate a parsed batch file. Throws with every problem named, not just the first.
 * @returns {{product:string, variant:string|null, count:number, form:string|null,
 *            concepts:Array<{headline:string, subhead:string|null}>, scenes:string[]}}
 */
export function parseBatch(raw) {
  const errors = [];
  if (!raw || typeof raw !== 'object') throw new Error('ad-batch: batch file must be a JSON object');
  const product = typeof raw.product === 'string' ? raw.product.trim() : '';
  if (!product) errors.push('"product" (a handle from data/product-images/manifest.json) is required');
  const variant = typeof raw.variant === 'string' && raw.variant.trim() ? raw.variant.trim() : null;
  const count = raw.count == null ? DEFAULT_COUNT : Number(raw.count);
  if (!Number.isInteger(count) || count < MIN_COUNT || count > MAX_COUNT) {
    errors.push(`"count" must be a whole number from ${MIN_COUNT} to ${MAX_COUNT} (got ${raw.count})`);
  }
  const form = raw.form == null ? null : String(raw.form);
  if (form && !['packaged', 'unwrapped', 'mixed'].includes(form)) {
    errors.push('"form" must be packaged, unwrapped or mixed');
  }
  const concepts = [];
  if (!Array.isArray(raw.concepts) || raw.concepts.length === 0) {
    errors.push('"concepts" must be a non-empty list of { headline, subhead? }');
  } else {
    raw.concepts.forEach((c, i) => {
      const headline = typeof c?.headline === 'string' ? c.headline.trim() : '';
      if (!headline) { errors.push(`concepts[${i}] has no headline`); return; }
      const subhead = typeof c.subhead === 'string' && c.subhead.trim() ? c.subhead.trim() : null;
      concepts.push({ headline, subhead });
    });
  }
  const scenes = Array.isArray(raw.scenes)
    ? raw.scenes.map(s => String(s || '').trim()).filter(Boolean)
    : [];
  if (errors.length) throw new Error('ad-batch: invalid batch file:\n  - ' + errors.join('\n  - '));
  return { product, variant, count, form, concepts, scenes };
}

/**
 * The deception check on Sean's copy: the fleet's blocking tier on the commercial
 * surface (cure claims, disease positioning, drug words, "antiperspirant"). Copy is
 * never rewritten here; a failing concept is skipped and named.
 */
export function screenConcepts(concepts) {
  const ok = [];
  const skipped = [];
  for (const c of concepts) {
    const r = checkSeoCopyFields({ headline: c.headline, subhead: c.subhead || '' }, { surface: COMMERCIAL_SURFACE });
    if (r.ok) ok.push(c);
    else skipped.push({ ...c, reasons: r.blocking.map(b => `${b.field}: "${b.match}" (${b.why})`) });
  }
  return { ok, skipped };
}

const IMAGE_RE = /\.(png|jpe?g|webp)$/i;

function firstImages(dir, n, { exists = existsSync, list = readdirSync } = {}) {
  if (!exists(dir)) return [];
  return list(dir).filter(f => IMAGE_RE.test(f)).sort().slice(0, n).map(f => join(dir, f));
}

/**
 * Everything the prompt and the checks need to know about the product.
 * @returns {{handle, variant, title, category, unitCount, description, unwrappedDescription,
 *            labelStrings:string[], refs:{packaged:string[], unwrapped:string[]}}}
 */
export function resolveProduct({ handle, variant, manifest, references = {}, imageRoot, fs = {} }) {
  const entry = (manifest || []).find(p => p.handle === handle);
  if (!entry) throw new Error(`ad-batch: "${handle}" is not in data/product-images/manifest.json`);
  const curated = references[handle] || {};
  const forVariant = (variant && curated[variant]) || {};
  const anyVariant = curated['*'] || {};
  const pick = (list) => (list || []).map(p => join(imageRoot, p)).filter(p => (fs.exists || existsSync)(p));

  let packaged = pick(forVariant.packaged);
  if (!packaged.length && variant) packaged = firstImages(join(imageRoot, entry.imageDir, variant), 3, fs);
  if (!packaged.length) packaged = firstImages(join(imageRoot, entry.imageDir), 3, fs);
  if (!packaged.length) {
    throw new Error(`ad-batch: no reference photos for ${handle}${variant ? ' / ' + variant : ''} under ${join(imageRoot, entry.imageDir)}`);
  }
  let unwrapped = pick(forVariant.unwrapped || anyVariant.unwrapped);
  if (!unwrapped.length && entry.unwrapped?.imageDir) unwrapped = firstImages(join(imageRoot, entry.unwrapped.imageDir), 3, fs);

  return {
    handle,
    variant,
    title: entry.title,
    category: categoryFor(handle),
    unitCount: entry.unitCount || 1,
    description: entry.productDescription || '',
    unwrappedDescription: entry.unwrapped?.productDescription || '',
    labelStrings: buildLabelStrings({ manifestEntry: entry, variant }),
    refs: { packaged, unwrapped },
  };
}
