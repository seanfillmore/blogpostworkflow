import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// A SOURCE SCAN, not a behavioural test, for the same reason
// tests/agents/seo-copy-writers-gated.test.js is one: both agents call
// loadEnv() and process.exit() at module scope, so importing either RUNS it —
// live Shopify writes and paid API calls included.
//
// What it pins: the two agents that wrap anchors around existing article prose
// use the single guarded implementation, and neither has grown its own copy
// back. They carried byte-identical copies of an unguarded `injectLink` that
// rewrote text inside <script type="application/ld+json"> blocks, breaking the
// JSON on 58 of 183 live blog pages.

const INJECTORS = [
  'agents/internal-linker/index.js',
  'agents/collection-linker/index.js',
];

for (const rel of INJECTORS) {
  const src = readFileSync(join(ROOT, rel), 'utf8');

  test(`${rel} imports the shared guarded injector`, () => {
    assert.match(
      src,
      /import\s*\{[^}]*\binjectLink\b[^}]*\}\s*from\s*['"]\.\.\/\.\.\/lib\/internal-link-inject\.js['"]/,
      'must import injectLink from lib/internal-link-inject.js'
    );
  });

  test(`${rel} does not declare its own injectLink`, () => {
    assert.doesNotMatch(
      src,
      /(?:^|\n)\s*(?:export\s+)?(?:async\s+)?function\s+injectLink\s*\(/,
      'a second copy of the injector is a second copy that drifts'
    );
    assert.doesNotMatch(
      src,
      /(?:const|let|var)\s+injectLink\s*=/,
      'a second copy of the injector is a second copy that drifts'
    );
  });

  test(`${rel} keeps no fragment of the old unguarded regex`, () => {
    // The exact expression that landed anchors inside JSON-LD string values.
    assert.doesNotMatch(src, /\(\?<!<\[\^>\]\*\)/,
      'the `(?<!<[^>]*)` lookbehind was never a substitute for a parse');
    // The 300-character backwards scan that stood in for knowing the context.
    assert.doesNotMatch(src, /lastIndexOf\(['"]<\/a>['"]\)/,
      'the fixed-window lookback missed any enclosing tag further back than 300 chars');
  });
}

test('the guarded injector is the only thing that builds a link anchor', () => {
  // If a third caller appears it must come through the library, not paste the
  // markup template again.
  const template = /<a href="\$\{[^}]*\}" title="/;
  for (const rel of INJECTORS) {
    const src = readFileSync(join(ROOT, rel), 'utf8');
    assert.doesNotMatch(src, template, `${rel} must not build anchor markup itself`);
  }
});
