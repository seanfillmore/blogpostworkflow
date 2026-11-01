// One-off production of three ads modelled on long-running competitor STRUCTURES
// (Meta Ad Library research, 2026-10-03). Renders are gated by Ad Studio's verifyImage;
// all type is set in code in the brand faces; all copy passes the ad-concepts gates.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const R = '/Users/seanfillmore/Code/Claude/';
const OUT = new URL('./out/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const require = createRequire(R + 'package.json');
const puppeteer = require('puppeteer');
const { GoogleGenAI } = require('@google/genai');
const studio = await import(R + 'agents/ad-studio/index.js');
const { selectReferencePhotos, buildProductFidelityBlock } = await import(R + 'agents/ad-studio/render.js');
const { buildSourceIndex } = await import(R + 'agents/ad-studio/claims.js');
const { selectVolumeStrings } = await import(R + 'agents/ad-studio/verify.js');
const { gateCopy } = await import(R + 'agents/ad-concepts/copy.js');
const { fontFaceCss } = await import(R + 'lib/brand-fonts.js');
const { default: Anthropic } = await import(R + 'lib/anthropic.js');

const env = Object.fromEntries(readFileSync(R + '.env', 'utf8').split('\n').filter(l => /^[A-Z_]+=/.test(l)).map(l => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')]; }));
const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
const gemini = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
const loadJson = (p) => JSON.parse(readFileSync(R + p, 'utf8'));
const manifest = loadJson('data/product-images/manifest.json');
const catalog = loadJson('data/brand/product-catalog.json').products;
const brandKit = loadJson('data/brand/brand-kit.json');
const VARIANT = 'coconut-breeze';
let renders = 0;

async function productFor(handle) {
  const m = manifest.find(e => e.handle === handle);
  const labelStrings = studio.buildLabelStrings({ manifestEntry: m, variant: VARIANT });
  const product = {
    handle, title: catalog[handle].title, variant: VARIANT, unitCount: m.unitCount,
    labelStrings, badgeStrings: studio.resolveBadgeStrings({ manifestEntry: m, variant: VARIANT }),
    labelInk: m.labelInk || null, physicalDescription: m.productDescription || '',
  };
  const photos = selectReferencePhotos(join(R, 'data/product-images', m.imageDir, VARIANT), 4);
  if (!photos.length || !labelStrings.length) throw new Error(`no photos/labels for ${handle}`);
  return { product, photos, refs: studio.loadReferencePhotos(photos) };
}

const PHONE = 'A casual, photorealistic smartphone photo: natural daylight, slightly imperfect framing, real camera-roll look with a touch of grain, true-to-life colour, nothing staged or glossy like studio product photography.';
const NOTEXT = 'There is no text anywhere in the image except our product\'s own printed label.';

async function renderVerified(name, { scene, prod, ratio, people = false, maxTakes = 4, withProduct = true }) {
  for (let t = 1; t <= maxTakes; t++) {
    const prompt = [PHONE, scene, NOTEXT, withProduct ? `EXACTLY 1 UNIT OF OUR PRODUCT. All printed type on our product's label is ${prod.product.labelInk || 'black'} ink.` : '',
      withProduct ? buildProductFidelityBlock(prod.product, { allowPeople: people }) : ''].filter(Boolean).join('\n\n');
    renders++;
    const buf = await studio.renderVariationWithBackoff(gemini, { prompt, photoPaths: withProduct ? prod.photos : [], ratio });
    const mediaType = studio.sniffImageMediaType(buf);
    writeFileSync(join(OUT, `${name}-take${t}.jpg`), buf);
    if (!withProduct) return { buf, mediaType, proof: { ok: true } };
    const proof = await studio.verifyImage({
      anthropic, buffer: buf, mediaType, referencePhotos: prod.refs, expected: [], mode: 'plate',
      format: { key: name, plateSetting: 'scene', pairsImagesWithLabels: false },
      physicalDescription: prod.product.physicalDescription, unitCount: 1, variant: VARIANT,
      expectedLabelInk: prod.product.labelInk, expectedBadge: prod.product.badgeStrings,
      volumeStrings: selectVolumeStrings(prod.product.labelStrings),
    });
    writeFileSync(join(OUT, `${name}-take${t}.proof.json`), JSON.stringify(proof, null, 2));
    console.log(name, 'take', t, proof.ok ? 'PASS' : `fail: ${(proof.reasons || []).slice(0, 2).join(' | ')}`);
    if (proof.ok) return { buf, mediaType, proof };
  }
  throw new Error(`${name}: no take passed`);
}

const fonts = fontFaceCss();
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const dataUrl = (r) => `data:${r.mediaType};base64,${r.buf.toString('base64')}`;
async function shoot(name, html, w, h) {
  const b = await puppeteer.launch({ args: ['--no-sandbox', '--font-render-hinting=none'] });
  try {
    const p = await b.newPage();
    await p.setViewport({ width: w, height: h, deviceScaleFactor: 1 });
    await p.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>${fonts} html,body{margin:0;width:${w}px;height:${h}px;overflow:hidden}</style></head><body>${html}</body></html>`, { waitUntil: 'load' });
    await p.evaluate(() => document.fonts.ready);
    writeFileSync(join(OUT, `${name}-FINAL.jpg`), await p.screenshot({ type: 'jpeg', quality: 92 }));
  } finally { await b.close(); }
}

// ---- evidence + copy gate -------------------------------------------------------------
const cream = await productFor('coconut-moisturizer');
const lotion = await productFor('coconut-lotion');
const reviews = [...studio.fetchAdReviews ? await studio.fetchAdReviews('coconut-moisturizer', { env }) : [], ...await studio.fetchAdReviews('coconut-lotion', { env })];
const sourceIndex = buildSourceIndex({ brandKit, catalogEntry: { ...catalog['coconut-moisturizer'], lotion: catalog['coconut-lotion'] }, reviews });
const competitorNames = loadJson('config/competitors.json').map(c => c.name);
function gate(name, fields, claims) {
  const g = gateCopy(fields, claims, { sourceIndex, competitorNames, variant: VARIANT, siblingVariants: ['calming-lavender', 'lavender-and-rose', 'pure-unscented', 'rose-petal'] });
  if (!g.ok) throw new Error(`${name} copy gate: ${g.reasons.join('; ')}`);
}

if (!process.env.ONLY_C) {
// ---- A: customer comment card + product + band (Ancestral Cosmetics, 304 days) -------
const QUOTE = 'This is THE moisturizer for Wisconsin winters for my whole family. It\'s long lasting and doesn\'t feel greasy. We use it all over and love it!';
gate('A', { headline: 'The winter moisturizer.', quote: QUOTE, band: 'FREE SHIPPING ON ORDERS OVER $45' },
  [{ text: 'THE moisturizer for Wisconsin winters for my whole family. It\'s long lasting and doesn\'t feel greasy. We use it all over and love it!', sourceId: 'reviews' }]);
const a = await renderVerified('A-comment-card', { prod: cream, ratio: '1:1',
  scene: 'Our 4 oz coconut moisturizer jar sits on a light wood bathroom counter, lid off and leaning against it, the thick white cream visible inside; the jar is in the lower third of the frame, label facing the camera. The upper half of the frame is a plain, softly out-of-focus pale wall.' });
await shoot('A-comment-card', `
<div style="position:relative;width:1080px;height:1080px;background:url('${dataUrl(a)}') center/cover">
  <div style="position:absolute;top:56px;left:0;right:0;text-align:center;font-family:Outfit;font-weight:600;font-size:76px;color:#000;letter-spacing:-1px">The <span style="border-bottom:7px solid #c0392b">winter</span> moisturizer.</div>
  <div style="position:absolute;top:190px;left:80px;right:80px;display:flex;gap:22px;align-items:flex-start">
    <div style="flex:none;width:76px;height:76px;border-radius:50%;background:#C9CDD2"></div>
    <div>
      <div style="background:#F0F2F5;border-radius:26px;padding:22px 28px;font-family:Cabin;font-size:31px;line-height:1.32;color:#050505">
        <div style="font-weight:700;font-size:28px;margin-bottom:6px">Customer review</div>${esc(QUOTE)}</div>
      <div style="font-family:Cabin;font-weight:700;font-size:24px;color:#3a3b3c;margin:10px 0 0 26px">Like&nbsp;&nbsp;&nbsp;Reply</div>
    </div>
  </div>
  <div style="position:absolute;left:0;right:0;bottom:0;height:104px;background:#000;color:#fff;display:flex;align-items:center;justify-content:center;font-family:Outfit;font-weight:600;font-size:40px;letter-spacing:2px">FREE SHIPPING ON ORDERS OVER $45</div>
</div>`, 1080, 1080);

// ---- B: texture scoop (Beauty From Bees, 256 days) -----------------------------------
gate('B', { headline: 'Soft. Never greasy.' }, [{ text: 'Doesn’t make you feel greasy or sticky after use', sourceId: 'reviews' }]);
const b = await renderVerified('B-texture', { prod: cream, ratio: '1:1', people: true,
  scene: 'Extreme close-up: one hand holds our open 4 oz coconut moisturizer jar from below while the index finger of the other hand lifts a generous, glossy swirl of thick whipped white cream out of it. The jar label is visible below the rim. Very shallow depth of field, soft warm window light, a blurred neutral background with clean empty space in the upper-left third of the frame. Natural relaxed hands with five fingers each, short unpainted nails.' });
await shoot('B-texture', `
<div style="position:relative;width:1080px;height:1080px;background:url('${dataUrl(b)}') center/cover">
  <div style="position:absolute;top:70px;left:72px;font-family:Outfit;font-weight:600;font-size:92px;line-height:1.02;color:#111;letter-spacing:-1px">Soft.<br>Never greasy.</div>
</div>`, 1080, 1080);

}
// ---- C: "what they think we sell / what we actually sell" split (Ancestral, 207 days) -
gate('C', { left: 'Coconut lotion they think we sell', right: 'Coconut lotion we actually sell', band: 'Only 6 clean ingredients. Made in the USA.' },
  [{ text: 'Only 6 Clean Ingredients', sourceId: 'catalog' }, { text: 'made in the USA', sourceId: 'brandKit' }]);
const left = await renderVerified('C-left', { prod: lotion, ratio: '9:16', withProduct: false,
  scene: 'A plain, unbranded clear plastic tub of solid white cooking coconut oil, lid off, a metal spoon stuck in it, sitting on a cluttered kitchen counter next to a frying pan. Unlabelled: no logo, no printing, no text on the tub.' });
const right = await renderVerified('C-right', { prod: lotion, ratio: '3:4',
  scene: 'Our 8 fl oz coconut body lotion bottle stands upright on a white marble bathroom counter, centred and large: it fills about 65% of the frame height, label facing straight at the camera, sharp and evenly lit. Behind it, softly out of focus, a bright airy bathroom with a green plant.' });
await shoot('C-split', `
<div style="display:flex;width:1080px;height:1350px;position:relative;background:#000">
  ${[['Coconut lotion they think we sell', left], ['Coconut lotion we actually sell', right]].map(([t, r]) => `
  <div style="position:relative;width:538px;height:1246px;background:url('${dataUrl(r)}') center/cover;margin-right:4px">
    <div style="position:absolute;top:44px;left:28px;right:28px;text-align:center;font-family:Outfit;font-weight:600;font-size:46px;line-height:1.12;color:#fff;text-shadow:0 2px 14px rgba(0,0,0,.75)">${t}</div>
  </div>`).join('')}
  <div style="position:absolute;left:0;right:0;bottom:0;height:104px;background:#EDE5D8;display:flex;align-items:center;justify-content:center;font-family:Outfit;font-weight:600;font-size:38px;color:#000">Only 6 clean ingredients. Made in the USA.</div>
</div>`, 1080, 1350);

console.log(`\nrenders: ${renders} (~$${(renders * 0.13).toFixed(2)})`);
