/**
 * Verify each bundle variant's customer-facing `bundle.contents` copy matches the
 * components actually attached to it.
 *
 *   node scripts/verify-bundle-contents.mjs [product-handle]
 *
 * WHY
 *   `bundle.contents` is hand-written prose, deliberately — the storefront cannot
 *   read `productVariantComponents`, and "Calming Lavender (lavender, lemon &
 *   rosemary)" is more useful to a buyer than `coconut-oil-deodorant/Calming
 *   Lavender`. The cost of that choice is duplicated data, and duplicated data
 *   drifts. This is the check that catches the drift.
 *
 *   It has already caught one: the Gentle kit shipped All Natural toothpaste while
 *   its copy said Fresh Mint. A customer buying the "gentle" option would have
 *   received cinnamon and clove.
 *
 * WHAT IT CANNOT CHECK
 *   The parenthetical ingredient notes. Those come from config/ingredients.json and
 *   are checked by eye — see the note below about "All Natural", whose name and
 *   config keywords both imply unflavoured while it actually carries four oils.
 */

import { shopifyGraphQL } from '../lib/shopify.js';
import { loadRoster } from '../lib/bundle-roster.js';

const only = process.argv[2];

const q = `{
  products(first: 100, query: "tag:bundle") {
    nodes {
      handle title
      priceRangeV2 { minVariantPrice { amount } maxVariantPrice { amount } }
      components: metafield(namespace: "bundle", key: "components") { value }
      qty: metafield(namespace: "bundle", key: "component_qty") { value }
      variants(first: 20) {
        pageInfo { hasNextPage }
        nodes {
          title
          selectedOptions { name value }
          metafield(namespace: "bundle", key: "contents") { value }
          productVariantComponents(first: 20) {
            nodes { quantity productVariant { title product { handle title } } }
          }
        }
      }
    }
  }
}`;

const res = await shopifyGraphQL(q);
let products = res.products.nodes.filter(p => p.variants.nodes.some(v => v.productVariantComponents.nodes.length));
if (only) products = products.filter(p => p.handle === only);

// Truncation guard: variants(first: 20) must not silently truncate
for (const p of products) {
  if (p.variants.pageInfo.hasNextPage) {
    throw new Error(
      `verify-bundle-contents: "${p.handle}" has more than 20 variants — ` +
      'variants(first: 20) truncated silently. Raise `first` on the variants connection ' +
      '(and re-check the query cost budget) before trusting the component drift check.'
    );
  }
}

if (!products.length) {
  console.log(only ? `no componentized bundle with handle "${only}"` : 'no componentized bundles found (are they tagged "bundle"?)');
  process.exit(0);
}

// Resolve product gids -> handles so the reference list can be compared to components.
const handleOf = {};
{
  const ids = products.flatMap(p => { try { return JSON.parse(p.components?.value ?? '[]'); } catch { return []; } });
  if (ids.length) {
    const r = await shopifyGraphQL(`{ nodes(ids: [${[...new Set(ids)].map(i => `"${i}"`).join(',')}]) { ... on Product { id handle } } }`);
    for (const n of r.nodes) if (n) handleOf[n.id] = n.handle;
  }
}

let problems = 0;
for (const p of products) {
  console.log(`\n${p.title}  (${p.handle})`);

  // ── bundle.components / bundle.component_qty are two index-aligned lists.
  // Reorder one without the other and quantities silently attach to the wrong
  // product — nothing errors, the card just lies. This is that check.
  // Componentizing a variant OVERWRITES its price with the component sum. Do it
  // after setting the price — as happened to the Clean Swap's Gentle kit, which
  // silently reverted to $207 — and nothing errors; the page just sells at the
  // wrong price. So: every variant of a bundle must share one price.
  const lo = Number(p.priceRangeV2.minVariantPrice.amount);
  const hi = Number(p.priceRangeV2.maxVariantPrice.amount);
  if (lo !== hi) {
    console.log(`  PRICE SPLIT ACROSS VARIANTS: $${lo.toFixed(2)} - $${hi.toFixed(2)} — one variant likely reverted to its component sum after re-componentizing`);
    problems++;
  }

  let refIds = [], refQty = [];
  try { refIds = JSON.parse(p.components?.value ?? '[]'); } catch {}
  try { refQty = JSON.parse(p.qty?.value ?? '[]'); } catch {}

  if (refIds.length) {
    if (refQty.length && refQty.length !== refIds.length) {
      console.log(`  components/qty LENGTH MISMATCH: ${refIds.length} products vs ${refQty.length} quantities`);
      problems++;
    } else {
      // what the variants actually ship, summed per component product
      const actual = {};
      for (const v of p.variants.nodes) {
        for (const c of v.productVariantComponents.nodes) {
          const h = c.productVariant.product.handle;
          actual[h] = Math.max(actual[h] ?? 0, c.quantity);
        }
      }
      const declared = refIds.map((id, i) => [handleOf[id] ?? id, refQty[i] ?? null]);
      const bad = [];
      for (const [h, q] of declared) {
        if (actual[h] === undefined) bad.push(`declares ${h} but no variant ships it`);
        else if (q !== null && q !== actual[h]) bad.push(`${h}: card says ${q}x, components ship ${actual[h]}x`);
      }
      for (const h of Object.keys(actual)) {
        if (!declared.some(([dh]) => dh === h)) bad.push(`ships ${h} but the cards never show it`);
      }
      if (bad.length) { problems++; console.log('  COMPONENT CARDS MISMATCH'); for (const b of bad) console.log(`      ${b}`); }
      else console.log(`  component cards: ok (${declared.map(([h,q]) => `${q}x ${h}`).join(', ')})`);
    }
  }
  for (const v of p.variants.nodes) {
    const comps = v.productVariantComponents.nodes;
    if (!comps.length) continue;
    const copy = v.metafield?.value ?? '';

    if (!copy) {
      console.log(`  ${v.title}: NO bundle.contents copy — the picker will show nothing`);
      problems++;
      continue;
    }

    const missing = [];
    for (const c of comps) {
      // the component's variant title must appear somewhere in the copy
      if (!copy.toLowerCase().includes(c.productVariant.title.toLowerCase())) {
        missing.push(`${c.quantity}× ${c.productVariant.product.title} / ${c.productVariant.title}`);
      }
    }
    // and the copy must not promise a variant that is not actually a component
    const compTitles = comps.map(c => c.productVariant.title.toLowerCase());
    const promised = [...copy.matchAll(/—\s*([^(\n]+?)\s*(?:\(|$)/gm)].map(m => m[1].trim());
    const phantom = promised.filter(t => t && !compTitles.includes(t.toLowerCase()));

    if (!missing.length && !phantom.length) {
      console.log(`  ${v.title}: ok (${comps.length} components)`);
    } else {
      problems++;
      console.log(`  ${v.title}: MISMATCH`);
      for (const m of missing) console.log(`      ships but copy never mentions it:  ${m}`);
      for (const t of phantom) console.log(`      copy promises but does not ship:   ${t}`);
    }
  }
}

if (problems) {
  console.log(`\n${problems} variant(s) with mismatched copy. Customers would receive something other than what the page says.`);
  process.exitCode = 1;
}
if (!problems) console.log('\nAll bundle copy matches components.');

// ── spec ↔ Shopify ─────────────────────────────────────────────────────────
// The roster is only a source of truth if drift from it is an error. Without
// this, config/bundles.json is documentation that rots.

const roster = loadRoster();
let drift = 0;

// When checking a single handle, only validate that bundle in the roster.
const bundlesToCheck = only ? roster.bundles.filter(b => b.handle === only) : roster.bundles;

for (const spec of bundlesToCheck) {
  const live = products.find(p => p.handle === spec.handle);
  if (!live) { console.log(`\n${spec.handle}: in the roster but not live`); drift++; continue; }

  for (const sv of spec.variants) {
    const wanted = Object.values(sv.options).join(' / ');
    // Match on the exact option map, never on the title. "4 pumps" is a prefix
    // of "4 pumps + body lotion", so a substring match compares the wrong
    // basket and reports a false pass.
    const lv = live.variants.nodes.find(v => {
      const liveOpts = Object.fromEntries(v.selectedOptions.map(o => [o.name, o.value]));
      const specKeys = Object.keys(sv.options);
      return specKeys.length === Object.keys(liveOpts).length
        && specKeys.every(k => liveOpts[k] === sv.options[k]);
    });
    if (!lv) { console.log(`\n${spec.handle} / ${wanted}: variant missing in Shopify`); drift++; continue; }

    const liveSet = new Set(lv.productVariantComponents.nodes
      .map(c => `${c.productVariant.product.handle}/${c.productVariant.title}×${c.quantity}`));
    const specSet = new Set(sv.components.map(c => `${c.product}/${c.variant}×${c.qty}`));

    for (const s of specSet) if (!liveSet.has(s)) { console.log(`\n${spec.handle} / ${wanted}: roster expects ${s}, Shopify does not ship it`); drift++; }
    for (const l of liveSet) if (!specSet.has(l)) { console.log(`\n${spec.handle} / ${wanted}: Shopify ships ${l}, roster does not list it`); drift++; }
  }
}

console.log(drift ? `\n${drift} drift(s) between config/bundles.json and Shopify.` : '\nRoster matches Shopify.');
if (drift) process.exitCode = 1;
