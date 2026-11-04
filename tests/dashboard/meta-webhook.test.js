import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { validSignature, verifyChallenge } from '../../agents/dashboard/routes/meta-webhook.js';

test('validSignature: only the exact HMAC of the raw body with the app secret', () => {
  const raw = Buffer.from('{"object":"instagram","entry":[]}');
  const sig = `sha256=${createHmac('sha256', 's3cret').update(raw).digest('hex')}`;
  assert.equal(validSignature(raw, sig, 's3cret'), true);
  assert.equal(validSignature(Buffer.from('{"object":"instagram","entry":[1]}'), sig, 's3cret'), false, 'tampered body');
  assert.equal(validSignature(raw, sig, 'other'), false, 'wrong secret');
  assert.equal(validSignature(raw, undefined, 's3cret'), false);
  assert.equal(validSignature(raw, 'sha256=short', 's3cret'), false);
  assert.equal(validSignature(raw, sig, ''), false, 'no secret configured: refuse');
});

test('verifyChallenge: echoes the challenge only for subscribe + the exact token', () => {
  const q = (s) => new URLSearchParams(s);
  assert.equal(verifyChallenge(q('hub.mode=subscribe&hub.verify_token=tok&hub.challenge=12345'), 'tok'), '12345');
  assert.equal(verifyChallenge(q('hub.mode=subscribe&hub.verify_token=nope&hub.challenge=12345'), 'tok'), null);
  assert.equal(verifyChallenge(q('hub.mode=subscribe&hub.verify_token=tok&hub.challenge=12345'), undefined), null, 'no token configured');
  assert.equal(verifyChallenge(q('hub.mode=subscribe&hub.verify_token=tok&hub.challenge=<script>'), 'tok'), null, 'never echoes markup');
});
