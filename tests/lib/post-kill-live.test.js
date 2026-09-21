import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isArticleLive } from '../../lib/post-kill-live.js';

const NOW = new Date('2026-09-21T16:00:00Z');

test('unknown publish state is LIVE — the 2026-09-21 deleted-without-redirect case', () => {
  assert.equal(isArticleLive(null, false, NOW), true);
  assert.equal(isArticleLive(undefined, false, NOW), true);
});

test('known states decide normally', () => {
  assert.equal(isArticleLive('2024-04-22T17:26:52-06:00', true, NOW), true);
  assert.equal(isArticleLive(null, true, NOW), false, 'Shopify said draft');
  assert.equal(isArticleLive('2027-01-01T00:00:00Z', true, NOW), false, 'scheduled');
  assert.equal(isArticleLive('garbage', true, NOW), true, 'unparseable counts as live');
});

test('killPost asks Shopify when local meta records no publish date, and uses the shared rule', () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../lib/post-kill.js'), 'utf8');
  assert.match(src, /if \(!publishStateKnown\)[\s\S]*findArticleByHandle\(article\.handle\)/);
  assert.match(src, /const isLive = isArticleLive\(article\.published_at, publishStateKnown\)/);
});
