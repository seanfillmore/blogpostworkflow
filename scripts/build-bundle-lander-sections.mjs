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

/**
 * `--sections` adds missing sections and never touches existing ones, so a
 * re-run cannot clobber edits made in the theme editor. `--sections --update`
 * is the deliberate opt-in that rewrites their settings from SECTIONS — used
 * when the design itself changes, which the theme editor cannot express.
 */
function injectSections(j, update = false) {
  let added = 0;
  for (const s of SECTIONS) {
    if (j.sections[s.key]) {
      if (!update) { console.log(`  ok    ${s.key} already present`); continue; }
      const before = JSON.stringify(j.sections[s.key].settings);
      if (before === JSON.stringify(s.settings)) { console.log(`  ok    ${s.key} unchanged`); continue; }
      j.sections[s.key] = { type: s.type, settings: s.settings };
      console.log(`  UPD   ${s.key}`);
      added++;
      continue;
    }
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

/**
 * Remove the hero's own star row.
 *
 * It drew 5 stars filled to `bundle.rating_value` and captioned them with
 * `bundle.rating_count` — hand-maintained numbers that drift the moment a
 * review lands. Judge.me's badge already renders a live rating on the same
 * page, so this was a second, staler renderer of the same fact: the API says
 * the lotion+cream group is 135 @ 4.84 while the badge shows 131, and our
 * metafields had been asserting whichever was last copied by hand.
 *
 * Judge.me is now the only thing on the page that states a rating.
 */
const HERO_RATING_START =
  '{% if section.settings.show_rating and rating_count > 0 and rating_value != blank %}';
const HERO_RATING_ASSIGNS =
  "assign rating_count = product.metafields.bundle.rating_count.value | plus: 0\n" +
  '  assign rating_value = product.metafields.bundle.rating_value.value\n' +
  '  if rating_count > 0 and rating_value != blank\n' +
  "    assign hero_rating = rating_value | append: ' from ' | append: rating_count" +
  " | append: ' reviews of the products inside'\n" +
  '  endif\n';

export function dropHeroRating(liquid) {
  if (!liquid.includes(HERO_RATING_START) && !liquid.includes(HERO_RATING_ASSIGNS)) return liquid;

  let out = liquid;
  const s0 = out.indexOf(HERO_RATING_START);
  if (s0 === -1) throw new Error('hero rating: assigns found but markup missing — inspect before proceeding');
  const divIdx = out.indexOf('</div>', s0);
  const endIdx = out.indexOf('{% endif %}', divIdx);
  if (divIdx === -1 || endIdx === -1) throw new Error('hero rating: could not find the block close');
  out = out.slice(0, s0) + out.slice(endIdx + '{% endif %}'.length);

  if (!out.includes(HERO_RATING_ASSIGNS)) throw new Error('hero rating: assign block not found verbatim');
  out = out.replace(HERO_RATING_ASSIGNS, '');

  if (/bundle\.rating_(value|count)/.test(out)) {
    throw new Error('hero rating: a reference to the rating metafields survived the edit');
  }
  return out;
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

const HOME_KEY = 'templates/index.json';
const BANNER_KEY = 'reset-banner';
const BANNER = {
  type: 'custom-liquid',
  settings: {
    custom_liquid:
      '<style>.rbn{background:#f6f8f3;border-top:1px solid #e2ead9;border-bottom:1px solid #e2ead9;padding:26px 18px}' +
      '.rbn__i{max-width:900px;margin:0 auto;display:flex;gap:18px;align-items:center;justify-content:space-between;flex-wrap:wrap}' +
      '.rbn__t{margin:0;font-size:clamp(17px,2.2vw,21px);font-weight:700;color:#1a1b18;line-height:1.35}' +
      '.rbn__s{margin:5px 0 0;font-size:14px;color:#4a4a4a}' +
      '.rbn__c{background:#4a8b3c;color:#fff;text-decoration:none;font-weight:700;font-size:15px;padding:12px 22px;border-radius:8px;white-space:nowrap}</style>' +
      '<div class="rbn"><div class="rbn__i"><div>' +
      '<p class="rbn__t">Tired of running out? Get ninety days of both formulas.</p>' +
      '<p class="rbn__s">3 Body Lotions + 3 Body Creams — about $1.34 a day.</p></div>' +
      '<a class="rbn__c" href="/products/99-coconut-reset-digital">See the 90-Day Reset</a>' +
      '</div></div>',
  },
};

async function main() {
  if (process.argv.includes('--homepage')) {
    const themeId = await getMainThemeId();
    const rawH = await getThemeAsset(themeId, HOME_KEY);
    const h = JSON.parse(rawH);
    if (h.sections[BANNER_KEY]) { console.log('banner already present.'); return; }
    const at = h.order.indexOf('thesis');
    if (at === -1) throw new Error('homepage "thesis" section not found — inspect index.json');
    h.sections[BANNER_KEY] = BANNER;
    h.order.splice(at, 0, BANNER_KEY);
    console.log(`inserted ${BANNER_KEY} before "thesis"`);
    console.log(`order: ${h.order.join(' → ')}`);
    if (!APPLY) { console.log('\ndry run — re-run with --apply to push.'); return; }
    await updateThemeAsset(themeId, HOME_KEY, JSON.stringify(h, null, 2));
    console.log(`pushed ${HOME_KEY}`);
    return;
  }

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
    const added = injectSections(j, process.argv.includes('--update'));
    console.log(`\norder: ${j.order.join(' → ')}`);
    if (!added) { console.log('nothing to change.'); return; }
    if (!APPLY) { console.log('\ndry run — re-run with --apply to push.'); return; }
    await updateThemeAsset(themeId, KEY, JSON.stringify(j, null, 2));
    console.log(`pushed ${KEY} to theme ${themeId}`);
    return;
  }

  if (process.argv.includes('--drop-hero-rating')) {
    const key = 'sections/hero-landing-section.liquid';
    const before = await getThemeAsset(themeId, key);
    if (!before) throw new Error(`${key} not found on theme ${themeId}`);
    const after = dropHeroRating(before);
    if (before === after) { console.log('hero rating already removed.'); return; }
    console.log(`${key}: ${before.length} → ${after.length} bytes`);
    console.log('  removed the metafield-driven star row; Judge.me is now the only rating on the page');
    if (!APPLY) { console.log('\ndry run — re-run with --apply to push.'); return; }
    await updateThemeAsset(themeId, key, after);
    console.log(`pushed ${key} to theme ${themeId}`);
    return;
  }

  console.error('specify --value-stack, --sections, --sections-liquid, --homepage, or --drop-hero-rating');
  process.exit(1);
}

await main();
