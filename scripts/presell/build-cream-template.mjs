#!/usr/bin/env node
/**
 * Render the Coconut Moisturizer pre-sell copy into its theme template.
 *
 *   data/presell/coconut-cream/content.json  (copy, gated by
 *                                             tests/theme/presell-cream-copy.test.js)
 *   data/presell/coconut-cream/media.json    (Shopify CDN urls and posters)
 *     -> theme/templates/page.presell-cream.json
 *
 * The copy lives in section and block SETTINGS so it stays editable in the theme
 * editor, but the source of truth is content.json: an editor change made on the
 * live theme is overwritten by the next build, and the template test fails if the
 * file in git ever differs from what this script produces. Edit content.json and
 * re-run; never hand-edit the template.
 *
 * NEVER RENDERED: content.theirLabel.sourceUrl / manufacturerUrl / product /
 * sourceNote / checkedOn. They name the comparison brand and exist so the
 * comparison can be re-checked. Only the ingredient list itself is copied in.
 *
 * Output is serialised the way Shopify writes theme JSON: two-space indent,
 * every "/" escaped as "\/", trailing newline. Deterministic, so re-running it is
 * byte-identical. Local file only; this script never touches a live theme.
 *
 * Usage: node scripts/presell/build-cream-template.mjs [--check]
 *   --check  exit 1 if the template on disk differs from a fresh build
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDirectRun } from '../../lib/is-direct-run.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const TEMPLATE_PATH = 'theme/templates/page.presell-cream.json';

// No header comment: the Admin API strips a comment from a JSON template on
// write, so a commented file can never read back byte-equal to git, and the
// publish guard (scripts/presell/publish-cream-presell.mjs) compares bytes.
// Provenance lives in sections/presell-listicle.liquid's header instead.
const HEADER = '';

export const serialize = (t) => `${HEADER}${JSON.stringify(t, null, 2).replace(/\//g, '\\/')}\n`;

function reasonBlock(content, media, r) {
  const m = media[r.media.key];
  if (!m) throw new Error(`media.json has no entry for ${r.media.key}`);
  const settings = {
    number: r.n,
    title: r.title,
    body: r.body,
    media_kind: r.media.kind,
    media_url: m.url,
  };
  if (r.media.kind === 'video') {
    const v = content.videos[r.media.key];
    if (!m.poster) throw new Error(`video ${r.media.key} has no poster`);
    settings.media_alt = v.alt;
    settings.poster_url = m.poster;
    settings.caption = v.caption;
    settings.captions_burned_in = v.burnedInCaptions;
  } else {
    settings.media_alt = content.images[r.media.key].alt;
  }
  return { type: 'reason', settings };
}

/** Pure: content + media -> template object. */
export function buildTemplate(content, media) {
  if (content.reasons.length !== 5) throw new Error('expected five reasons');
  if (content.reviews.length > 3) throw new Error('the reviews block has three slots');
  if (content.notes.length !== 2) throw new Error('the notes block has two slots');
  const hero = media[content.hero.key];
  if (!hero || hero.kind !== 'image') throw new Error('the hero must be a still image');

  const reviews = { heading: content.reviewsHeading };
  content.reviews.forEach((r, i) => {
    reviews[`quote_${i + 1}`] = r.quote;
    reviews[`name_${i + 1}`] = r.name;
  });

  const [r1, r2, r3, r4, r5] = content.reasons;
  const ordered = [
    ['reason-1', reasonBlock(content, media, r1)],
    ['label-compare', {
      type: 'label-compare',
      settings: {
        heading: content.labelCompare.heading,
        ours_title: content.labelCompare.oursTitle,
        ours_note: content.labelCompare.oursNote,
        ours_list: content.ourLabel.join('\n'),
        theirs_title: content.labelCompare.theirsTitle,
        theirs_list: content.theirLabel.ingredients.join('\n'),
      },
    }],
    ['reason-2', reasonBlock(content, media, r2)],
    ['reason-3', reasonBlock(content, media, r3)],
    ['reviews', { type: 'reviews', settings: reviews }],
    ['cta', { type: 'cta', settings: { label: content.buyBox.cta } }],
    ['reason-4', reasonBlock(content, media, r4)],
    ['reason-5', reasonBlock(content, media, r5)],
    ['notes', { type: 'notes', settings: { note_1: content.notes[0], note_2: content.notes[1] } }],
    ['buy-box', {
      type: 'buy-box',
      settings: {
        title: content.buyBox.title,
        price_note: content.buyBox.priceNote,
        scent_label: content.buyBox.scentLabel,
        cta: content.buyBox.cta,
        shipping: content.buyBox.shipping,
        guarantee: content.guarantee,
      },
    }],
  ];

  return {
    sections: {
      main: {
        type: 'presell-listicle',
        settings: {
          eyebrow: content.eyebrow,
          headline: content.headline,
          intro: content.intro,
          hero_image: hero.url,
          hero_alt: content.hero.alt,
          product_handle: content.product.handle,
          default_variant_id: content.product.defaultVariantId,
          default_scent: content.product.defaultScent,
          price_token: content.product.price,
        },
        blocks: Object.fromEntries(ordered),
        block_order: ordered.map(([id]) => id),
      },
    },
    order: ['main'],
  };
}

function main() {
  const read = (p) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));
  const content = read('data/presell/coconut-cream/content.json');
  const media = read('data/presell/coconut-cream/media.json');
  const out = serialize(buildTemplate(content, media));
  const target = join(ROOT, TEMPLATE_PATH);
  let current = null;
  try { current = readFileSync(target, 'utf8'); } catch { /* first build */ }
  if (process.argv.includes('--check')) {
    if (current !== out) { console.error(`${TEMPLATE_PATH} is out of date; rebuild it`); process.exit(1); }
    console.log(`${TEMPLATE_PATH} is up to date`);
    return;
  }
  if (current === out) { console.log(`${TEMPLATE_PATH} unchanged`); return; }
  writeFileSync(target, out);
  console.log(`wrote ${TEMPLATE_PATH}`);
}

if (isDirectRun(import.meta.url)) main();
