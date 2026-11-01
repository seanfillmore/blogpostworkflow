import { getThemes, getThemeAssetRaw, updateThemeAsset } from '/Users/seanfillmore/Code/Claude/lib/shopify.js';
import { writeFileSync, mkdirSync } from 'node:fs';
const EXCLUDE = 'index, collection, list-collections, page, blog, 404';
const KEY = 'config/settings_data.json';
const A = '/Users/seanfillmore/Code/Claude/data/reports/pagespeed/app-scoping-2026-09-13';
const parse = (s) => JSON.parse(s.replace(/^\s*\/\*[\s\S]*?\*\//, ''));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const main = (await getThemes()).find((t) => t.role === 'main');
console.log('live theme', main.id, main.name, main.updated_at);
if (main.id !== 148782940330) throw new Error('ABORT: live theme id changed');
const raw = (await getThemeAssetRaw(main.id, KEY)).value;
mkdirSync(A, { recursive: true });
writeFileSync(`${A}/live-settings_data.before-ocu-exclusion.json`, raw);
const s = parse(raw);
const ocu = Object.entries(s.current.blocks).filter(([, b]) => b.type.includes('/one-click-upsell/blocks/app-embed/'));
if (ocu.length !== 1) throw new Error(`ABORT: expected 1 OCU app-embed block, found ${ocu.length}`);
const [bid, block] = ocu[0];
console.log('before:', JSON.stringify(block.settings), 'disabled:', !!block.disabled);
if ((block.settings.allowed_templates ?? '') !== '' && block.settings.allowed_templates !== EXCLUDE) throw new Error('ABORT: setting already changed by someone else');
const before = JSON.stringify(s);
block.settings.allowed_templates = EXCLUDE;
// Only that one value may differ.
const a = parse(raw); a.current.blocks[bid].settings.allowed_templates = EXCLUDE;
if (JSON.stringify(a) !== JSON.stringify(s) || before === JSON.stringify(s)) throw new Error('ABORT: unexpected diff');
await updateThemeAsset(main.id, KEY, JSON.stringify(s, null, 2));
for (let i = 0; i < 6; i++) {
  const rb = parse((await getThemeAssetRaw(main.id, KEY)).value);
  const other = JSON.parse(JSON.stringify(rb)); other.current.blocks[bid].settings.allowed_templates = '';
  const orig = parse(raw); orig.current.blocks[bid].settings.allowed_templates = '';
  if (rb.current.blocks[bid].settings.allowed_templates === EXCLUDE && JSON.stringify(other) === JSON.stringify(orig)) { console.log('✓ live read back, only the OCU setting changed'); process.exit(0); }
  await sleep(1500);
}
throw new Error('read-back mismatch');
