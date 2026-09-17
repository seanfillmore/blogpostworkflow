import { getThemes, getThemeAssetRaw, updateThemeAsset, listThemeAssets } from '/Users/seanfillmore/Code/Claude/lib/shopify.js';
const LIVE = 148439367850, DRAFT = 148782940330;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const themes = await getThemes();
const live = themes.find((t) => t.id === LIVE), draft = themes.find((t) => t.id === DRAFT);
if (live.role !== 'main' || draft.role !== 'unpublished') throw new Error('ABORT: roles changed');
const changed = (await listThemeAssets(LIVE)).filter((a) => new Date(a.updated_at) > new Date('2026-09-12T21:24:55-06:00')).map((a) => a.key);
if (changed.length !== 1 || changed[0] !== 'templates/llms.txt.liquid') throw new Error(`ABORT: live changes are now ${changed.join(', ')}`);

// 1. Carry the fresh llms.txt over.
const llms = (await getThemeAssetRaw(LIVE, 'templates/llms.txt.liquid')).value;
await updateThemeAsset(DRAFT, 'templates/llms.txt.liquid', llms);
let ok = false;
for (let i = 0; i < 6 && !ok; i++) { ok = (await getThemeAssetRaw(DRAFT, 'templates/llms.txt.liquid')).value === llms; if (!ok) await sleep(1500); }
console.log(`${ok ? '✓' : '✗'} templates/llms.txt.liquid (${llms.length} chars)`);

// 2. Blog tag filter off.
const parse = (s) => JSON.parse(s.replace(/^\s*\/\*[\s\S]*?\*\//, ''));
const tpl = parse((await getThemeAssetRaw(DRAFT, 'templates/blog.json')).value);
if (tpl.sections?.main?.type !== 'main-blog') throw new Error('ABORT: unexpected blog.json shape');
console.log('blog show_tag_filter before:', tpl.sections.main.settings.show_tag_filter);
tpl.sections.main.settings.show_tag_filter = false;
await updateThemeAsset(DRAFT, 'templates/blog.json', JSON.stringify(tpl, null, 2));
ok = false;
for (let i = 0; i < 6 && !ok; i++) { ok = parse((await getThemeAssetRaw(DRAFT, 'templates/blog.json')).value).sections.main.settings.show_tag_filter === false; if (!ok) await sleep(1500); }
console.log(`${ok ? '✓' : '✗'} templates/blog.json show_tag_filter=false`);
console.log('live updated_at at check:', live.updated_at);
