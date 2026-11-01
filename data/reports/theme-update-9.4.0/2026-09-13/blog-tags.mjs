import { getThemeAssetRaw } from '/Users/seanfillmore/Code/Claude/lib/shopify.js';
const DRAFT = 148782940330, LIVE = 148439367850;
const tpl = JSON.parse((await getThemeAssetRaw(DRAFT, 'templates/blog.json')).value.replace(/^\s*\/\*[\s\S]*?\*\//, ''));
console.log('blog.json sections:', Object.entries(tpl.sections).map(([id, s]) => `${id}:${s.type} ${JSON.stringify(s.settings)}`));
for (const [id, s] of Object.entries(tpl.sections)) {
  const key = `sections/${s.type}.liquid`;
  for (const [label, theme] of [['draft', DRAFT], ['live', LIVE]]) {
    const v = (await getThemeAssetRaw(theme, key))?.value ?? '';
    const schema = JSON.parse((v.match(/\{%-?\s*schema\s*-?%\}([\s\S]*?)\{%-?\s*endschema/) || [])[1] || '{}');
    const tagSettings = (schema.settings || []).filter((x) => /tag|filter/i.test(`${x.id} ${x.label} ${x.content ?? ''}`));
    console.log(`\n[${label}] ${key}: tag/filter settings:`, JSON.stringify(tagSettings));
    const lines = v.split('\n').map((l, i) => [i + 1, l]).filter(([, l]) => /blog\.all_tags|all_tags|tag_filter|tags-filter|blog-tags/i.test(l));
    console.log(`[${label}] tag lines:`, lines.slice(0, 8).map(([n, l]) => `${n}: ${l.trim().slice(0, 140)}`));
  }
}
