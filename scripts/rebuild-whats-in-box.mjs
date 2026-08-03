#!/usr/bin/env node
/**
 * Rebuild the lander's "What's in the box" grid from the per-variant cutouts,
 * and teach the value panel to compose its own quantity prefix.
 *
 *   node scripts/rebuild-whats-in-box.mjs [--apply]
 *
 * ── The bug ─────────────────────────────────────────────────────────────────
 * The grid rendered `c.featured_image` for each product in
 * `product.metafields.bundle.components` — the component PRODUCT's primary
 * image. A product reference has no idea which of its variants a given bundle
 * contains, so the grid was variant-blind in two directions at once:
 *
 *   · it showed the same pictures for Gentle and Fresh, because the components
 *     metafield is product-level and cannot differ per variant;
 *   · the picture it chose was whichever variant happened to be that product's
 *     primary — so Head-to-Toe showed a Coconut Breeze lotion, a Coconut Breeze
 *     cream, a Coconut Breeze lip balm and a Coconut Breeze hand soap inside the
 *     PURE UNSCENTED kit, plus a Wildcrafted Frankincense deodorant that ships in
 *     neither kit.
 *
 * The grid now reads the same per-variant `value_stack` rows the price panel
 * does. Each row names its cutout, so the picture is the exact unit that ships.
 *
 * ── Why the panel changes too ───────────────────────────────────────────────
 * `label` lost its baked-in "3 × " prefix so that `qty` could be its own field —
 * the grid always shows a count, the panel only above one. Both compose it now,
 * rather than one of them string-parsing it back out of the other's label.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { shopifyGraphQL, getMainThemeId, getThemeAsset, updateThemeAsset } from '../lib/shopify.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const KEY = 'templates/product.bundle-landing.json';
const APPLY = process.argv.includes('--apply');

/** Shared by both surfaces: hide every panel but the selected variant's. */
const swapJs = (attr) => `(function(){
  var sel = document.getElementById('vqr-variant-{{ product.id }}');
  if(!sel) return;
  sel.addEventListener('change', function(){
    document.querySelectorAll('[${attr}]').forEach(function(el){
      el.style.display = (el.getAttribute('${attr}') === sel.value) ? '' : 'none';
    });
  });
})();`;

// ── The price panel ─────────────────────────────────────────────────────────
const VS_CSS = '<style>'
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

const VALUE_STACK = VS_CSS
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
  + `<div class="crx-vs__row"><span class="crx-vs__label">{% if row.qty and row.qty > 1 %}{{ row.qty }} &times; {% endif %}{{ row.label }}`
  + `{% if row.digital %} <small>(digital)</small>{% endif %}`
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
  + `<script>${swapJs('data-vs-variant')}</script>`
  + `{%- endif -%}`;

// ── The grid ────────────────────────────────────────────────────────────────
// A fixed image height with `object-position:bottom` stands every product on one
// baseline, the way the gallery's contents frame does. The old `aspect-ratio:4/3`
// box floated each product in its own dead space, so a tall bottle and a round
// soap read as unrelated crops rather than as a shelf.
const WIB_CSS = '<style>'
  + '.wib{padding:48px 0}'
  + '.wib__h{text-align:center;font-size:clamp(22px,3vw,30px);font-weight:700;margin:0 0 6px;color:#1a1b18}'
  + '.wib__sub{text-align:center;color:#6d7175;margin:0 0 28px;font-size:15px}'
  // 820px against a 170px minimum gives four columns, so the seven-product kit
  // wraps 4+3 instead of 6+1. Head-to-Toe is the only bundle with an awkward
  // count, and a lone orphan card on the widest row reads as a layout bug rather
  // than as a seventh product.
  + '.wib__grid{display:grid;gap:26px 18px;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));'
  + 'max-width:820px;margin:0 auto;padding:0 18px;justify-content:center}'
  + '.wib__card{text-align:center}'
  + '.wib__card img{width:100%;height:170px;object-fit:contain;object-position:center bottom;display:block;background:transparent}'
  + '.wib__qty{font-weight:700;font-size:15px;margin:12px 0 2px;color:#1a1b18;line-height:1.3}'
  + '.wib__name{font-size:13px;color:#6d7175;line-height:1.4;margin:0}'
  + '</style>';

const WHATS_IN_IT = WIB_CSS
  + `{%- assign has_stack = false -%}`
  + `{%- for v in product.variants -%}{% if v.metafields.bundle.value_stack.value %}{% assign has_stack = true %}{% endif %}{%- endfor -%}`
  + `{%- if has_stack -%}`
  + `<div class="wib">`
  + `<h2 class="wib__h">What's in the box</h2>`
  + `{%- assign wib_note = product.metafields.bundle.lander.value.whats_in_it_note -%}`
  + `{%- if wib_note != blank -%}<p class="wib__sub">{{ wib_note }}</p>{%- endif -%}`
  + `{%- for v in product.variants -%}`
  + `{%- assign stack = v.metafields.bundle.value_stack.value -%}`
  + `{%- if stack and stack.size > 0 -%}`
  + `<div data-wib-variant="{{ v.id }}"{% unless v == product.selected_or_first_available_variant %} style="display:none"{% endunless %}>`
  + `<div class="wib__grid">`
  + `{%- for row in stack -%}`
  // Rows with no cutout are the digital goods. They are genuinely delivered but
  // they are not IN the box, and inventing a picture for a PDF is how a grid
  // starts lying — so they are skipped here and stay in the price panel.
  + `{%- if row.img -%}`
  + `<div class="wib__card">`
  + `<img src="{{ row.img | asset_url }}" alt="{{ row.qty }} {{ row.label }} in {{ row.scent }}" loading="lazy" width="300" height="170">`
  + `<p class="wib__qty">{{ row.qty | default: 1 }} &times; {{ row.label }}</p>`
  + `{%- if row.scent -%}<p class="wib__name">{{ row.scent }}</p>{%- endif -%}`
  + `</div>`
  + `{%- endif -%}`
  + `{%- endfor -%}`
  + `</div></div>`
  + `{%- endif -%}`
  + `{%- endfor -%}`
  + `</div>`
  + `<script>${swapJs('data-wib-variant')}</script>`
  + `{%- endif -%}`;

// ── 1. Every lander sharing the template must be ready ─────────────────────
const prods = (await shopifyGraphQL(`{ products(first:250){ nodes{ handle templateSuffix
  variants(first:30){ nodes{ title metafields(first:10,namespace:"bundle"){ nodes{ key value } } } } } } }`)).products.nodes
  .filter((p) => p.templateSuffix === 'bundle-landing');

let notReady = 0;
for (const p of prods) {
  const bad = p.variants.nodes.filter((v) => {
    const raw = v.metafields.nodes.find((m) => m.key === 'value_stack')?.value;
    if (!raw) return true;
    const rows = JSON.parse(raw);
    // Every physical row must name a cutout, or that card renders a broken image.
    return rows.some((r) => !r.digital && !r.img);
  });
  console.log(`${bad.length ? '✗' : '✓'} ${p.handle.padEnd(26)} ${p.variants.nodes.length} variant(s)`
    + `${bad.length ? `  not ready: ${bad.map((v) => v.title).join(', ')}` : ''}`);
  if (bad.length) notReady++;
}
if (notReady) {
  console.error(`\n✗ ${notReady} lander(s) lack per-variant stacks with cutout names. `
    + 'Run scripts/build-variant-value-stacks.mjs --apply first.');
  process.exit(1);
}

// ── 2. Parse both inline scripts before either can reach the theme ─────────
for (const [name, js] of [['value-stack', swapJs('data-vs-variant')], ['whats-in-it', swapJs('data-wib-variant')]]) {
  writeFileSync('/tmp/wib-check.js', js.replace(/\{\{[^}]*\}\}/g, 'X'));
  try {
    execFileSync(process.execPath, ['--check', '/tmp/wib-check.js'], { stdio: 'pipe' });
    console.log(`✓ ${name} inline script parses`);
  } catch (e) {
    console.error(`✗ ${name} inline script does NOT parse — refusing to write:\n${String(e.stderr || e)}`);
    process.exit(1);
  }
}

// ── 3. Write ───────────────────────────────────────────────────────────────
const themeId = await getMainThemeId();
const raw = await getThemeAsset(themeId, KEY);
const j = JSON.parse(raw);
if (!j.sections['whats-in-it']) throw new Error('no whats-in-it section in the template');
if (!j.sections.main?.blocks?.['value-stack']) throw new Error('no value-stack block in the template');

mkdirSync(join(ROOT, 'data', 'backups', 'theme'), { recursive: true });
const backupPath = join(ROOT, 'data', 'backups', 'theme', 'product.bundle-landing.before-wib-cutouts.json');
writeFileSync(backupPath, raw);
console.log(`backed up template → ${backupPath.replace(ROOT + '/', '')}`);

const wibSettings = j.sections['whats-in-it'].settings;
const wibKey = Object.keys(wibSettings).find((k) => typeof wibSettings[k] === 'string' && wibSettings[k].includes('wib__grid'));
if (!wibKey) throw new Error('could not find the custom_liquid setting on the whats-in-it section');
wibSettings[wibKey] = WHATS_IN_IT;
j.sections.main.blocks['value-stack'].settings.custom_liquid = VALUE_STACK;

const out = JSON.stringify(j, null, 2);
JSON.parse(out);

if (!APPLY) { console.log('\ndry run — pass --apply'); process.exit(0); }
await updateThemeAsset(themeId, KEY, out);
console.log('\n✓ template updated — grid and panel both rebuilt');
