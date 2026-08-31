import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { resolveLiveTemplate } from '../../lib/klaviyo-flow-templates.js';

// An injected index keeps this test off the network. The resolver's whole job is the
// NAME -> current-template mapping and the rotation verdict; the walk that builds the
// index is I/O and is exercised against the live account by hand.
const index = new Map([
  ['Winback — 01 We Miss You', { templateId: 'StwFGY', flowId: 'Yb63w6', flowName: 'Winback', messageId: 'QUKf8L' }],
  ['Welcome — 02 Brand Story', { templateId: 'TzuGfG', flowId: 'UUa3Qk', flowName: 'Welcome', messageId: 'M2' }],
]);

test('resolves by name and reports a rotation when the live id has moved', async () => {
  // The real 2026-08-31 case: the spec is filed under SHb8Df, Klaviyo now sends StwFGY.
  const r = await resolveLiveTemplate({ specId: 'SHb8Df', name: 'Winback — 01 We Miss You', index });
  assert.equal(r.templateId, 'StwFGY');
  assert.equal(r.rotated, true);
});

test('an unrotated id resolves to itself and is not flagged', async () => {
  const r = await resolveLiveTemplate({ specId: 'TzuGfG', name: 'Welcome — 02 Brand Story', index });
  assert.equal(r.templateId, 'TzuGfG');
  assert.equal(r.rotated, false);
});

test('a name with no live flow email is a REASON, never a fallback to the spec key', async () => {
  // Falling back to the spec id is what made the old check fetch a dead template,
  // get a 404, and report PASS anyway. The caller must be told it could not resolve.
  const r = await resolveLiveTemplate({ specId: 'RiMM8C', name: 'Post-Purchase — 99 Does Not Exist', index });
  assert.equal(r.templateId, null);
  assert.match(r.reason, /no live flow email named/);
});
