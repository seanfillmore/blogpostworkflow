#!/usr/bin/env node
/**
 * Render the quantity-ladder custom_liquid block and write it into a base
 * product's template.
 *
 *   node scripts/build-quantity-ladder.mjs <base-handle>
 *
 * Structure (which handles, how many units) is baked from config/bundles.json.
 * PRICES ARE NEVER BAKED — the block reads all_products at render time, so a
 * reprice cannot leave a stale number on the page.
 *
 * Refuses to write when validateLadder reports anything, which includes a tier
 * that is not ACTIVE on Shopify. That is the 2026-08-25 failure: a roster-live
 * tier serving a 404 would put an unbuyable variant behind a tier card.
 *
 * No --apply flag: this script only ever writes a local build artifact
 * (data/ladder-<base>.liquid), never a Shopify mutation, so a dry-run/apply
 * distinction would be noise. Installing the generated block onto a template
 * is a separate step (update-theme-asset.mjs).
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRoster } from '../lib/bundle-roster.js';
import { resolveTiers, validateLadder, freeUnitFraming } from '../lib/quantity-ladder.js';
import { isDirectRun } from '../lib/is-direct-run.js';
import { supplyLabel } from '../lib/supply-duration.js';
import { hasHealthClaim } from '../agents/ad-studio/health-claims.js';
import { checkSeoCopyFields } from '../lib/seo-copy-health-gate.js';

/**
 * The buy-box review must be a real customer's words: an exact excerpt of the
 * Judge.me review it cites (source_body, whitespace-normalised), passing both
 * claim gates, with no em dash and a display name. Throws otherwise; a ladder
 * with no review is fine and renders none.
 */
export function assertReview(review, label = 'ladder') {
  if (!review) return null;
  const { judgeme_id: id, name, text, source_body: source } = review;
  if (!Number.isInteger(id)) throw new Error(`${label}: review has no judgeme_id`);
  if (!name || !text || !source) throw new Error(`${label}: review needs name, text and source_body`);
  if (!source.includes(text)) throw new Error(`${label}: review text is not an exact excerpt of Judge.me review ${id}`);
  if (/—/.test(text)) throw new Error(`${label}: review text carries an em dash`);
  if (hasHealthClaim(text)) throw new Error(`${label}: review text trips the ad health-claim gate`);
  const gate = checkSeoCopyFields({ 'buy-box review': text });
  if (!gate.ok) throw new Error(`${label}: review trips the commercial claim gate: ${gate.blocking.map((b) => b.match).join(', ')}`);
  return review;
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The Liquid assigns the block body reads. Structure only, never prices. */
export function renderLadderPreamble(tiers, ladder) {
  return [
    `{%- assign ladder_base = "${ladder.base}" -%}`,
    `{%- assign ladder_default = "${ladder.default}" -%}`,
    `{%- assign ladder_unit_noun = "${ladder.unit_noun ?? 'unit'}" -%}`,
    `{%- assign ladder_handles = "${tiers.map((t) => t.handle).join(',')}" | split: "," -%}`,
    `{%- assign ladder_units = "${tiers.map((t) => t.units).join(',')}" | split: "," -%}`,
    // One supply line per tier, '' where no measured rate backs one. Every
    // tier of a ladder is the base product in a bigger box, so the rate is the
    // base's. supplyLabel throws rather than print a claim the box can't meet.
    `{%- assign ladder_supply = "${tiers.map((t) => supplyLabel(ladder.base, t.units) ?? '').join('|')}" | split: "|" -%}`,
  ].join('\n');
}

const escapeHtml = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * The approved review, as its OWN block placed after `trust-line`, so the
 * guarantee stays directly under the CTA and the review sits below it (the
 * reference buy box's order). Pure HTML: the customer's words are escaped
 * here, so no Liquid string can be broken by an apostrophe. '' when the
 * ladder has no review.
 */
export function renderReviewBlock(ladder) {
  const r = assertReview(ladder.review, ladder.base);
  if (!r) return '';
  return `<figure class="ladder-review">
  <div class="ladder-review__head">
    <span class="ladder-review__stars" role="img" aria-label="5 out of 5 stars">★★★★★</span>
    <span>Verified buyer</span>
  </div>
  <blockquote class="ladder-review__text">“${escapeHtml(r.text)}”</blockquote>
  <figcaption class="ladder-review__name">${escapeHtml(r.name)}</figcaption>
</figure>
<style>
  .ladder-review{margin:4px 0 16px;padding:16px 0 0;border-top:1px dashed #d4d2cc}
  .ladder-review__head{display:flex;align-items:center;gap:10px;font-size:.85em;color:#6d7175}
  .ladder-review__stars{color:#111;letter-spacing:2px;font-size:1.05em}
  .ladder-review__text{margin:8px 0 6px;padding:0;border:0;font-size:1em;line-height:1.5;color:#111;font-style:normal}
  .ladder-review__name{font-size:.85em;color:#6d7175}
</style>
`;
}

export function renderBlock(tiers, ladder) {
  const body = readFileSync(join(ROOT, 'theme', 'blocks', 'quantity-ladder.liquid'), 'utf8');
  return `${renderLadderPreamble(tiers, ladder)}\n${body}`;
}

/**
 * The divergence check the spec ("Data model") describes and that had never
 * been built: recompute freeUnitFraming from LIVE prices for every non-base
 * tier and refuse to build when a tier's framing would be incoherent.
 *
 * `prices` maps handle -> integer cents (same units freeUnitFraming and the
 * Liquid's modulo arithmetic both use). `tiers` is resolveTiers()'s output.
 *
 * Two conservative checks, applied per non-base tier:
 *   1. tierPrice >= baseUnitPrice * units — a "multipack" priced at or above
 *      buying the units singly. Never a legitimate ladder entry: it is either
 *      a repricing accident or a tier that should not exist. freeUnitFraming
 *      alone would not catch this — at exact equality it correctly returns
 *      `savings` (paid === units), which reads as "no bug" even though a
 *      multipack with zero savings over buying singly is exactly the
 *      nonsense-saving case this validator exists to catch.
 *   2. A free-units result whose `paid` does not satisfy 0 < paid < units.
 *      freeUnitFraming as written can never actually return that shape (it
 *      falls back to `savings` itself whenever paid is out of range) — this
 *      re-checks the invariant defensively rather than trusting the import
 *      never regresses, per the brief's "at minimum" list.
 */
export function checkPricingCoherence(tiers, prices, ladder) {
  const errors = [];
  const base = tiers.find((t) => t.isBase);
  const baseUnitPrice = base ? prices[base.handle] : undefined;

  if (!Number.isInteger(baseUnitPrice) || baseUnitPrice <= 0) {
    errors.push(`${ladder.base}: no usable live price for base tier "${base?.handle ?? ladder.base}"`);
    return errors;
  }

  for (const t of tiers) {
    if (t.isBase) continue;
    const tierPrice = prices[t.handle];
    if (!Number.isInteger(tierPrice) || tierPrice <= 0) {
      errors.push(`${ladder.base}: no usable live price for tier "${t.handle}"`);
      continue;
    }

    const singlyPrice = baseUnitPrice * t.units;
    if (tierPrice >= singlyPrice) {
      errors.push(
        `${ladder.base}: tier "${t.handle}" is priced ${tierPrice}c for ${t.units} units, ` +
        `at or above buying singly (${singlyPrice}c) — refusing to build`
      );
      continue;
    }

    const framing = freeUnitFraming({ tierPrice, baseUnitPrice, units: t.units });
    if (framing.kind === 'free-units' && !(framing.paid > 0 && framing.paid < t.units)) {
      errors.push(
        `${ladder.base}: tier "${t.handle}" computed an incoherent free-unit framing ` +
        `(paid=${framing.paid}, units=${t.units}) — refusing to build`
      );
    }
  }

  return errors;
}

// Direct-run guard: this module is imported by its test, and an agent that runs
// on import is the failure mode reference_agents_run_on_import documents.
// isDirectRun() is the one tested predicate for this (lib/is-direct-run.js) —
// hand-rolled spellings of this check accumulated to five in this fleet before
// being consolidated, and two audits miscounted guarded agents as a result.
if (isDirectRun(import.meta.url)) {
  const { shopifyGraphQL } = await import('../lib/shopify.js');
  const base = process.argv.slice(2).find((a) => !a.startsWith('--'));
  if (!base) { console.error('usage: build-quantity-ladder.mjs <base-handle>'); process.exit(2); }

  const roster = loadRoster();
  const ladder = (roster.ladders ?? []).find((l) => l.base === base);
  if (!ladder) { console.error(`no ladder configured for base "${base}"`); process.exit(2); }

  const d = await shopifyGraphQL(`{
    products(first: 250) {
      nodes { handle status priceRangeV2 { minVariantPrice { amount } } }
    }
  }`);
  const statuses = Object.fromEntries(d.products.nodes.map((p) => [p.handle, { status: p.status }]));
  // Integer cents, matching the units freeUnitFraming (lib/quantity-ladder.js)
  // and the Liquid's `modulo`/`divided_by` arithmetic both assume.
  const prices = Object.fromEntries(
    d.products.nodes.map((p) => [p.handle, Math.round(Number(p.priceRangeV2.minVariantPrice.amount) * 100)])
  );

  const errors = validateLadder(ladder, roster, statuses);
  if (errors.length) {
    console.error('Ladder is invalid — refusing to build:\n  ' + errors.join('\n  '));
    process.exit(1);
  }

  const tiers = resolveTiers(roster, ladder);

  // The divergence check: recompute freeUnitFraming from live prices and
  // refuse to build if any tier's framing would be incoherent. See
  // checkPricingCoherence's docstring for what "incoherent" means here.
  const pricingErrors = checkPricingCoherence(tiers, prices, ladder);
  if (pricingErrors.length) {
    console.error('Ladder pricing is incoherent — refusing to build:\n  ' + pricingErrors.join('\n  '));
    process.exit(1);
  }

  const block = renderBlock(tiers, ladder);
  console.log(`${base}: ${tiers.length} tiers (${tiers.map((t) => t.units).join('/')} units), ${block.length} bytes`);
  writeFileSync(join(ROOT, 'data', `ladder-${base}.liquid`), block);
  console.log(`wrote data/ladder-${base}.liquid`);

  // --install writes the block into the ladder's live template; --preview
  // writes a COPY of that template as product.ladder-preview.json, an
  // alternate template no product is assigned to, viewable only with
  // ?view=ladder-preview. Both are dry without --apply.
  const INSTALL = process.argv.includes('--install');
  const PREVIEW = process.argv.includes('--preview');
  if (INSTALL || PREVIEW) {
    const APPLY = process.argv.includes('--apply');
    const { getAccessToken } = await import('../lib/shopify.js');
    const { API_VERSION } = await import('../lib/shopify-api-version.js');
    const { serialize } = await import('./build-product-templates.mjs');
    const env = Object.fromEntries(readFileSync(join(ROOT, '.env'), 'utf8').split('\n')
      .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
      .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')]; }));
    const token = await getAccessToken();
    const H = (path, init = {}) => fetch(`https://${env.SHOPIFY_STORE}/admin/api/${API_VERSION}/${path}`,
      { ...init, headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' } });
    const { themes } = await (await H('themes.json')).json();
    const theme = themes.find((t) => t.role === 'main');
    const srcKey = `templates/${ladder.template}`;
    const live = (await (await H(`themes/${theme.id}/assets.json?asset[key]=${encodeURIComponent(srcKey)}`)).json()).asset.value;
    if (serialize(JSON.parse(live)) !== live) { console.error(`${srcKey}: round-trip mismatch — refusing`); process.exit(1); }
    const parsed = JSON.parse(live);
    const blk = parsed.sections?.main?.blocks?.[ladder.block_id];
    if (!blk) { console.error(`${srcKey}: no "${ladder.block_id}" block — refusing`); process.exit(1); }
    blk.settings.custom_liquid = block;
    const main = parsed.sections.main;
    const review = renderReviewBlock(ladder);
    if (review) {
      if (!main.blocks['ladder-review']) {
        const after = main.block_order.includes('trust-line') ? 'trust-line' : ladder.block_id;
        main.blocks['ladder-review'] = { type: 'custom_liquid', settings: { custom_liquid: review } };
        main.block_order.splice(main.block_order.indexOf(after) + 1, 0, 'ladder-review');
      } else {
        main.blocks['ladder-review'].settings.custom_liquid = review;
      }
    }
    const out = serialize(parsed);
    const key = PREVIEW ? 'templates/product.ladder-preview.json' : srcKey;
    if (!PREVIEW && out === live) { console.log(`${key}: already current`); process.exit(0); }
    console.log(`${APPLY ? 'WRITE' : 'DRY  '} ${key} on ${theme.name} (${theme.id})`);
    if (!APPLY) process.exit(0);
    if (!PREVIEW) {
      mkdirSync(join(ROOT, 'data', 'template-backup'), { recursive: true });
      writeFileSync(join(ROOT, 'data', 'template-backup', ladder.template), live);
    }
    const put = await H(`themes/${theme.id}/assets.json`, { method: 'PUT', body: JSON.stringify({ asset: { key, value: out } }) });
    if (!put.ok) { console.error(`PUT ${key} failed ${put.status}: ${(await put.text()).slice(0, 300)}`); process.exit(1); }
    const back = (await (await H(`themes/${theme.id}/assets.json?asset[key]=${encodeURIComponent(key)}`)).json()).asset.value;
    console.log(`  readback identical: ${back === out}`);
    if (!PREVIEW) writeFileSync(join(ROOT, 'theme', key), out);
  }
}
