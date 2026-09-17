import { listThemeAssets, getThemeAssetRaw } from '/Users/seanfillmore/Code/Claude/lib/shopify.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const LIVE = 148439367850, DRAFT = 148782940330;
const OUT = '/private/tmp/claude-501/-Users-seanfillmore-Code-Claude/363304d7-fc64-470b-8f25-d8d7cc74b167/scratchpad/theme-diff';
const [la, da] = await Promise.all([listThemeAssets(LIVE), listThemeAssets(DRAFT)]);
const L = new Map(la.map(a => [a.key, a])), D = new Map(da.map(a => [a.key, a]));
const onlyLive = [...L.keys()].filter(k => !D.has(k)).sort();
const onlyDraft = [...D.keys()].filter(k => !L.has(k)).sort();
const differ = [], same = [];
for (const [k, a] of L) { if (!D.has(k)) continue; (a.checksum && a.checksum === D.get(k).checksum ? same : differ).push(k); }
const details = [];
for (const k of differ.sort()) {
  const [lv, dv] = [await getThemeAssetRaw(LIVE, k), await getThemeAssetRaw(DRAFT, k)];
  const l = lv?.value ?? lv?.attachment ?? '', d = dv?.value ?? dv?.attachment ?? '';
  let kind = 'text';
  if (k.endsWith('.json')) { try { kind = JSON.stringify(JSON.parse(l.replace(/^\/\*[\s\S]*?\*\//, ''))) === JSON.stringify(JSON.parse(d.replace(/^\/\*[\s\S]*?\*\//, ''))) ? 'json-equal' : 'json-differs'; } catch { kind = 'json-unparsed'; } }
  else if (l === d) kind = 'text-equal';
  const ll = l.split('\n'), dl = d.split('\n'); const ds = new Set(dl), ls = new Set(ll);
  details.push({ key: k, kind, liveBytes: l.length, draftBytes: d.length, linesOnlyInLive: ll.filter(x => !ds.has(x)).length, linesOnlyInDraft: dl.filter(x => !ls.has(x)).length });
  const f = k.replace(/\//g, '__');
  mkdirSync(join(OUT, 'live'), { recursive: true }); mkdirSync(join(OUT, 'draft'), { recursive: true });
  writeFileSync(join(OUT, 'live', f), l); writeFileSync(join(OUT, 'draft', f), d);
}
const summary = { liveCount: L.size, draftCount: D.size, same: same.length, onlyLive, onlyDraft, differ: details };
writeFileSync(join(OUT, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(`live ${L.size} / draft ${D.size} · identical ${same.length} · differ ${details.length}`);
console.log('ONLY IN LIVE:', onlyLive.length, onlyLive.join(', '));
console.log('ONLY IN DRAFT:', onlyDraft.length, onlyDraft.join(', '));
for (const x of details) console.log(`  ${x.kind.padEnd(13)} -${String(x.linesOnlyInLive).padStart(4)} +${String(x.linesOnlyInDraft).padStart(4)}  ${x.key}`);
