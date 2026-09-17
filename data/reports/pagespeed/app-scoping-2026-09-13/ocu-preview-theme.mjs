import { getThemes, getThemeAssetRaw, updateThemeAsset, shopifyGraphQL } from '/Users/seanfillmore/Code/Claude/lib/shopify.js';
const LIVE = 148782940330;
const EXCLUDE = 'index, collection, list-collections, page, blog, 404';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const parse = (s) => JSON.parse(s.replace(/^\s*\/\*[\s\S]*?\*\//, ''));
const themes = await getThemes();
if (themes.find((t) => t.id === LIVE)?.role !== 'main') throw new Error('ABORT: live id changed');
let preview = themes.find((t) => t.name === 'Preview — OCU excluded templates' && t.role === 'unpublished');
if (!preview) {
  const res = await shopifyGraphQL(`mutation($id: ID!, $name: String) { themeDuplicate(id: $id, name: $name) { newTheme { id name role processing } userErrors { field message } } }`, { id: `gid://shopify/OnlineStoreTheme/${LIVE}`, name: 'Preview — OCU excluded templates' });
  console.log(JSON.stringify(res));
  const gid = res.themeDuplicate?.newTheme?.id; if (!gid) throw new Error('duplicate failed');
  const id = Number(gid.split('/').pop());
  for (let i = 0; i < 60; i++) { const t = (await getThemes()).find((x) => x.id === id); if (t && !t.processing) { preview = t; break; } await sleep(5000); }
  if (!preview) throw new Error('duplicate still processing');
}
console.log('preview theme', preview.id, preview.role);
const key = 'config/settings_data.json';
const s = parse((await getThemeAssetRaw(preview.id, key)).value);
const entry = Object.entries(s.current.blocks).find(([, b]) => b.type.includes('/one-click-upsell/blocks/app-embed/'));
if (!entry) throw new Error('OCU app-embed block not found');
console.log('before:', JSON.stringify(entry[1].settings));
entry[1].settings.allowed_templates = EXCLUDE;
await updateThemeAsset(preview.id, key, JSON.stringify(s, null, 2));
for (let i = 0; i < 6; i++) {
  const rb = parse((await getThemeAssetRaw(preview.id, key)).value).current.blocks[entry[0]].settings;
  if (rb.allowed_templates === EXCLUDE) { console.log('✓ read back:', JSON.stringify(rb)); process.exit(0); }
  await sleep(1500);
}
throw new Error('read-back mismatch');
