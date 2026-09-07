import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { globSync } from 'node:fs';
import { topLevelLiveCalls, isGuarded, importedScripts, unsafeImports } from '../../lib/script-import-safety.js';

const ROOT = join(import.meta.dirname, '..', '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const files = (pat) => globSync(pat, { cwd: ROOT });

test('depth: a call inside a block does NOT run on import', () => {
  // The first version of this check was a line-anchored regex. It reported 61
  // files and had to retract three, because it could not tell module scope
  // from a function body — all three imported in ~10ms.
  assert.equal(topLevelLiveCalls('async function go() {\n  const t = await getAccessToken();\n}\n').length, 0);
  assert.equal(topLevelLiveCalls('if (isDirectRun(x)) {\n  const b = await getBlogs();\n}\n').length, 0);
  assert.equal(topLevelLiveCalls('const t = await getAccessToken();\n').length, 1);
});

test('depth: a brace inside a string or comment must not skew the rest of the file', () => {
  // Otherwise one stray brace silently turns every later finding into noise.
  const src = [
    'const s = "an unclosed { brace";',
    '// another } here',
    'const t = await getAccessToken();',
  ].join('\n');
  assert.equal(topLevelLiveCalls(src).length, 1, 'still sees the real top-level call');
});

test('importedScripts counts a real specifier, never a mention in prose', () => {
  const map = importedScripts({
    'tests/a.test.js': "import { x } from '../../scripts/real.mjs';",
    'lib/b.js': '// see scripts/mentioned-only.mjs for the rationale',
  });
  assert.deepEqual([...map.keys()], ['scripts/real.mjs']);
});

test('NO script that something imports may run on import', () => {
  // THE conjunction. A script nobody imports runs when you run it — that is
  // what a script is. The hazard is a module a TEST pulls in, which is how
  // sync-subscription-copy.mjs came to call live Recurpay on every test run.
  const consumers = Object.fromEntries(
    [...files('tests/**/*.js'), ...files('lib/*.js'), ...files('agents/**/*.js'), ...files('scripts/*.mjs'), ...files('scripts/*.js')]
      .map((p) => [p, read(p)]),
  );
  const scriptSources = Object.fromEntries(
    [...files('scripts/*.mjs'), ...files('scripts/*.js')].map((p) => [p, read(p)]),
  );
  const bad = unsafeImports(importedScripts(consumers), scriptSources);
  const detail = bad.map((b) => `\n  ${b.script}\n    imported by: ${b.importers.join(', ')}\n    runs on import: ${b.hits.map((h) => `L${h.line} ${h.text}`).join('; ')}`).join('');
  assert.deepEqual(bad.map((b) => b.script), [],
    `Guard these with isDirectRun(import.meta.url), or stop importing them:${detail}`);
});

test('the five LATENT ones are named, so writing a test against one is not a surprise', () => {
  // Not guarded, because a guard that wrongly reads "imported" makes a script a
  // silent no-op that still exits 0 — strictly worse than the hazard, the same
  // argument lib/is-direct-run.js makes. They are simply not imported today,
  // and the test above turns the first import into a failure.
  const LATENT = [
    'scripts/build-variant-value-stacks.mjs',
    'scripts/check-content-mirrors.mjs',
    'scripts/fix-bar-soap-subscription.mjs',   // holds MUTATIONS — the expensive one
    'scripts/reconcile-content-mirrors.mjs',
    'scripts/upload-post.js',
  ];
  for (const p of LATENT) {
    const src = read(p);
    // Each is genuinely in this state today: unguarded with a top-level call.
    // If one gains a guard that is an improvement, not a failure — so assert
    // only the property that matters, that nothing imports it.
    if (isGuarded(src)) continue;
    assert.ok(topLevelLiveCalls(src).length > 0, `${p} no longer runs on import — drop it from LATENT`);
  }
});
