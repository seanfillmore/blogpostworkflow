import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guardVerdict, FILES, PAGE, LIVE_BASE_REF, headContainsBase, assertHeadContainsBase } from '../../scripts/presell/publish-cream-presell.mjs';

test('new file: absent → write, equal → already, anything else → refuse', () => {
  assert.equal(guardVerdict({ current: undefined, before: null, target: 'N' }), 'write');
  assert.equal(guardVerdict({ current: 'N', before: null, target: 'N' }), 'already');
  assert.equal(guardVerdict({ current: 'X', before: null, target: 'N' }), 'refuse');
});

test('existing file: only the known before (or the new content) may be overwritten', () => {
  assert.equal(guardVerdict({ current: 'B', before: 'B', target: 'N' }), 'write');
  assert.equal(guardVerdict({ current: 'N', before: 'B', target: 'N' }), 'already');
  assert.equal(guardVerdict({ current: 'B2', before: 'B', target: 'N' }), 'refuse');
  assert.equal(guardVerdict({ current: undefined, before: 'B', target: 'N' }), 'refuse');
});

test('ships exactly the four pre-sell files over their origin/main versions, never the product template', () => {
  assert.deepEqual(FILES.map((f) => f.key).sort(), [
    'assets/presell-buy.js', 'assets/presell.css', 'sections/presell-listicle.liquid',
    'templates/page.presell-cream.json',
  ]);
  // Each file is live now, so its expected "before" is the version merged in PR #1087.
  for (const f of FILES) assert.equal(f.before, LIVE_BASE_REF, f.key);
  assert.ok(!FILES.some((f) => f.key.includes('product.landing-page-cream')));
  assert.equal(PAGE.template_suffix, 'presell-cream');
  assert.equal(PAGE.handle, 'coconut-body-cream');
});

test('an earlier branch version may be overwritten (redeploying a fix); an unknown one may not', () => {
  assert.equal(guardVerdict({ current: 'V1', before: null, target: 'V2', prior: ['V1'] }), 'write');
  assert.equal(guardVerdict({ current: 'X', before: 'B', target: 'V2', prior: ['V1'] }), 'refuse');
});

test('the guard refuses unless HEAD contains origin/main (a stale branch cannot overwrite newer live files)', () => {
  const calls = [];
  const ancestor = (args) => { calls.push(args); };
  const notAncestor = () => { const e = new Error('exit 1'); e.status = 1; throw e; };
  assert.equal(headContainsBase(ancestor), true);
  assert.deepEqual(calls[0], ['merge-base', '--is-ancestor', LIVE_BASE_REF, 'HEAD']);
  assert.equal(headContainsBase(notAncestor), false);
  assert.throws(() => assertHeadContainsBase(notAncestor), /does not contain origin\/main/);
  assert.doesNotThrow(() => assertHeadContainsBase(ancestor));
  // This branch is built on main, so the real check passes here.
  assert.equal(headContainsBase(), true);
});
