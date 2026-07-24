// tests/config/creative-models.test.js
import { strict as assert } from 'node:assert';
import { CREATIVE_MODELS } from '../../config/creative-models.js';

assert.equal(CREATIVE_MODELS.adCopy, 'claude-opus-4-8', 'ad copy uses the flagship');
assert.equal(CREATIVE_MODELS.styleBrief, 'claude-haiku-4-5');
assert.equal(CREATIVE_MODELS.templateVision, 'claude-haiku-4-5');
assert.equal(CREATIVE_MODELS.sessionName, 'claude-haiku-4-5');
assert.equal(CREATIVE_MODELS.imageGen, 'gemini-2.5-flash-image');

console.log('✓ creative-models config tests pass');
