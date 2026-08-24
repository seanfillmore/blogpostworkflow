// tests/theme/giveaway-referrer-typo.test.js
//
// theme/assets/giveaway.js is served by Shopify and has no build step, so it
// cannot import lib/giveaway/referrer-suggest.js — the provider list and the
// distance rule exist twice by necessity. This test is the thing that stops the
// two copies drifting.
//
// Drift here is not cosmetic. The form is the ONLY place a mistyped referrer can
// be corrected (Official Rules §5 makes the typed address the sole identifier of
// the referral, and §6 hangs a second $536.40 prize on it), so a theme copy that
// silently stops catching a provider the server knows about costs entrants real
// entries with nothing downstream able to recover them.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KNOWN_DOMAINS, suggestDomainTypo } from '../../lib/giveaway/referrer-suggest.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const themeJs = readFileSync(join(ROOT, 'theme', 'assets', 'giveaway.js'), 'utf8');

/** Pull the theme's KNOWN_DOMAINS array literal back out as real data. */
function themeDomains() {
  const m = themeJs.match(/var KNOWN_DOMAINS = \[([\s\S]*?)\];/);
  assert.ok(m, 'the theme must still declare a KNOWN_DOMAINS array');
  return m[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
}

test('the theme provider list matches the server module exactly', () => {
  assert.deepEqual(
    themeDomains(),
    KNOWN_DOMAINS,
    'theme/assets/giveaway.js and lib/giveaway/referrer-suggest.js must agree, in the same order',
  );
});

test('the theme still checks the known-good set BEFORE measuring distance', () => {
  // Order is the whole guard: mail.com is a real provider one edit from
  // gmail.com, so distance-first would tell every mail.com entrant they meant
  // gmail.com. Pinning the order in the source text is crude but it is what
  // catches a well-meaning reordering during a refactor.
  const guardAt = themeJs.indexOf("if (KNOWN_DOMAINS.indexOf(domain) !== -1) return null;");
  const distanceAt = themeJs.indexOf('editDistance(domain, KNOWN_DOMAINS[i])');
  assert.ok(guardAt > -1, 'the known-good short-circuit must still exist');
  assert.ok(distanceAt > -1, 'the distance loop must still exist');
  assert.ok(guardAt < distanceAt, 'the known-good check must run before the distance loop');
});

test('the theme still refuses to guess on a tie', () => {
  assert.match(themeJs, /if \(!best \|\| tied\) return null;/, 'a tie must not produce a suggestion');
});

test('the server module the theme mirrors behaves as the theme claims', () => {
  // A cheap cross-check that the shared rule is the one actually shipping: if
  // either side is edited, at least one of these two assertions moves.
  assert.equal(suggestDomainTypo('sara.jones@gmial.com'), 'sara.jones@gmail.com');
  assert.equal(suggestDomainTypo('someone@mail.com'), null);
});

test('the typo check is attached to BOTH address fields, not just the referrer', () => {
  // Measured 2026-08-24 across 1,102 real entrants: the protected referrer field
  // held ZERO domain typos, the unprotected entrant field held FIVE — all five
  // unconfirmed, because a confirmation email cannot reach an address that does
  // not exist. Same check, same file, one field wired and the other not.
  //
  // A mistyped entrant address is unrecoverable in the plainest way: that person
  // never confirms, is never credited, is never sold to, and is never told.
  assert.match(themeJs, /attachTypoCheck\(/, 'the shared helper must still exist');
  const wired = [...themeJs.matchAll(/attachTypoCheck\(\s*\n?\s*form\.querySelector\('(#[\w-]+)'/g)]
    .map((m) => m[1]);
  assert.deepEqual(wired.sort(), ['#gv-email', '#gv-ref'],
    'both the entrant email and the referrer field must be wired');
});

test('the entrant field has somewhere to render a suggestion', () => {
  // The JS resolves `.gv-email-fix` and silently does nothing when it is absent,
  // so deleting the element from the section disables the check with no error
  // anywhere — exactly the kind of silent unwiring this whole file guards.
  const section = readFileSync(
    new URL('../../theme/sections/giveaway-entry.liquid', import.meta.url), 'utf8');
  assert.match(section, /class="gv-ref-fix gv-email-fix"/,
    'the entrant email field needs its own suggestion target');
  assert.match(section, /class="gv-ref-fix gv-email-fix" hidden role="status"/,
    'and it must be announced, not merely drawn');
});
