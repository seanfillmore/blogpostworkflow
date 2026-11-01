import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { verifyImage, fetchPdpBody, sniffImageMediaType } from '../../agents/ad-studio/index.js';

// sniffImageMediaType needs at least 12 bytes, so pad the JPEG signature.
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(12)]);
const format = { key: 'concept', plateSetting: 'scene', pairsImagesWithLabels: false };

function stubAnthropic(json, stop_reason = 'end_turn') {
  const calls = [];
  return {
    calls,
    messages: { create: async (req) => { calls.push(req); return { stop_reason, content: [{ type: 'text', text: JSON.stringify(json) }] }; } },
  };
}

test('verifies an arbitrary buffer and threads allowedSceneText', async () => {
  const anthropic = stubAnthropic({
    checks: [], productVolume: '', defects: [{ text: 'illegible printed lines', issue: 'stray-text' }],
    transcript: [], sceneInventory: [{ object: 'soap bar', kind: 'product-unit' }],
  });
  const strict = await verifyImage({ anthropic, buffer: JPEG, mediaType: sniffImageMediaType(JPEG), format, mode: 'plate' });
  assert.equal(strict.ok, false);
  const relaxed = await verifyImage({ anthropic, buffer: JPEG, mediaType: 'image/jpeg', format, mode: 'plate', allowedSceneText: 'illegible-print' });
  assert.equal(relaxed.ok, true);
  assert.match(anthropic.calls[1].messages[0].content.at(-1).text, /declared illegible print/);
});

test('a truncated verify response throws, never passes', async () => {
  const anthropic = stubAnthropic({}, 'max_tokens');
  await assert.rejects(() => verifyImage({ anthropic, buffer: JPEG, mediaType: 'image/jpeg', format }), /cut off/);
});

test('fetchPdpBody is exported', () => {
  assert.equal(typeof fetchPdpBody, 'function');
});
