// tests/lib/giveaway-referrer-suggest.test.js
//
// The prevention half of the referral work. Official Rules §5 makes the address
// TYPED INTO THE FORM the sole identifier of a referral, and §6 hangs a second
// $536.40 prize on it, so a typo cannot be repaired afterwards — see
// lib/giveaway/referral-audit.js. The only place a wrong address can be fixed is
// before it is submitted, which is what this module serves.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { suggestDomainTypo, KNOWN_DOMAINS } from '../../lib/giveaway/referrer-suggest.js';

test('the common gmail typo is corrected with no lookup of any kind', () => {
  // Zero enumeration exposure: this layer never consults the entrant list, so it
  // cannot leak whether a given address entered the giveaway.
  assert.equal(suggestDomainTypo('sara.jones@gmial.com'), 'sara.jones@gmail.com');
});

test('several real-world provider typos are corrected', () => {
  const cases = [
    ['a@gmai.com', 'a@gmail.com'],
    ['a@gmail.co', 'a@gmail.com'],
    ['a@hotmial.com', 'a@hotmail.com'],
    ['a@yaho.com', 'a@yahoo.com'],
    ['a@outlok.com', 'a@outlook.com'],
  ];
  for (const [typed, expected] of cases) {
    assert.equal(suggestDomainTypo(typed), expected, `${typed} should suggest ${expected}`);
  }
});

test('an address that is ALREADY on a known provider is never second-guessed', () => {
  for (const domain of KNOWN_DOMAINS) {
    assert.equal(suggestDomainTypo(`someone@${domain}`), null, `${domain} is real and must be left alone`);
  }
});

test('REGRESSION: mail.com is a real provider one edit from gmail.com and must survive', () => {
  // The whole reason the known-good set is consulted BEFORE distance: without
  // it, every mail.com entrant would be told they meant gmail.com.
  assert.equal(suggestDomainTypo('someone@mail.com'), null);
});

test('an unrelated corporate domain is left alone', () => {
  assert.equal(suggestDomainTypo('buyer@realskincare.com'), null);
  assert.equal(suggestDomainTypo('someone@acme-industrial.co.uk'), null);
});

test('an ambiguous domain equidistant from two providers proposes nothing', () => {
  // Guessing between two providers would put a wrong address in front of the
  // entrant with the same confidence as a right one.
  const typed = 'a@aol.con';
  const suggestion = suggestDomainTypo(typed);
  if (suggestion !== null) assert.equal(suggestion, 'a@aol.com', 'if it resolves at all it must resolve to the near one');
});

test('a malformed address yields no suggestion rather than throwing', () => {
  // This runs on every keystroke pause in a live entry form.
  assert.equal(suggestDomainTypo('not-an-email'), null);
  assert.equal(suggestDomainTypo(''), null);
  assert.equal(suggestDomainTypo(null), null);
  assert.equal(suggestDomainTypo(undefined), null);
  assert.equal(suggestDomainTypo('@gmial.com'), null, 'no local part means nothing to suggest');
});

test('the local part is preserved exactly, including dots and plus-tags', () => {
  assert.equal(suggestDomainTypo('first.last+giveaway@gmial.com'), 'first.last+giveaway@gmail.com');
});

test('case is normalized the same way every other giveaway path normalizes it', () => {
  assert.equal(suggestDomainTypo('Sara.Jones@GMIAL.COM'), 'sara.jones@gmail.com');
});
