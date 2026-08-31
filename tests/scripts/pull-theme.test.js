import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, mirroredKeys, locallyModifiedKeys } from '../../scripts/pull-theme.mjs';

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
  mkdirSync(join(dir, 'blocks'), { recursive: true });
  writeFileSync(join(dir, 'blocks', 'b.liquid'), 'x');
  // blocks/ is inlined into custom_liquid template blocks, not uploaded as assets.
  assert.ok(!mirroredKeys(dir).some((k) => k.startsWith('blocks/')), 'blocks/ is excluded');
});

test('a file with uncommitted local changes is HELD, not overwritten', () => {
  // This tool destroyed two lander edits on 2026-08-31 by silently re-pulling
  // them from live. Committed files are recoverable from git; uncommitted ones
  // are not, which is where the line is drawn.
  const fakeGit = () => ({
    status: 0,
    stdout: ' M theme/templates/product.bundle-landing.json\n?? theme/snippets/new.liquid\n M other/thing.js\n',
  });
  const held = locallyModifiedKeys('/repo', fakeGit);
  assert.ok(held.has('templates/product.bundle-landing.json'), 'modified file is held');
  assert.ok(held.has('snippets/new.liquid'), 'untracked file is held too');
  assert.ok(!held.has('thing.js'), 'paths outside theme/ are ignored');
});

test('a rename line yields the NEW path, not "old -> new"', () => {
  const fakeGit = () => ({ status: 0, stdout: 'R  theme/sections/a.liquid -> theme/sections/b.liquid\n' });
  const held = locallyModifiedKeys('/repo', fakeGit);
  assert.ok(held.has('sections/b.liquid'), `got ${[...held].join(',')}`);
});

test('when git cannot answer, nothing is held rather than everything', () => {
  // Failing closed here would make the puller useless outside a git checkout.
  // The guard protects against an accident, it is not a security boundary.
  assert.equal(locallyModifiedKeys('/repo', () => ({ status: 128, stdout: '' })).size, 0);
});

test('--force is parsed, so discarding local edits stays deliberate', () => {
  assert.equal(parseArgs(['--force']).force, true);
  assert.equal(parseArgs([]).force, false);
});
