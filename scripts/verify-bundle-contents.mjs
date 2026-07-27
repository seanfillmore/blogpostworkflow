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
import { loadRoster, SKU_BY_HANDLE } from '../lib/bundle-roster.js';
import { SKUS } from './bundle-economics.mjs';

const only = process.argv[2];

const q = `{
  products(first: 100, query: "tag:bundle") {
    nodes {
      handle title
      components: metafield(namespace: "bundle", key: "components") { value }
      qty: metafield(namespace: "bundle", key: "component_qty") { value }
      variants(first: 20) {
        pageInfo { hasNextPage }
        nodes {
          title
          price
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

// Channel publications, fetched separately (one root field per bundle, aliased)
// rather than nested inside the products(first: 100) query above — nesting
// resourcePublications there multiplies its cost by the outer connection size
// and blows the single-query cost budget (1055 > 1000). `products` here is
// already just the small set of componentized bundles, so this stays cheap.
{
  const query = products
    .map((p, i) => `p${i}: productByHandle(handle: "${p.handle}") { resourcePublications(first: 20) { nodes { publication { name } isPublished } } }`)
    .join('\n');
  const r = await shopifyGraphQL(`{ ${query} }`);
  products.forEach((p, i) => { p.resourcePublications = r[`p${i}`]?.resourcePublications; });
}

// The roster is the ground truth the builder itself reads from (see
// scripts/build-bundle.mjs step 5), so it is also the ground truth this
// script compares against — both for the component-cards check just below
// and for the spec ↔ Shopify drift check further down.
const roster = loadRoster();

let problems = 0;
const knownGaps = [];
for (const p of products) {
  console.log(`\n${p.title}  (${p.handle})`);
  const spec = roster.bundles.find(b => b.handle === p.handle);

  // ── bundle.components / bundle.component_qty are two index-aligned lists.
  // Reorder one without the other and quantities silently attach to the wrong
  // product — nothing errors, the card just lies. This is that check.
  // (Price correctness — including the componentize-overwrite trap — is
  // checked exactly against config/bundles.json in the roster section below,
  // not guessed here. See the comment there for why.)

  let refIds = [], refQty = [];
  try { refIds = JSON.parse(p.components?.value ?? '[]'); } catch {}
  try { refQty = JSON.parse(p.qty?.value ?? '[]'); } catch {}

  if (refIds.length) {
    if (refQty.length && refQty.length !== refIds.length) {
      console.log(`  components/qty LENGTH MISMATCH: ${refIds.length} products vs ${refQty.length} quantities`);
      problems++;
    } else {
      // What the cards SHOULD show, per the builder's own documented intent
      // (scripts/build-bundle.mjs step 5): the product-level cards are
      // derived from roster.variants[0].components ONLY, because a
      // product-level field can only ever describe one basket. Comparing
      // against an aggregate of every live variant's components — as this
      // check used to — contradicts that by design: the Hand Soap Set's
      // later configurations deliberately add a body lotion that
      // variants[0] never had, and the aggregate flagged that addition as
      // a "the cards never show it" mismatch when it was never supposed to
      // be on the cards at all. Compare against the same source the
      // builder used, not a reconstruction from live data.
      const actual = {};
      for (const c of spec?.variants?.[0]?.components ?? []) {
        actual[c.product] = (actual[c.product] ?? 0) + c.qty;
      }
      const declared = refIds.map((id, i) => [handleOf[id] ?? id, refQty[i] ?? null]);
      const bad = [];
      for (const [h, q] of declared) {
        if (actual[h] === undefined) bad.push(`declares ${h} but roster's first variant doesn't ship it`);
        else if (q !== null && q !== actual[h]) bad.push(`${h}: card says ${q}x, roster's first variant ships ${actual[h]}x`);
      }
      for (const h of Object.keys(actual)) {
        if (!declared.some(([dh]) => dh === h)) bad.push(`roster's first variant ships ${h} but the cards never show it`);
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
      // A roster entry that explicitly declares `contents: ""` (as opposed
      // to simply omitting the field) is documenting a KNOWN, pre-existing
      // gap — e.g. sensitive-skin-starter-set, where the metafield genuinely
      // is not set live. That is not the same failure as drift: drift is
      // "this used to match and no longer does"; this is "this was never
      // set, and the roster says so". Conflating the two trains reviewers to
      // ignore the exit code, which is exactly the alarm fatigue that let a
      // real $207 mispricing through review. Report it, but separately, and
      // don't let it fail the build.
      const specVariant = spec?.variants?.find(sv => {
        const liveOpts = Object.fromEntries(v.selectedOptions.map(o => [o.name, o.value]));
        const specKeys = Object.keys(sv.options);
        return specKeys.length === Object.keys(liveOpts).length
          && specKeys.every(k => liveOpts[k] === sv.options[k]);
      });
      if (specVariant && specVariant.contents === '') {
        knownGaps.push(`${p.handle} / ${v.title}: NO bundle.contents copy (roster's "contents" is explicitly "" — a documented gap, not drift)`);
        console.log(`  ${v.title}: no bundle.contents copy — known gap, see "Known gaps" below`);
      } else {
        console.log(`  ${v.title}: NO bundle.contents copy — the picker will show nothing`);
        problems++;
      }
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

if (knownGaps.length) {
  console.log('\nKnown gaps (not drift):');
  for (const g of knownGaps) console.log(`  ${g}`);
}

// ── channel publishing ──────────────────────────────────────────────────────
// Componentized bundles must only be on Online Store and Shop — every other
// channel is a product-feed channel that either refuses componentized
// products outright or, worse, accepts the listing without the component
// relationship and carries phantom sellable inventory. Publishing is
// additive (scripts/build-bundle.mjs only ever calls publishablePublish, never
// unpublish), so nothing here catches a channel someone added by hand except
// this check. Reported, not auto-fixed — 99-coconut-reset-digital and
// sensitive-skin-starter-set are already on extra channels and require a
// manual unpublish, not a script.
const ALLOWED_CHANNELS = new Set(['Online Store', 'Shop']);
const extraChannelReports = [];
for (const p of products) {
  const extra = (p.resourcePublications?.nodes ?? [])
    .filter(rp => rp.isPublished && !ALLOWED_CHANNELS.has(rp.publication.name))
    .map(rp => rp.publication.name);
  if (extra.length) extraChannelReports.push(`${p.handle}: published to ${extra.join(', ')} (componentized bundles should only be on Online Store/Shop)`);
}
if (extraChannelReports.length) {
  console.log('\nExtra channel publishing (not drift — needs a manual unpublish):');
  for (const r of extraChannelReports) console.log(`  ${r}`);
}

// ── spec ↔ Shopify ─────────────────────────────────────────────────────────
// The roster is only a source of truth if drift from it is an error. Without
// this, config/bundles.json is documentation that rots.

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

    // Exact comparison, not a spread heuristic: componentizing overwrites a
    // variant's price with its component sum, and that has mispriced live
    // products three times. A "do all variants share one price" heuristic
    // used to catch it, but it also fired on the Hand Soap Set's deliberate
    // $44/$59/$72 ladder — a false positive indistinguishable in output from
    // the real bug, which got a genuine $48 overcharge dismissed as noise.
    // The roster now names every variant's intended price, so there is no
    // need to guess: compare live to roster, and when they differ, name the
    // component sum too — if live price equals it, that IS the overwrite bug.
    const livePrice = Number(lv.price);
    const wantPrice = Number(sv.price);
    if (livePrice !== wantPrice) {
      const sum = sv.components.reduce((s, c) => {
        const key = SKU_BY_HANDLE[c.product];
        return s + (key && SKUS[key] ? SKUS[key].price * c.qty : 0);
      }, 0);
      const sumNote = livePrice === sum
        ? ` — equals the component sum ($${sum.toFixed(2)}): this is the componentize-overwrite bug, not a deliberate reprice`
        : '';
      console.log(`\n${spec.handle} / ${wanted}: live price $${livePrice.toFixed(2)}, roster expects $${wantPrice.toFixed(2)}${sumNote}`);
      drift++;
    }

    const liveSet = new Set(lv.productVariantComponents.nodes
      .map(c => `${c.productVariant.product.handle}/${c.productVariant.title}×${c.quantity}`));
    const specSet = new Set(sv.components.map(c => `${c.product}/${c.variant}×${c.qty}`));

    for (const s of specSet) if (!liveSet.has(s)) { console.log(`\n${spec.handle} / ${wanted}: roster expects ${s}, Shopify does not ship it`); drift++; }
    for (const l of liveSet) if (!specSet.has(l)) { console.log(`\n${spec.handle} / ${wanted}: Shopify ships ${l}, roster does not list it`); drift++; }
  }

  // Reverse pass: the loop above only ever walks spec.variants, so a live
  // variant the roster doesn't declare at all is never price- or
  // component-checked by anything above — it just silently isn't visited.
  // A variant added directly in Shopify (or one a roster edit left behind)
  // needs to be just as loud as a declared variant that drifted.
  for (const lv of live.variants.nodes) {
    const liveOpts = Object.fromEntries(lv.selectedOptions.map(o => [o.name, o.value]));
    const declaredInRoster = spec.variants.some(sv => {
      const specKeys = Object.keys(sv.options);
      return specKeys.length === Object.keys(liveOpts).length
        && specKeys.every(k => liveOpts[k] === sv.options[k]);
    });
    if (!declaredInRoster) {
      console.log(`\n${spec.handle} / ${lv.title}: live variant is not declared in the roster at all`);
      drift++;
    }
  }
}

console.log(drift ? `\n${drift} drift(s) between config/bundles.json and Shopify.` : '\nRoster matches Shopify.');
if (drift) process.exitCode = 1;
