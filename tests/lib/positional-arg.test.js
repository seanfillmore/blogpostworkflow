import { test } from 'node:test';
import assert from 'node:assert/strict';
import { positionalArg } from '../../lib/positional-arg.js';

const VALUE_FLAGS = ['--limit'];

// ── the production failure ────────────────────────────────────────────────────
test('does NOT return a value-flag\'s value as the positional (the 4-month bug)', () => {
  // scheduler.js runs: node agents/blog-post-verifier/index.js --limit 10
  // The old `args.find(a => !a.startsWith('--'))` returned '10' and the agent
  // died with "No article found matching slug: 10" on every run since 2026-04-12.
  assert.equal(positionalArg(['--limit', '10'], VALUE_FLAGS), undefined);
});

test('returns a real slug when one is given', () => {
  assert.equal(positionalArg(['best-soap-for-tattoos'], VALUE_FLAGS), 'best-soap-for-tattoos');
});

test('returns the slug when it follows a value flag and its value', () => {
  assert.equal(positionalArg(['--limit', '10', 'my-slug'], VALUE_FLAGS), 'my-slug');
});

test('returns the slug when it precedes the flags', () => {
  assert.equal(positionalArg(['my-slug', '--limit', '10'], VALUE_FLAGS), 'my-slug');
});

test('boolean flags consume no value', () => {
  assert.equal(positionalArg(['--apply', 'my-slug'], VALUE_FLAGS), 'my-slug');
  assert.equal(positionalArg(['--apply', '--dry-run'], VALUE_FLAGS), undefined);
});

test('--flag=value carries its value inline and consumes no extra token', () => {
  assert.equal(positionalArg(['--limit=10', 'my-slug'], VALUE_FLAGS), 'my-slug');
});

test('a path is returned as-is (slug normalization is the caller\'s job)', () => {
  assert.equal(
    positionalArg(['data/posts/x/meta.json'], VALUE_FLAGS),
    'data/posts/x/meta.json',
  );
});

test('empty and junk input', () => {
  assert.equal(positionalArg([], VALUE_FLAGS), undefined);
  assert.equal(positionalArg(undefined, VALUE_FLAGS), undefined);
  assert.equal(positionalArg([null, 'slug'], VALUE_FLAGS), 'slug');
});

test('with no value-flags declared, a flag value IS treated as positional', () => {
  // Documents the contract: the caller must declare which flags take values.
  assert.equal(positionalArg(['--limit', '10']), '10');
});
