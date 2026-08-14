import { strict as assert } from 'node:assert';
import { CREATIVE_MODELS } from '../../config/creative-models.js';
import { GEMINI_MODELS } from '../../agents/dashboard/lib/creatives-store.js';

// Ad Studio block exists and uses the GA Pro image model.
assert.ok(CREATIVE_MODELS.adStudio, 'adStudio block must exist');
assert.equal(CREATIVE_MODELS.adStudio.imageGen, 'gemini-3-pro-image');
assert.ok(CREATIVE_MODELS.adStudio.copy.includes('opus'), 'copy must stay on the flagship');
assert.ok(CREATIVE_MODELS.adStudio.verify.includes('haiku'), 'verify is a short vision task');
assert.ok(CREATIVE_MODELS.adStudio.angle.includes('opus'), 'angle selection stays on the flagship');

// No preview IDs anywhere in the model config or the dashboard picker.
assert.ok(
  !JSON.stringify(CREATIVE_MODELS).includes('-preview'),
  'creative-models must not reference preview model IDs'
);
for (const m of GEMINI_MODELS) {
  assert.ok(!m.id.endsWith('-preview'), `GEMINI_MODELS entry ${m.id} must not be a preview ID`);
}

// The GA Pro model must be offered by the dashboard picker.
assert.ok(
  GEMINI_MODELS.some(m => m.id === 'gemini-3-pro-image'),
  'dashboard picker must offer gemini-3-pro-image'
);
