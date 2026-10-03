import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import { pickTextColour, bandLuminance, buildOverlayHtml, typesetTake } from '../../agents/ad-concepts/typeset.js';

const require = createRequire(import.meta.url);
const sharp = require('sharp');
const solid = (rgb, fmt = 'jpeg') => sharp({ create: { width: 800, height: 1000, channels: 3, background: rgb } })[fmt]().toBuffer();

test('colour flips on light vs dark bands', async () => {
  assert.equal(pickTextColour(200), '#000000');
  assert.equal(pickTextColour(40), '#FFFFFF');
  assert.ok(await bandLuminance(await solid({ r: 237, g: 229, b: 216 }), 'top') > 200);
  assert.ok(await bandLuminance(await solid({ r: 20, g: 20, b: 20 }), 'bottom') < 40);
});

test('the HTML carries the exact strings and the brand faces', () => {
  const html = buildOverlayHtml({ dataUrl: 'data:image/jpeg;base64,AA', width: 800, height: 1000, headline: "Your soap's ingredient list.", sub: 'Ours: one fat.', band: 'top', treatment: 'band', colour: '#000000', fontCss: '@font-face{}' });
  assert.match(html, /Your soap&#39;s ingredient list\.|Your soap's ingredient list\./);
  assert.match(html, /Ours: one fat\./);
  assert.match(html, /@font-face/);
});

test('renders at the take size, PNG or JPEG in, and shrinks a long headline instead of overflowing', { timeout: 60000 }, async () => {
  for (const fmt of ['jpeg', 'png']) {
    const r = await typesetTake({ buffer: await solid({ r: 237, g: 229, b: 216 }, fmt), headline: 'Your soap has a very long ingredient list', sub: 'Ours: one fat. Organic virgin coconut oil.', band: 'top' });
    const meta = await sharp(r.buffer).metadata();
    assert.equal(meta.width, 800);
    assert.equal(meta.height, 1000);
    assert.equal(r.overflow, false);
    assert.equal(r.colour, '#000000');
  }
});
