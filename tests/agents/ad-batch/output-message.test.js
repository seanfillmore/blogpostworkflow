// tests/agents/ad-batch/output-message.test.js
//
// ad-batch files each batch under a MESSAGE folder of the RSC creatives library
// (Drive "Real Skin Care/Creatives/01 Static Ads", Sean 2026-10-26). The cases are
// the real headlines of the batches filed by hand on that day, so the tool files a
// new batch where the library already keeps that message.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  messageFolder, MESSAGES, UNSORTED_MESSAGE, defaultOutRoot, CREATIVES_STATIC_ROOT, DESKTOP_OUT_ROOT,
} from '../../../agents/ad-batch/output.js';

const CASES = [
  ["Scariest thing in your house? Your lotion's ingredient list.", 'Halloween - Scariest Thing in Your House'],
  ["Grandma's cream. 7 ingredients.", "Grandma's Recipe"],
  ["Your grandma used real cream.", "Grandma's Recipe"],
  ['Skin that reacts to everything?', 'Sensitive Skin'],
  ['Tired of gambling on lotion?', 'Sensitive Skin'],
  ['Foam on the mirror, the faucet and my shirt. Every single morning.', 'Toothpaste - SLS-Free & Gentle'],
  ["The minty burn isn't clean. It's just loud.", 'Toothpaste - SLS-Free & Gentle', 'Coconut Oil Toothpaste'],
  ['Deep moisture. Zero junk.', 'Short Ingredient List'],
  ['You can read the whole label.', 'Short Ingredient List'],
  ['6 ingredients. 7 ingredients. Nothing else.', 'Short Ingredient List'],
  ["Tight, flaky skin after a shower isn't aging.", 'Dry Skin Pain Points'],
  ['Cracked knuckles, white shins and a lotion habit.', 'Dry Skin Pain Points'],
  ["Your lotion smells great. Your skin is still thirsty.", 'Dry Skin Pain Points'],
];

test('real headlines file under the message folder the library keeps them in', () => {
  for (const [headline, want, productTitle] of CASES) {
    assert.equal(messageFolder({ headlines: [headline], productTitle }), want, headline);
  }
});

test('an explicit batch message wins, matched case-insensitively, but only for a known folder', () => {
  assert.equal(messageFolder({ message: 'dry skin pain points', headlines: ['Deep moisture. Zero junk.'] }), 'Dry Skin Pain Points');
  assert.equal(messageFolder({ message: 'Product & Scent Spotlight' }), 'Product & Scent Spotlight');
  // A typo never invents a new folder: it falls through to the rules.
  assert.equal(messageFolder({ message: 'Dry Skin Pain Pionts', headlines: ['Deep moisture. Zero junk.'] }), 'Short Ingredient List');
});

test('an unrecognised headline goes to the to-sort folder, never a guess', () => {
  assert.equal(messageFolder({ headlines: ['Meet the new jar.'] }), UNSORTED_MESSAGE);
  assert.ok(!MESSAGES.includes(UNSORTED_MESSAGE));
});

test('the first recognised headline decides a mixed batch', () => {
  assert.equal(messageFolder({ headlines: ['Meet the new jar.', 'Skin that reacts to everything?', 'Deep moisture. Zero junk.'] }), 'Sensitive Skin');
});

test('default output is the Drive library when present, else the Desktop folder', () => {
  const saved = process.env.AD_BATCH_OUT;
  delete process.env.AD_BATCH_OUT;
  try {
    assert.equal(defaultOutRoot(() => true), CREATIVES_STATIC_ROOT);
    assert.equal(defaultOutRoot(() => false), DESKTOP_OUT_ROOT);
    assert.ok(CREATIVES_STATIC_ROOT.endsWith('Real Skin Care/Creatives/01 Static Ads'));
    process.env.AD_BATCH_OUT = '/tmp/x';
    assert.equal(defaultOutRoot(() => true), '/tmp/x');
  } finally {
    if (saved === undefined) delete process.env.AD_BATCH_OUT; else process.env.AD_BATCH_OUT = saved;
  }
});
