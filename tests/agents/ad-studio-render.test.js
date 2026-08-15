import { strict as assert } from 'node:assert';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildRenderPrompt, selectReferencePhotos, renderVariation } from '../../agents/ad-studio/render.js';
import { formatByKey } from '../../agents/ad-studio/formats.js';

const product = {
  title: 'Non-Toxic Body Lotion',
  handle: 'coconut-lotion',
  productDescription: 'An 8 fl. oz. white plastic bottle with a black disc cap.',
  labelStrings: ['real', 'SKIN CARE', 'coconut breeze', 'moisturizing body lotion', '8 fl. oz. - 236ml'],
};
const brandKit = { palette_hexes: ['#000000', '#EDE5D8', '#AEDEAC', '#EDEDED'] };
const zones = { headline: 'SIX INGREDIENTS.', listItems: ['ORGANIC JOJOBA'], bottomBar: 'NO MINERAL OIL' };
const format = formatByKey('ingredient-callout');

// finished mode carries the copy and every label string verbatim.
const finished = buildRenderPrompt({ format, zones, product, brandKit, mode: 'finished' });
assert.ok(finished.includes('SIX INGREDIENTS.'));
assert.ok(finished.includes('ORGANIC JOJOBA'));
assert.ok(finished.includes('NO MINERAL OIL'));
for (const s of product.labelStrings) {
  assert.ok(finished.includes(s), `render prompt must name label string: ${s}`);
}
assert.ok(finished.includes('8 fl. oz. - 236ml'), 'volume marking must appear literally');
assert.ok(finished.includes('#EDE5D8'), 'brand palette must be carried');
assert.ok(finished.includes(format.layoutBrief.slice(0, 40)), 'layout brief must be carried');
assert.ok(/generated as part of the scene|in-scene/i.test(finished), 'must require in-scene product');

// plate mode forbids copy but still requires a correct product label.
const plate = buildRenderPrompt({ format, zones, product, brandKit, mode: 'plate' });
assert.ok(!plate.includes('SIX INGREDIENTS.'), 'plate must not carry headline copy');
assert.ok(!plate.includes('NO MINERAL OIL'), 'plate must not carry bottom-bar copy');
assert.ok(/NO TEXT/i.test(plate), 'plate must forbid text');
assert.ok(plate.includes('8 fl. oz. - 236ml'), 'plate still needs a correct product label');

// An unknown mode is a programming error, not a silent default.
assert.throws(() => buildRenderPrompt({ format, zones, product, brandKit, mode: 'wat' }), /unknown mode/i);

// selectReferencePhotos: deterministic, image files only, capped.
const dir = join(tmpdir(), 'ad-studio-photos-' + Date.now());
mkdirSync(dir, { recursive: true });
for (const f of ['b.jpg', 'a.jpg', 'c.webp', 'd.png', 'e.jpg', 'notes.txt']) writeFileSync(join(dir, f), 'x');
const picked = selectReferencePhotos(dir);
assert.equal(picked.length, 4, 'caps at 4 reference photos');
assert.ok(picked.every(p => /\.(jpe?g|png|webp)$/i.test(p)), 'images only');
assert.deepEqual(picked, selectReferencePhotos(dir), 'selection is deterministic');
assert.deepEqual(picked.map(p => p.split('/').pop()), ['a.jpg', 'b.jpg', 'c.webp', 'd.png']);
assert.equal(selectReferencePhotos(dir, 2).length, 2);
assert.deepEqual(selectReferencePhotos(join(dir, 'nope')), [], 'missing dir yields no photos');
rmSync(dir, { recursive: true, force: true });

// renderVariation: sends photos then prompt, and returns the image bytes.
let captured = null;
const fakeGemini = {
  models: {
    generateContent: async (req) => {
      captured = req;
      return { candidates: [{ content: { parts: [{ inlineData: { data: Buffer.from('IMG').toString('base64') } }] } }] };
    },
  },
};
const photoDir = join(tmpdir(), 'ad-studio-one-' + Date.now());
mkdirSync(photoDir, { recursive: true });
writeFileSync(join(photoDir, 'a.jpg'), 'jpegbytes');
const buf = await renderVariation(fakeGemini, {
  prompt: 'PROMPT',
  photoPaths: selectReferencePhotos(photoDir),
  ratio: '1:1',
});
assert.equal(buf.toString(), 'IMG');
assert.equal(captured.config.imageConfig.imageSize, '2K');
assert.equal(captured.config.imageConfig.aspectRatio, '1:1');
const parts = captured.contents[0].parts;
assert.ok(parts[0].inlineData, 'reference photo goes first');
assert.equal(parts[parts.length - 1].text, 'PROMPT', 'prompt goes last');
rmSync(photoDir, { recursive: true, force: true });

// A response with no image is an error, not an undefined buffer.
const emptyGemini = { models: { generateContent: async () => ({ candidates: [{ content: { parts: [{ text: 'refused' }] } }] }) } };
await assert.rejects(
  () => renderVariation(emptyGemini, { prompt: 'P', photoPaths: [], ratio: '1:1' }),
  /no image/i
);

// ── The physical description reaches the renderer ──────────────────────────────────
//
// data/product-images/manifest.json describes the bottle precisely — "tall, slim lotion
// bottle shape, roughly 7-8 inches tall", "a black horizontal accent bar behind the
// variant name text" — and index.js used to mine that prose for label strings and then
// throw it away. The renderer was told exactly what the label SAYS and nothing about what
// the bottle IS, and it rendered a squat, wide bottle with a short disc cap and no accent
// bar. Every string on it was correct, so the text gate accepted it on attempt 1.
//
// The sister agent learned this first: PR #314, "faithful product renders (drop reference
// image, pass product descriptions)".
const physical = 'An 8 fl. oz. (236ml) white plastic cylindrical squeeze bottle, tall and slim, ' +
  'with a black flip-top cap and a black horizontal accent bar behind the variant name.';
const withPhysical = buildRenderPrompt({
  format: { key: 'x', layoutBrief: 'A brief.' },
  zones: { headline: 'HELLO' },
  product: { labelStrings: ['real SKIN CARE', '8 fl. oz. (236ml)'], physicalDescription: physical },
  brandKit: { palette_hexes: ['#000'] },
  mode: 'finished',
});
assert.ok(withPhysical.includes(physical), 'the render prompt must carry the physical description');
assert.ok(/PHYSICAL FORM/i.test(withPhysical), 'the physical description needs its own labelled block');

// A plate is the product on a clean background — the description matters MORE there.
const platePhysical = buildRenderPrompt({
  format: { key: 'x', layoutBrief: 'A brief.' },
  zones: {},
  product: { labelStrings: ['real SKIN CARE'], physicalDescription: physical },
  brandKit: { palette_hexes: ['#000'] },
  mode: 'plate',
});
assert.ok(platePhysical.includes(physical), 'a plate render must carry the physical description too');

// A product with no description on file still renders — the label strings alone are the
// pre-existing behaviour and must not start throwing.
const noPhysical = buildRenderPrompt({
  format: { key: 'x', layoutBrief: 'A brief.' },
  zones: { headline: 'HELLO' },
  product: { labelStrings: ['real SKIN CARE'] },
  brandKit: { palette_hexes: ['#000'] },
  mode: 'finished',
});
assert.ok(noPhysical.includes('real SKIN CARE'));
assert.ok(!/PHYSICAL FORM/i.test(noPhysical), 'no empty PHYSICAL FORM block when there is no description');

// ── The renderer is told about the safe zone, not just judged on it ──────────────────
//
// critique.js hard-fails a 9:16 frame whose copy sits under the Stories/Reels UI. On the
// first live run it did exactly that — correctly — three times in a row, because
// ingredient-callout's layoutBrief MANDATES a full-width bottom bar and nothing had told
// the renderer that the bottom fifth of a vertical frame is unusable. A check the layout
// cannot satisfy is not a gate, it is a $0.39 tax per attempt.
//
// Same lesson as the physical description: detection without prevention burns retries.
const verticalPrompt = buildRenderPrompt({
  format: { key: 'x', layoutBrief: 'A brief with a bottom bar.' },
  zones: { headline: 'HELLO' },
  product: { labelStrings: ['real SKIN CARE'] },
  brandKit: { palette_hexes: ['#000'] },
  mode: 'finished',
  ratio: '9:16',
});
assert.ok(/SAFE ZONE/i.test(verticalPrompt), 'a 9:16 render must be told about the platform safe zone');
assert.ok(/top one-seventh/i.test(verticalPrompt));
assert.ok(/bottom one-fifth/i.test(verticalPrompt));
// The background may fill the frame — it is only TEXT that must stay out of the bands.
assert.ok(/background/i.test(verticalPrompt));

// A square frame has no platform UI over it, so the instruction must not appear: it would
// shrink the usable area of every feed ad for no reason.
const squarePrompt = buildRenderPrompt({
  format: { key: 'x', layoutBrief: 'A brief with a bottom bar.' },
  zones: { headline: 'HELLO' },
  product: { labelStrings: ['real SKIN CARE'] },
  brandKit: { palette_hexes: ['#000'] },
  mode: 'finished',
  ratio: '1:1',
});
assert.ok(!/SAFE ZONE/i.test(squarePrompt), 'no safe-zone instruction on a ratio nothing overlays');

// A PLATE carries no copy to place, so the instruction is pointless there too.
const platePrompt = buildRenderPrompt({
  format: { key: 'x', layoutBrief: 'A brief.' },
  zones: {},
  product: { labelStrings: ['real SKIN CARE'] },
  brandKit: { palette_hexes: ['#000'] },
  mode: 'plate',
  ratio: '9:16',
});
assert.ok(!/SAFE ZONE/i.test(platePrompt), 'a text-free plate needs no safe-zone instruction');
