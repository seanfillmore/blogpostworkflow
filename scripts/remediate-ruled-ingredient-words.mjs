#!/usr/bin/env node
/**
 * Pass two of the ingredient-name ruling: take "mineral oil", "petrolatum" and
 * "dimethicone" out of live product bodies, bundle-lander metaobjects and theme assets.
 *
 * Dry by default. `--apply` writes.
 * Theme entries run ONLY with `--theme-id <id>`, and the value is always built from the
 * LIVE theme's current asset — so pointing it at an unpublished theme gives a preview of
 * exactly what live would become. Targeting the live theme additionally requires
 * `--allow-live-theme`, typed by a human after looking at the preview.
 *
 * RULINGS.
 *   · Sean, 2026-09-09: "I have never heard a human being say petrolatum or dimethicone"
 *     → "Do not use those words." Mineral oil, petrolatum and dimethicone — even negated.
 *     Evidence: 0 of 3,841 real customer search terms use either word; no regulator backs
 *     the implied harm; the claim was sourced only to our own PDP (see PR #865).
 *   · Sean, 2026-09-11: "petroleum jelly" / "petroleum wax" are NOT covered. So where a
 *     sentence genuinely needs the idea (the homepage's "labels lied" paragraph), the
 *     shopper's words replace the technical ones: "petroleum jelly", "silicones".
 *     Verified before using "silicones": no ingredient in config/ingredients.json is a
 *     silicone of any kind.
 *   · Sean, 2026-09-11, approved removing the Replo offer page's "not formulated or
 *     guaranteed to fight against acne, assist psoriasis, or relieve eczema, some of our
 *     members have reported positive results" — a disease claim above a buy button. That
 *     entry was applied to live the same day and is recorded here so a rerun reports it.
 *
 * WHY PRODUCT BODIES MATTER EVEN WHERE THE THEME HIDES THEM. Several landing templates do
 * not render `body_html`, but it is what Shopify syndicates: the lotion's own event log
 * shows the catalogue included on Meta, Google AI Mode / Gemini and X. An AI answer quoting
 * "no petrolatum, no mineral oil" is the same copy on a surface we cannot see.
 *
 * SCOPE, and what is deliberately left alone:
 *   · Rows where "petroleum" is the only word (deodorant body, llms.txt, lip-balm FAQ,
 *     the "no petroleum" bundle bullets) — permitted by the 2026-09-11 ruling.
 *   · Customer reviews naming eczema/psoriasis (Judge.me, jdgm-featured-reviews-3up) —
 *     customer voice, and Judge.me writes are known to false-succeed. Its own decision.
 *   · One row that is not a ruled word rides along because the operator asked for it:
 *     the body cream's "covers more than a pump of lotion". The lotion is a squeeze bottle
 *     (config/ingredients.json); the only RSC product with a pump is the foaming hand soap.
 *     It carries `nonRuledReason`, and a test pins that it is the only such entry.
 *   · hand-soap-set is ARCHIVED. Fixed anyway: harmless now, and it would otherwise bring
 *     the words back the day someone unarchives it.
 *   · PRODUCT METAFIELDS were not in the first cut and should have been. After the first
 *     apply, /products/99-coconut-reset-digital still rendered "Mineral oil" — from a
 *     `bundle.comparison_rows` json metafield, which no body or lander scan can see. A scan
 *     of all 336 metafields on all 23 products then found exactly that one hit outside
 *     Judge.me's review widgets. Scan the metafields, not just the fields you expect copy in.
 *
 * MECHANICS, copied from the reviewed-plan pattern (scripts/remediate-petrolatum-avoidance-
 * claim.mjs, whose `decideEntry` is IMPORTED, never re-declared): literal BEFORE, literal
 * AFTER, asserted occurrence count, skip when live matches neither, backup before write,
 * every AFTER re-gated at run time. Entries are GROUPED BY TARGET so each product,
 * metaobject and theme asset is read once and written once — four homepage swaps written
 * one at a time from the same source would each overwrite the last.
 *
 * Usage:
 *   node scripts/remediate-ruled-ingredient-words.mjs                       # dry run
 *   node scripts/remediate-ruled-ingredient-words.mjs --apply               # products + landers
 *   node scripts/remediate-ruled-ingredient-words.mjs --theme-id <preview> --apply
 *   node scripts/remediate-ruled-ingredient-words.mjs --theme-id <live> --allow-live-theme --apply
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkSeoCopyFields } from '../lib/seo-copy-health-gate.js';
import { isDirectRun } from '../lib/is-direct-run.js';
import { decideEntry } from './remediate-petrolatum-avoidance-claim.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'data', 'reports', 'ruled-ingredient-words');

export const RULED_WORDS = /mineral oil|petrolatum|dimethicone/i;
export const DISEASE_WORDS = /eczema|psoriasis|rosacea|dermatitis/i;

const REPLO_OFFER_CHUNK = 'snippets/reploChunk.00d6760b-fed1-4b86-a9d3-2380b64564e2.2.liquid';

export const PLAN = [
  // ── Product bodies ────────────────────────────────────────────────────────────────
  {
    id: 'cream-beeswax-line', kind: 'product', handle: 'coconut-moisturizer', productId: 7644968911018,
    expectedOccurrences: 1,
    before: '<strong>Beeswax is what makes it a cream.</strong> No petrolatum, no mineral oil, no synthetic fragrance, no parabens.',
    after: '<strong>Beeswax is what makes it a cream.</strong> No synthetic fragrance, no parabens.',
    reason: 'Drops the two ruled words; keeps the two absences shoppers actually search.',
  },
  {
    id: 'cream-pump-comparison', kind: 'product', handle: 'coconut-moisturizer', productId: 7644968911018,
    expectedOccurrences: 1,
    before: 'A tiny bit covers more than a pump of lotion does.',
    after: 'A tiny bit covers more than the same amount of lotion does.',
    reason: 'Product accuracy, not a ruled word.',
    nonRuledReason: 'The RSC lotion is a squeeze bottle with a flip-top cap; the only RSC pump is the '
      + 'foaming hand soap. The same wording was already fixed on the cream how-to frame (PR #859).',
  },
  {
    id: 'lip-balm-unlike-waxes', kind: 'product', handle: 'coconut-oil-lip-balm', productId: 7644975071402,
    expectedOccurrences: 1,
    before: 'Unlike petrolatum, paraffin, or microcrystalline wax, beeswax',
    after: 'Unlike paraffin or microcrystalline wax, beeswax',
    reason: 'Keeps the mechanistic comparison against the petroleum waxes; drops the ruled word.',
  },
  {
    id: 'lip-balm-absence-list', kind: 'product', handle: 'coconut-oil-lip-balm', productId: 7644975071402,
    expectedOccurrences: 1,
    before: 'No lanolin, no petrolatum, no paraffin, no parabens, no menthol, no synthetic flavoring.',
    after: 'No lanolin, no paraffin, no parabens, no menthol, no synthetic flavoring.',
    reason: 'Drops the ruled word from the absence list.',
  },
  {
    id: 'sensitive-set-beeswax-comparison', kind: 'product', handle: 'sensitive-skin-starter-set', productId: 8390839468202,
    expectedOccurrences: 1,
    before: 'locks moisture in without sealing pores closed the way petrolatum does — and organic palm stearic',
    after: 'locks moisture in — and organic palm stearic',
    reason: 'Removes the ruled word and the pore-sealing comparison with it: the evidence in PR #865 is '
      + 'that cosmetic petrolatum is non-comedogenic, so "sealing pores closed" was the implied harm.',
  },
  {
    id: 'sensitive-set-never-list', kind: 'product', handle: 'sensitive-skin-starter-set', productId: 8390839468202,
    expectedOccurrences: 1,
    before: 'propylene glycol, mineral oil, petrolatum, dimethicone or lanolin.',
    after: 'propylene glycol or lanolin.',
    reason: 'Drops all three ruled words from the "Never in the formula" list.',
  },
  {
    id: 'clean-swap-lotion-line', kind: 'product', handle: 'clean-swap', productId: 8563567558826,
    expectedOccurrences: 1,
    before: 'No mineral oil, no dimethicone, no synthetic fragrance.',
    after: 'No synthetic fragrance.',
    reason: 'Drops the two ruled words from the bundle\'s lotion line.',
  },
  {
    id: 'gift-box-lip-balm-line', kind: 'product', handle: 'gift-box', productId: 8563958284458,
    expectedOccurrences: 1,
    before: 'vitamin E. No petrolatum, no lanolin.',
    after: 'vitamin E. No lanolin.',
    reason: 'Drops the ruled word from the bundle\'s lip balm line.',
  },
  {
    id: 'hand-soap-set-lotion-line', kind: 'product', handle: 'hand-soap-set', productId: 8563958513834,
    expectedOccurrences: 1,
    before: 'No mineral oil, no dimethicone, no synthetic fragrance.',
    after: 'No synthetic fragrance.',
    reason: 'ARCHIVED product — fixed so unarchiving it cannot bring the words back.',
  },

  // ── Bundle-lander metaobjects (fields are JSON-encoded lists) ────────────────────────
  {
    id: 'lander-reset-90-day-bullets', kind: 'metaobject', handle: 'reset-90-day',
    metaobjectId: 'gid://shopify/Metaobject/219195703466', key: 'bullets', expectedOccurrences: 1,
    before: 'no fragrance, parabens, or mineral oil',
    after: 'no fragrance or parabens',
    reason: 'Hero bullet.',
  },
  {
    id: 'lander-reset-90-day-buybox', kind: 'metaobject', handle: 'reset-90-day',
    metaobjectId: 'gid://shopify/Metaobject/219195703466', key: 'buybox_bullets', expectedOccurrences: 1,
    before: 'No synthetic fragrance, no petrolatum, no dimethicone, no lanolin',
    after: 'No synthetic fragrance, no lanolin',
    reason: 'Buy-box bullet. No new claim is added in their place.',
  },
  {
    id: 'lander-clean-swap-90-day-buybox', kind: 'metaobject', handle: 'clean-swap-90-day',
    metaobjectId: 'gid://shopify/Metaobject/219195736234', key: 'buybox_bullets', expectedOccurrences: 1,
    before: 'No synthetic fragrance, no petrolatum, no parabens, no SLS',
    after: 'No synthetic fragrance, no parabens, no SLS',
    reason: 'Buy-box bullet — the one hit left on /products/90-day-clean-swap after the template push.',
  },
  {
    id: 'lander-head-to-toe-buybox', kind: 'metaobject', handle: 'head-to-toe',
    metaobjectId: 'gid://shopify/Metaobject/219322482858', key: 'buybox_bullets', expectedOccurrences: 1,
    before: 'No synthetic fragrance, no petrolatum, no parabens, no SLS',
    after: 'No synthetic fragrance, no parabens, no SLS',
    reason: 'Buy-box bullet.',
  },
  {
    id: 'lander-head-to-toe-ingredients-tab', kind: 'metaobject', handle: 'head-to-toe',
    metaobjectId: 'gid://shopify/Metaobject/219322482858', key: 'tabs', expectedOccurrences: 1,
    before: 'No parabens, no petrolatum, no synthetic fragrance, no SLS.',
    after: 'No parabens, no synthetic fragrance, no SLS.',
    reason: 'Ingredients tab.',
  },
  {
    id: 'lander-99-coconut-reset-digital-bullets', kind: 'metaobject', handle: '99-coconut-reset-digital',
    metaobjectId: 'gid://shopify/Metaobject/220166586538', key: 'bullets', expectedOccurrences: 1,
    before: 'no fragrance, parabens, or mineral oil',
    after: 'no fragrance or parabens',
    reason: 'Hero bullet.',
  },

  // ── Product metafields (found by a full scan of every product metafield) ─────────────
  {
    id: 'reset-digital-comparison-mineral-oil-row', kind: 'product-metafield', handle: '99-coconut-reset-digital',
    ownerId: 'gid://shopify/Product/8566372303018', namespace: 'bundle', key: 'comparison_rows', type: 'json',
    expectedOccurrences: 1,
    before: '"Synthetic \\"fragrance\\""},{"attribute":"Mineral oil","us":"None","them":"Common"},{"attribute":"Made in"',
    after: '"Synthetic \\"fragrance\\""},{"attribute":"Made in"',
    reason: 'Removes the "Mineral oil / None / Common" comparison row. REMOVED rather than renamed to '
      + '"Petroleum jelly", so the table makes no comparison claim it did not already make. Anchored on '
      + 'the neighbouring rows so the literal is unique and a rerun reads already-applied.',
  },

  // ── Theme assets (raw JSON text: quotes are \" and closing tags <\/li>) ─────────────
  {
    id: 'homepage-hero-subheading', kind: 'theme-asset', key: 'templates/index.json', expectedOccurrences: 1,
    before: "for people whose skin doesn't tolerate fragrance, parabens, dimethicones, or mineral oil.",
    after: "for people whose skin doesn't tolerate fragrance, parabens, or silicones.",
    reason: '"silicones" is the shopper\'s word for the same idea (6 real search terms vs 0 for dimethicone).',
  },
  {
    id: 'homepage-thesis-labels-lied', kind: 'theme-asset', key: 'templates/index.json', expectedOccurrences: 1,
    before: '\\"Natural\\" lotions still used petrolatum. \\"Gentle\\" creams still relied on dimethicones.',
    after: '\\"Natural\\" lotions still used petroleum jelly. \\"Gentle\\" creams still relied on silicones.',
    reason: 'Keeps the brand story\'s three-beat rhythm in the words a shopper uses (ruling 2026-09-11).',
  },
  {
    id: 'homepage-exclusion-band', kind: 'theme-asset', key: 'templates/index.json', expectedOccurrences: 1,
    before: '<li>Petrolatum<\\/li><li>Mineral oil<\\/li><li>Dimethicone<\\/li>',
    after: '<li>Petroleum jelly<\\/li><li>Silicones<\\/li>',
    reason: 'Same absences, plain words; mineral oil and petrolatum collapse into one household term.',
  },
  {
    id: 'homepage-founder-story', kind: 'theme-asset', key: 'templates/index.json', expectedOccurrences: 1,
    before: 'that still relied on petrolatum, dimethicone, or undisclosed fragrance.',
    after: 'that still relied on petroleum jelly, silicones, or undisclosed fragrance.',
    reason: 'Founder story, plain words.',
  },
  {
    id: 'replo-offer-page-disease-claim', kind: 'theme-asset', key: REPLO_OFFER_CHUNK, expectedOccurrences: 1,
    before: 'when applying to the face. While our bars are not formulated or guaranteed to fight against acne, '
      + 'assist psoriasis, or relieve eczema, some of our members have reported positive results. '
      + 'Check out our favorite bars for daily use here.',
    after: 'when applying to the face. Check out our favorite bars for daily use here.',
    reason: 'Disease-efficacy claim above a buy button, on /pages/offer-page. Applied to live 2026-09-11 '
      + 'on explicit operator approval; recorded so a rerun reports already-applied. Note Replo can '
      + 'republish this chunk from its editor, so re-check after any Replo publish.',
    appliedLive: '2026-09-11',
  },
];

/** Plain text for the gate: unescape theme JSON, then tags → spaces. */
export function gateText(s) {
  return String(s).replace(/\\"/g, '"').replace(/<\\\//g, '</').replace(/<[^>]+>/g, ' ');
}

/** Refuse any AFTER that names a ruled word or a disease, or fails the health gate. */
export function gateAfter(entry) {
  const text = gateText(entry.after);
  if (RULED_WORDS.test(text)) return { ok: false, why: `AFTER still names a ruled word: ${text}` };
  if (DISEASE_WORDS.test(text)) return { ok: false, why: `AFTER names a disease: ${text}` };
  const gate = checkSeoCopyFields({ copy: text });
  if (!gate.ok) return { ok: false, why: `AFTER fails the health gate: ${JSON.stringify(gate.blocking)}` };
  return { ok: true };
}

/** Group entries by the object they write, preserving plan order. */
export function groupByTarget(plan) {
  const groups = new Map();
  for (const e of plan) {
    const t = e.kind === 'product' ? `product:${e.productId}`
      : e.kind === 'metaobject' ? `metaobject:${e.metaobjectId}:${e.key}`
        : e.kind === 'product-metafield' ? `metafield:${e.ownerId}:${e.namespace}.${e.key}`
          : `theme:${e.key}`;
    if (!groups.has(t)) groups.set(t, []);
    groups.get(t).push(e);
  }
  return groups;
}

/** Apply a group's entries in order to one value. Returns the next value and per-entry decisions. */
export function applyGroup(entries, liveValue) {
  let value = liveValue;
  const decisions = [];
  for (const e of entries) {
    const d = decideEntry(e, value);
    decisions.push({ id: e.id, action: d.action, why: d.why });
    if (d.action === 'apply') value = d.next;
  }
  return { next: value, decisions, changed: value !== liveValue };
}

const flag = (argv, name) => argv.includes(name);
function argValue(argv, name) {
  const i = argv.indexOf(name);
  return i === -1 ? null : argv[i + 1] ?? null;
}

async function readBackUntil(read, predicate, { tries = 4, delayMs = 1500, sleep }) {
  for (let i = 0; i < tries; i += 1) {
    const v = await read();
    if (predicate(v)) return { verified: true, value: v };
    await sleep(delayMs);
  }
  return { verified: false };
}

/**
 * `outDir` is injectable so tests never write into the real report directory. They did,
 * once: stub `--apply` runs left backups of FAKE body_html beside the real apply run's
 * backups, and a restore from one of those would have written stub copy onto a live page.
 */
export async function main({ api, argv = process.argv, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), outDir = OUT_DIR } = {}) {
  const apply = flag(argv, '--apply');
  const themeId = argValue(argv, '--theme-id');
  const allowLive = flag(argv, '--allow-live-theme');
  const shopify = api ?? await import('../lib/shopify.js');

  // Gate every AFTER before reading anything live. One failure aborts the run.
  for (const e of PLAN) {
    const g = gateAfter(e);
    if (!g.ok) throw new Error(`ABORT — ${e.id}: ${g.why}`);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = join(outDir, 'backups', stamp);
  const results = [];
  const backup = (name, value) => {
    mkdirSync(backupDir, { recursive: true });
    writeFileSync(join(backupDir, name), typeof value === 'string' ? value : JSON.stringify(value, null, 2));
  };

  let liveThemeId = null;
  for (const [target, entries] of groupByTarget(PLAN)) {
    const kind = entries[0].kind;

    if (kind === 'product') {
      const { productId, handle } = entries[0];
      const product = await shopify.getProduct(productId);
      const live = product?.body_html;
      const { next, decisions, changed } = applyGroup(entries, live);
      results.push({ target, handle, decisions, changed, written: false });
      report(target, decisions);
      if (!changed || !apply) continue;
      backup(`product-${handle}.body_html.html`, live);
      await shopify.updateProduct(productId, { body_html: next });
      // Shopify can re-serialise body_html on save, so verify by content, not byte equality:
      // every applied AFTER is present and no applied BEFORE survives.
      const applied = entries.filter((e) => decisions.find((d) => d.id === e.id)?.action === 'apply');
      const rb = await readBackUntil(async () => (await shopify.getProduct(productId))?.body_html,
        (v) => typeof v === 'string' && applied.every((e) => v.includes(e.after) && !v.includes(e.before)),
        { sleep });
      results.at(-1).written = true;
      results.at(-1).verified = rb.verified;
      console.log(`  ✓ written${rb.verified ? ', read back identical' : ' — READ-BACK NOT YET IDENTICAL, re-check'}`);
      continue;
    }

    if (kind === 'metaobject') {
      const { metaobjectId, key, handle } = entries[0];
      const r = await shopify.shopifyGraphQL(
        'query($id: ID!) { metaobject(id: $id) { id handle fields { key value } } }', { id: metaobjectId });
      const mo = r?.metaobject ?? r?.data?.metaobject;
      const live = mo?.fields?.find((f) => f.key === key)?.value;
      const { next, decisions, changed } = applyGroup(entries, live);
      if (changed) {
        try { JSON.parse(next); } catch { throw new Error(`ABORT — ${target}: result is no longer valid JSON`); }
      }
      results.push({ target, handle, decisions, changed, written: false });
      report(target, decisions);
      if (!changed || !apply) continue;
      backup(`metaobject-${handle}.${key}.json`, live);
      const w = await shopify.shopifyGraphQL(
        'mutation($id: ID!, $metaobject: MetaobjectUpdateInput!) { metaobjectUpdate(id: $id, metaobject: $metaobject) { metaobject { id } userErrors { field message } } }',
        { id: metaobjectId, metaobject: { fields: [{ key, value: next }] } });
      const errs = (w?.metaobjectUpdate ?? w?.data?.metaobjectUpdate)?.userErrors ?? [];
      if (errs.length) throw new Error(`metaobjectUpdate ${target} refused: ${JSON.stringify(errs)}`);
      const rb = await readBackUntil(async () => {
        const again = await shopify.shopifyGraphQL(
          'query($id: ID!) { metaobject(id: $id) { fields { key value } } }', { id: metaobjectId });
        return (again?.metaobject ?? again?.data?.metaobject)?.fields?.find((f) => f.key === key)?.value;
      }, (v) => v === next, { sleep });
      results.at(-1).written = true;
      results.at(-1).verified = rb.verified;
      console.log(`  ✓ written${rb.verified ? ', read back identical' : ' — READ-BACK NOT YET IDENTICAL, re-check'}`);
      continue;
    }

    if (kind === 'product-metafield') {
      const { ownerId, namespace, key: mfKey, type, handle } = entries[0];
      const readMf = async () => {
        const r = await shopify.shopifyGraphQL(
          'query($id: ID!, $ns: String!, $key: String!) { product(id: $id) { metafield(namespace: $ns, key: $key) { value type } } }',
          { id: ownerId, ns: namespace, key: mfKey });
        return (r?.product ?? r?.data?.product)?.metafield?.value;
      };
      const live = await readMf();
      const { next, decisions, changed } = applyGroup(entries, live);
      if (changed && type === 'json') {
        try { JSON.parse(next); } catch { throw new Error(`ABORT — ${target}: result is no longer valid JSON`); }
      }
      results.push({ target, handle, decisions, changed, written: false });
      report(target, decisions);
      if (!changed || !apply) continue;
      backup(`metafield-${handle}.${namespace}.${mfKey}.json`, live);
      const w = await shopify.shopifyGraphQL(
        'mutation($m: [MetafieldsSetInput!]!) { metafieldsSet(metafields: $m) { metafields { id } userErrors { field message } } }',
        { m: [{ ownerId, namespace, key: mfKey, type, value: next }] });
      const errs = (w?.metafieldsSet ?? w?.data?.metafieldsSet)?.userErrors ?? [];
      if (errs.length) throw new Error(`metafieldsSet ${target} refused: ${JSON.stringify(errs)}`);
      // Shopify may re-serialise a json metafield, so compare parsed values, not bytes.
      const canon = (s) => { try { return JSON.stringify(JSON.parse(s)); } catch { return s; } };
      const rb = await readBackUntil(readMf, (v) => typeof v === 'string' && canon(v) === canon(next), { sleep });
      results.at(-1).written = true;
      results.at(-1).verified = rb.verified;
      console.log(`  ✓ written${rb.verified ? ', read back identical' : ' — READ-BACK NOT YET IDENTICAL, re-check'}`);
      continue;
    }

    // Theme asset.
    const key = entries[0].key;
    if (!themeId) {
      results.push({ target, decisions: entries.map((e) => ({ id: e.id, action: 'skip', why: 'theme entries need --theme-id' })) });
      console.log(`\n${target} — SKIP: theme entries need --theme-id <id>`);
      continue;
    }
    liveThemeId ??= await shopify.getMainThemeId();
    const targetId = Number(themeId);
    if (targetId === Number(liveThemeId) && !allowLive) {
      throw new Error(`REFUSED — --theme-id ${themeId} is the LIVE theme; pass --allow-live-theme after reviewing a preview`);
    }
    const live = await shopify.getThemeAsset(liveThemeId, key);
    const current = await shopify.getThemeAsset(targetId, key);
    const { next, decisions, changed } = applyGroup(entries, live);
    if (changed && key.endsWith('.json')) {
      try { JSON.parse(next.replace(/^\/\*[\s\S]*?\*\/\s*/, '')); } catch { throw new Error(`ABORT — ${target}: result is no longer valid JSON`); }
    }
    const needsWrite = next !== current;
    results.push({ target, themeId: targetId, decisions, changed, needsWrite, written: false });
    report(`${target} → theme ${targetId}${targetId === Number(liveThemeId) ? ' (LIVE)' : ''}`, decisions);
    if (!needsWrite) { console.log('  target already matches — nothing to write'); continue; }
    if (!apply) { console.log('  (dry run — pass --apply to write)'); continue; }
    backup(`theme-${targetId}-${key.replace(/\//g, '__')}`, current ?? '');
    await shopify.updateThemeAsset(targetId, key, next);
    const rb = await readBackUntil(() => shopify.getThemeAsset(targetId, key), (v) => v === next, { sleep });
    results.at(-1).written = true;
    results.at(-1).verified = rb.verified;
    console.log(`  ✓ written${rb.verified ? ', read back identical' : ' — READ-BACK NOT YET IDENTICAL, re-check'}`);
  }

  mkdirSync(outDir, { recursive: true });
  const record = { generated_at: new Date().toISOString(), applied: apply, themeId, results };
  writeFileSync(join(outDir, `run-${stamp}.json`), JSON.stringify(record, null, 2));
  console.log(`\nRun record: ${join(outDir, `run-${stamp}.json`)}`);
  return record;
}

function report(target, decisions) {
  console.log(`\n${target}`);
  for (const d of decisions) console.log(`  ${d.action.toUpperCase().padEnd(15)} ${d.id} — ${d.why}`);
}

if (isDirectRun(import.meta.url)) {
  main().catch((err) => { console.error(err.message); process.exit(1); });
}
