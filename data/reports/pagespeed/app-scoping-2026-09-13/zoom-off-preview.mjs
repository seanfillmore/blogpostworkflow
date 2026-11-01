import { getThemes, getThemeAssetRaw, updateThemeAsset } from '/Users/seanfillmore/Code/Claude/lib/shopify.js';
const LIVE = 148782940330, PREVIEW = 148801880234, KEY = 'config/settings_data.json';
const parse = (s) => JSON.parse(s.replace(/^\s*\/\*[\s\S]*?\*\//, ''));
const t = await getThemes();
if (t.find((x) => x.id === PREVIEW)?.role !== 'unpublished' || t.find((x) => x.id === LIVE)?.role !== 'main') throw new Error('ABORT roles');
const live = parse((await getThemeAssetRaw(LIVE, KEY)).value), prev = parse((await getThemeAssetRaw(PREVIEW, KEY)).value);
// Make the preview's settings identical to live, then flip the one setting.
live.current.image_zoom_effect_enabled = false;
await updateThemeAsset(PREVIEW, KEY, JSON.stringify(live, null, 2));
const rb = parse((await getThemeAssetRaw(PREVIEW, KEY)).value);
const cmp = JSON.parse(JSON.stringify(rb)); cmp.current.image_zoom_effect_enabled = true;
const liveNow = parse((await getThemeAssetRaw(LIVE, KEY)).value);
console.log('preview zoom setting:', rb.current.image_zoom_effect_enabled, '| otherwise identical to live:', JSON.stringify(cmp.current) === JSON.stringify(liveNow.current));
