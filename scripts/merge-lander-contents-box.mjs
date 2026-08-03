#!/usr/bin/env node
/**
 * Merge the lander's two "what's in the box" panels into one.
 *
 *   node scripts/merge-lander-contents-box.mjs [--apply]
 *
 * Before: `kit-contents` listed the items WITH scents (per variant, from
 * variant.metafields.bundle.contents) and `value-stack` listed the same items
 * WITH prices (product-level, from product.metafields.bundle.value_stack). The
 * buyer read the same seven things twice, four lines apart, in the densest part
 * of the page.
 *
 * After: one panel, per variant, label + scent + price, then total / saving, and
 * the swap-a-scent note — which now sits directly above the `scent-request`
 * input it refers to instead of three blocks away.
 *
 * Rows come from `variant.metafields.bundle.value_stack`, written by
 * scripts/build-variant-value-stacks.mjs, which DERIVES them from
 * config/bundles.json plus live component prices. Read that script's header for
 * why the two old lists could not simply be zipped together.
 *
 * ── Two things this script refuses to get wrong ─────────────────────────────
 * 1. The block carries inline JS to swap panels on variant change. A syntax
 *    error anywhere in it silently disables the whole thing and the page still
 *    returns 200 — that cost a live-broken variant picker once already
 *    (scripts/fix-vqr-brace.mjs). The JS is parsed before anything is written.
 * 2. The template is shared by five landers, so this is not a per-product edit.
 *    Every one of them is checked for a per-variant stack first; if any lacks
 *    one, the merge would blank its box, so nothing is written at all.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { shopifyGraphQL, getMainThemeId, getThemeAsset, updateThemeAsset } from '../lib/shopify.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const KEY = 'templates/product.bundle-landing.json';
const APPLY = process.argv.includes('--apply');

// ── The merged panel ────────────────────────────────────────────────────────
// One <div> per variant, all but the selected one hidden, swapped by the same
// listener the old kit-contents block used (#vqr-variant-<product.id>).
const CSS = '<style>'
  + '.crx-vs{border:1px solid #cbd8c0;background:#f4f8ee;border-radius:12px;padding:18px 20px 16px;margin:18px 0;}'
  + '.crx-vs *{box-sizing:border-box;}'
  + '.crx-vs__title{font-weight:700;font-size:15px;color:#1a1b18;margin:0 0 12px;letter-spacing:-0.01em;font-family:inherit;}'
  + '.crx-vs__row{display:flex;justify-content:space-between;align-items:baseline;gap:14px;padding:8px 0;border-bottom:1px solid #e2ead9;}'
  + '.crx-vs__row:last-of-type{border-bottom:0;}'
  + '.crx-vs__label{font-size:14.5px;color:#33352f;line-height:1.35;font-family:inherit;}'
  + '.crx-vs__scent{display:block;color:#6d7f63;font-size:12.5px;margin-top:1px;}'
  + '.crx-vs__label small{color:#7c8a72;font-size:12.5px;}'
  + '.crx-vs__price{font-size:14.5px;font-weight:600;color:#1a1b18;white-space:nowrap;}'
  + '.crx-vs__total{display:flex;justify-content:space-between;align-items:baseline;margin-top:12px;padding-top:12px;border-top:2px solid #cbd8c0;}'
  + '.crx-vs__tl{font-weight:700;font-size:16px;color:#1a1b18;}'
  + '.crx-vs__was{color:#9aa593;text-decoration:line-through;font-weight:500;margin-right:8px;font-size:15px;}'
  + '.crx-vs__now{color:#4a8b3c;font-weight:700;font-size:17px;}'
  + '.crx-vs__save{margin-top:12px;background:#4a8b3c;color:#fff;text-align:center;font-weight:700;font-size:14px;letter-spacing:0.3px;padding:9px 12px;border-radius:8px;}'
  + '.crx-vs__note{margin:10px 0 0;font-size:12.5px;color:#6d7175;line-height:1.45;}'
  + '</style>';

// Written as a JS string so the swap script can be extracted and parsed below.
const SWAP_JS = `(function(){
  var sel = document.getElementById('vqr-variant-{{ product.id }}');
  if(!sel) return;
  sel.addEventListener('change', function(){
    document.querySelectorAll('[data-vs-variant]').forEach(function(el){
      el.style.display = (el.getAttribute('data-vs-variant') === sel.value) ? '' : 'none';
    });
  });
})();`;

const LIQUID = CSS
  + `{%- assign has_stack = false -%}`
  + `{%- for v in product.variants -%}{% if v.metafields.bundle.value_stack.value %}{% assign has_stack = true %}{% endif %}{%- endfor -%}`
  + `{%- if has_stack -%}`
  + `{%- for v in product.variants -%}`
  + `{%- assign stack = v.metafields.bundle.value_stack.value -%}`
  + `{%- if stack and stack.size > 0 -%}`
  + `{%- liquid
  assign total = 0
  for row in stack
    assign total = total | plus: row.amount
  endfor
  assign price_dollars = v.price | divided_by: 100
  assign savings = total | minus: price_dollars
-%}`
  + `<div class="crx-vs" data-vs-variant="{{ v.id }}"{% unless v == product.selected_or_first_available_variant %} style="display:none"{% endunless %}>`
  + `<p class="crx-vs__title">{% if product.variants.size > 1 %}Everything in your {{ v.title }} box{% else %}Everything in your box{% endif %}</p>`
  + `{%- for row in stack -%}`
  + `<div class="crx-vs__row"><span class="crx-vs__label">{{ row.label }}{% if row.digital %} <small>(digital)</small>{% endif %}`
  + `{% if row.scent %}<span class="crx-vs__scent">{{ row.scent }}</span>{% endif %}</span>`
  + `<span class="crx-vs__price">\${{ row.amount }}</span></div>`
  + `{%- endfor -%}`
  + `<div class="crx-vs__total"><span class="crx-vs__tl">Total value</span><span>`
  + `<span class="crx-vs__was">\${{ total }}</span><span class="crx-vs__now">{{ v.price | money }} today</span></span></div>`
  + `<div class="crx-vs__save">You save \${{ savings }} today</div>`
  + `{%- if product.variants.size > 1 -%}`
  + `<p class="crx-vs__note">Want different scents? Add a note below and we'll swap them.</p>`
  + `{%- endif -%}`
  + `</div>`
  + `{%- endif -%}`
  + `{%- endfor -%}`
  + `<script>${SWAP_JS}</script>`
  + `{%- endif -%}`;

// ── 1. Refuse unless every lander sharing the template is ready ─────────────
const prods = (await shopifyGraphQL(`{ products(first:250){ nodes{ handle title templateSuffix
  variants(first:30){ nodes{ title metafields(first:10,namespace:"bundle"){ nodes{ key value } } } } } } }`)).products.nodes
  .filter((p) => p.templateSuffix === 'bundle-landing');

let notReady = 0;
for (const p of prods) {
  const missing = p.variants.nodes.filter((v) => !v.metafields.nodes.some((m) => m.key === 'value_stack'));
  console.log(`${missing.length ? '✗' : '✓'} ${p.handle.padEnd(26)} ${p.variants.nodes.length} variant(s)`
    + `${missing.length ? `  MISSING per-variant value_stack on: ${missing.map((v) => v.title).join(', ')}` : ''}`);
  if (missing.length) notReady++;
}
if (notReady) {
  console.error(`\n✗ ${notReady} lander(s) have no per-variant value stack. The merged block would render an EMPTY box `
    + 'on them, and they share this template. Run scripts/build-variant-value-stacks.mjs --apply first.');
  process.exit(1);
}

// ── 2. Parse the inline JS before it can reach the theme ────────────────────
// Liquid interpolation is replaced with a literal so this is checkable as JS.
const checkable = SWAP_JS.replace(/\{\{[^}]*\}\}/g, 'X');
writeFileSync('/tmp/swap-check.js', checkable);
try {
  execFileSync(process.execPath, ['--check', '/tmp/swap-check.js'], { stdio: 'pipe' });
  console.log('\n✓ inline swap script parses');
} catch (e) {
  console.error('\n✗ inline swap script does NOT parse — refusing to write:\n' + String(e.stderr || e));
  process.exit(1);
}

// ── 3. Rewrite the template ────────────────────────────────────────────────
const themeId = await getMainThemeId();
const raw = await getThemeAsset(themeId, KEY);
const j = JSON.parse(raw);
const main = j.sections.main;
if (!main?.blocks?.['value-stack']) throw new Error('no value-stack block in the template');
if (!main.blocks['kit-contents']) console.log('note: kit-contents block already absent');

mkdirSync(join(ROOT, 'data', 'backups', 'theme'), { recursive: true });
const backupPath = join(ROOT, 'data', 'backups', 'theme', 'product.bundle-landing.before-box-merge.json');
writeFileSync(backupPath, raw);
console.log(`backed up template → ${backupPath.replace(ROOT + '/', '')}`);

main.blocks['value-stack'].settings.custom_liquid = LIQUID;
delete main.blocks['kit-contents'];
main.block_order = main.block_order.filter((b) => b !== 'kit-contents');

// The panel now carries the swap note, so it must sit immediately above the
// scent-request input it points at.
const vs = main.block_order.indexOf('value-stack');
const sr = main.block_order.indexOf('scent-request');
if (vs >= 0 && sr >= 0 && sr !== vs + 1) {
  main.block_order.splice(sr, 1);
  main.block_order.splice(main.block_order.indexOf('value-stack') + 1, 0, 'scent-request');
  console.log('moved scent-request directly below the merged panel');
}
console.log(`block order: ${main.block_order.join(', ')}`);

const out = JSON.stringify(j, null, 2);
JSON.parse(out);   // the template must still be valid JSON after interpolation

if (!APPLY) { console.log('\ndry run — pass --apply'); process.exit(0); }
await updateThemeAsset(themeId, KEY, out);
console.log('\n✓ template updated');
