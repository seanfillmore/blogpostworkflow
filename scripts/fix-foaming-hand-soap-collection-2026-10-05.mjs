#!/usr/bin/env node
/**
 * Two fixes to the live /collections/foaming-hand-soap page (2026-10-05).
 *
 * 1. SCENT ACCURACY (body_html). The copy says the soaps are scented with
 *    "lavender, eucalyptus, citrus" three times. There is no eucalyptus soap:
 *    the variations are Orange Zest, Coconut Breeze (coconut oil extract),
 *    Calming Lavender and Pure Unscented (config/ingredients.json, and the
 *    Ingredients tab on /products/organic-foaming-hand-soap). Each span is
 *    replaced, nothing else in the body moves.
 *
 * 2. SERP TITLE (global.title_tag). "Foaming Hand Soap – Gentle, Non-Toxic,
 *    Organic Clean" renders at 70 characters with the theme's " – Real Skin
 *    Care" suffix, so Google truncates it, and it never says "organic hand
 *    soap" (880 + 880 searches/mo, where Moon Valley Organics is #2 and this
 *    page is #25/#45). The on-page H1 (collection.title) is NOT changed.
 *
 * Every AFTER is re-gated through the commercial-surface claim gate and the
 * rendered-title length gate at run time; one failure aborts. The live value
 * of each field must match its BEFORE (or already its AFTER) or the run skips
 * it rather than overwrite something it did not read. Dry by default;
 * --apply writes, after backing up the live collection JSON.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDirectRun } from '../lib/is-direct-run.js';
import { checkSeoCopyFields } from '../lib/seo-copy-health-gate.js';
import { checkCopyLength } from '../lib/seo-copy-length.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const COLLECTION_ID = 153343098915;
export const HANDLE = 'foaming-hand-soap';

export const BODY_PLAN = [
  {
    before: 'Essential oil blends — lavender, eucalyptus, citrus — fade more quickly',
    after: 'Essential oil blends like lavender and citrus fade more quickly',
  },
  {
    before: '<li>Scented only with pure essential oils — lavender, eucalyptus, citrus profiles</li>',
    after: '<li>Scented with lavender or citrus essential oils, coconut oil extract, or nothing at all</li>',
  },
  {
    before: 'are scented with pure essential oils — including lavender, eucalyptus, and citrus profiles — or available unscented.',
    after: 'come in Calming Lavender, Orange Zest (orange, bergamot, spearmint, lemon and grapefruit oils), Coconut Breeze (coconut oil extract) and Pure Unscented.',
  },
];

export const TITLE_TAG = {
  before: 'Foaming Hand Soap – Gentle, Non-Toxic, Organic Clean',
  after: 'Organic Foaming Hand Soap – Coconut Oil',
};

const count = (s, sub) => s.split(sub).length - 1;

/** Pure: apply the body plan. Each BEFORE must occur exactly once, or its AFTER already does. */
export function planBody(html) {
  let out = html;
  const steps = [];
  for (const { before, after } of BODY_PLAN) {
    const b = count(out, before);
    if (b === 1) { out = out.replace(before, after); steps.push('applied'); continue; }
    if (b === 0 && count(out, after) === 1) { steps.push('already-applied'); continue; }
    throw new Error(`body span found ${b} times (expected 1): ${before.slice(0, 60)}…`);
  }
  if (/eucalyptus/i.test(out)) throw new Error('eucalyptus still present after the plan');
  return { html: out, steps };
}

/** Pure: every AFTER must clear the commercial claim gate and the rendered-title length gate. */
export function gateAfters() {
  const gate = checkSeoCopyFields({ title: TITLE_TAG.after, ...Object.fromEntries(BODY_PLAN.map((p, i) => [`body span ${i + 1}`, p.after])) });
  if (!gate.ok) throw new Error(`claim gate: ${JSON.stringify(gate.blocking)}`);
  const len = checkCopyLength({ title: TITLE_TAG.after });
  if (len.overlong?.length) throw new Error(`title too long: ${JSON.stringify(len.overlong)}`);
  if (/—/.test(TITLE_TAG.after + BODY_PLAN.map((p) => p.after).join(''))) throw new Error('new copy carries an em dash');
}

async function main() {
  const apply = process.argv.includes('--apply');
  gateAfters();
  const { getCustomCollections, getMetafields, updateCustomCollection, upsertMetafield } = await import('../lib/shopify.js');
  const [col] = (await getCustomCollections({ ids: String(COLLECTION_ID) })).filter((c) => c.id === COLLECTION_ID);
  if (!col || col.handle !== HANDLE) throw new Error(`collection ${COLLECTION_ID} not found or handle moved`);
  const mf = (await getMetafields('collections', COLLECTION_ID)).find((m) => m.namespace === 'global' && m.key === 'title_tag');
  const liveTitle = mf?.value ?? null;

  const body = planBody(col.body_html);
  const titleState = liveTitle === TITLE_TAG.after ? 'already-applied' : liveTitle === TITLE_TAG.before ? 'apply' : 'SKIP (live value matches neither)';
  console.log(`body spans: ${body.steps.join(', ')}`);
  console.log(`title_tag: ${titleState}\n  live:  ${liveTitle}\n  after: ${TITLE_TAG.after}`);
  if (!apply) { console.log('\nDry run. Re-run with --apply to write.'); return; }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = join(ROOT, 'data/reports/collection-fixes', stamp);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${HANDLE}.before.json`), JSON.stringify({ collection: col, title_tag: liveTitle }, null, 2));
  if (body.steps.includes('applied')) await updateCustomCollection(COLLECTION_ID, { body_html: body.html });
  if (titleState === 'apply') await upsertMetafield('collections', COLLECTION_ID, 'global', 'title_tag', TITLE_TAG.after);
  console.log(`\nWritten. Backup: ${dir}`);
}

if (isDirectRun(import.meta.url)) main().catch((e) => { console.error(e.message); process.exit(1); });
