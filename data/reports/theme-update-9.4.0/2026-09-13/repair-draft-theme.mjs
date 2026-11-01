// Re-apply the customizations Shopify's Be Yours 9.2.0 -> 9.4.0 updater dropped, onto the
// UNPUBLISHED draft only. Dry by default; --apply writes. Every target is guarded so it
// refuses if the draft/live difference is not exactly the one diagnosed on 2026-09-12.
import { getThemes, getThemeAssetRaw, updateThemeAsset, listThemeAssets } from '/Users/seanfillmore/Code/Claude/lib/shopify.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const LIVE = 148439367850, DRAFT = 148782940330;
const APPLY = process.argv.includes('--apply');
const OUT = '/private/tmp/claude-501/-Users-seanfillmore-Code-Claude/363304d7-fc64-470b-8f25-d8d7cc74b167/scratchpad/theme-repair';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const themes = await getThemes();
if (themes.find((t) => t.id === LIVE)?.role !== 'main') throw new Error('ABORT: LIVE is not the main theme');
if (themes.find((t) => t.id === DRAFT)?.role !== 'unpublished') throw new Error('ABORT: DRAFT is not unpublished');

const get = async (id, k) => (await getThemeAssetRaw(id, k))?.value;
const norm = (x) => x.replace(/\s+/g, ' ').trim();
function onlyIn(a, b) { // ws-insensitive multiset: lines of a missing from b
  const m = new Map(); for (const x of b.split('\n').map(norm).filter(Boolean)) m.set(x, (m.get(x) || 0) + 1);
  const out = []; for (const x of a.split('\n').map(norm).filter(Boolean)) { const c = m.get(x) || 0; if (c) m.set(x, c - 1); else out.push(x); }
  return out;
}
const parse = (s) => JSON.parse(s.replace(/^\s*\/\*[\s\S]*?\*\//, ''));
function paths(a, b, p = '', out = []) {
  if (JSON.stringify(a) === JSON.stringify(b)) return out;
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) paths(a[k], b[k], `${p}.${k}`, out);
    return out;
  }
  out.push(p); return out;
}
const sameSet = (a, b) => a.length === b.length && [...a].sort().join('|') === [...b].sort().join('|');
function must(cond, msg) { if (!cond) throw new Error(`ABORT: ${msg}`); }
function count(s, sub) { return s.split(sub).length - 1; }

const plan = []; // { key, draft, next, checks[] }

// 1. theme.liquid — draft is live minus exactly our 14 lines.
{
  const key = 'layout/theme.liquid', live = await get(LIVE, key), draft = await get(DRAFT, key);
  must(onlyIn(draft, live).length === 0 && onlyIn(live, draft).length === 14, `${key}: diff shape changed`);
  const next = live;
  must(next.includes("render 'rsc-rum'") && next.includes("render 'rsc-click-id'") && next.includes('clarity.ms'), `${key}: restored content incomplete`);
  plan.push({ key, draft, next });
}

// 2. product-info.js — draft is stock; live is stock + the two scroll fixes.
{
  const key = 'assets/product-info.js', live = await get(LIVE, key), draft = await get(DRAFT, key);
  const d = onlyIn(draft, live), l = onlyIn(live, draft);
  must(d.length === 2 && l.length === 23 && d.some((x) => x.includes("this.dataset.updateUrl === 'true' && shouldSwapProduct")), `${key}: diff shape changed`);
  plan.push({ key, draft, next: live });
}

// 3. Giveaway templates reset to main-page.
for (const [name, type] of [['giveaway', 'giveaway-entry'], ['giveaway-entered', 'giveaway-entered'], ['giveaway-confirmed', 'giveaway-confirmed'], ['giveaway-offer', 'giveaway-offer']]) {
  const key = `templates/page.${name}.json`, live = await get(LIVE, key), draft = await get(DRAFT, key);
  must(sameSet(paths(parse(live), parse(draft)), ['.sections.main.type', '.sections.main.settings.narrow', '.sections.main.settings.padding_top', '.sections.main.settings.padding_bottom']), `${key}: diff shape changed`);
  must(parse(live).sections.main.type === type, `${key}: live main type is not ${type}`);
  plan.push({ key, draft, next: live, json: true });
}

// 4. Landers: updater inserted a product-recommendations section.
for (const key of ['templates/product.bundle-landing.json', 'templates/product.landing-page-sensitive-skin-set-lander.json']) {
  const live = await get(LIVE, key), draft = await get(DRAFT, key);
  must(sameSet(paths(parse(live), parse(draft)), ['.sections.product-recommendations', '.order']), `${key}: diff shape changed`);
  plan.push({ key, draft, next: live, json: true });
}

// 5. settings_data: three values the updater overwrote or dropped.
{
  const key = 'config/settings_data.json', live = await get(LIVE, key), draft = await get(DRAFT, key);
  const L = parse(live), D = parse(draft);
  const ANN = ['announcement-bar', 'd2935cc2-f410-4c7c-93a9-022622d5ae52'], FOOT = ['footer', '6162a016-aa31-49f3-86b2-ead6a6bdc6ef'];
  const CHECKOUT = ['checkout_logo_image', 'checkout_logo_position', 'checkout_logo_size', 'checkout_sidebar_background_color', 'checkout_accent_color', 'checkout_button_color'].map((k) => `.${k}`);
  const expected = [...CHECKOUT, `.sections.${ANN[0]}.blocks.${ANN[1]}.settings.text`, `.sections.${FOOT[0]}.blocks.${FOOT[1]}.settings.text`, '.sections.offer-40-subscribe'];
  must(sameSet(paths(L.current, D.current), expected), `${key}: current diff shape changed: ${paths(L.current, D.current).join(', ')}`);
  const draftKeys = new Set((await listThemeAssets(DRAFT)).map((a) => a.key));
  const N = JSON.parse(JSON.stringify(D));
  N.current.sections[ANN[0]].blocks[ANN[1]].settings.text = L.current.sections[ANN[0]].blocks[ANN[1]].settings.text;
  N.current.sections[FOOT[0]].blocks[FOOT[1]].settings.text = L.current.sections[FOOT[0]].blocks[FOOT[1]].settings.text;
  const offerFile = draftKeys.has('sections/offer-40-subscribe.liquid');
  if (offerFile) N.current.sections['offer-40-subscribe'] = L.current.sections['offer-40-subscribe'];
  const left = paths(L.current, N.current);
  must(sameSet(left, offerFile ? CHECKOUT : [...CHECKOUT, '.sections.offer-40-subscribe']), `${key}: patched current still differs: ${left.join(', ')}`);
  must(JSON.stringify(N.presets) === JSON.stringify(D.presets), `${key}: presets changed`);
  console.log(`settings_data: offer-40-subscribe section file ${offerFile ? 'present — settings restored' : 'ABSENT on draft — orphan setting left out'}; checkout_* keys left out (removed from the 9.4.0 schema)`);
  plan.push({ key, draft, next: JSON.stringify(N, null, 2), json: true });
}

// 6/7. Bundle price tokens re-applied onto the 9.4.0 rich-text and multicolumn sections.
for (const [key, fields, button] of [['sections/rich-text.liquid', { heading: 1, text: 1 }, true], ['sections/multicolumn.liquid', { title: 1, text: 2 }, false]]) {
  const live = await get(LIVE, key), draft = await get(DRAFT, key);
  must(!draft.includes('bundle_total'), `${key}: draft already carries the token block`);
  // Keep the draft file's own line endings: the 9.4.0 rich-text ships CRLF, multicolumn LF.
  const eol = draft.includes('\r\n') ? '\r\n' : '\n';
  const head = (live.match(/^\{%- liquid\r?\n[\s\S]*?\r?\n-%\}\r?\n/) || [])[0];
  must(head && head.includes('bundle_total') && head.includes('Bundle price tokens'), `${key}: live token block not found at file start`);
  const assigns = {};
  for (const m of live.matchAll(/\{%- assign bt_(heading|text|title|button) = [^\r\n]*?-%\}/g)) {
    must(!assigns[m[1]] || assigns[m[1]] === m[0], `${key}: live has differing assign lines for bt_${m[1]}`);
    assigns[m[1]] = m[0];
  }
  let next = head.replace(/\r?\n/g, eol) + draft;
  for (const [field, n] of Object.entries(fields)) {
    must(assigns[field], `${key}: no live assign for bt_${field}`);
    const re = new RegExp(`([ \\t]*)(\\{%- render 'highlight-text',[ \\t]*\\r?\\n[ \\t]*)hl_input: block\\.settings\\.${field},`, 'g');
    let hits = 0;
    next = next.replace(re, (_m, indent, render) => { hits++; return `${indent}${assigns[field]}${eol}${indent}${render}hl_input: bt_${field},`; });
    must(hits === n, `${key}: expected ${n} ${field} render anchors, found ${hits}`);
  }
  if (button) {
    must(assigns.button, `${key}: no live assign for bt_button`);
    must(count(next, '<div class="button-group">') === 1, `${key}: button-group anchor count`);
    next = next.replace(/([ \t]*)<div class="button-group">/, (_m, indent) => `${indent}${assigns.button}${eol}${indent}<div class="button-group">`);
    must(count(next, '{{ block.settings.button_label | escape }}') === 2, `${key}: button label anchor count`);
    next = next.split('{{ block.settings.button_label | escape }}').join('{{ bt_button | escape }}');
  }
  const lostTokenLines = onlyIn(live, next).filter((x) => /bt_|bundle_|\[\[/.test(x));
  must(lostTokenLines.length === 0, `${key}: token lines still missing: ${lostTokenLines.join(' || ')}`);
  must(count(next, 'bt_') === count(live, 'bt_'), `${key}: bt_ count ${count(next, 'bt_')} != live ${count(live, 'bt_')}`);
  console.log(`${key}: live-only lines after patch ${onlyIn(live, next).length}, draft(9.4.0)-only lines kept ${onlyIn(next, live).length}`);
  plan.push({ key, draft, next });
}

for (const p of plan) {
  const f = p.key.replace(/\//g, '__');
  mkdirSync(join(OUT, 'draft-backup'), { recursive: true }); mkdirSync(join(OUT, 'patched'), { recursive: true });
  writeFileSync(join(OUT, 'draft-backup', f), p.draft);
  writeFileSync(join(OUT, 'patched', f), p.next);
}
console.log(`\n${plan.length} target(s) validated: ${plan.map((p) => p.key).join(', ')}`);
if (!APPLY) { console.log('DRY RUN — patched files in', join(OUT, 'patched')); process.exit(0); }

for (const p of plan) {
  await updateThemeAsset(DRAFT, p.key, p.next);
  let ok = false;
  for (let i = 0; i < 6 && !ok; i++) {
    const rb = await get(DRAFT, p.key);
    ok = p.json ? JSON.stringify(parse(rb)) === JSON.stringify(parse(p.next)) : rb === p.next;
    if (!ok) await sleep(1500);
  }
  console.log(`  ${ok ? '✓' : '✗ READ-BACK MISMATCH'} ${p.key}`);
}
