#!/usr/bin/env node
/**
 * Render the holiday gift-guide copy into its theme template.
 *
 *   data/presell/gift-guide/content.json  (copy, gated by
 *                                          tests/theme/gift-guide-copy.test.js)
 *     -> theme/templates/page.presell-gifts.json
 *
 * Same contract as build-cream-template.mjs: content.json is the source of
 * truth, the template is generated, and the template test fails if the file in
 * git differs from a fresh build. Prices, stock and images are NOT in either
 * file; sections/gift-guide-listicle.liquid reads them live, so this has no
 * media step. Local file only; this script never touches a live theme.
 *
 * Usage: node scripts/presell/build-gift-guide-template.mjs [--check]
 *   --check  exit 1 if the template on disk differs from a fresh build
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDirectRun } from '../../lib/is-direct-run.js';
import { serialize } from './build-cream-template.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const TEMPLATE_PATH = 'theme/templates/page.presell-gifts.json';
export const CONTENT_PATH = 'data/presell/gift-guide/content.json';

/** Pure: content -> template object. */
export function buildTemplate(content) {
  if (content.picks.length < 3) throw new Error('a gift guide needs at least three picks');
  if (content.reviews.length > 3) throw new Error('the reviews block has three slots');
  if (content.notes.length > 3) throw new Error('the notes block has three slots');
  if (!content.headline.includes('{count}')) throw new Error('the headline must carry {count}');

  const blocks = {};
  const order = [];
  const add = (id, block) => { blocks[id] = block; order.push(id); };

  // Reviews sit after the third pick, the same rhythm as the cream page.
  content.picks.forEach((p, i) => {
    add(`pick-${i + 1}`, {
      type: 'pick',
      settings: {
        product_handle: p.handle,
        title: p.title,
        for_who: p.forWho,
        body: p.body,
        button: p.button,
      },
    });
    if (i === 2) {
      const reviews = { heading: content.reviewsHeading };
      content.reviews.forEach((r, j) => {
        reviews[`quote_${j + 1}`] = r.quote;
        reviews[`name_${j + 1}`] = r.name;
      });
      add('reviews', { type: 'reviews', settings: reviews });
    }
  });

  const notes = { heading: content.notesHeading };
  content.notes.forEach((n, j) => { notes[`note_${j + 1}`] = n; });
  add('notes', { type: 'notes', settings: notes });

  return {
    sections: {
      main: {
        type: 'gift-guide-listicle',
        blocks,
        block_order: order,
        settings: {
          eyebrow: content.eyebrow,
          headline: content.headline,
          intro: content.intro,
          hero_image: '',
          hero_alt: content.heroAlt,
          closing: content.closing,
        },
      },
    },
    order: ['main'],
  };
}

export function render(root = ROOT) {
  const content = JSON.parse(readFileSync(join(root, CONTENT_PATH), 'utf8'));
  return serialize(buildTemplate(content));
}

if (isDirectRun(import.meta.url)) {
  const out = render();
  const path = join(ROOT, TEMPLATE_PATH);
  if (process.argv.includes('--check')) {
    const onDisk = readFileSync(path, 'utf8');
    if (onDisk !== out) { console.error(`${TEMPLATE_PATH} is stale; re-run without --check`); process.exit(1); }
    console.log(`${TEMPLATE_PATH} is current`);
  } else {
    writeFileSync(path, out);
    console.log(`wrote ${TEMPLATE_PATH}`);
  }
}
