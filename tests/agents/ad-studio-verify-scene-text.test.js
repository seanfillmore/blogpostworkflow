import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { buildVerifyPrompt, normalizeDefects, verdictFor, isIllegiblePrintReport, ALLOWED_SCENE_TEXT } from '../../agents/ad-studio/verify.js';

const format = { key: 'concept', plateSetting: 'scene', pairsImagesWithLabels: false };
const base = { expected: [], format, mode: 'plate', volumeStrings: [], physicalDescription: '', referenceCount: 0, unitCount: 1 };

test('off by default: prompt and defects are unchanged', () => {
  assert.equal(buildVerifyPrompt(base), buildVerifyPrompt({ ...base, allowedSceneText: null }));
  const d = [{ text: 'illegible printed lines', issue: 'stray-text' }];
  assert.deepEqual(normalizeDefects(d, 'plate'), normalizeDefects(d, 'plate', { allowedSceneText: null }));
  assert.equal(normalizeDefects(d, 'plate').length, 1, 'without the declaration, any reported text still fails');
});

test('declared illegible print: the prompt says so, descriptions pass, real characters fail', () => {
  assert.deepEqual([...ALLOWED_SCENE_TEXT], ['illegible-print']);
  const prompt = buildVerifyPrompt({ ...base, allowedSceneText: 'illegible-print' });
  assert.match(prompt, /declared illegible print/);
  const defects = [
    { text: 'illegible printed lines on the receipt paper', issue: 'stray-text' },
    { text: 'Orgarric Nacet 12.50', issue: 'stray-text' },
  ];
  const kept = normalizeDefects(defects, 'plate', { allowedSceneText: 'illegible-print' });
  assert.deepEqual(kept.map(k => k.text), ['Orgarric Nacet 12.50']);
  assert.equal(isIllegiblePrintReport('faint hairlines'), true);
  assert.equal(isIllegiblePrintReport('WEAK SOAP'), false);
});

test('verdictFor threads the option to the defect check', () => {
  const args = {
    expected: [], checks: [], format, mode: 'plate', sceneInventory: [{ object: 'soap bar', kind: 'product-unit' }],
    defects: [{ text: 'blurred lines of print', issue: 'stray-text' }],
  };
  assert.equal(verdictFor(args).ok, false);
  assert.equal(verdictFor({ ...args, allowedSceneText: 'illegible-print' }).ok, true);
});
