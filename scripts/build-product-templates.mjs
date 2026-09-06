#!/usr/bin/env node
/**
 * Assemble the product templates from SHARED block sources.
 *
 *   node scripts/build-product-templates.mjs            # dry run + diff
 *   node scripts/build-product-templates.mjs --apply    # write live theme + repo mirror
 *   node scripts/build-product-templates.mjs --only=lotion [--apply]
 *
 * WHY THIS EXISTS. A Shopify JSON template has no include mechanism: a block's
 * `custom_liquid` is inline text in that one file. So nine product templates
 * each carried their own copy of blocks meant to be identical, and the copies
 * drifted — `ymal-recommendations` (10 KB) had two versions differing by a
 * blank line, and 12 blocks sat DEFINED BUT NEVER RENDERED on the ladder
 * pages. This is the same source-of-truth pattern build-quantity-ladder.mjs
 * already applies to the ladder: edit one file, regenerate every template.
 *
 * WHAT IT DELIBERATELY DOES NOT UNIFY, because it is not drift:
 *
 *   - The Recurpay widget. `recurpay-widget` (7 pages) and
 *     `recurpay-app-block-widget` (cream, lotion) are DIFFERENT app blocks
 *     from the same app, not one block under two ids. Collapsing them would
 *     change which subscription widget renders on lotion — 72% of revenue.
 *
 * `tab-shipping` IS unified, but by a FLAG rather than a majority vote. The
 * clause "and on every subscription order" is a CLAIM, and it is true on a
 * page exactly when something that page sells can be subscribed to. Verified
 * live 2026-09-05: the "Subscription Free Shipping" automatic discount is
 * ACTIVE, appliesOnSubscription, no minimum, recurringCycleLimit 0 (Shopify:
 * "applies indefinitely"), US-only, maximumShippingPrice $7.00 — which the
 * $5.99 Standard rate clears and every subscribable SKU is far under 5 lb.
 * `subscribable` per template is measured, not assumed: it is true on the
 * three LADDER pages because a multipack TIER carries the selling plan even
 * though the single unit does not, and false on lip-balm and liquid-soap,
 * where no tier has a plan at all.
 *
 * PER-TEMPLATE EXTRAS. A block may be core + page-specific additions, e.g.
 * lotion's `discount-callout` carries extra CSS for a testimonial section
 * only that page has. `<name>.<template>.liquid` is appended to
 * `<name>.liquid`. The core is never edited per page.
 *
 * SAFETY. Serialization escapes forward slashes because Shopify's editor
 * writes templates that way, and the round-trip is PROVEN against the
 * unchanged live file before any edit — otherwise a two-line change produces
 * a whole-file diff and the pre-apply review becomes useless
 * (reference_theme_json_template_escaping).
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDirectRun } from '../lib/is-direct-run.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Shopify's theme editor escapes `/` inside strings; structural JSON has none. */
export const serialize = (t) => `${JSON.stringify(t, null, 2).replace(/\//g, '\\/')}\n`;

/**
 * Which template gets which shared block, and which blocks are DEAD.
 *
 * `drop` names blocks that are defined but absent from block_order — the
 * theme never renders them (Liquid's `section.blocks` follows block_order),
 * so removing them cannot change a page. On the three ladder templates these
 * are the buy-box blocks the ladder replaced.
 *
 * `insertAfter` places a block that the template does not have yet, and
 * `dropSections` removes a whole top-level section. Those two are the fields
 * that change what a shopper sees; `dropSections` refuses anything the page's
 * own ladder does not already make redundant (see isRedundantCrossSell).
 */
export const MANIFEST = {
  'product.landing-page-toothpaste.json': {
    shared: ['ymal-recommendations', 'discount-callout', 'tab-shipping'],
    drop: ['variant_picker', 'buy_buttons', 'sticky_cart', 'vqr-combo'],
        // subscribable via the 3-pack TIER; the single tube has no plan.
    subscribable: true,
    dropSections: ['complete-the-routine'],
    insertAfter: { 'trust-line': 'quantity-ladder' },
  },
  'product.landing-page-deodorant.json': {
    shared: ['ymal-recommendations', 'discount-callout', 'tab-shipping'],
    drop: ['variant_picker', 'buy_buttons', 'sticky_cart', 'vqr-combo'],
        // subscribable via the 4-pack TIER; the single bottle has no plan.
    subscribable: true,
    dropSections: ['complete-the-routine'],
    insertAfter: { 'trust-line': 'quantity-ladder' },
  },
  'product.landing-page-bar-soap.json': {
    shared: ['ymal-recommendations', 'discount-callout', 'tab-shipping'],
    drop: ['variant_picker', 'buy_buttons', 'sticky_cart', 'vqr-combo'],
        // subscribable via the 4-pack TIER (the 12-pack has no plan).
    subscribable: true,
    dropSections: ['complete-the-routine'],
    insertAfter: { 'trust-line': 'quantity-ladder' },
  },
  'product.landing-page-lotion.json': {
    shared: ['ymal-recommendations', 'discount-callout', 'vqr-combo', 'trust-line', 'tab-shipping'],
    drop: [],
        subscribable: true,
    insertAfter: {},
  },
  'product.landing-page-cream.json': {
    shared: ['ymal-recommendations', 'discount-callout', 'vqr-combo', 'tab-shipping'],
    drop: [],
        subscribable: true,
    insertAfter: { 'trust-line': 'buy_buttons' },
  },
  'product.landing-page-lip-balm.json': {
    shared: ['ymal-recommendations', 'discount-callout', 'vqr-combo', 'tab-shipping'],
    drop: [],
        // NO tier on this page carries a selling plan.
    subscribable: false,
    insertAfter: { 'trust-line': 'buy_buttons' },
  },
  'product.landing-page-liquid-soap.json': {
    shared: ['ymal-recommendations', 'discount-callout', 'tab-shipping'],
    drop: ['variant_picker', 'buy_buttons', 'sticky_cart', 'vqr-combo'],
    // PER-PRODUCT, not per-page — the only template that needs it. It serves
    // the foaming pump and its ladder tiers (pump, 2-pack, 4-pack), none of
    // which has a selling plan, AND the 32oz refill, which gained Recurpay
    // plan 11152263 (1/2/3/4-month) on 2026-09-05. A page-level flag would
    // either advertise subscription shipping on three products that cannot be
    // subscribed to, or withhold it from the one that can.
    subscribable: ['foam-soap-refill-32oz'],
    dropSections: ['complete-the-routine'],
    insertAfter: { 'trust-line': 'quantity-ladder' },
  },
  // The two landers already state the 30-day guarantee in their trust-row, so
  // they get no trust-line: a second copy under the button would be a
  // duplicate promise, not reinforcement.
  'product.landing-page-sensitive-skin-set-lander.json': {
    shared: ['discount-callout', 'vqr-combo', 'tab-shipping'],
    drop: [],
        subscribable: true,
    insertAfter: {},
  },
  'product.bundle-landing.json': {
    shared: ['discount-callout', 'vqr-combo'],
    drop: [],
        // no tab-shipping block, and none of its six bundles is subscribable.
    subscribable: false,
    insertAfter: {},
  },
};

/** Template key -> the short name used for a `<block>.<template>.liquid` extra. */
export function templateNick(file) {
  return file.replace(/^product\.(landing-page-)?/, '').replace(/\.json$/, '');
}

/**
 * The one claim token in a shared source. `%%SUBSCRIPTION%%` expands to the
 * free-subscription-shipping clause on a page where something IS subscribable
 * and to nothing where it is not — so both variants come from ONE paragraph
 * and cannot drift apart in wording while differing in claim.
 */
export const SUBSCRIPTION_CLAUSE = ' and on every subscription order';

/** True when a template's `subscribable` names specific handles rather than the whole page. */
export const isPerProduct = (v) => Array.isArray(v);

/**
 * Expand `%%SUBSCRIPTION%%` for a template.
 *
 * `subscribable: true|false` covers a template that serves ONE product. The
 * liquid-soap template serves two with different answers — the foaming pump
 * (and its ladder tiers) cannot be subscribed to, while the 32oz refill can —
 * so `subscribable` may instead be a LIST of handles, which emits a
 * `product.handle` conditional. That is the same shape the per-day anchor on
 * that very template already uses.
 */
export function expandSubscription(core, subscribable) {
  if (!core.includes('%%SUBSCRIPTION%%')) return core;
  if (!isPerProduct(subscribable)) {
    return core.split('%%SUBSCRIPTION%%').join(subscribable ? SUBSCRIPTION_CLAUSE : '');
  }
  const test = subscribable.map((h) => `product.handle == '${h}'`).join(' or ');
  const on = core.split('%%SUBSCRIPTION%%').join(SUBSCRIPTION_CLAUSE);
  const off = core.split('%%SUBSCRIPTION%%').join('');
  return `{%- if ${test} -%}${on}{%- else -%}${off}{%- endif -%}`;
}

/** Core source plus this template's extras, if any. */
export function blockSource(name, file, read) {
  const core = read(`theme/blocks/${name}.liquid`);
  const extraPath = `theme/blocks/${name}.${templateNick(file)}.liquid`;
  const withClaim = (t) => expandSubscription(t, MANIFEST[file]?.subscribable);
  const extra = read(extraPath);
  if (extra == null) return withClaim(core);
  // CSS extras append INSIDE the wrapper; markup extras simply follow.
  return withClaim(core.trimEnd().endsWith('</style>')
    ? `${core.trimEnd().slice(0, -'</style>'.length)}${extra}</style>`
    : `${core}${extra}`);
}

/**
 * Apply the manifest to one parsed template. Pure: no I/O, so the decisions
 * are testable without a theme.
 */
/**
 * Which settings key holds a block's text. A `collapsible_tab` keeps it in
 * `content`; writing `custom_liquid` there would leave the tab unchanged AND
 * silently add a second, unrendered copy of the paragraph.
 */
/**
 * The tier handles a page's quantity ladder already sells, read off the baked
 * `ladder_handles` assign. Empty when the page has no ladder.
 */
export function ladderTiers(parsed) {
  const liquid = parsed.sections?.main?.blocks?.['quantity-ladder']?.settings?.custom_liquid;
  const m = typeof liquid === 'string' && liquid.match(/ladder_handles = "([^"]+)"/);
  return m ? m[1].split(',').map((h) => h.trim()).filter(Boolean) : [];
}

/**
 * A `complete-the-routine` card is REDUNDANT when it points at a product the
 * page's own ladder already sells as a tier — the shopper is being cross-sold
 * something already in the buy box a few hundred pixels above. It is a genuine
 * cross-sell when it points anywhere else (cream and lotion both point at the
 * Sensitive Skin Set, which neither page sells).
 *
 * Derived from the template rather than listed, so the manifest cannot drift
 * from the rule and a future ladder change re-decides it automatically.
 */
export function isRedundantCrossSell(parsed, sectionKey) {
  const sec = parsed.sections?.[sectionKey];
  if (!sec) return false;
  const target = sec.settings?.product;
  return Boolean(target) && ladderTiers(parsed).includes(target);
}

/**
 * Which settings key holds a block's text.
 *
 * A `collapsible_tab` has BOTH, and they are not interchangeable: `content` is
 * type `richtext`, so Liquid inside it is printed to the page literally, while
 * `custom_liquid` is type `liquid` and IS evaluated. The theme outputs them in
 * sequence — `{{ content }}{{ page.content }}{{ custom_liquid }}` — so filling
 * both renders the paragraph TWICE, which is why the writer blanks the other.
 *
 * The key therefore follows the SOURCE, not just the block type: copy carrying
 * a Liquid tag has to land in `custom_liquid` or it ships as visible
 * `{%- if ... -%}` text on a live page.
 */
export function settingsKey(block, source = '') {
  if (block.type !== 'collapsible_tab') return 'custom_liquid';
  return /\{%|\{\{/.test(source) ? 'custom_liquid' : 'content';
}

export function applyManifest(parsed, file, read) {
  const spec = MANIFEST[file];
  if (!spec) throw new Error(`no manifest entry for ${file}`);
  const main = parsed.sections?.main;
  if (!main) throw new Error(`${file}: no main section`);
  const notes = [];

  for (const name of spec.shared) {
    const blk = main.blocks[name];
    if (!blk) throw new Error(`${file}: shared block "${name}" is not in the template`);
    const next = blockSource(name, file, read);
    const key = settingsKey(blk, next);
    const other = key === 'content' ? 'custom_liquid' : 'content';
    const needsBlank = blk.type === 'collapsible_tab' && (blk.settings[other] ?? '') !== '';
    if (blk.settings[key] !== next || needsBlank) {
      notes.push(`unified ${name}`);
      blk.settings[key] = next;
      // Both fields render, so the one we are not using must be emptied or the
      // tab shows the paragraph twice.
      if (blk.type === 'collapsible_tab') blk.settings[other] = '';
    }
  }

  for (const name of spec.drop) {
    if (!(name in main.blocks)) continue;
    // Refuse to delete anything the page actually renders. A block in
    // block_order is live markup; only an orphan is dead weight.
    if (main.block_order.includes(name)) {
      throw new Error(`${file}: refusing to drop "${name}" — it IS in block_order`);
    }
    delete main.blocks[name];
    notes.push(`dropped orphan ${name}`);
  }

  for (const name of spec.dropSections ?? []) {
    if (!(name in (parsed.sections ?? {}))) continue;
    // Only ever remove a card the page's own ladder makes redundant. A section
    // is whole-page markup; deleting a real cross-sell would silently remove a
    // conversion path, which is the opposite of the Prime Directive.
    if (!isRedundantCrossSell(parsed, name)) {
      throw new Error(`${file}: refusing to drop section "${name}" — it does not point at a ladder tier`);
    }
    delete parsed.sections[name];
    parsed.order = (parsed.order ?? []).filter((k) => k !== name);
    notes.push(`dropped redundant section ${name}`);
  }

  for (const [name, after] of Object.entries(spec.insertAfter)) {
    if (main.block_order.includes(name)) continue;
    const at = main.block_order.indexOf(after);
    if (at < 0) throw new Error(`${file}: cannot insert "${name}" — anchor "${after}" not in block_order`);
    main.blocks[name] = { type: 'custom_liquid', settings: { custom_liquid: blockSource(name, file, read) } };
    main.block_order.splice(at + 1, 0, name);
    notes.push(`inserted ${name} after ${after}`);
  }

  return notes;
}

if (isDirectRun(import.meta.url)) {
  const APPLY = process.argv.includes('--apply');
  const only = (process.argv.find((a) => a.startsWith('--only=')) || '').split('=')[1];
  const { getAccessToken } = await import('../lib/shopify.js');
  const { API_VERSION } = await import('../lib/shopify-api-version.js');
  const token = await getAccessToken();
  const env = Object.fromEntries(
    readFileSync(join(ROOT, '.env'), 'utf8').split('\n')
      .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
      .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }),
  );
  const H = (p, i) => fetch(`https://${env.SHOPIFY_STORE}/admin/api/${API_VERSION}/${p}`, {
    ...i, headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json', ...(i?.headers ?? {}) },
    signal: AbortSignal.timeout(60_000),
  });
  const read = (p) => (existsSync(join(ROOT, p)) ? readFileSync(join(ROOT, p), 'utf8') : null);

  const { themes } = await (await H('themes.json')).json();
  const theme = themes.find((t) => t.role === 'main');
  console.log(`theme: ${theme.name} (${theme.id})\n`);

  let changed = 0;
  for (const file of Object.keys(MANIFEST)) {
    if (only && templateNick(file) !== only) continue;
    const key = `templates/${file}`;
    const live = (await (await H(`themes/${theme.id}/assets.json?asset[key]=${encodeURIComponent(key)}`)).json()).asset.value;
    const parsed = JSON.parse(live);
    // Prove the serializer round-trips THIS file before trusting it on it.
    if (serialize(JSON.parse(live)) !== live) {
      console.log(`${file}: ROUND-TRIP MISMATCH — refusing`);
      continue;
    }
    const notes = applyManifest(parsed, file, read);
    const out = serialize(parsed);
    if (out === live) { console.log(`${file}: already current`); continue; }
    const before = live.split('\n');
    const diff = out.split('\n').filter((l, i) => l !== before[i]).length;
    console.log(`${file}\n    ${notes.join(', ') || '(no notes)'}\n    ${before.length} -> ${out.split('\n').length} lines, ${diff} line(s) differ`);
    changed += 1;
    if (!APPLY) continue;
    mkdirSync(join(ROOT, 'data', 'template-backup'), { recursive: true });
    writeFileSync(join(ROOT, 'data', 'template-backup', file), live);
    await (await H(`themes/${theme.id}/assets.json`, { method: 'PUT', body: JSON.stringify({ asset: { key, value: out } }) })).json();
    const back = (await (await H(`themes/${theme.id}/assets.json?asset[key]=${encodeURIComponent(key)}`)).json()).asset.value;
    console.log(`    written, readback identical: ${back === out}`);
    writeFileSync(join(ROOT, 'theme', key), out);
  }
  console.log(`\n${APPLY ? 'APPLIED' : 'DRY RUN'} — ${changed} template(s)${APPLY ? '' : '; pass --apply to write'}`);
}
