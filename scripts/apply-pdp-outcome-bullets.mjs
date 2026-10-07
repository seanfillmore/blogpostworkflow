#!/usr/bin/env node
/**
 * Write the approved outcome bullets (config/pdp-outcome-bullets.json) into the
 * benefit-1..N text blocks of each PDP template.
 *
 *   node scripts/apply-pdp-outcome-bullets.mjs            # dry run
 *   node scripts/apply-pdp-outcome-bullets.mjs --apply    # writes live
 *
 * Every line is gated before anything is written: the ad health-claim gate,
 * the commercial-surface SEO-copy gate (a buy box is the product speaking),
 * the product-category gate (never "antiperspirant"), and no em dash. One
 * failure refuses the whole run. The number of bullets must equal the number
 * of benefit blocks the page RENDERS, so a page never keeps a stale old
 * bullet under the new ones. Live template read fresh, round-trip proven,
 * backed up to data/template-backup/, read back, then mirrored to theme/.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serialize } from './build-product-templates.mjs';
import { hasHealthClaim } from '../agents/ad-studio/health-claims.js';
import { checkSeoCopyFields } from '../lib/seo-copy-health-gate.js';
import { findProductCategoryMisnomers } from '../lib/product-category-terms.js';
import { isDirectRun } from '../lib/is-direct-run.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Pure: reasons a bullet may not ship ([] when it may). */
export function bulletProblems(line) {
  const out = [];
  if (!line || !line.trim()) out.push('empty');
  if (/—/.test(line)) out.push('em dash');
  if (hasHealthClaim(line)) out.push('ad health-claim gate');
  const g = checkSeoCopyFields({ 'buy-box bullet': line });
  if (!g.ok) out.push(`commercial claim gate: ${g.blocking.map((b) => b.match).join(', ')}`);
  if (findProductCategoryMisnomers(line).length) out.push('product-category gate');
  return out;
}

/** Pure: the rendered benefit block ids, in page order. */
export function benefitIds(parsed) {
  return parsed.sections.main.block_order.filter((id) => /^benefit-\d+$/.test(id));
}

/** Pure: apply bullets to a parsed template. Throws on a count mismatch. */
export function applyBullets(parsed, bullets, file) {
  const ids = benefitIds(parsed);
  if (ids.length !== bullets.length) {
    throw new Error(`${file}: ${bullets.length} bullets for ${ids.length} rendered benefit blocks — refusing`);
  }
  const changed = [];
  ids.forEach((id, i) => {
    const blk = parsed.sections.main.blocks[id];
    if (blk.type !== 'text') throw new Error(`${file}: ${id} is a ${blk.type} block, not text — refusing`);
    if (blk.settings.text !== bullets[i]) { blk.settings.text = bullets[i]; changed.push(id); }
  });
  return changed;
}

export function loadBullets() {
  const cfg = JSON.parse(readFileSync(join(ROOT, 'config', 'pdp-outcome-bullets.json'), 'utf8'));
  return Object.fromEntries(Object.entries(cfg).filter(([k]) => !k.startsWith('_')));
}

if (isDirectRun(import.meta.url)) {
  const APPLY = process.argv.includes('--apply');
  const all = loadBullets();

  const failures = Object.entries(all).flatMap(([file, lines]) =>
    lines.flatMap((l) => bulletProblems(l).map((p) => `${file}: "${l}" — ${p}`)));
  if (failures.length) { console.error(`Refusing — ${failures.length} bullet(s) fail a gate:\n  ${failures.join('\n  ')}`); process.exit(1); }

  const { getAccessToken } = await import('../lib/shopify.js');
  const { API_VERSION } = await import('../lib/shopify-api-version.js');
  const env = Object.fromEntries(readFileSync(join(ROOT, '.env'), 'utf8').split('\n')
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')]; }));
  const token = await getAccessToken();
  const H = (path, init = {}) => fetch(`https://${env.SHOPIFY_STORE}/admin/api/${API_VERSION}/${path}`,
    { ...init, headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' } });
  const { themes } = await (await H('themes.json')).json();
  const theme = themes.find((t) => t.role === 'main');
  console.log(`theme: ${theme.name} (${theme.id})${APPLY ? '' : '  DRY RUN'}\n`);

  for (const [file, bullets] of Object.entries(all)) {
    const key = `templates/${file}`;
    const live = (await (await H(`themes/${theme.id}/assets.json?asset[key]=${encodeURIComponent(key)}`)).json()).asset.value;
    if (serialize(JSON.parse(live)) !== live) { console.error(`${file}: round-trip mismatch — refusing`); process.exit(1); }
    const parsed = JSON.parse(live);
    const changed = applyBullets(parsed, bullets, file);
    console.log(`${file}: ${changed.length ? `updates ${changed.join(', ')}` : 'already current'}`);
    if (!APPLY || !changed.length) continue;
    const out = serialize(parsed);
    mkdirSync(join(ROOT, 'data', 'template-backup'), { recursive: true });
    writeFileSync(join(ROOT, 'data', 'template-backup', file), live);
    const put = await H(`themes/${theme.id}/assets.json`, { method: 'PUT', body: JSON.stringify({ asset: { key, value: out } }) });
    if (!put.ok) { console.error(`  PUT failed ${put.status}`); process.exit(1); }
    const back = (await (await H(`themes/${theme.id}/assets.json?asset[key]=${encodeURIComponent(key)}`)).json()).asset.value;
    console.log(`  readback identical: ${back === out}`);
    writeFileSync(join(ROOT, 'theme', key), out);
  }
}
