// tests/lib/giveaway-confirm-template.test.js
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkConfirmTemplate } from '../../scripts/giveaway/build-confirm-flow.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const REAL = readFileSync(join(ROOT, 'data', 'giveaway', 'nurture', '00-confirm-request.html'), 'utf8');

test('the shipped confirmation template passes every gate', () => {
  assert.deepEqual(checkConfirmTemplate(REAL), []);
});

test('the shipped template writes gv_confirmed to a STATIC redirect', () => {
  // Pinned against the real file rather than a fixture: these two facts are what
  // lib/giveaway/reconcile.js and theme/sections/giveaway-confirmed.liquid are
  // both built around, and a copy edit is exactly how they would drift.
  const links = REAL.match(/\{%\s*update_property_link[^%]*%\}/g) || [];
  assert.ok(links.length >= 1, 'at least one confirmation link');
  for (const link of links) {
    assert.match(link, /'gv_confirmed'\s*'true'/, 'writes the property the reconciler reads');
    assert.match(link, /'https:\/\/www\.realskincare\.com\/pages\/giveaway-confirmed'/,
      'redirects to the confirmed page, statically');
  }
});

test('a template that lost its confirmation link is rejected', () => {
  // The failure this gate exists for: the email still renders and still sends,
  // and confirms nobody. Nothing else in the system would notice.
  const stripped = REAL.replace(/\{%\s*update_property_link[^%]*%\}/g, 'https://www.realskincare.com');
  const problems = checkConfirmTemplate(stripped);
  assert.ok(problems.some((p) => /cannot confirm anyone/.test(p)), problems.join('; '));
});

test('a link that sets the wrong property is rejected', () => {
  const wrong = REAL.replace(/'gv_confirmed'/g, "'gv_subscribed'");
  assert.ok(checkConfirmTemplate(wrong).some((p) => /does not set gv_confirmed/.test(p)));
});

test('a dynamic redirect is rejected — the tag does not interpolate', () => {
  const dynamic = REAL.replace(
    /'https:\/\/www\.realskincare\.com\/pages\/giveaway-confirmed'/,
    "'https://www.realskincare.com/pages/giveaway-confirmed?e={{ person.email }}'",
  );
  assert.ok(checkConfirmTemplate(dynamic).some((p) => /must be static/.test(p)));
});

test('the compliance lines are all required', () => {
  assert.ok(checkConfirmTemplate(REAL.replace(/\{%\s*unsubscribe\s*%\}/, '#'))
    .some((p) => /unsubscribe/.test(p)));
  assert.ok(checkConfirmTemplate(REAL.replace(/No purchase necessary/i, 'Buy now'))
    .some((p) => /No purchase necessary/.test(p)));
  assert.ok(checkConfirmTemplate(REAL.replace(/unsubscribing does not forfeit your entry/i, 'thanks'))
    .some((p) => /§12/.test(p)));
});
