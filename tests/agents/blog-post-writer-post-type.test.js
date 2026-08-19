// tests/agents/blog-post-writer-post-type.test.js
//
// agents/blog-post-writer/index.js calls main() at module scope, so it cannot be
// imported into a test process without kicking off a real writing run (and real spend).
// The behaviour under test — which CTA rules each search-intent type receives — is
// therefore asserted against the agent's source, the same way
// blog-post-writer-voc.test.js asserts its wiring.
//
// What this guards: the writer's CTA weighting is chosen from classifySearchIntent's
// return value, and its output flows calendar-runner → editor → publisher with no human
// in the loop. Before 2026-08-18 a soap-making SUPPLY query ("coconut oil soap base")
// classified as `product` and got the full buy-CTA treatment aimed at someone shopping
// for lye. The `supply` type fixed that, and these assertions stop a future intent type
// from quietly falling through to the product branch the same way.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SEARCH_INTENT_TYPES } from '../../lib/search-intent.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = readFileSync(join(ROOT, 'agents', 'blog-post-writer', 'index.js'), 'utf8');

test('every search-intent type has an explicit post-type label in the writer', () => {
  const block = /const POST_TYPE_LABELS = \{([\s\S]*?)\};/.exec(SRC);
  assert.ok(block, 'POST_TYPE_LABELS lookup not found');
  for (const type of SEARCH_INTENT_TYPES) {
    assert.match(block[1], new RegExp(`\\b${type}:`), `POST_TYPE_LABELS is missing "${type}"`);
  }
});

test('an unhandled post type throws instead of falling through to the product branch', () => {
  // The fallthrough IS the defect: an unknown type landing on the product branch is how
  // a non-buyer gets buy-CTAs.
  assert.match(SRC, /if \(!POST_TYPE_LABELS\[postType\]\) \{[\s\S]{0,240}throw new Error/);
});

test('supply posts are branched on explicitly and get no CTA block', () => {
  assert.match(SRC, /postType === 'supply' \? `/, 'no explicit supply branch in the POST TYPE section');
  assert.match(SRC, /DO NOT place any sales CTA block anywhere in this post/);
  assert.match(SRC, /3\. NO CTA BLOCK\./, 'supply structure still offers a CTA slot');
  // The shortcut framing is honest for a DIY reader and dishonest for a supply reader —
  // a finished bar does not substitute for the soap base they came to buy.
  assert.match(SRC, /DO NOT offer a finished product as a "shortcut"/);
});

test('supply posts still carry exactly one plain product link', () => {
  // The editor's checkCTAs() blocks a post with zero product/collection links, and the
  // Prime Directive wants every page to keep a purchase path. One inline sentence
  // satisfies both without spending the page on a buyer who is not there.
  assert.match(SRC, /EXACTLY ONE plain inline mention/);
  assert.match(SRC, /exactly ONE plain <p> sentence in the body/);
});

test('the user prompt does not name product CTA slots for non-product post types', () => {
  // The system prompt's supply rules would be contradicted — and a contradiction reads as
  // an instruction — if the closing line still said "start with the above-the-fold CTA".
  const closing = /Write the complete post now following the POST STRUCTURE from the system prompt exactly\. \$\{([\s\S]*?)\} Write no more than/.exec(SRC);
  assert.ok(closing, 'closing instruction is no longer post-type aware');
  assert.match(closing[1], /detectPostType\(brief\) === 'product'/);
  assert.match(closing[1], /Use exactly the CTA placement its POST TYPE section specifies/);
});

test('the missing-CTA warning knows a supply post is supposed to have none', () => {
  assert.match(SRC, /!hasCTA && detectPostType\(brief\) !== 'supply'/);
});
