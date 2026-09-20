// tests/lib/meta-token.test.js
//
// Pins the ORDER, which is the only thing about this module that can be wrong
// in a way that costs money.
//
// FACEBOOK_ACCESS_TOKEN must stay first: it is the proven live CAPI path (a real
// giveaway entry took the dataset's Lead count 6 -> 7 on 2026-08-17 through it),
// and sending a CAPI event on the system token is deliberately UNVERIFIED —
// it would require firing a real event. META_USER_ACCESS_TOKEN exists as the
// fallback so the user token's 2026-10-19 expiry, which lands inside the Meta
// launch window, becomes a no-op instead of a fleet-wide outage that presents
// as a permissions bug.

import test from 'node:test';
import assert from 'node:assert/strict';

import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { resolveMetaAccessToken, META_TOKEN_KEYS, ENV_FILE } from '../../lib/meta-token.js';
import { resolveLeadAccessToken } from '../../lib/meta-capi.js';
import { resolveAccessToken } from '../../lib/giveaway/meta-spend.js';

// A path that cannot exist, so the .env arm is a guaranteed miss. THIS CHECKOUT
// HAS A REAL .env — without pinning the path, key 1 resolves from disk and the
// key-2 fallback is never exercised, which is precisely the branch that has to
// work when the user token expires on 2026-10-19.
const NO_ENV = { envFilePath: join(tmpdir(), 'rsc-meta-token-does-not-exist-9f3a2b') };

test('the user token wins when both are present', () => {
  const token = resolveMetaAccessToken({
    FACEBOOK_ACCESS_TOKEN: 'user-token',
    META_USER_ACCESS_TOKEN: 'system-token',
  });
  assert.equal(token, 'user-token', 'the proven CAPI path must stay primary');
});

test('the system token is used when the user token is absent', () => {
  assert.equal(resolveMetaAccessToken({ META_USER_ACCESS_TOKEN: 'system-token' }, NO_ENV), 'system-token');
});

test('an EMPTY user token falls through rather than resolving to empty string', () => {
  // The realistic shape of the 2026-10-19 expiry being handled badly: a key that
  // exists but is blank. Returning '' would send access_token= and fail as auth.
  const token = resolveMetaAccessToken({
    FACEBOOK_ACCESS_TOKEN: '',
    META_USER_ACCESS_TOKEN: 'system-token',
  }, NO_ENV);
  assert.equal(token, 'system-token');
});

test('neither key anywhere resolves to null, never undefined or empty string', () => {
  assert.equal(resolveMetaAccessToken({ SOMETHING_ELSE: 'x' }, NO_ENV), null);
});

test('the default env-file path is the real .env, not the injected one', () => {
  // The injection exists for tests only; production must not depend on it.
  assert.ok(ENV_FILE.endsWith('/.env'), ENV_FILE);
});

test('the key order is pinned, not incidental', () => {
  assert.deepEqual([...META_TOKEN_KEYS], ['FACEBOOK_ACCESS_TOKEN', 'META_USER_ACCESS_TOKEN']);
});

// ── both former copies now delegate here ───────────────────────────────────
// There were two byte-identical resolvers and a third was about to be written.
// These assert the wrappers kept their exported names (no call site changed)
// AND that they actually share the implementation rather than having drifted.

test('resolveLeadAccessToken and resolveAccessToken share this implementation', () => {
  const env = { FACEBOOK_ACCESS_TOKEN: 'user-token', META_USER_ACCESS_TOKEN: 'system-token' };
  assert.equal(resolveLeadAccessToken(env, NO_ENV), resolveMetaAccessToken(env, NO_ENV));
  assert.equal(resolveAccessToken(env, NO_ENV), resolveMetaAccessToken(env, NO_ENV));
});

test('both wrappers reach the system token fallback', () => {
  const env = { META_USER_ACCESS_TOKEN: 'system-token' };
  assert.equal(resolveLeadAccessToken(env, NO_ENV), 'system-token', 'CAPI must survive the user-token expiry');
  assert.equal(resolveAccessToken(env, NO_ENV), 'system-token', 'spend reads must survive it too');
});

test('a caller passing no argument at all still resolves', () => {
  // resolveLeadAccessToken({}) is a real call shape in lib/meta-capi.js's own
  // tests; the default parameter must not throw on an absent env.
  assert.doesNotThrow(() => resolveMetaAccessToken());
});
