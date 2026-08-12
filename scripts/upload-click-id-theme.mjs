/**
 * Install (or refresh) the Google click-id capture in the live Shopify theme.
 *
 * Uploads:
 *   theme/assets/rsc-click-id.js       -> assets/rsc-click-id.js
 *   theme/snippets/rsc-click-id.liquid -> snippets/rsc-click-id.liquid
 * and adds `{% render 'rsc-click-id' %}` immediately before </body> in
 * layout/theme.liquid if it is not already there.
 *
 * WHY: Shopify caps order.landing_site at 255 chars and Google Shopping puts gclid last,
 * so the gclid always arrives server-side as a 4-character stump. Cart attributes have no
 * cap and land on the order as note_attributes — the only route by which a full gclid can
 * reach agents/ads-conversion-uploader.
 *
 * Idempotent: re-running refreshes the asset and snippet without duplicating the render
 * tag. layout/theme.liquid is backed up to theme/backups/ before any write, because it is
 * the one file that can take the whole storefront down.
 *
 * Usage:
 *   node scripts/upload-click-id-theme.mjs --dry-run
 *   node scripts/upload-click-id-theme.mjs --apply
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'url';
import { getMainThemeId, getThemeAsset, updateThemeAsset } from '../lib/shopify.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RENDER_TAG = "{% render 'rsc-click-id' %}";
const apply = process.argv.includes('--apply');

/** getThemeAsset throws on 404; for a not-yet-uploaded asset that means absent. */
async function readAsset(themeId, key) {
  try {
    return await getThemeAsset(themeId, key);
  } catch (err) {
    if (/HTTP 404/.test(String(err.message))) return null;
    throw err;
  }
}

const files = [
  { local: join(ROOT, 'theme', 'assets', 'rsc-click-id.js'), key: 'assets/rsc-click-id.js' },
  { local: join(ROOT, 'theme', 'snippets', 'rsc-click-id.liquid'), key: 'snippets/rsc-click-id.liquid' },
];

async function main() {
  const themeId = await getMainThemeId();
  if (!themeId) throw new Error('no main theme found');
  console.log(`Live theme: ${themeId}${apply ? '' : '  (dry run)'}`);

  for (const f of files) {
    const value = readFileSync(f.local, 'utf8');
    const current = await readAsset(themeId, f.key);
    if (current === value) {
      console.log(`  = ${f.key} already current (${value.length} bytes)`);
      continue;
    }
    console.log(`  ${current == null ? '+' : '~'} ${f.key} (${value.length} bytes)`);
    if (apply) await updateThemeAsset(themeId, f.key, value);
  }

  const layoutKey = 'layout/theme.liquid';
  const layout = await readAsset(themeId, layoutKey);
  if (!layout) throw new Error(`could not read ${layoutKey}`);

  if (layout.includes("render 'rsc-click-id'")) {
    console.log(`  = ${layoutKey} already renders the snippet`);
    return;
  }

  const idx = layout.lastIndexOf('</body>');
  if (idx === -1) throw new Error(`no </body> in ${layoutKey} — refusing to guess an insertion point`);

  const patched = `${layout.slice(0, idx)}  ${RENDER_TAG}\n${layout.slice(idx)}`;
  console.log(`  ~ ${layoutKey} — inserting ${RENDER_TAG} before </body>`);

  if (apply) {
    const backupDir = join(ROOT, 'theme', 'backups');
    mkdirSync(backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backup = join(backupDir, `theme.liquid.${stamp}.bak`);
    writeFileSync(backup, layout);
    console.log(`  backed up ${layoutKey} -> ${backup}`);
    await updateThemeAsset(themeId, layoutKey, patched);
  }

  console.log(apply
    ? '\nApplied. Verify with: curl -s "https://www.realskincare.com/?gclid=<test>" | grep rsc-click-id'
    : '\nDry run — nothing written.');
}

main().catch((err) => { console.error(err); process.exit(1); });
