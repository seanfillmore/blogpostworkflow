/**
 * Edit the shared bundle landing template.
 *
 *   node scripts/build-bundle-lander-sections.mjs --value-stack     [--apply]
 *   node scripts/build-bundle-lander-sections.mjs --sections        [--apply]
 *   node scripts/build-bundle-lander-sections.mjs --sections-liquid [--apply]
 *
 * FIVE bundles share templates/product.bundle-landing.json. Everything written
 * here must be per-product data-driven, or it leaks one bundle's content onto
 * the other four. Sections self-suppress on blank fields for exactly that
 * reason.
 *
 * --sections-liquid patches three site-wide section files that ALSO compute a
 * bundle value total (independently of the template blocks above) whenever
 * they render on a product with a bundle.value_stack metafield:
 *   sections/hero-landing-section.liquid
 *   sections/multicolumn.liquid
 *   sections/rich-text.liquid
 * They loop over `bt_row`, not `row`, so they were missed by --value-stack.
 * Same digital-exclusion fix, same idempotency contract.
 *
 * The live theme is the source of truth: pull, modify, push. Dry-run default.
 */
import { getMainThemeId, getThemeAsset, updateThemeAsset } from '../lib/shopify.js';
import { SECTIONS } from '../lib/bundle-lander.js';

const KEY = 'templates/product.bundle-landing.json';
const APPLY = process.argv.includes('--apply');

const ORDER = [
  'hero', 'hook', 'main', 'whats-in-it', 'timeline', 'mechanism',
  'ingredient-cards', 'stats', 'compare-rows',
  'judgeme_section_review_widget_f881', 'founder-note',
  'free-from-block', 'collapsible-content', 'final-cta-strip',
];

function injectSections(j) {
  let added = 0;
  for (const s of SECTIONS) {
    if (j.sections[s.key]) { console.log(`  ok    ${s.key} already present`); continue; }
    j.sections[s.key] = { type: s.type, settings: s.settings };
    console.log(`  ADD   ${s.key}`);
    added++;
  }
  const present = ORDER.filter((k) => j.sections[k]);
  const extras = Object.keys(j.sections).filter((k) => !present.includes(k));
  if (extras.length) throw new Error(`unexpected sections not in ORDER: ${extras.join(', ')}`);
  j.order = present;
  return added;
}

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

// The three site-wide sections loop over `bt_row` (not `row`) and sum with
// no digital exclusion at all. Same fix as patchTotalOnly, different loop var.
const NAIVE_BT_ROW_LOOP =
  '    for bt_row in product.metafields.bundle.value_stack.value\n'
  + '      assign bundle_total = bundle_total | plus: bt_row.amount\n'
  + '    endfor';
const DIGITAL_AWARE_BT_ROW_LOOP =
  '    for bt_row in product.metafields.bundle.value_stack.value\n'
  + '      unless bt_row.digital\n'
  + '        assign bundle_total = bundle_total | plus: bt_row.amount\n'
  + '      endunless\n'
  + '    endfor';

function patchBtRowLoop(liquid, label) {
  if (liquid.includes(DIGITAL_AWARE_BT_ROW_LOOP)) return liquid; // already patched
  if (!liquid.includes(NAIVE_BT_ROW_LOOP)) {
    throw new Error(`${label}: expected naive bt_row loop not found — inspect before proceeding`);
  }
  return liquid.replace(NAIVE_BT_ROW_LOOP, DIGITAL_AWARE_BT_ROW_LOOP);
}

const SECTION_LIQUID_FILES = [
  'sections/hero-landing-section.liquid',
  'sections/multicolumn.liquid',
  'sections/rich-text.liquid',
];

async function main() {
  if (process.argv.includes('--sections-liquid')) {
    const themeId = await getMainThemeId();
    let anyChanged = false;

    for (const key of SECTION_LIQUID_FILES) {
      const before = await getThemeAsset(themeId, key);
      if (before == null) throw new Error(`${key} not found on theme ${themeId}`);
      const after = patchBtRowLoop(before, key);
      if (before === after) {
        console.log(`${key}: ok (already patched)`);
        continue;
      }
      anyChanged = true;
      if (!APPLY) {
        console.log(`${key}: would patch (dry run)`);
        continue;
      }
      await updateThemeAsset(themeId, key, after);
      console.log(`${key}: patched and pushed to theme ${themeId}`);
    }

    if (!anyChanged) { console.log('\nall three section files already patched — nothing to do.'); return; }
    if (!APPLY) { console.log('\ndry run — re-run with --apply to push.'); return; }
    return;
  }

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

  if (process.argv.includes('--sections')) {
    const added = injectSections(j);
    console.log(`\norder: ${j.order.join(' → ')}`);
    if (!added) { console.log('nothing to add.'); return; }
    if (!APPLY) { console.log('\ndry run — re-run with --apply to push.'); return; }
    await updateThemeAsset(themeId, KEY, JSON.stringify(j, null, 2));
    console.log(`pushed ${KEY} to theme ${themeId}`);
    return;
  }

  console.error('specify --value-stack, --sections, or --sections-liquid');
  process.exit(1);
}

await main();
