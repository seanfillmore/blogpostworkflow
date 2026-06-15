import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertHtmlComplete } from '../../lib/html-output-guards.js';

test('throws when the model stopped at max_tokens (truncated output)', () => {
  assert.throws(
    () => assertHtmlComplete({ html: '<p>fine</p>', stopReason: 'max_tokens' }),
    /max_tokens|truncat/i
  );
});

test('throws on an unclosed href attribute (truncated mid-link)', () => {
  assert.throws(
    () => assertHtmlComplete({ html: '<p>see <a href="https://x.com/best', stopReason: 'end_turn' }),
    /href/i
  );
});

test('passes for complete HTML that ended normally', () => {
  assert.doesNotThrow(() =>
    assertHtmlComplete({ html: '<p>see <a href="https://x.com/best">best</a></p>', stopReason: 'end_turn' })
  );
});

test('passes when stopReason is absent and HTML is well-formed', () => {
  assert.doesNotThrow(() => assertHtmlComplete({ html: '<p>hello</p>' }));
});
