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
