import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { buildOcclusionPrompt, parseOcclusionResponse, checkOcclusion } from '../../agents/ad-concepts/occlusion.js';

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]);
const reply = (text, stop = 'end_turn') => ({ stop_reason: stop, content: [{ type: 'text', text }] });

test('prompt names the product, the band and both failure modes', () => {
  const p = buildOcclusionPrompt({ productDescription: 'A round paper-wrapped soap bar with a tea tree label.', band: 'top' });
  assert.match(p, /round paper-wrapped soap bar/);
  assert.match(p, /top quarter/);
  assert.match(p, /covered/i);
  assert.match(p, /edge of the frame/i);
  assert.match(buildOcclusionPrompt({ productDescription: 'x', band: 'bottom' }), /bottom quarter/);
});

test('parse: ok only when visible, uncovered and not cut off', () => {
  assert.deepEqual(parseOcclusionResponse('{"productVisible":true,"productCovered":false,"productCutOffByFrame":false,"detail":""}'), { ok: true, detail: '' });
  const covered = parseOcclusionResponse('sure {"productVisible":true,"productCovered":true,"productCutOffByFrame":false,"detail":"the caption strip covers the top of the bar and clips the logo"}');
  assert.equal(covered.ok, false);
  assert.match(covered.detail, /clips the logo/);
  assert.equal(parseOcclusionResponse('{"productVisible":true,"productCovered":false,"productCutOffByFrame":true,"detail":"cut"}').ok, false);
  assert.equal(parseOcclusionResponse('{"productVisible":false,"productCovered":false,"productCutOffByFrame":false}').ok, false);
});

test('parse fails CLOSED: unparseable or non-boolean answers are not ok', () => {
  assert.equal(parseOcclusionResponse('looks fine to me').ok, false);
  assert.match(parseOcclusionResponse('looks fine to me').detail, /unparseable/);
  assert.equal(parseOcclusionResponse('{"productVisible":"yes","productCovered":"no","productCutOffByFrame":"no"}').ok, false);
  assert.equal(parseOcclusionResponse('').ok, false);
});

test('checkOcclusion sends the image and the prompt, and parses the verdict', async () => {
  const calls = [];
  const anthropic = { messages: { create: async (req) => { calls.push(req); return reply('{"productVisible":true,"productCovered":true,"productCutOffByFrame":false,"detail":"strip over the lid"}'); } } };
  const r = await checkOcclusion({ anthropic, model: 'v', buffer: JPEG, mediaType: 'image/jpeg', productDescription: 'a bar', band: 'top' });
  assert.equal(r.ok, false);
  assert.match(r.detail, /strip over the lid/);
  const content = calls[0].messages[0].content;
  assert.equal(calls[0].model, 'v');
  assert.equal(content[0].type, 'image');
  assert.equal(content[0].source.media_type, 'image/jpeg');
  assert.equal(content[0].source.data, JPEG.toString('base64'));
  assert.match(content[1].text, /a bar/);
});

test('checkOcclusion throws on a cut-off reply', async () => {
  const anthropic = { messages: { create: async () => reply('{"productVis', 'max_tokens') } };
  await assert.rejects(checkOcclusion({ anthropic, model: 'v', buffer: JPEG, mediaType: 'image/jpeg', productDescription: 'a bar', band: 'top' }), /cut off/);
});

test('with layout regions, the prompt names where the type sits instead of a quarter band', () => {
  const p = buildOcclusionPrompt({
    productDescription: 'A white squeeze bottle.',
    regions: [{ name: 'headline', x: 40, y: 56, w: 1000, h: 118 }, { name: 'band', x: 0, y: 976, w: 1080, h: 104 }],
    size: { width: 1080, height: 1080 },
  });
  assert.match(p, /headline: left 4%, top 5%, 93% wide, 11% tall/);
  assert.match(p, /band: left 0%, top 90%, 100% wide, 10% tall/);
  assert.doesNotMatch(p, /quarter/);
  assert.match(p, /covered/i);
});

test('with no regions at all (a photo with nothing set on it) the prompt says so', () => {
  const p = buildOcclusionPrompt({ productDescription: 'x', regions: [], size: { width: 1080, height: 1080 } });
  assert.match(p, /No overlay type/);
});
