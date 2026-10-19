// tests/theme/presell-cream-template.test.js
//
// Pins the shipped Coconut Moisturizer pre-sell page: the section
// (theme/sections/presell-listicle.liquid) and the template that feeds it
// (theme/templates/page.presell-cream.json).
//
// The copy gate (presell-cream-copy.test.js) only covers what ships if the
// template's text IS content.json's text. So this test maps every setting of
// every block back to content.json / media.json by an explicit table written
// HERE, independently of the build script, and requires an exact match in both
// directions: no setting differs from its source, and no setting exists that the
// table does not account for. A hand edit in the theme JSON, or a build-script
// bug, fails here instead of shipping unchecked copy.
//
// It also pins the page contract the next tasks rely on: the hero is the only
// above-the-fold media and is a still, every <video> is lazy (data-src, poster,
// muted loop playsinline preload="none"), the buy-box markup Task 3's script
// binds to, no third-party scripts, the competitor provenance never rendered,
// and an idempotent, `\/`-escaped template file.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkSeoCopyFields } from '../../lib/seo-copy-health-gate.js';
import {
  buildTemplate,
  serialize,
  TEMPLATE_PATH,
} from '../../scripts/presell/build-cream-template.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const content = JSON.parse(readFileSync(join(ROOT, 'data/presell/coconut-cream/content.json'), 'utf8'));
const media = JSON.parse(readFileSync(join(ROOT, 'data/presell/coconut-cream/media.json'), 'utf8'));
const TEMPLATE_FILE = join(ROOT, 'theme/templates/page.presell-cream.json');
const SECTION_FILE = join(ROOT, 'theme/sections/presell-listicle.liquid');
const CSS_FILE = join(ROOT, 'theme/assets/presell.css');

const raw = () => readFileSync(TEMPLATE_FILE, 'utf8');
const liquid = () => readFileSync(SECTION_FILE, 'utf8');
// The section's markup without its Liquid comments (which describe the tags).
const markup = () => liquid().replace(/{%-?\s*comment\s*-?%}[\s\S]*?{%-?\s*endcomment\s*-?%}/g, ' ');
const stripHeader = (s) => s.replace(/^\s*\/\*[\s\S]*?\*\/\s*/, '');
const template = () => JSON.parse(stripHeader(raw()));
const section = () => template().sections[template().order[0]];
const blocks = () => section().block_order.map((id) => section().blocks[id]);
const schema = () => JSON.parse(liquid().match(/{%-?\s*schema\s*-?%}([\s\S]*?){%-?\s*endschema\s*-?%}/)[1]);

// ── The independent source map ──────────────────────────────────────────────
function reasonSettings(r) {
  const isVideo = r.media.kind === 'video';
  const src = isVideo ? content.videos[r.media.key] : content.images[r.media.key];
  const s = {
    number: r.n,
    title: r.title,
    body: r.body,
    media_kind: r.media.kind,
    media_url: media[r.media.key].url,
    media_alt: src.alt,
  };
  if (isVideo) {
    s.poster_url = media[r.media.key].poster;
    s.caption = src.caption;
    s.captions_burned_in = src.burnedInCaptions;
  }
  return s;
}

function expectedSection() {
  const [r1, r2, r3, r4, r5] = content.reasons;
  const reviews = { heading: content.reviewsHeading };
  content.reviews.forEach((r, i) => {
    reviews[`quote_${i + 1}`] = r.quote;
    reviews[`name_${i + 1}`] = r.name;
  });
  return {
    settings: {
      eyebrow: content.eyebrow,
      headline: content.headline,
      intro: content.intro,
      hero_image: media[content.hero.key].url,
      hero_alt: content.hero.alt,
      product_handle: content.product.handle,
      default_variant_id: content.product.defaultVariantId,
      default_scent: content.product.defaultScent,
      price_token: content.product.price,
    },
    blocks: [
      { type: 'reason', settings: reasonSettings(r1) },
      {
        type: 'label-compare',
        settings: {
          heading: content.labelCompare.heading,
          ours_title: content.labelCompare.oursTitle,
          ours_note: content.labelCompare.oursNote,
          ours_list: content.ourLabel.join('\n'),
          theirs_title: content.labelCompare.theirsTitle,
          theirs_list: content.theirLabel.ingredients.join('\n'),
        },
      },
      { type: 'reason', settings: reasonSettings(r2) },
      { type: 'reason', settings: reasonSettings(r3) },
      { type: 'reviews', settings: reviews },
      { type: 'cta', settings: { label: content.buyBox.cta } },
      { type: 'reason', settings: reasonSettings(r4) },
      { type: 'reason', settings: reasonSettings(r5) },
      { type: 'notes', settings: { note_1: content.notes[0], note_2: content.notes[1] } },
      {
        type: 'buy-box',
        settings: {
          title: content.buyBox.title,
          price_note: content.buyBox.priceNote,
          scent_label: content.buyBox.scentLabel,
          cta: content.buyBox.cta,
          shipping: content.buyBox.shipping,
          guarantee: content.guarantee,
        },
      },
    ],
  };
}

// ── Template ↔ content ──────────────────────────────────────────────────────

test('template parses and its one section is presell-listicle', () => {
  const t = template();
  assert.equal(t.order.length, 1);
  assert.equal(section().type, 'presell-listicle');
});

test('section settings equal content.json / media.json exactly', () => {
  assert.deepEqual(section().settings, expectedSection().settings);
});

test('every block, in order, equals its content.json / media.json source', () => {
  const exp = expectedSection().blocks;
  const got = blocks();
  assert.equal(got.length, exp.length);
  got.forEach((b, i) => {
    assert.equal(b.type, exp[i].type, `block ${i} type`);
    assert.deepEqual(b.settings, exp[i].settings, `block ${i} (${b.type}) settings`);
  });
  // The content table above must use all copy: every review, both notes, five reasons.
  assert.ok(content.reviews.length <= 3, 'reviews block has three slots');
  assert.equal(content.notes.length, 2);
});

test('the comparison provenance and the brand are never in the template or section', () => {
  for (const s of [raw(), liquid(), readFileSync(CSS_FILE, 'utf8')]) {
    assert.ok(!/palmer/i.test(s), 'brand name');
    assert.ok(!s.includes('vitacost'), 'retailer source url');
    assert.ok(!s.includes(content.theirLabel.sourceUrl.replace(/\//g, '\\/')), 'escaped source url');
  }
});

// ── Above the fold and video loading ────────────────────────────────────────

test('the hero is a still image and the hero markup holds no video', () => {
  assert.equal(content.hero.kind, 'image');
  assert.match(section().settings.hero_image, /\.(jpe?g|png|webp)(\?|$)/);
  const hero = liquid().match(/<header class="presell-hero"[\s\S]*?<\/header>/);
  assert.ok(hero, 'hero markup');
  assert.ok(!/<video/i.test(hero[0]), 'video in hero');
  assert.match(hero[0], /fetchpriority="high"/);
});

test('every video block has a poster', () => {
  const vids = blocks().filter((b) => b.type === 'reason' && b.settings.media_kind === 'video');
  assert.equal(vids.length, 3);
  for (const v of vids) assert.match(v.settings.poster_url, /^https:\/\/cdn\.shopify\.com\//);
});

test('every <video> is lazy: muted loop playsinline preload=none, poster, data-src, no src', () => {
  const tags = markup().match(/<video\b[^>]*>/g) || [];
  assert.ok(tags.length >= 1, 'section renders videos');
  for (const t of tags) {
    for (const attr of ['muted', 'loop', 'playsinline', 'preload="none"', 'poster=', 'data-src=']) {
      assert.ok(t.includes(attr), `${attr} missing in ${t}`);
    }
    assert.ok(!/\ssrc=/.test(t), `video loads eagerly: ${t}`);
  }
  assert.ok(!/<source\b/.test(markup()), 'a <source> child would load eagerly');
  assert.match(liquid(), /IntersectionObserver/);
});

// ── Buy box contract (Task 3) ────────────────────────────────────────────────

test('buy box defaults to Coconut Breeze, variant 44179428475050', () => {
  assert.equal(section().settings.default_variant_id, '44179428475050');
  assert.equal(section().settings.product_handle, 'coconut-moisturizer');
});

test('buy-box markup contract Task 3 binds to', () => {
  const l = liquid();
  assert.match(l, /<form[^>]*data-presell-buy[^>]*id="presell-buy"|<form[^>]*id="presell-buy"[^>]*data-presell-buy/);
  assert.match(l, /<select[^>]*name="id"/);
  assert.match(l, /<option[^>]*value="{{ v\.id }}"/);
  assert.match(l, /all_products\[section\.settings\.product_handle\]/);
  assert.match(l, /<button[^>]*type="submit"[^>]*data-presell-submit/);
  assert.match(l, /<p[^>]*data-presell-error[^>]*hidden/);
  assert.match(l, /<a[^>]*data-presell-sticky[^>]*href="#presell-buy"/);
  assert.match(l, /<form[^>]*data-price-token="[^"]*"[^>]*data-scent-token="/);
  const labelled = l.match(/<[^>]*data-presell-label[^>]*>/g) || [];
  assert.equal(labelled.length, 4);
  for (const tag of labelled) assert.match(tag, /data-presell-template="{{ s\.\w+ \| escape }}"/);
  assert.match(l, /<script src="{{ 'presell-buy\.js' \| asset_url }}" defer><\/script>/);
  assert.match(l, /money_without_trailing_zeros/, 'price is live from the product');
  const code = l.replace(/{%-?\s*comment\s*-?%}[\s\S]*?{%-?\s*endcomment\s*-?%}/g, '');
  assert.ok(!/recurpay|selling_plan/i.test(code), 'no Recurpay widget or selling plan rendered');
});

test('no third-party scripts: every <script src> is a theme asset', () => {
  const scripts = [...markup().matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)];
  assert.ok(scripts.length >= 1);
  for (const m of scripts) {
    assert.match(m[1], /asset_url/, `third-party script ${m[1]}`);
  }
});

test('no robots meta in the section (noindex is a page metafield)', () => {
  assert.ok(!/name="robots"/.test(liquid()));
});

// ── Schema ↔ template ───────────────────────────────────────────────────────

test('schema declares every block type and every setting the template uses', () => {
  const sch = schema();
  const sectionIds = new Set(sch.settings.map((s) => s.id));
  for (const k of Object.keys(section().settings)) assert.ok(sectionIds.has(k), `section setting ${k}`);
  const types = Object.fromEntries(sch.blocks.map((b) => [b.type, new Set(b.settings.map((s) => s.id))]));
  for (const t of ['reason', 'reviews', 'label-compare', 'buy-box', 'cta', 'notes']) assert.ok(types[t], `block ${t}`);
  for (const b of blocks()) {
    for (const k of Object.keys(b.settings)) assert.ok(types[b.type].has(k), `${b.type}.${k} not in schema`);
  }
});

// ── Copy that lives in the Liquid itself ────────────────────────────────────

test('copy hardcoded in the section is clean too', () => {
  const visible = liquid()
    .replace(/{%-?\s*schema[\s\S]*?endschema\s*-?%}/, ' ')
    .replace(/{%-?\s*comment\s*-?%}[\s\S]*?{%-?\s*endcomment\s*-?%}/g, ' ')
    .replace(/<script[\s\S]*?<\/script>/g, ' ')
    .replace(/<style[\s\S]*?<\/style>/g, ' ')
    .replace(/{[{%][\s\S]*?[}%]}/g, ' ')
    .replace(/<[^>]+>/g, ' ');
  assert.ok(!visible.includes('—'), 'em dash');
  assert.ok(!/mineral oil|petrolatum|paraffin|antiperspirant/i.test(visible));
  const res = checkSeoCopyFields({ section: visible });
  assert.equal(res.ok, true, JSON.stringify(res.blocking));
  // Schema labels and defaults surface in the theme editor only, but keep them clean.
  assert.ok(!liquid().includes('—'), 'em dash anywhere in the section');
});

// ── Serialization ───────────────────────────────────────────────────────────

test('the build script reproduces the template byte for byte, with \\/ escaping', () => {
  assert.equal(TEMPLATE_PATH, 'theme/templates/page.presell-cream.json');
  const built = serialize(buildTemplate(content, media));
  assert.equal(built, raw(), 'template drifted from the build; re-run the build script');
  assert.ok(raw().includes('https:\\/\\/cdn.shopify.com'), '\\/ escaping');
  assert.ok(!/[^\\]\/\//.test(stripHeader(raw())), 'an unescaped // in the JSON body');
  // Re-serialising what was written is a no-op.
  assert.equal(serialize(template()), raw());
});

// ── Videos wait for the visitor to scroll (fix round 1) ──────────────────────
//
// Reason 1's video sits ~840-940px down a 390px phone, inside a 650-750px
// viewport plus any generous rootMargin, so an observer created on parse fires
// for it at once and the MP4 downloads during the hero's LCP window. The inline
// script is run here against a stub DOM to prove no video is observed (or
// loaded) until the first scroll, and that the look-ahead margin stays small.
const MAX_VIDEO_LOOKAHEAD_PX = 150;

function runInlineScript() {
  const src = markup().match(/<script>([\s\S]*?)<\/script>/)[1];
  const listeners = {};
  const observers = [];
  const makeVideo = () => ({
    attrs: { 'data-src': 'x.mp4' }, loaded: 0,
    getAttribute(k) { return this.attrs[k] ?? null; },
    set src(v) { this.attrs.src = v; }, load() { this.loaded++; },
    play() { return Promise.resolve(); }, pause() {},
  });
  const videos = [makeVideo(), makeVideo()];
  const el = () => ({ classList: { toggle() {} }, setAttribute() {} });
  const root = {
    querySelector: (s) => (s.includes('sticky') || s.includes('hero') ? el() : null),
    querySelectorAll: (s) => (s.startsWith('video') ? videos : []),
  };
  class IO {
    constructor(cb, opts = {}) { this.opts = opts; this.targets = []; observers.push(this); }
    observe(t) { this.targets.push(t); }
  }
  const win = {
    IntersectionObserver: IO,
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
  };
  const doc = { querySelector: () => root, getElementById: () => el() };
  new Function('window', 'document', 'IntersectionObserver', src)(win, doc, IO);
  const videoObservers = () => observers.filter((o) => o.targets.some((t) => videos.includes(t)));
  const fire = (type) => (listeners[type] || []).forEach((fn) => fn({}));
  return { videos, listeners, videoObservers, fire };
}

test('no video is observed or loaded until the first scroll', () => {
  const r = runInlineScript();
  assert.equal(r.videoObservers().length, 0, 'video observer created on parse');
  assert.ok(r.videos.every((v) => v.loaded === 0 && !v.attrs.src), 'a video loaded on parse');
  assert.ok(!r.listeners.load, 'window load must not start videos');
  r.fire('scroll');
  assert.equal(r.videoObservers().length, 1, 'scroll starts exactly one video observer');
  assert.equal(r.videoObservers()[0].targets.length, r.videos.length);
  r.fire('scroll');
  assert.equal(r.videoObservers().length, 1, 'a second scroll does not add observers');
});

test(`the video look-ahead margin is at most ${MAX_VIDEO_LOOKAHEAD_PX}px`, () => {
  const r = runInlineScript();
  r.fire('scroll');
  const margin = r.videoObservers()[0].opts.rootMargin || '0px';
  const px = margin.split(/\s+/).map((v) => parseFloat(v));
  assert.ok(margin.split(/\s+/).every((v) => /^-?\d+(\.\d+)?px$/.test(v)), `rootMargin in px: ${margin}`);
  assert.ok(Math.max(...px) <= MAX_VIDEO_LOOKAHEAD_PX, `rootMargin ${margin}`);
});

test('schema header settings fit Shopify\'s 50-character limit (the API rejects the asset otherwise)', () => {
  const sch = schema();
  const all = [...(sch.settings || []), ...(sch.blocks || []).flatMap((b) => b.settings || [])];
  for (const s of all.filter((x) => x.type === 'header')) {
    assert.ok(s.content.length <= 50, `header "${s.content}" is ${s.content.length} chars`);
  }
});
