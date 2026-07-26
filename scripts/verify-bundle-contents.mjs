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

const only = process.argv[2];

const q = `{
  products(first: 100, query: "tag:bundle") {
    nodes {
      handle title
      variants(first: 20) {
        nodes {
          title
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

if (!products.length) {
  console.log(only ? `no componentized bundle with handle "${only}"` : 'no componentized bundles found (are they tagged "bundle"?)');
  process.exit(0);
}

let problems = 0;
for (const p of products) {
  console.log(`\n${p.title}  (${p.handle})`);
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
  process.exit(1);
}
console.log('\nAll bundle copy matches components.');
