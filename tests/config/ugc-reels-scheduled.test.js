// Every scheduled ad Reel in config/ugc-reels.json must be postable as written:
// a caption that clears the commercial claim gate and the Reels caption rules,
// a public https video url, and a parseable not_before. The agent re-checks the
// caption at run time; this catches a bad entry before it ever reaches the box.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkSeoCopyFields } from '../../lib/seo-copy-health-gate.js';
import { captionFormatCheck } from '../../lib/ugc-reels.js';

const config = JSON.parse(readFileSync(new URL('../../config/ugc-reels.json', import.meta.url), 'utf8'));

test('scheduled Reels are well formed and their captions pass every gate', () => {
  const ids = new Set();
  for (const item of config.scheduled || []) {
    assert.ok(item.id && !ids.has(item.id), `duplicate or missing id ${item.id}`);
    ids.add(item.id);
    assert.ok(Number.isFinite(Date.parse(item.not_before)), `${item.id}: not_before`);
    assert.match(item.video_url, /^https:\/\/cdn\.shopify\.com\//, `${item.id}: video_url`);
    assert.ok(item.product_key, `${item.id}: product_key`);
    const gate = checkSeoCopyFields({ caption: item.caption });
    assert.deepEqual(gate.blocking, [], `${item.id}: claim gate`);
    const fmt = captionFormatCheck({ transcript: '' }).check({ caption: item.caption }).filter((h) => !/quotes words/.test(h.why));
    assert.deepEqual(fmt, [], `${item.id}: caption rules`);
    assert.doesNotMatch(item.caption, /antiperspirant/i);
  }
});
