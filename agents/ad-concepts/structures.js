/**
 * Structure library: long-running competitor ad STRUCTURES the model fills
 * slots in, instead of inventing concepts. Pure apart from reading the library
 * file and checking that source images exist. Schema note lives in the
 * library's own "schema" field.
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LAYOUT_REGISTRY } from './layouts/index.js';

export const LAYOUTS = ['comment-card', 'headline-over-photo', 'split-two-panel', 'checklist-split', 'photo-only', 'labelled-bundle'];
export const EVIDENCE = ['review', 'offer', 'catalogFact', 'bundleLanding'];
const STATUSES = ['approved', 'candidate', 'retired'];
const RATIOS = ['1:1', '4:5'];
/** One output ratio per run (Meta steers feed to 4:5; a flexible ad shares one ratio). Default first. */
export const RUN_RATIOS = ['4:5', '1:1'];
/** Ratios a single plate may be rendered at (a split panel is tall and narrow). */
export const PLATE_RATIOS = ['1:1', '4:5', '3:4', '9:16'];

/** The run ratios a structure supports: its `ratios` list, else just its `ratio`. */
export const supportedRatios = (s) => (Array.isArray(s?.ratios) && s.ratios.length ? s.ratios : [s?.ratio]);

export const DEFAULT_LIBRARY_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../../data/ad-structures/library.json');

function validate(s, dir) {
  const id = s?.id || '(no id)';
  const fail = (why) => { throw new Error(`ad structure "${id}": ${why}`); };
  if (!s?.id) fail('missing id');
  if (!LAYOUTS.includes(s.layout)) fail(`unknown layout "${s.layout}"`);
  if (!STATUSES.includes(s.status)) fail(`bad status "${s.status}"`);
  if (!RATIOS.includes(s.ratio)) fail(`bad ratio "${s.ratio}"`);
  const layoutRatios = LAYOUT_REGISTRY[s.layout]?.ratios || [];
  for (const r of supportedRatios(s)) {
    if (!RUN_RATIOS.includes(r) || !layoutRatios.includes(r)) fail(`ratio ${r} is not one layout "${s.layout}" renders (${layoutRatios.join(', ')})`);
  }
  for (const p of s.plates || []) {
    if (!PLATE_RATIOS.includes(p?.ratio)) fail(`each plates[] entry needs a plate ratio (${PLATE_RATIOS.join(', ')}), got "${p?.ratio}"`);
  }
  if (!Array.isArray(s.fits) || !s.fits.length) fail('fits is empty');
  if (!Array.isArray(s.sources) || !s.sources.length) fail('sources is empty');
  for (const src of s.sources) {
    if (!src.image || !existsSync(join(dir, src.image))) fail(`source image missing: ${src.image}`);
  }
  for (const r of s.requires || []) if (!EVIDENCE.includes(r)) fail(`unknown requires "${r}"`);
  if (!s.scene?.primary) fail('missing scene.primary');
  const frac = (v) => Number.isFinite(v) && v >= 0 && v <= 1;
  for (const p of s.labelPositions || []) {
    if (!['x', 'y', 'tx', 'ty'].every(k => frac(p?.[k]))) fail(`labelPositions entries need x, y, tx, ty as 0-1 fractions, got ${JSON.stringify(p)}`);
  }
}

export function loadLibrary(path = DEFAULT_LIBRARY_PATH) {
  const lib = JSON.parse(readFileSync(path, 'utf8'));
  const dir = dirname(path);
  for (const s of lib.structures || []) validate(s, dir);
  return { version: lib.version, structures: lib.structures || [] };
}

/** Why a structure cannot run this time, or null when it can. */
export function whyIneligible(s, { productKinds, evidence, ratio = null }) {
  if (s.status !== 'approved') return `status is ${s.status}`;
  const missing = (s.requires || []).filter(r => !evidence.has(r));
  if (missing.length) return `missing evidence: ${missing.join(', ')}`;
  if (!s.fits.some(k => productKinds.includes(k))) return `fits ${s.fits.join('/')}, not ${productKinds.join('/')}`;
  if (ratio && !supportedRatios(s).includes(ratio)) return `does not support ${ratio} (supports ${supportedRatios(s).join(', ')})`;
  return null;
}

export function eligible(lib, ctx) {
  return lib.structures.filter(s => !whyIneligible(s, ctx));
}

const maxDays = (s) => Math.max(...s.sources.map(x => x.days || 0));

export function selectStructures(list, { slots = 3, override = [] } = {}) {
  const picked = [];
  for (const id of override) {
    const s = list.find(x => x.id === id);
    if (!s) throw new Error(`override structure "${id}" is not eligible (unknown, not approved, evidence missing, or does not fit the products)`);
    if (!picked.includes(s)) picked.push(s);
  }
  const rest = list.filter(s => !picked.includes(s)).sort((a, b) => maxDays(b) - maxDays(a));
  for (const s of rest) {
    if (picked.length >= slots) break;
    if (picked.some(p => p.layout === s.layout)) continue;
    picked.push(s);
  }
  return picked.slice(0, Math.max(slots, override.length));
}
