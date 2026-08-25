// tests/theme/giveaway-section-classes.test.js
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SECTIONS = join(ROOT, 'theme', 'sections');
const CSS = readFileSync(join(ROOT, 'theme', 'assets', 'giveaway.css'), 'utf8');

/**
 * Classes that legitimately have no CSS rule. Three different reasons, kept
 * apart on purpose — collapsing them into one allowlist is how a real bug gets
 * parked next to two non-bugs and stops being visible.
 */

/** Structural: `.gv-next` is `display: grid` and this groups the text half
 *  into one grid item. The live entered page has always shipped it unstyled. */
const STRUCTURAL_ONLY = new Set(['gv-next-copy']);

/** JS query hooks. `.gv-email-fix` is only ever read by giveaway.js:141; the
 *  element carries `.gv-ref-fix` alongside it for the actual styling, so it is
 *  a selector handle and correctly has no rule of its own. */
const JS_HOOKS = new Set(['gv-email-fix']);

/**
 * PRE-EXISTING and genuinely unstyled — not exempt, just not this change's to
 * fix. `.gv-lead-sub` (giveaway-entered.liquid:38) has no rule and no JS
 * reference, so that sub-lede renders at browser default rather than at
 * `.gv-lead`'s muted 1.7rem. It is the same gap `.gv-copy` was added for.
 * Fixing it changes the typography of a live page and belongs in its own
 * change; this entry is here so it stays visible rather than passing silently.
 */
const KNOWN_UNSTYLED = new Set(['gv-lead-sub']);

const exempt = (c) => STRUCTURAL_ONLY.has(c) || JS_HOOKS.has(c) || KNOWN_UNSTYLED.has(c);

const giveawaySections = () =>
  readdirSync(SECTIONS).filter((f) => f.startsWith('giveaway-') && f.endsWith('.liquid'));

const classesIn = (html) => {
  const out = new Set();
  for (const [, attr] of html.matchAll(/class="([^"]+)"/g)) {
    for (const c of attr.trim().split(/\s+/)) if (c.startsWith('gv-')) out.add(c);
  }
  return out;
};

/**
 * A class is "defined" if the stylesheet selects it anywhere — as its own rule,
 * in a selector list, or as a descendant. Matching on the bare name would miss
 * `.gv-entered h2`-style rules; matching `.name` followed by a non-name char
 * catches every real form without matching `.gv-next-copy` inside
 * `.gv-next-copy-thing`.
 */
const isDefined = (cls) => new RegExp(`\\.${cls}(?![\\w-])`).test(CSS);

test('every gv- class used in a giveaway section exists in giveaway.css', () => {
  // REGRESSION 2026-08-24. giveaway-offer.liquid and giveaway-confirmed.liquid
  // between them invented TEN classes that had no rule: .gv-next-card,
  // .gv-next-img, .gv-entered-main, .gv-entered-title, .gv-entered-lede,
  // .gv-ladder-title, .gv-ladder-body, .gv-ladder-fine, .gv-next-title.
  //
  // It looked almost right, which is why it shipped: `.gv-entered h1` and
  // `.gv-entered h2` are DESCENDANT selectors, so every heading styled itself
  // correctly regardless of the class on it. What broke was everything with no
  // element-level fallback — body prose rendered at browser default, and the
  // product shot in the offer page's aside was missing entirely because
  // .gv-next-card replaced the .gv-next-shot wrapper that holds the <img>.
  const undefinedByFile = {};
  for (const file of giveawaySections()) {
    const missing = [...classesIn(readFileSync(join(SECTIONS, file), 'utf8'))]
      .filter((c) => !exempt(c) && !isDefined(c))
      .sort();
    if (missing.length) undefinedByFile[file] = missing;
  }
  assert.deepEqual(undefinedByFile, {},
    'these classes are used in a section but have no rule in giveaway.css');
});

test('every giveaway section that offers a product renders a product shot', () => {
  // The reported symptom. An aside selling something with no image is a card
  // of grey text; .gv-next-shot is the wrapper that gives the <img> its frame
  // (aspect-ratio, white ground, 92% width), so an <img> outside it is
  // unstyled even when it is present.
  for (const file of giveawaySections()) {
    const html = readFileSync(join(SECTIONS, file), 'utf8');
    if (!html.includes('class="gv-next"')) continue;
    assert.ok(/class="gv-next-shot"[\s\S]{0,400}?<img\b/.test(html),
      `${file} has a .gv-next offer aside but no <img> inside .gv-next-shot`);
  }
});

test('every product shot requests a sized image rather than the full original', () => {
  // The CDN original is ~2000px. Shopify resizes on the query param, and the
  // source url already carries ?v=, so the separator is & not ?.
  for (const file of giveawaySections()) {
    const html = readFileSync(join(SECTIONS, file), 'utf8');
    for (const [, src] of html.matchAll(/<img[^>]+src="([^"]+)"/g)) {
      if (!src.includes('set_image')) continue;
      assert.match(src, /&width=\d+/, `${file}: product shot must request a width`);
    }
  }
});
