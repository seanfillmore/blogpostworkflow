import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { normalizeEmail, hashIdentifier, buildUserData, buildConversionEvent, buildIngestRequest }
  from '../../lib/ads-conversions.js';

// Google's required normalization before SHA-256 (support.google.com/google-ads/answer/13258081):
//   1. trim leading/trailing whitespace
//   2. lowercase
//   3. remove ALL periods preceding the domain in gmail.com / googlemail.com addresses
// Google does NOT do step 3 for you. Skipping it produces a hash that matches nothing,
// which fails silently — the conversion is simply never attributed.
{
  assert.equal(normalizeEmail('  John.Doe@Gmail.com '), 'johndoe@gmail.com');
  assert.equal(normalizeEmail('a.b.c@googlemail.com'), 'abc@googlemail.com');
  // Periods are significant outside gmail — stripping them there would break matching.
  assert.equal(normalizeEmail('john.doe@realskincare.com'), 'john.doe@realskincare.com');
  // Only the local part is touched; a dotted domain must survive.
  assert.equal(normalizeEmail('First.Last@Gmail.Com'), 'firstlast@gmail.com');
  // Plus-addressing is NOT stripped — Google's rule covers periods only.
  assert.equal(normalizeEmail('user+tag@gmail.com'), 'user+tag@gmail.com');
  assert.equal(normalizeEmail(''), null);
  assert.equal(normalizeEmail(null), null);
  assert.equal(normalizeEmail('not-an-email'), null);
}

// Lowercase hex SHA-256 of the normalized value.
{
  const h = hashIdentifier('johndoe@gmail.com');
  assert.equal(h, createHash('sha256').update('johndoe@gmail.com').digest('hex'));
  assert.equal(h.length, 64);
  assert.equal(h, h.toLowerCase());
}

// The raw address must never leave the process.
{
  const ud = buildUserData({ email: 'John.Doe@Gmail.com' });
  assert.deepEqual(Object.keys(ud), ['userIdentifiers']);
  assert.equal(ud.userIdentifiers.length, 1);
  assert.equal(ud.userIdentifiers[0].emailAddress,
    createHash('sha256').update('johndoe@gmail.com').digest('hex'));
  assert.ok(!JSON.stringify(ud).includes('John'), 'plaintext email must not appear in the payload');
  assert.ok(!JSON.stringify(ud).includes('gmail.com'), 'plaintext domain must not appear either');
}

// Shopify puts the address in different places depending on how the order was created.
{
  assert.ok(buildUserData({ contact_email: 'a@b.com' }));
  assert.ok(buildUserData({ customer: { email: 'a@b.com' } }));
  assert.equal(buildUserData({}), null);
  assert.equal(buildUserData({ email: 'garbage' }), null);
}

// --- Event + request integration ----------------------------------------------------

const ORDER = {
  order_number: 2322,
  created_at: '2026-07-31T18:47:07-06:00',
  total_price: '37.19',
  currency: 'USD',
  email: 'Buyer@Gmail.com',
  landing_site: '/p?gbraid=0AAAAAosZu9t1m6C2lo-Rjf93JtQMUwnB-',
};

// userData rides ALONGSIDE adIdentifiers — it is a matching fallback, not a replacement.
// The gbraid must survive.
{
  const e = buildConversionEvent(ORDER);
  assert.equal(e.adIdentifiers.gbraid, '0AAAAAosZu9t1m6C2lo-Rjf93JtQMUwnB-');
  assert.equal(e.userData.userIdentifiers[0].emailAddress,
    createHash('sha256').update('buyer@gmail.com').digest('hex'));
}

// An order with no email still uploads on the click id alone.
{
  const e = buildConversionEvent({ ...ORDER, email: undefined });
  assert.equal(e.userData, undefined);
  assert.ok(e.adIdentifiers.gbraid);
}

// `encoding` tells Google how the hashes are encoded and is required when userData is
// present; sending hashes without it makes them unreadable.
{
  const req = buildIngestRequest([ORDER], { accountId: '1', conversionActionId: '2' });
  assert.equal(req.encoding, 'HEX');
}
{
  const req = buildIngestRequest([{ ...ORDER, email: undefined }], { accountId: '1', conversionActionId: '2' });
  assert.equal(req.encoding, undefined, 'no encoding field when no hashed data is sent');
}

console.log('ads-user-data: all assertions passed');
