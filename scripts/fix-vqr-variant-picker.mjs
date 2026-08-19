#!/usr/bin/env node
/**
 * Fix the bundle lander's scent picker so changing a variant actually swaps the image.
 *
 *   node scripts/fix-vqr-variant-picker.mjs [--apply]
 *
 * THE BUG
 *   The `vqr-combo` custom_liquid block renders its own <select> whose option values are
 *   variant IDs. On change it did:
 *
 *       hidden.value = pickEl.value          // e.g. "48955068121258"
 *
 *   against the theme's `variant-selects` <select>, whose options are option VALUES —
 *   "Coconut Breeze", "Pure Unscented". Assigning an ID matches no option, so the select's
 *   value silently becomes empty and the dispatched change event tells Dawn nothing. The
 *   media gallery never swaps.
 *
 *   Server-side rendering was always correct: /products/x?variant=<id> returns the right
 *   image. Only the client-side swap was broken, which is why the product data looked fine.
 *
 *   The author already got this right for the radio branch, which matches on option text.
 *   Only the select branch was wrong.
 *
 * THE FIX
 *   Render a variant-id → option-values map from Liquid, then set EACH theme select to its
 *   corresponding option value. Per-option rather than single-value because
 *   `bundle-landing` is shared by six bundles and the Hand Soap Set has two options
 *   (Configuration + Scent) — a single-select fix would leave that one broken.
 *
 * Backs the current asset up to data/reports/theme-backups/ before writing.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAccessToken } from '../lib/shopify.js';
import { API_VERSION } from '../lib/shopify-api-version.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const THEME = 147480051882;
const KEY = 'templates/product.bundle-landing.json';
const APPLY = process.argv.includes('--apply');

const env = Object.fromEntries(
  readFileSync(join(ROOT, '.env'), 'utf8').split('\n')
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }),
);
const token = await getAccessToken();
const base = `https://${env.SHOPIFY_STORE}/admin/api/${API_VERSION}/themes/${THEME}/assets.json`;

const current = (await (await fetch(`${base}?asset[key]=${encodeURIComponent(KEY)}`, {
  headers: { 'X-Shopify-Access-Token': token },
})).json()).asset.value;

const doc = JSON.parse(current);
const block = doc.sections.main.blocks['vqr-combo'];
if (!block) throw new Error('vqr-combo block not found');

const OLD_HANDLER = `  pickEl.addEventListener('change', function(){
    var hidden = findHiddenSelect();
    if(hidden){
      if(hidden.tagName === 'SELECT'){
        hidden.value = pickEl.value;
        hidden.dispatchEvent(new Event('change', { bubbles: true }));
      } else {`;

if (!block.settings.custom_liquid.includes(OLD_HANDLER)) {
  if (block.settings.custom_liquid.includes('VQR_OPTION_VALUES')) {
    console.log('already patched — nothing to do');
    process.exit(0);
  }
  throw new Error('handler not found verbatim; the block changed. Inspect before patching.');
}

const NEW_HANDLER = `  // variant id -> its option values, so multi-option bundles (Hand Soap Set:
  // Configuration + Scent) set every select, not just the first.
  var VQR_OPTION_VALUES = {
    {%- for v in product.variants -%}
    "{{ v.id }}": [{% for o in v.options %}{{ o | json }}{% unless forloop.last %},{% endunless %}{% endfor %}]{% unless forloop.last %},{% endunless %}
    {%- endfor -%}
  };
  pickEl.addEventListener('change', function(){
    var opts = VQR_OPTION_VALUES[pickEl.value];
    if(!opts){ return; }
    var root = document.querySelector('variant-selects:not([data-vqr-skip])');
    var selects = root ? root.querySelectorAll('select') : [];
    if(selects.length){
      // Assign the OPTION VALUE, never the variant id — an id matches no option, so the
      // select silently empties and the gallery never updates. That was the bug.
      for(var i = 0; i < selects.length; i++){
        if(opts[i] != null){ selects[i].value = opts[i]; }
      }
      selects[selects.length - 1].dispatchEvent(new Event('change', { bubbles: true }));
    } else {`;

const patched = block.settings.custom_liquid.replace(OLD_HANDLER, NEW_HANDLER);
if (patched === block.settings.custom_liquid) throw new Error('replacement produced no change');

// The old radio fallback matched a single option's text. Keep it working per-option.
const OLD_RADIO = `        var radios = document.querySelectorAll('variant-radios input[type="radio"]');
        radios.forEach(function(r){ if(r.value === pickEl.options[pickEl.selectedIndex].textContent.trim().split(' - ')[0]) { r.checked = true; r.dispatchEvent(new Event('change',{bubbles:true})); } });`;
const NEW_RADIO = `      var radios = document.querySelectorAll('variant-radios input[type="radio"]');
      radios.forEach(function(r){ if(opts.indexOf(r.value) !== -1){ r.checked = true; r.dispatchEvent(new Event('change',{bubbles:true})); } });`;

const finalLiquid = patched.includes(OLD_RADIO) ? patched.replace(OLD_RADIO, NEW_RADIO) : patched;

block.settings.custom_liquid = finalLiquid;
const next = JSON.stringify(doc, null, 2);

console.log(`asset ${KEY}`);
console.log(`  ${current.length} bytes -> ${next.length} bytes`);
console.log(`  radio fallback updated: ${patched.includes(OLD_RADIO)}`);

if (!APPLY) { console.log('\ndry run — pass --apply to write to the LIVE theme'); process.exit(0); }

const dir = join(ROOT, 'data/reports/theme-backups/2026-08-01');
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'product.bundle-landing.json.orig'), current);
console.log(`  backup written to data/reports/theme-backups/2026-08-01/`);

const res = await fetch(base, {
  method: 'PUT',
  headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
  body: JSON.stringify({ asset: { key: KEY, value: next } }),
});
if (!res.ok) throw new Error(`PUT failed HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
console.log('✓ written to the live theme');
