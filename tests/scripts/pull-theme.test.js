import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, mirroredKeys } from '../../scripts/pull-theme.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = readFileSync(join(ROOT, 'scripts', 'pull-theme.mjs'), 'utf8');

// This exists because the repo had four scripts that PUSH to a theme and none
// that pull, so the only way to try a change was to make it on the live theme.

test('the puller can never upload', () => {
  // The whole point of the script. Asserted against code, not the header prose,
  // which discusses uploading in order to say it never does.
  const code = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/updateThemeAsset|putThemeAsset/.test(code), 'must not import or call a theme writer');
  assert.ok(/getThemeAsset|listThemeAssets|getThemes/.test(code), 'reads only');
});

test('parseArgs collects keys and rejects an unknown flag', () => {
  const a = parseArgs(['--key', 'templates/product.bundle-landing.json', '--theme', '123']);
  assert.deepEqual(a.keys, ['templates/product.bundle-landing.json']);
  assert.equal(a.theme, '123');
  assert.equal(a.all, false);
  assert.throws(() => parseArgs(['--apply']), /unknown argument/);
});

test('mirroredKeys returns Shopify asset keys, not filesystem paths', () => {
  const dir = mkdtempSync(join(tmpdir(), 'theme-'));
  mkdirSync(join(dir, 'sections'), { recursive: true });
  mkdirSync(join(dir, 'rum'), { recursive: true });
  writeFileSync(join(dir, 'sections', 'a.liquid'), 'x');
  writeFileSync(join(dir, '.theme-source.json'), '{}');
  writeFileSync(join(dir, 'rum', 'reporter.js'), 'x');

  const keys = mirroredKeys(dir);
  assert.ok(keys.includes('sections/a.liquid'), 'nested files become slash-joined keys');
  assert.ok(!keys.some((k) => k.startsWith('.')), 'dotfiles are not assets');
  // theme/rum/ is authored source for an asset uploaded under a different key,
  // so re-pulling it would either 404 or overwrite the source with the build.
  assert.ok(!keys.some((k) => k.startsWith('rum/')), 'rum/ is excluded');
});
