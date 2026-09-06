/**
 * Has a product template drifted away from what the manifest says it should be?
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * `scripts/build-product-templates.mjs` is only ever run by whoever happens to
 * be changing a template. Between those runs the STORE moves underneath it, and
 * twice in one week that silently invalidated a decision the manifest had
 * already recorded:
 *
 *   · PR #805 added a quantity ladder to the hand soap. That instantly made its
 *     `complete-the-routine` card redundant — it cross-sells the 4-pack, which
 *     the new ladder now sells as a tier — and nothing said so. The card shipped
 *     redundant and stayed that way until an operator noticed it on the bar soap.
 *   · Recurpay plan 11152263 attached a selling plan to `foam-soap-refill-32oz`
 *     on 2026-09-05, which made `subscribable: false` on that template a
 *     WITHHELD TRUE CLAIM. The page could take a subscription and the shipping
 *     tab did not say free subscription shipping applied.
 *
 * Both are the same shape: the manifest was right when written and the catalogue
 * changed. Neither is visible in a diff, because neither repo file changed.
 *
 * ── Pure, so every branch is a case a test constructs ────────────────────────
 * No I/O and no network. The caller supplies the templates it read and the
 * catalogue facts it fetched; this decides.
 */

import { MANIFEST, ladderTiers, isRedundantCrossSell, isPerProduct, templateNick } from '../scripts/build-product-templates.mjs';

/**
 * Shopify's `templateSuffix` is the FILE's middle name (`landing-page-toothpaste`),
 * NOT the manifest nickname (`toothpaste`). Keying the catalogue map by file
 * removes the mismatch rather than translating it at each use — the first
 * version of this gate keyed on the nickname and reported all eight templates
 * as orphans on a store where every one of them is in use.
 */
export const fileForSuffix = (suffix) => `product.${suffix}.json`;

/**
 * A card the page's own ladder has made redundant that the manifest is NOT
 * dropping. This is the PR #805 shape, and it is the one finding the builder's
 * own dry run structurally cannot report: `applyManifest` only drops what
 * `dropSections` names, so a card nobody has classified reads as "already
 * current" and the run looks clean.
 */
export function staleRedundantCards(templates) {
  const out = [];
  for (const [file, parsed] of Object.entries(templates)) {
    const spec = MANIFEST[file];
    if (!spec) continue;
    if ((spec.dropSections ?? []).includes('complete-the-routine')) continue;
    if (!isRedundantCrossSell(parsed, 'complete-the-routine')) continue;
    out.push({
      template: templateNick(file),
      file,
      product: parsed.sections['complete-the-routine'].settings.product,
      tiers: ladderTiers(parsed),
    });
  }
  return out;
}

/**
 * Does each template's `subscribable` still match what the catalogue sells on
 * a subscription?
 *
 * `plansByHandle` maps a product handle to whether it carries a selling plan.
 * `productsByFile` maps a template FILE to the products whose `templateSuffix`
 * names it.
 *
 * THAT MAP ALONE IS NOT THE ANSWER, and getting this wrong made the gate report
 * three false alarms on its first live run. A quantity ladder sells OTHER
 * PRODUCTS as tiers — the toothpaste page sells `coconut-toothpaste-3-pack`,
 * which is a separate product on the DEFAULT template — so `templateSuffix`
 * cannot see them. Subscribability is a property of everything a page can put
 * in a cart, which is why the three ladder pages qualify on a multipack tier
 * while their single unit carries no plan at all. `pageHandles` unions the two.
 *
 * BOTH DIRECTIONS ARE REPORTED, and they are different problems:
 *   claimed but not sellable → a FALSE claim on a live page.
 *   sellable but not claimed → a WITHHELD true claim; the refill's shape.
 */
export function pageHandles(file, productsByFile, templates) {
  const direct = productsByFile[file] ?? [];
  // FAIL OPEN on a catalogue that does not mention this template at all. The
  // ladder handles are BAKED INTO THE TEMPLATE, so they are available even
  // when the Shopify query returned nothing — and judging on them alone would
  // condemn all three ladder pages as false claims during an outage, from an
  // empty `plansByHandle` that knows nothing rather than says no. Same rule as
  // lib/cluster-hold.js: an absent measurement is not a verdict.
  if (direct.length === 0) return [];
  const tiers = templates?.[file] ? ladderTiers(templates[file]) : [];
  return [...new Set([...direct, ...tiers])];
}

export function subscribableDrift(productsByFile, plansByHandle, templates = {}) {
  const out = [];
  for (const [file, spec] of Object.entries(MANIFEST)) {
    const nick = templateNick(file);
    const handles = pageHandles(file, productsByFile, templates);
    // A template serving nothing is a different finding (see orphanTemplates)
    // and must not be read as "nothing is subscribable".
    if (!handles || handles.length === 0) continue;

    const subscribable = handles.filter((h) => plansByHandle[h]);
    const actual = subscribable.length > 0;

    if (isPerProduct(spec.subscribable)) {
      // The listed handles must be exactly the ones that really carry a plan;
      // anything else means the conditional gates the wrong products.
      const listed = [...spec.subscribable].sort();
      const real = [...subscribable].sort();
      if (listed.join('|') !== real.join('|')) {
        out.push({ template: nick, file, kind: 'per-product-mismatch', listed, real });
      }
      continue;
    }

    if (Boolean(spec.subscribable) !== actual) {
      out.push({
        template: nick,
        file,
        kind: actual ? 'withheld' : 'false-claim',
        flag: Boolean(spec.subscribable),
        subscribable,
        handles,
      });
    }
  }
  return out;
}

/** A manifest entry whose template no active product uses — dead config. */
export function orphanTemplates(productsByFile) {
  return Object.keys(MANIFEST)
    .filter((file) => !(productsByFile[file]?.length))
    .map(templateNick);
}

/**
 * Roll findings into the exit code the cron wrapper reports on.
 *
 * `builderChanges` comes from the builder's own dry run — the templates live
 * on Shopify no longer match what the sources would produce. It is kept
 * SEPARATE from the two staleness findings because it means something
 * different: somebody edited a template outside this repo (the Shopify theme
 * editor is the realistic case), and the next `--apply` will revert it.
 */
export function summarize({ stale = [], drift = [], orphans = [], builderChanges = [] }) {
  if (stale.length || drift.length) return { code: 2, stale, drift, orphans, builderChanges };
  if (builderChanges.length) return { code: 1, stale, drift, orphans, builderChanges };
  if (orphans.length) return { code: 1, stale, drift, orphans, builderChanges };
  return { code: 0, stale, drift, orphans, builderChanges };
}

/** Human-readable body — this IS the digest body, so it names files and fixes. */
export function renderReport(result) {
  const lines = [];
  for (const s of result.stale) {
    lines.push(`· [redundant card] ${s.template}: "complete-the-routine" points at ${s.product}, which its own ladder already sells (${s.tiers.join(', ')})`);
    lines.push(`    fix: add 'complete-the-routine' to dropSections for ${s.file}, then run scripts/build-product-templates.mjs --apply`);
  }
  for (const d of result.drift) {
    if (d.kind === 'withheld') {
      lines.push(`· [withheld claim] ${d.template}: subscribable=false but ${d.subscribable.join(', ')} carries a selling plan — the shipping tab is not saying free subscription shipping applies`);
    } else if (d.kind === 'false-claim') {
      lines.push(`· [FALSE claim] ${d.template}: subscribable=true but nothing it sells (${d.handles.join(', ')}) carries a selling plan`);
    } else {
      lines.push(`· [per-product mismatch] ${d.template}: gated on [${d.listed.join(', ')}] but the plans are on [${d.real.join(', ')}]`);
    }
    lines.push(`    fix: update subscribable for ${d.file}, then run scripts/build-product-templates.mjs --apply`);
  }
  for (const o of result.orphans) {
    lines.push(`· [orphan template] ${o}: in the manifest, but no active product uses it`);
  }
  for (const c of result.builderChanges) {
    lines.push(`· [live drift] ${c.file}: ${c.notes.join(', ')} — live no longer matches the sources; the next --apply will overwrite it`);
  }
  if (!lines.length) lines.push('Every product template matches its manifest, and every subscription claim matches the catalogue.');
  return lines.join('\n');
}
