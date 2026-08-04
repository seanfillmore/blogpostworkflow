/**
 * Edit the shared bundle landing template.
 *
 *   node scripts/build-bundle-lander-sections.mjs --value-stack [--apply]
 *   node scripts/build-bundle-lander-sections.mjs --sections    [--apply]
 *
 * FIVE bundles share templates/product.bundle-landing.json. Everything written
 * here must be per-product data-driven, or it leaks one bundle's content onto
 * the other four. Sections self-suppress on blank fields for exactly that
 * reason.
 *
 * The live theme is the source of truth: pull, modify, push. Dry-run default.
 */
import { getMainThemeId, getThemeAsset, updateThemeAsset } from '../lib/shopify.js';

const KEY = 'templates/product.bundle-landing.json';
const APPLY = process.argv.includes('--apply');

// Mirrors computeStackTotals() in lib/bundle-lander.js. Change both together.
const VALUE_STACK_LOGIC = `{%- liquid
  assign total = 0
  assign has_digital = false
  for row in stack
    if row.digital
      assign has_digital = true
    else
      assign total = total | plus: row.amount
    endif
  endfor
  assign price_dollars = v.price | divided_by: 100
  assign savings = total | minus: price_dollars
-%}`;

function patchValueStack(liquid) {
  // Idempotent: already-patched liquid carries this exact logic block verbatim.
  if (liquid.includes(VALUE_STACK_LOGIC)) return liquid;

  // Replace the naive sum with the digital-aware one.
  const naive = /\{%-\s*liquid\s+assign total = 0\s+for row in stack\s+assign total = total \| plus: row\.amount\s+endfor\s+assign price_dollars = v\.price \| divided_by: 100\s+assign savings = total \| minus: price_dollars\s*-%\}/;
  if (!naive.test(liquid)) throw new Error('value-stack: expected naive-sum block not found — inspect before proceeding');
  let out = liquid.replace(naive, VALUE_STACK_LOGIC);

  // Priced rows only in the priced list.
  const rowLoop = '{%- for row in stack -%}<div class="crx-vs__row">';
  if (!out.includes(rowLoop)) throw new Error('value-stack: row loop not found');
  out = out.replace(rowLoop, '{%- for row in stack -%}{%- unless row.digital -%}<div class="crx-vs__row">');
  const rowEnd = '<span class="crx-vs__price">${{ row.amount }}</span></div>{%- endfor -%}';
  if (!out.includes(rowEnd)) throw new Error('value-stack: row loop end not found');
  out = out.replace(rowEnd,
    '<span class="crx-vs__price">${{ row.amount }}</span></div>{%- endunless -%}{%- endfor -%}' +
    '{%- if has_digital -%}<div class="crx-vs__incl"><p class="crx-vs__incl-t">Also included, free</p>' +
    '{%- for row in stack -%}{%- if row.digital -%}<div class="crx-vs__incl-r">{{ row.label }}</div>{%- endif -%}{%- endfor -%}' +
    '</div>{%- endif -%}');

  // Styles for the new group.
  out = out.replace('</style>',
    '.crx-vs__incl{margin-top:12px;padding-top:12px;border-top:1px dashed #cbd8c0;}' +
    '.crx-vs__incl-t{margin:0 0 6px;font-size:12.5px;font-weight:700;color:#4a8b3c;letter-spacing:.02em;}' +
    '.crx-vs__incl-r{font-size:13.5px;color:#4a4a4a;line-height:1.5;}' +
    '.crx-vs__incl-r:before{content:"+ ";color:#4a8b3c;font-weight:700;}</style>');
  return out;
}

// bundle-savings and benefits both total the stack with the identical naive
// sum (no digital exclusion). Mirrors computeStackTotals in lib/bundle-lander.js
// — change both together. This does NOT add an "Also included, free" group;
// that presentation is value-stack-only. These two only need `total` corrected
// so it matches value-stack's $174 rather than the naive $208.
const NAIVE_TOTAL_LOOP =
  'assign total = 0\n  for row in stack\n    assign total = total | plus: row.amount\n  endfor';
const DIGITAL_AWARE_TOTAL_LOOP =
  'assign total = 0\n  for row in stack\n    unless row.digital\n      assign total = total | plus: row.amount\n    endunless\n  endfor';

function patchTotalOnly(liquid, label) {
  if (liquid.includes(DIGITAL_AWARE_TOTAL_LOOP)) return liquid; // already patched
  if (!liquid.includes(NAIVE_TOTAL_LOOP)) {
    throw new Error(`${label}: expected naive-sum loop not found — inspect before proceeding`);
  }
  return liquid.replace(NAIVE_TOTAL_LOOP, DIGITAL_AWARE_TOTAL_LOOP);
}

async function main() {
  const themeId = await getMainThemeId();
  const raw = await getThemeAsset(themeId, KEY);
  if (!raw) throw new Error(`${KEY} not found on theme ${themeId}`);
  const j = JSON.parse(raw);

  if (process.argv.includes('--value-stack')) {
    let changed = false;

    const vsBlock = j.sections.main.blocks['value-stack'];
    if (!vsBlock) throw new Error('value-stack block missing');
    const vsBefore = vsBlock.settings.custom_liquid;
    const vsAfter = patchValueStack(vsBefore);
    if (vsBefore === vsAfter) {
      console.log('value-stack: ok (already patched)');
    } else {
      vsBlock.settings.custom_liquid = vsAfter;
      changed = true;
      console.log('value-stack: digital rows excluded from total, rendered as "Also included, free"');
    }

    // bundle-savings and benefits: total-only fix, no presentation change.
    for (const name of ['bundle-savings', 'benefits']) {
      const block = j.sections.main.blocks[name];
      if (!block) throw new Error(`${name} block missing`);
      const before = block.settings.custom_liquid;
      const after = patchTotalOnly(before, name);
      if (before === after) {
        console.log(`${name}: ok (already patched)`);
      } else {
        block.settings.custom_liquid = after;
        changed = true;
        console.log(`${name}: total now excludes digital rows`);
      }
    }

    if (!changed) { console.log('\nall three blocks already patched — nothing to do.'); return; }
    if (!APPLY) { console.log('\ndry run — re-run with --apply to push.'); return; }
    await updateThemeAsset(themeId, KEY, JSON.stringify(j, null, 2));
    console.log(`pushed ${KEY} to theme ${themeId}`);
    return;
  }

  console.error('specify --value-stack or --sections');
  process.exit(1);
}

await main();
