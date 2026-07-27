/**
 * Reconcile a bundle in Shopify against config/bundles.json.
 *
 *   node scripts/build-bundle.mjs <handle> [--apply]
 *   node scripts/build-bundle.mjs --all [--apply]
 *
 * Idempotent: every step reads current state and skips when already correct, so
 * a partial failure is repaired by running it again.
 *
 * ORDER MATTERS. Componentizing OVERWRITES the variant price with the sum of
 * its components, so prices are re-asserted afterwards in their own step. That
 * has shipped a wrong price to production twice.
 *
 * Channels: only Online Store and Shop accept componentized bundles. Google,
 * Meta, Pinterest, TikTok and Buy Button all refuse them, so channels are
 * published one at a time and refusals are reported, not fatal.
 */

import { shopifyGraphQL } from '../lib/shopify.js';
import { loadRoster, validateRoster } from '../lib/bundle-roster.js';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const ALL = args.includes('--all');
const handles = args.filter(a => !a.startsWith('--'));

const PUBLICATIONS = [
  ['gid://shopify/Publication/41249308707', 'Online Store'],
  ['gid://shopify/Publication/90546471082', 'Shop'],
];

const log = (...a) => console.log(...a);

async function gql(query, variables = {}) {
  const data = await shopifyGraphQL(query, variables);
  for (const v of Object.values(data ?? {})) {
    const errs = v?.userErrors ?? v?.mediaUserErrors;
    if (errs?.length) throw new Error(errs.map(e => `${(e.field ?? []).join('.')}: ${e.message}`).join('; '));
  }
  return data;
}

/** handle -> { id, variants: { [title]: id } } for every component product. */
async function loadCatalogue() {
  const d = await shopifyGraphQL(
    `{ products(first: 50) { nodes { id handle variants(first: 50) { nodes { id title } } } } }`
  );
  const byHandle = {};
  for (const p of d.products.nodes) {
    byHandle[p.handle] = {
      id: p.id,
      variants: Object.fromEntries(p.variants.nodes.map(v => [v.title, v.id])),
    };
  }
  return byHandle;
}

async function getProduct(handle) {
  const d = await shopifyGraphQL(`{
    productByHandle(handle: "${handle}") {
      id status templateSuffix
      lander: metafield(namespace: "bundle", key: "lander") { value }
      options { id name values }
      variants(first: 50) {
        nodes { id title price selectedOptions { name value }
          productVariantComponents(first: 20) { nodes { quantity productVariant { id } } } }
      }
      resourcePublications(first: 20) { nodes { publication { id name } isPublished } }
    }
  }`);
  return d.productByHandle;
}

const optionKey = opts => Object.entries(opts).sort(([a], [b]) => a.localeCompare(b))
  .map(([k, v]) => `${k}=${v}`).join('|');

async function buildBundle(bundle, catalogue) {
  log(`\n=== ${bundle.handle}`);

  let product = await getProduct(bundle.handle);

  // Guard: "bundle-landing" is a template SHARED across every bundle, driven
  // entirely by a per-product `bundle_lander` metaobject. This script never
  // writes that metaobject — it only ever wrote `bundle.components`,
  // `component_qty` and `contents`. Setting the template suffix without the
  // lander content existing first does not fall back to "no landing page";
  // it falls back to whatever OTHER product's lander metaobject Shopify
  // happens to resolve, rendering that product's H1, CTA and price. That is
  // exactly how clean-swap, gift-box and hand-soap-set went live all showing
  // the 90-Day Reset's copy and "$0 value, $0 today — you save $0". Refuse to
  // set this template until lander content is proven to exist.
  //
  // "Exist" means EITHER source: a non-empty roster `lander` object (for
  // bundles not yet backfilled onto Shopify), OR a live `bundle.lander`
  // metafield already on the product (pre-existing bundles like
  // 99-coconut-reset-digital, 90-day-clean-swap and head-to-toe were built
  // directly in Shopify — their lander metaobject reference was never
  // mirrored into the roster). Only refuse when NEITHER source has it.
  const hasRosterLander = bundle.lander && typeof bundle.lander === 'object' &&
    !Array.isArray(bundle.lander) && Object.keys(bundle.lander).length > 0;
  const hasLiveLander = Boolean(product?.lander?.value);
  if (bundle.templateSuffix === 'bundle-landing' && !hasRosterLander && !hasLiveLander) {
    throw new Error(
      `${bundle.handle}: refusing to set templateSuffix "bundle-landing" — this roster entry has no ` +
      `non-empty "lander" object AND the live product has no "bundle.lander" metafield. A shared ` +
      `template with no per-product content renders another product's copy. Build the bundle_lander ` +
      `metaobject for "${bundle.handle}" first, then add its reference under this bundle's "lander" ` +
      `key in config/bundles.json (or confirm it directly in Shopify).`
    );
  }

  // 1 — product shell
  //
  // A reconciler must never blank a field the roster is simply silent about —
  // descriptionHtml and tags are only sent when the roster actually specifies
  // them, same guard as `seo` already had. Status follows the roster: only
  // "live" bundles go ACTIVE and get published later; anything else stays
  // DRAFT and step 7 skips publishing.
  const isLive = bundle.status === 'live';
  const input = {
    title: bundle.title,
    handle: bundle.handle,
    templateSuffix: bundle.templateSuffix ?? null,
    status: isLive ? 'ACTIVE' : 'DRAFT',
    ...(bundle.descriptionHtml ? { descriptionHtml: bundle.descriptionHtml } : {}),
    ...(bundle.tags ? { tags: bundle.tags } : {}),
    ...(bundle.seo ? { seo: bundle.seo } : {}),
  };

  if (!product) {
    log('  creating product');
    if (!APPLY) return log('  (dry run — stopping here; nothing else can be planned without an id)');
    const d = await gql(
      `mutation ($input: ProductInput!) { productCreate(input: $input) { product { id } userErrors { field message } } }`,
      { input: { ...input, productOptions: bundle.options.map(o => ({ name: o.name, values: o.values.map(v => ({ name: v })) })) } }
    );
    product = await getProduct(bundle.handle);
    log(`  created ${d.productCreate.product.id}`);
  } else if (APPLY) {
    await gql(
      `mutation ($input: ProductInput!) { productUpdate(input: $input) { product { id } userErrors { field message } } }`,
      { input: { ...input, id: product.id } }
    );
    log('  product updated');
  }

  // 2 — variants
  const existing = new Map(product.variants.nodes.map(v =>
    [optionKey(Object.fromEntries(v.selectedOptions.map(o => [o.name, o.value]))), v]));

  // Orphans: variants live in Shopify but absent from the roster. Never
  // deleted here — deleting live variants is out of scope and dangerous —
  // but silent divergence from the source of truth is worse than a warning.
  const rosterKeys = new Set(bundle.variants.map(v => optionKey(v.options)));
  const orphans = [...existing.entries()].filter(([key]) => !rosterKeys.has(key)).map(([, v]) => v);
  if (orphans.length) {
    log(`  ⚠ orphan variant(s) in Shopify not in the roster (left alone): ${orphans.map(v => v.title).join(', ')}`);
  }

  const missing = bundle.variants.filter(v => !existing.has(optionKey(v.options)));
  if (missing.length) {
    log(`  ${APPLY ? 'creating' : 'would create'} ${missing.length} variant(s): ${missing.map(v => Object.values(v.options).join(' / ')).join(', ')}`);
    if (APPLY) {
      await gql(
        `mutation ($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
          productVariantsBulkCreate(productId: $productId, variants: $variants) {
            productVariants { id } userErrors { field message } } }`,
        {
          productId: product.id,
          variants: missing.map(v => ({
            optionValues: Object.entries(v.options).map(([name, value]) => ({ optionName: name, name: value })),
            price: String(v.price),
            ...(v.compareAtPrice ? { compareAtPrice: String(v.compareAtPrice) } : {}),
          })),
        }
      );
      product = await getProduct(bundle.handle);
    }
  }

  const live = new Map(product.variants.nodes.map(v =>
    [optionKey(Object.fromEntries(v.selectedOptions.map(o => [o.name, o.value]))), v]));

  // Resolve every roster variant to its live counterpart ONCE, before any
  // write. A miss here must throw immediately, naming the bundle and the
  // option key — not surface later as a bare "Cannot read properties of
  // undefined" after componentization has already overwritten the price
  // with the component sum, leaving the product live at the wrong price.
  // In a dry run against an EXISTING product, a roster variant with no live
  // counterpart is one already reported above as "would create" — skip it
  // here instead of throwing, since there is nothing live yet to diff
  // components or price against.
  const resolved = [];
  for (const v of bundle.variants) {
    const target = live.get(optionKey(v.options));
    if (!target) {
      if (!APPLY) continue;
      throw new Error(`${bundle.handle}: no live variant matches roster option key "${optionKey(v.options)}"`);
    }
    resolved.push({ v, target });
  }

  // 3 — components
  //
  // `productVariantRelationshipBulkUpdate`'s three verbs are NOT
  // interchangeable, and picking the wrong one fails in a way that looks like
  // something else entirely. `...ToUpdate` only changes the quantity of a
  // component relationship that ALREADY EXISTS on the parent variant — a
  // brand-new bundle has none, so Shopify rejects the call with
  // PRODUCT_VARIANTS_NOT_FOUND naming the PARENT variant id. That reads
  // exactly like the variant hasn't propagated yet (a transient timing issue)
  // and it is not one — it cost a full review cycle to trace back to "wrong
  // verb" instead of "wait and retry". `...ToCreate` is the verb that attaches
  // a component for the first time; `...ToRemove` (bare component variant
  // IDs, not `{id, quantity}`) detaches one. A reconciler that promises
  // idempotency has to read what's actually attached and route each desired
  // component to the correct one of the three verbs every time it runs — not
  // assume the bundle is either fully new or fully built, because a partial
  // failure (like this one) can leave a single variant with some components
  // attached and others missing. Do not collapse this back to one verb.
  const componentDiffs = resolved.map(({ v, target }) => {
    const present = new Map(
      target.productVariantComponents.nodes.map(n => [n.productVariant.id, n.quantity])
    );
    const desired = new Map(
      v.components.map(c => {
        const id = catalogue[c.product]?.variants[c.variant];
        if (!id) throw new Error(`no variant id for ${c.product} / ${c.variant}`);
        return [id, c.qty];
      })
    );

    const toCreate = [...desired].filter(([id]) => !present.has(id)).map(([id, quantity]) => ({ id, quantity }));
    // Only resend "present" relationships whose quantity actually changed —
    // otherwise a second run would call ToUpdate for every unchanged
    // component too, which isn't wrong but isn't a true no-op either, and the
    // docstring promises steps "skip when already correct".
    const toUpdate = [...desired]
      .filter(([id, quantity]) => present.has(id) && present.get(id) !== quantity)
      .map(([id, quantity]) => ({ id, quantity }));
    const toRemove = [...present.keys()].filter(id => !desired.has(id));

    return { v, target, toCreate, toUpdate, toRemove };
  });

  const relationships = componentDiffs
    .filter(d => d.toCreate.length || d.toUpdate.length || d.toRemove.length)
    .map(d => {
      const input = { parentProductVariantId: d.target.id };
      if (d.toCreate.length) input.productVariantRelationshipsToCreate = d.toCreate;
      if (d.toUpdate.length) input.productVariantRelationshipsToUpdate = d.toUpdate;
      if (d.toRemove.length) input.productVariantRelationshipsToRemove = d.toRemove;
      return input;
    });

  // Price diffs, needed both for the dry-run preview below and for the real
  // re-assertion in step 4.
  const priceChanges = resolved.filter(({ v, target }) => Number(target.price) !== v.price);

  // Channels not yet published, needed both for the dry-run preview and step 7.
  const alreadyPublished = new Set((product.resourcePublications?.nodes ?? [])
    .filter(rp => rp.isPublished)
    .map(rp => rp.publication.name));
  const channelsToPublish = isLive ? PUBLICATIONS.filter(([, name]) => !alreadyPublished.has(name)) : [];

  if (!APPLY) {
    log('  --- dry run preview (nothing written) ---');
    if (componentDiffs.some(d => d.toCreate.length || d.toUpdate.length || d.toRemove.length)) {
      for (const d of componentDiffs) {
        if (!d.toCreate.length && !d.toUpdate.length && !d.toRemove.length) continue;
        const label = Object.values(d.v.options).join(' / ');
        const parts = [];
        if (d.toCreate.length) parts.push(`+${d.toCreate.length} create`);
        if (d.toUpdate.length) parts.push(`~${d.toUpdate.length} update`);
        if (d.toRemove.length) parts.push(`-${d.toRemove.length} remove`);
        log(`    components, ${label}: ${parts.join(', ')}`);
      }
    } else {
      log('    components already match the roster — no changes');
    }
    if (priceChanges.length) {
      for (const { v, target } of priceChanges) {
        log(`    price, ${Object.values(v.options).join(' / ')}: $${target.price} -> $${v.price}`);
      }
    } else {
      log('    prices already match the roster — no changes');
    }
    if (channelsToPublish.length) {
      log(`    would publish to: ${channelsToPublish.map(([, name]) => name).join(', ')}`);
    } else if (isLive) {
      log('    already published to Online Store and Shop');
    }
    log('  (dry run — nothing written)');
    return;
  }

  // 3 & 4 — components, then RE-ASSERT PRICES. Componentizing overwrites
  // variant prices with the component sum as a Shopify side-effect, and the
  // product has been ACTIVE and published since step 1. These are two
  // separate mutations with no shared transaction: if EITHER throws, the
  // product is left in an unknown state that may already be componentized
  // (and therefore mispriced at the component sum) while still live and for
  // sale. Assume the worse case, draft the product immediately so nothing
  // can be purchased at the wrong price, and rethrow loudly rather than
  // swallow the error.
  try {
    if (relationships.length) {
      await gql(
        `mutation ($input: [ProductVariantRelationshipUpdateInput!]!) {
          productVariantRelationshipBulkUpdate(input: $input) {
            parentProductVariants { id } userErrors { field message } } }`,
        { input: relationships }
      );
      log(`  componentized ${relationships.length} variant(s) (create/update/remove as needed)`);
    } else {
      log('  components already match the roster — nothing to do');
    }

    // RE-ASSERT PRICES. Componentizing just overwrote them with the component sum.
    await gql(
      `mutation ($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
        productVariantsBulkUpdate(productId: $productId, variants: $variants) {
          productVariants { id price } userErrors { field message } } }`,
      {
        productId: product.id,
        variants: resolved.map(({ v, target }) => ({
          id: target.id,
          price: String(v.price),
          ...(v.compareAtPrice ? { compareAtPrice: String(v.compareAtPrice) } : {}),
        })),
      }
    );
    log('  prices re-asserted after componentization');
  } catch (err) {
    // The DRAFT mutation itself is not protected by anything upstream — if it
    // throws (network error, userErrors), it must never replace the pending
    // error. Losing the original failure here would erase the reason the
    // product needs attention, while leaving it ACTIVE and possibly priced at
    // the component sum with nothing in the output to explain why.
    try {
      await gql(
        `mutation ($input: ProductInput!) { productUpdate(input: $input) { product { id } userErrors { field message } } }`,
        { input: { id: product.id, status: 'DRAFT' } }
      );
    } catch (draftErr) {
      console.error(
        `  ✗✗ ${bundle.handle}: FAILED TO DRAFT after componentization/price re-assertion error — the ` +
        `product is STILL ACTIVE and may be priced at its component sum. Needs immediate manual ` +
        `attention. Drafting error: ${draftErr.message}`
      );
      throw err; // rethrow the ORIGINAL error, not the drafting error
    }
    throw new Error(
      `${bundle.handle}: componentization/price re-assertion failed — product set to DRAFT to prevent ` +
      `selling at the component sum. Original error: ${err.message}`
    );
  }

  // 5 — metafields
  //
  // `bundle.components` / `bundle.component_qty` drive the "what's in the box"
  // cards, which are PRODUCT-level and so can only describe one basket. For a
  // single-basket bundle (every kit holds the same SKUs, differing only by
  // scent) that is exact. For the Hand Soap Set the cards describe the FIRST
  // declared configuration; the per-variant `bundle.contents` panel is what
  // tells a buyer what their selection actually contains. Order the Hand Soap
  // Set's variants so the intended default configuration is first.
  //
  // Both lists are derived from variants[0] ONLY — mixing components from
  // every variant into the handle list while quantities came from variants[0]
  // used to yield zero-quantity entries (e.g. hand-soap-set's product-level
  // card would read "0 × Coconut Lotion") whenever a later variant introduced
  // a component the first variant didn't have.
  const componentHandles = [...new Set(bundle.variants[0].components.map(c => c.product))];
  const qtyByHandle = componentHandles.map(h =>
    bundle.variants[0].components.filter(c => c.product === h).reduce((s, c) => s + c.qty, 0));

  const metafields = [
    { ownerId: product.id, namespace: 'bundle', key: 'components', type: 'list.product_reference',
      value: JSON.stringify(componentHandles.map(h => catalogue[h].id)) },
    { ownerId: product.id, namespace: 'bundle', key: 'component_qty', type: 'list.number_integer',
      value: JSON.stringify(qtyByHandle) },
    ...resolved
      .filter(({ v }) => v.contents)
      .map(({ v, target }) => ({ ownerId: target.id, namespace: 'bundle', key: 'contents',
        type: 'multi_line_text_field', value: v.contents })),
  ];

  await gql(
    `mutation ($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) { metafields { id } userErrors { field message } } }`,
    { metafields }
  );
  log(`  wrote ${metafields.length} metafields`);

  // 6 — collections
  for (const gid of bundle.collections ?? []) {
    await gql(
      `mutation ($id: ID!, $productIds: [ID!]!) {
        collectionAddProducts(id: $id, productIds: $productIds) { collection { handle } userErrors { field message } } }`,
      { id: gid, productIds: [product.id] }
    );
  }

  // 7 — publish, channel by channel. Only "live" roster bundles publish; a
  // draft/proposed bundle stays DRAFT (set in step 1) and unpublished.
  if (!isLive) {
    log(`  status "${bundle.status}" is not live — skipping publish`);
  } else {
    for (const [publicationId, name] of PUBLICATIONS) {
      try {
        await gql(
          `mutation ($id: ID!, $input: [PublicationInput!]!) {
            publishablePublish(id: $id, input: $input) { publishable { availablePublicationsCount { count } } userErrors { field message } } }`,
          { id: product.id, input: [{ publicationId }] }
        );
        log(`  ✓ ${name}`);
      } catch (err) {
        log(`  ✗ ${name} — ${err.message}`);
      }
    }
  }

  log(`  done — https://www.realskincare.com/products/${bundle.handle}`);
}

// ── main ───────────────────────────────────────────────────────────────────

const roster = loadRoster();
const catalogue = await loadCatalogue();

const errors = validateRoster(roster,
  Object.fromEntries(Object.entries(catalogue).map(([h, p]) => [h, Object.keys(p.variants)])));
if (errors.length) {
  console.error('Roster is invalid — refusing to build:\n  ' + errors.join('\n  '));
  process.exit(1);
}

const targets = ALL ? roster.bundles : roster.bundles.filter(b => handles.includes(b.handle));
if (!targets.length) {
  console.error(`No bundle matched. Available: ${roster.bundles.map(b => b.handle).join(', ')}`);
  process.exit(1);
}

if (!APPLY) log('DRY RUN — re-run with --apply to write.\n');

// One bad bundle must not silently abort the rest of the run — report the
// failing handle, keep going, and only exit non-zero (after every target has
// been attempted) if anything failed.
let anyFailed = false;
for (const b of targets) {
  try {
    await buildBundle(b, catalogue);
  } catch (err) {
    anyFailed = true;
    console.error(`\n✗ ${b.handle} failed: ${err.message}`);
  }
}
if (anyFailed) process.exit(1);
