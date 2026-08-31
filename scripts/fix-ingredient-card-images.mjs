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
 * ── What this does NOT fix, and why it is not a silent gap ─────────────────
 * `BAKING SODA`, `WILDCRAFTED MYRRH` and a generic `ESSENTIAL OILS` photograph
 * DO NOT EXIST in Shopify Files — checked against all 1,092 files by filename
 * and by alt text, not by recollection. Five cards therefore keep a knowingly
 * wrong image. They are printed as `BLOCKED` on every run, dry or applied, so
 * the residual is reported rather than left to be rediscovered. Substituting an
 * approximate photograph — grapefruit for "essential oils", wax for "baking
 * soda" — IS the defect this script exists to remove, so nothing is guessed.
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
 * giving the 66.1666% measured on the rendered PDPs. Both images this plan
 * introduces sit at or below it — `red-palm-oil.webp` 1200x800 = 1.5,
 * `Jojoba.webp` 1200x900 = 1.3333 — so `highest_ratio` cannot move and the row
 * keeps its height on every template. Verified after applying: all four pages
 * still render 66.1666% on all three cards. Jojoba, being the tallest, is
 * cover-cropped ~11% top and bottom; its subject is centred with margin to
 * spare.
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
 * `title` is asserted rather than searched for loosely — it is what makes "the
 * card that says Organic Jojoba" the unit of change instead of "block 2".
 */
export const PLAN = [
  {
    template: 'product.landing-page-lotion.json',
    title: 'Organic Jojoba',
    before: 'Spring_Water.webp',
    after: 'Jojoba.webp',
    reason: 'showed a pond; Jojoba.webp was sitting unused in Files',
  },
  {
    template: 'product.landing-page-lotion.json',
    title: 'Organic Red Palm Oil',
    before: 'Wax.webp',
    after: 'red-palm-oil.webp',
    reason: 'showed wax pellets; red-palm-oil.webp was sitting unused in Files',
  },
  {
    template: 'product.landing-page-cream.json',
    title: 'Organic Red Palm Oil',
    before: 'Spring_Water.webp',
    after: 'red-palm-oil.webp',
    reason: 'showed a pond',
  },
  {
    template: 'product.landing-page-lip-balm.json',
    title: 'Organic Red Palm Oil',
    before: 'Spring_Water.webp',
    after: 'red-palm-oil.webp',
    reason: 'showed a pond',
  },
  {
    template: 'product.landing-page-deodorant.json',
    title: 'Organic Jojoba',
    before: 'Spring_Water.webp',
    after: 'Jojoba.webp',
    reason: 'showed a pond',
  },
];

/**
 * Cards naming an ingredient we have NO photograph of. Printed every run so the
 * residual stays visible; deliberately not filled with a near-miss image.
 */
export const BLOCKED = [
  { template: 'product.landing-page-deodorant.json', title: 'Baking Soda', current: 'Wax.webp', needs: 'baking soda' },
  { template: 'product.landing-page-toothpaste.json', title: 'Baking Soda', current: 'Spring_Water.webp', needs: 'baking soda' },
  { template: 'product.landing-page-toothpaste.json', title: 'Wildcrafted Myrrh', current: 'Wax.webp', needs: 'myrrh resin' },
  { template: 'product.landing-page-bar-soap.json', title: 'Variation Essential Oils', current: 'Wax.webp', needs: 'essential oil bottles' },
  { template: 'product.landing-page-liquid-soap.json', title: 'Variation Essential Oils', current: 'Wax.webp', needs: 'essential oil bottles' },
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
  const section = template?.sections?.[SECTION];
  if (!section) return { status: 'skip', why: `no "${SECTION}" section in ${entry.template}` };

  const found = findCardByTitle(section, entry.title);
  if (!found) return { status: 'skip', why: `no card titled "${entry.title}"` };

  const image = found.block.settings.image;
  if (image === ref(entry.after)) return { status: 'already-applied', blockKey: found.key };
  if (image !== ref(entry.before)) {
    return {
      status: 'skip',
      blockKey: found.key,
      why: `card image is ${image ?? '(unset)'}, expected ${ref(entry.before)} — live state has moved on`,
    };
  }
  return { status: 'change', blockKey: found.key, from: image, to: ref(entry.after) };
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
      state.patched = replaceBlockImage(state.patched, SECTION, verdict.blockKey, entry.before, entry.after);
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
      if (r.status === 'change') console.log(`      ${r.before}  →  ${r.after}   (${r.reason})`);
      if (r.status === 'skip') console.log(`      SKIPPED: ${r.why}`);
    }
    console.log(`\n  ${changed.length} to change, `
      + `${results.length - changed.length - skipped.length} already applied, ${skipped.length} skipped`);

    console.log(`\nBLOCKED — no photograph of this ingredient exists in Shopify Files:`);
    for (const b of BLOCKED) {
      console.log(`  · ${short(b.template).padEnd(11)} "${b.title}" still shows ${b.current} — needs ${b.needs}`);
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
