#!/usr/bin/env node
/**
 * Point each `hero-ingredient-cards` block at a photograph of the ingredient it
 * names.
 *
 *   node scripts/fix-ingredient-card-images.mjs            # dry run (default)
 *   node scripts/fix-ingredient-card-images.mjs --apply     # write live templates
 *   node scripts/fix-ingredient-card-images.mjs --json      # machine-readable audit
 *
 * ── The defect ─────────────────────────────────────────────────────────────
 * Every `product.landing-page-*.json` template carries a `multicolumn` section
 * whose cards name the product's headline ingredients. All seven templates were
 * seeded from the same three images — `Coconut_Oil_Extract`, `Spring_Water`,
 * `Wax` — dealt out BY CARD POSITION, not by what the card says. So the lotion's
 * "Organic Jojoba" card showed a pond, its "Organic Red Palm Oil" card showed
 * wax pellets, and the deodorant's "Baking Soda" card showed wax pellets too.
 * Coconut oil is the only ingredient that landed on its own photograph, and only
 * because it is card 1 nearly everywhere.
 *
 * ── The ingredient library IS the lotion's ingredient list ─────────────────
 * Shopify Files holds exactly seven ingredient photographs, and they are not an
 * arbitrary set: `Spring_Water`, `coconut_oil`, `Coconut_Oil_Extract`,
 * `Jojoba`, `Wax`, `Grapefruit`, `red-palm-oil` are one-for-one the ingredients
 * of the body lotion. Whoever shot them shot the lotion. That is why `Jojoba`
 * and `red-palm-oil` sat in Files unused while three templates displayed the
 * wrong picture for those exact ingredients — the images existed, nothing had
 * ever been wired to them.
 *
 * ── The draft page had it RIGHT all along, which is the corroboration ──────
 * `templates/page.landing-page-design.json` (the unpublished `landing-page-5`)
 * carries a `landing-ingredients` section wiring all SEVEN images to their own
 * ingredients — Purified Spring Water, Virgin Coconut Oil, Jojoba Oil,
 * Plant-Based Emulsifying Wax, Grapefruit Seed Extract, Red Palm Oil, Coconut
 * Oil Extract. Somebody built that correctly; only the PDP templates took the
 * position shortcut. That page is why entries carry their own `section`.
 *
 * ── What this does NOT fix, and why it is not a silent gap ─────────────────
 * A generic `ESSENTIAL OILS` photograph still does not exist, so both soaps'
 * "Variation Essential Oils" card keeps a knowingly wrong image. It is printed
 * as `BLOCKED` on every run, dry or applied, so the residual is reported rather
 * than left to be rediscovered. Substituting an approximate photograph —
 * grapefruit for "essential oils", wax for "baking soda" — IS the defect this
 * script exists to remove, so nothing is guessed.
 *
 * ── One supplied photograph was REJECTED on its text, and it is kept ───────
 * `data/brand/pdp-sections/essential-oils.REJECTED.source.jpg` is an operator-
 * supplied shot of nine labelled dropper bottles. It cannot ship: the headline
 * on one bottle reads **FRANKINCENBE**, every Latin binomial is model gibberish
 * (`Lecendule engustifate`, `Eocelyptis glebeloe`, `Cldos bergamia`), several
 * volumes read `1burt` / `Tord` / `10nd`, and the bergamot bottle is
 * illustrated with green limes. Unlike the myrrh shot below it CANNOT be
 * cropped clean — the labelled bottles ARE the subject. It is committed so the
 * next person does not regenerate the same brief and re-derive the same finding;
 * the replacement brief is in the README.
 *
 * Verify supplied artwork by zooming each string and reading it letter by
 * letter. At a glance all three of these images looked clean; `MYRRRH` (three
 * R's) and `FRANKINCENBE` both survived a first read, which is exactly the
 * autocorrecting-vision failure the fleet has hit before.
 *
 * ── Two cards are deliberately NOT treated as ingredients ──────────────────
 * The soap templates' card 2 is a mechanism claim: bar soap says "Naturally
 * Lathering", liquid soap says "Built for the Foaming Dispenser". Both show
 * `Spring_Water`, which reads as lather and as dilution respectively, and both
 * are left alone. The soaps are the family where a three-ingredient list does
 * not apply — Pure Unscented is saponified coconut oil and nothing else.
 *
 * ── The row's height is 1 / the WIDEST image, so only a wider one resizes it ─
 * `sections/multicolumn.liquid` under `image_ratio: adapt` walks every block,
 * keeps `highest_ratio = max(block.settings.image.aspect_ratio)`, and renders
 * ONE `--image-ratio-percent: 1 / highest_ratio` on all of them; each card is
 * then cover-cropped into it. Read the section, not the card — position is
 * irrelevant, and it is the MAXIMUM that decides, not the first.
 *
 * The incumbent maximum is `Coconut_Oil_Extract.webp` at 1200x794 = 1.5113,
 * giving the 66.1666% measured on the rendered PDPs. Every image this plan
 * introduces sits at or below it: `Jojoba.webp` 1200x900 = 1.3333 (tallest,
 * so cover-cropped ~11% top and bottom, subject centred with margin), and the
 * three prepared on 2026-08-31 — `baking-soda`, `myrrh-resin`,
 * `red-palm-fruit` — are cut to **1200x794 exactly**, byte-identical geometry
 * to the incumbent, precisely so `highest_ratio` cannot move.
 *
 * They are pre-cropped rather than uploaded square for the same reason: all
 * three arrived as 1024x1024, which the row would have cover-cropped by 34% top
 * and bottom sight-unseen. Composing the crop here means what was reviewed is
 * what ships.
 *
 * A FUTURE ENTRY INTRODUCING A WIDER IMAGE (aspect_ratio > 1.5113) SHORTENS THE
 * WHOLE ROW AND CROPS EVERY OTHER CARD HARDER. That is the check to re-run —
 * not "which card is it going in".
 *
 * ── Why this edits BYTES and does not re-serialize ─────────────────────────
 * Shopify writes these templates with every `/` escaped: the live value is
 * `"shopify:\/\/shop_images\/Spring_Water.webp"`. `JSON.stringify` does not
 * escape `/`, so a parse-and-reserialize would rewrite EVERY string in the file
 * that contains a slash — hundreds of lines of diff on a live template, for a
 * five-character change. So the file is parsed only to LOCATE and VERIFY the
 * block, and the replacement is a bounded splice inside that block's own brace
 * span. The bytes outside it are untouched by construction.
 *
 * ── How it writes ──────────────────────────────────────────────────────────
 * It does not call Shopify itself. It hands each patched file to
 * `scripts/update-theme-asset.mjs put --apply`, which already backs the pristine
 * live copy up under `theme/backup/`, prints the changed span, and re-reads the
 * asset until it matches (an asset PUT is not immediately consistent). A second
 * copy of that write path is a second copy that drifts.
 *
 * Every entry asserts its own BEFORE state — the block's title AND its current
 * image — and a template whose live state has moved on is SKIPPED and reported,
 * never overwritten. An already-applied entry reports `already-applied`, so the
 * script is idempotent and a second `--apply` writes nothing.
 */
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isDirectRun } from '../lib/is-direct-run.js';
import { getMainThemeId, getThemeAsset, getAllFiles } from '../lib/shopify.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SECTION = 'hero-ingredient-cards';

/** The unescaped reference a template block holds. */
export const ref = (file) => `shopify://shop_images/${file}`;
/** The same reference as Shopify writes it into the template JSON. */
export const escapedRef = (file) => `shopify:\\/\\/shop_images\\/${file}`;

/**
 * One entry per card that names an ingredient we hold a photograph of.
 *
 * `title` is asserted rather than searched for loosely — it is what makes "the
 * card that says Organic Jojoba" the unit of change instead of "block 2".
 * `section` defaults to the PDP row and is named only where it differs.
 * `before` is a LIST of acceptable prior values, so an entry stays runnable
 * across its own history: the red palm cards have held three different images
 * (the original `Spring_Water`/`Wax` mis-deal, then `red-palm-oil.webp`, now
 * `red-palm-fruit.webp`) and the plan should describe the destination, not one
 * hop of the journey.
 */
export const PLAN = [
  {
    template: 'product.landing-page-lotion.json',
    title: 'Organic Jojoba',
    before: ['Spring_Water.webp'],
    after: 'Jojoba.webp',
    reason: 'showed a pond; Jojoba.webp was sitting unused in Files',
  },
  {
    template: 'product.landing-page-deodorant.json',
    title: 'Organic Jojoba',
    before: ['Spring_Water.webp'],
    after: 'Jojoba.webp',
    reason: 'showed a pond',
  },
  // Red palm: `red-palm-oil.webp` is a lab flask on a MINT/TEAL ground against
  // the warm naturals of every sibling card. Accurate but visibly foreign, so
  // it is superseded by an operator-supplied grove shot on warm wood.
  {
    template: 'product.landing-page-lotion.json',
    title: 'Organic Red Palm Oil',
    before: ['Wax.webp', 'red-palm-oil.webp'],
    after: 'red-palm-fruit.webp',
    reason: 'showed wax pellets, then a teal lab flask that clashed with its siblings',
  },
  {
    template: 'product.landing-page-cream.json',
    title: 'Organic Red Palm Oil',
    before: ['Spring_Water.webp', 'red-palm-oil.webp'],
    after: 'red-palm-fruit.webp',
    reason: 'showed a pond, then a teal lab flask that clashed with its siblings',
  },
  {
    template: 'product.landing-page-lip-balm.json',
    title: 'Organic Red Palm Oil',
    before: ['Spring_Water.webp', 'red-palm-oil.webp'],
    after: 'red-palm-fruit.webp',
    reason: 'showed a pond, then a teal lab flask that clashed with its siblings',
  },
  {
    // The draft ingredient page — swept so the retired teal asset is left with
    // no referrer anywhere, rather than surviving on the one surface nobody
    // looks at. Different section type and key, hence the explicit `section`.
    template: 'page.landing-page-design.json',
    section: 'landing_ingredients_nd9fBX',
    title: 'Red Palm Oil',
    before: ['red-palm-oil.webp'],
    after: 'red-palm-fruit.webp',
    reason: 'this page was always correct; only the photograph is being upgraded',
  },
  {
    template: 'product.landing-page-deodorant.json',
    title: 'Baking Soda',
    before: ['Wax.webp'],
    after: 'baking-soda.webp',
    reason: 'showed wax pellets; no baking soda photograph existed until 2026-08-31',
  },
  {
    template: 'product.landing-page-toothpaste.json',
    title: 'Baking Soda',
    before: ['Spring_Water.webp'],
    after: 'baking-soda.webp',
    reason: 'showed a pond; no baking soda photograph existed until 2026-08-31',
  },
  {
    template: 'product.landing-page-toothpaste.json',
    title: 'Wildcrafted Myrrh',
    before: ['Wax.webp'],
    after: 'myrrh-resin.webp',
    reason: 'showed wax pellets; no myrrh photograph existed until 2026-08-31',
  },
];

/**
 * Cards naming an ingredient we have NO usable photograph of. Printed every run
 * so the residual stays visible; deliberately not filled with a near-miss image.
 *
 * `rejected` records that artwork WAS supplied and failed, which is a different
 * state from "nobody has tried" and needs a different next step.
 */
export const BLOCKED = [
  {
    template: 'product.landing-page-bar-soap.json',
    title: 'Variation Essential Oils',
    current: 'Wax.webp',
    needs: 'unlabelled amber dropper bottles',
    rejected: 'essential-oils.REJECTED.source.jpg — "FRANKINCENBE", gibberish binomials',
  },
  {
    template: 'product.landing-page-liquid-soap.json',
    title: 'Variation Essential Oils',
    current: 'Wax.webp',
    needs: 'unlabelled amber dropper bottles',
    rejected: 'essential-oils.REJECTED.source.jpg — "FRANKINCENBE", gibberish binomials',
  },
];

/** Cards whose heading is a mechanism claim, not an ingredient. Left alone. */
export const NOT_INGREDIENTS = [
  { template: 'product.landing-page-bar-soap.json', title: 'Naturally Lathering', current: 'Spring_Water.webp' },
  { template: 'product.landing-page-liquid-soap.json', title: 'Built for the Foaming Dispenser', current: 'Spring_Water.webp' },
];

/** Find the block in `section` whose settings.title matches, or null. */
export function findCardByTitle(section, title) {
  for (const key of section?.block_order ?? Object.keys(section?.blocks ?? {})) {
    const block = section?.blocks?.[key];
    if (block?.settings?.title === title) return { key, block };
  }
  return null;
}

/**
 * The `[start, end)` byte span of the JSON object that `"<key>":` introduces,
 * searched within `[from, to)` of `raw`.
 *
 * The needle requires the COLON. A bare `"ingredient-card-2"` also occurs inside
 * `block_order` (and a section key occurs inside the file's top-level `order`),
 * so matching the quoted key alone reports every real template as ambiguous.
 *
 * The scan is string-aware: these templates are full of HTML body copy carrying
 * braces and escaped quotes, and a naive brace count walks straight past the end
 * of the block.
 */
export function objectSpan(raw, key, from = 0, to = raw.length) {
  const region = raw.slice(from, to);
  const needle = new RegExp(`"${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\s*:`, 'g');
  const hits = [...region.matchAll(needle)];
  if (hits.length === 0) throw new Error(`key ${key} not found`);
  if (hits.length > 1) throw new Error(`key ${key} is not unique here — refusing to guess which one`);

  const open = region.indexOf('{', hits[0].index + hits[0][0].length);
  if (open === -1) throw new Error(`no object body after ${key}`);

  let depth = 0;
  let inString = false;
  for (let i = open; i < region.length; i++) {
    const c = region[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return [from + open, from + i + 1];
  }
  throw new Error(`unbalanced braces after ${key}`);
}

/**
 * Replace the single `"image"` value inside one block's span. The block is
 * located INSIDE its section's span, never across the whole file — two sections
 * may legitimately share a block key. Asserts the block holds exactly one
 * `image`, and that it currently reads `before`: a block that has moved on is a
 * caller error, not something to overwrite.
 */
export function replaceBlockImage(raw, sectionKey, blockKey, before, after) {
  const [secStart, secEnd] = objectSpan(raw, sectionKey);
  const [start, end] = objectSpan(raw, blockKey, secStart, secEnd);
  const body = raw.slice(start, end);
  const pattern = /"image"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  const hits = [...body.matchAll(pattern)];
  if (hits.length !== 1) {
    throw new Error(`block ${blockKey} holds ${hits.length} "image" keys, expected exactly 1`);
  }
  if (hits[0][1] !== escapedRef(before)) {
    throw new Error(`block ${blockKey} image is "${hits[0][1]}", expected "${escapedRef(before)}"`);
  }
  const patchedBody = body.slice(0, hits[0].index)
    + `"image": "${escapedRef(after)}"`
    + body.slice(hits[0].index + hits[0][0].length);
  return raw.slice(0, start) + patchedBody + raw.slice(end);
}

/**
 * Decide what one plan entry should do against the template it actually finds.
 * Pure — no I/O — so every verdict is a case a test can construct.
 */
export function decideEntry(entry, template) {
  const key = entry.section ?? SECTION;
  const section = template?.sections?.[key];
  if (!section) return { status: 'skip', why: `no "${key}" section in ${entry.template}` };

  const found = findCardByTitle(section, entry.title);
  if (!found) return { status: 'skip', why: `no card titled "${entry.title}"` };

  const image = found.block.settings.image;
  if (image === ref(entry.after)) return { status: 'already-applied', sectionKey: key, blockKey: found.key };

  const matched = entry.before.find((b) => image === ref(b));
  if (!matched) {
    return {
      status: 'skip',
      sectionKey: key,
      blockKey: found.key,
      why: `card image is ${image ?? '(unset)'}, expected one of `
        + `${entry.before.join(' | ')} — live state has moved on`,
    };
  }
  return { status: 'change', sectionKey: key, blockKey: found.key, matched, from: image, to: ref(entry.after) };
}

const short = (t) => t.replace('product.landing-page-', '').replace('.json', '');

async function main() {
  const APPLY = process.argv.includes('--apply');
  const JSON_OUT = process.argv.includes('--json');

  const themeId = await getMainThemeId();
  if (!themeId) throw new Error('no main theme');

  // Every `after` must be a real file. A shopify:// reference to a missing file
  // renders Dawn's grey placeholder — strictly worse than the wrong photograph.
  const files = await getAllFiles();
  const present = new Set(files.map((f) => {
    const url = f.image?.url || f.url || '';
    return decodeURIComponent((url.split('/').pop() || '').split('?')[0]);
  }));
  const absent = [...new Set(PLAN.map((e) => e.after))].filter((n) => !present.has(n));
  if (absent.length) throw new Error(`plan targets files not in Shopify Files: ${absent.join(', ')}`);

  const templates = [...new Set(PLAN.map((e) => e.template))];
  const live = new Map();
  for (const name of templates) {
    const raw = await getThemeAsset(themeId, `templates/${name}`);
    if (!raw) throw new Error(`live template not found: ${name}`);
    live.set(name, { raw, patched: raw, doc: JSON.parse(raw) });
  }

  const results = [];
  for (const entry of PLAN) {
    const state = live.get(entry.template);
    const verdict = decideEntry(entry, state.doc);
    results.push({ ...entry, ...verdict });
    if (verdict.status === 'change') {
      state.patched = replaceBlockImage(
        state.patched, verdict.sectionKey, verdict.blockKey, verdict.matched, entry.after,
      );
    }
  }

  const changed = results.filter((r) => r.status === 'change');
  const skipped = results.filter((r) => r.status === 'skip');

  if (JSON_OUT) {
    console.log(JSON.stringify({ results, blocked: BLOCKED, not_ingredients: NOT_INGREDIENTS }, null, 2));
  } else {
    console.log(`Ingredient card images — ${APPLY ? 'APPLY' : 'DRY RUN'}\n`);
    for (const r of results) {
      console.log(`  ${{ change: '→', 'already-applied': '=', skip: '!' }[r.status]} `
        + `${short(r.template).padEnd(11)} "${r.title}"`);
      if (r.status === 'change') console.log(`      ${r.matched}  →  ${r.after}   (${r.reason})`);
      if (r.status === 'skip') console.log(`      SKIPPED: ${r.why}`);
    }
    console.log(`\n  ${changed.length} to change, `
      + `${results.length - changed.length - skipped.length} already applied, ${skipped.length} skipped`);

    console.log(`\nBLOCKED — no usable photograph of this ingredient exists:`);
    for (const b of BLOCKED) {
      console.log(`  · ${short(b.template).padEnd(11)} "${b.title}" still shows ${b.current} — needs ${b.needs}`);
      if (b.rejected) console.log(`      artwork was supplied and REJECTED: ${b.rejected}`);
    }
    console.log(`\nNot ingredients (mechanism cards, left alone):`);
    for (const n of NOT_INGREDIENTS) {
      console.log(`  · ${short(n.template).padEnd(11)} "${n.title}" shows ${n.current}`);
    }
  }

  if (!changed.length) {
    if (!JSON_OUT) console.log(`\nNothing to write.`);
    return;
  }
  if (!APPLY) {
    if (!JSON_OUT) console.log(`\ndry run — pass --apply to write`);
    return;
  }

  // Delegate the write. update-theme-asset.mjs owns the pristine backup, the
  // changed-span diff, and the read-back-until-consistent check.
  const stage = mkdtempSync(join(tmpdir(), 'ingredient-cards-'));
  for (const name of templates) {
    if (!changed.some((c) => c.template === name)) continue;
    const out = join(stage, name);
    writeFileSync(out, live.get(name).patched);
    console.log(`\n─── ${name} ───`);
    execFileSync(
      process.execPath,
      [join(ROOT, 'scripts', 'update-theme-asset.mjs'), 'put', `templates/${name}`, out, '--apply'],
      { stdio: 'inherit', cwd: ROOT },
    );
  }
}

if (isDirectRun(import.meta.url)) await main();
