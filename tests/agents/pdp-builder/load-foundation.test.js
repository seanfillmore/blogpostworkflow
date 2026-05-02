// tests/agents/pdp-builder/load-foundation.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadFoundation } from '../../../agents/pdp-builder/lib/load-foundation.js';

const REPO_ROOT = process.cwd();

test('loadFoundation: returns object with all required keys when files present', () => {
  const f = loadFoundation({ root: REPO_ROOT });
  assert.equal(typeof f.voice, 'string', 'voice is a string');
  assert.ok(f.voice.length > 0, 'voice is non-empty');
  assert.equal(typeof f.clusterPOVs, 'string', 'clusterPOVs is a string');
  assert.equal(typeof f.comparisonFramework, 'string', 'comparisonFramework is a string');
  assert.equal(typeof f.founderNarrative, 'string', 'founderNarrative is a string');
  assert.equal(typeof f.ingredientStories, 'object', 'ingredientStories is an object');
  assert.ok(f.ingredientStories.organic_virgin_coconut_oil, 'has known stub ingredient key');
  assert.equal(typeof f.ingredientsByCluster, 'object', 'ingredientsByCluster is an object');
  assert.ok(f.ingredientsByCluster.toothpaste, 'has toothpaste cluster from config/ingredients.json');
});

test('loadFoundation: throws when data/brand/voice-and-pov.md missing', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'pdp-foundation-'));
  // Set up a fake repo root with everything EXCEPT voice-and-pov.md
  mkdirSync(join(tmp, 'data', 'brand'), { recursive: true });
  mkdirSync(join(tmp, 'config'), { recursive: true });
  writeFileSync(join(tmp, 'data', 'brand', 'cluster-povs.md'), 'stub');
  writeFileSync(join(tmp, 'data', 'brand', 'ingredient-stories.json'), '{}');
  writeFileSync(join(tmp, 'data', 'brand', 'comparison-framework.md'), 'stub');
  writeFileSync(join(tmp, 'data', 'brand', 'founder-narrative.md'), 'stub');
  copyFileSync(join(REPO_ROOT, 'config', 'ingredients.json'), join(tmp, 'config', 'ingredients.json'));

  assert.throws(
    () => loadFoundation({ root: tmp }),
    /voice-and-pov\.md/,
    'throws referencing the missing file'
  );

  rmSync(tmp, { recursive: true, force: true });
});

test('loadFoundation: throws when ingredient-stories.json is malformed JSON', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'pdp-foundation-'));
  mkdirSync(join(tmp, 'data', 'brand'), { recursive: true });
  mkdirSync(join(tmp, 'config'), { recursive: true });
  writeFileSync(join(tmp, 'data', 'brand', 'voice-and-pov.md'), 'stub');
  writeFileSync(join(tmp, 'data', 'brand', 'cluster-povs.md'), 'stub');
  writeFileSync(join(tmp, 'data', 'brand', 'ingredient-stories.json'), '{ this is not json }');
  writeFileSync(join(tmp, 'data', 'brand', 'comparison-framework.md'), 'stub');
  writeFileSync(join(tmp, 'data', 'brand', 'founder-narrative.md'), 'stub');
  copyFileSync(join(REPO_ROOT, 'config', 'ingredients.json'), join(tmp, 'config', 'ingredients.json'));

  assert.throws(
    () => loadFoundation({ root: tmp }),
    /ingredient-stories\.json/,
    'throws referencing the malformed file'
  );

  rmSync(tmp, { recursive: true, force: true });
});
