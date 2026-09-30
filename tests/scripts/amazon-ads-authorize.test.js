import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  codeFromUrl,
  buildAuthorizeUrl,
  upsertEnv,
} from '../../scripts/amazon-ads-authorize.mjs';

const CLIENT_ID = 'amzn1.application-oa2-client.testclientid';
const REDIRECT = 'https://www.realskincare.com/';

test('buildAuthorizeUrl targets the NA endpoint with the double-colon scope', () => {
  const url = new URL(buildAuthorizeUrl({ clientId: CLIENT_ID, redirectUri: REDIRECT }));

  assert.equal(url.origin + url.pathname, 'https://www.amazon.com/ap/oa');
  assert.equal(url.searchParams.get('client_id'), CLIENT_ID);
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('redirect_uri'), REDIRECT);

  // A single colon is one of the three documented causes of invalid_scope, and it fails
  // at the authorize step before any token exists — so pin the exact string.
  assert.equal(url.searchParams.get('scope'), 'advertising::campaign_management');
});

test('codeFromUrl extracts the code from a pasted address bar', () => {
  const landed = `${REDIRECT}?code=ANtestcode123&scope=advertising%3A%3Acampaign_management`;
  assert.equal(codeFromUrl(landed), 'ANtestcode123');
});

test('codeFromUrl tolerates surrounding whitespace from a paste', () => {
  assert.equal(codeFromUrl(`  ${REDIRECT}?code=ANabc  \n`), 'ANabc');
});

test('codeFromUrl surfaces an Amazon error instead of reporting a missing code', () => {
  assert.throws(
    () => codeFromUrl(`${REDIRECT}?error=invalid_scope&error_description=An+unknown+scope`),
    (err) => {
      assert.match(err.message, /invalid_scope/);
      // The actionable cause, not just the code Amazon returned.
      assert.match(err.message, /not approved for this scope|single colon/);
      return true;
    }
  );
});

test('codeFromUrl explains what to paste when the code is absent', () => {
  assert.throws(() => codeFromUrl(REDIRECT), /No "code" parameter/);
});

test('codeFromUrl rejects a non-URL', () => {
  assert.throws(() => codeFromUrl('ANtestcode123'), /Not a URL/);
});

test('upsertEnv REPLACES an existing key rather than appending a duplicate', () => {
  // dotenv takes the FIRST occurrence, so an appended duplicate would let the stale
  // value silently win. This is the whole reason upsertEnv is not an append.
  const before = 'FOO=1\nAMAZON_ADS_REFRESH_TOKEN=old\nBAR=2\n';
  const after = upsertEnv(before, { AMAZON_ADS_REFRESH_TOKEN: 'new' });

  assert.equal(after, 'FOO=1\nAMAZON_ADS_REFRESH_TOKEN=new\nBAR=2\n');
  assert.equal(after.match(/AMAZON_ADS_REFRESH_TOKEN=/g).length, 1);
});

test('upsertEnv appends a key that is not present, preserving the rest byte for byte', () => {
  const before = 'FOO=1\nBAR=2\n';
  const after = upsertEnv(before, { AMAZON_ADS_PROFILE_ID: '12345' });

  assert.equal(after, 'FOO=1\nBAR=2\nAMAZON_ADS_PROFILE_ID=12345\n');
});

test('upsertEnv does not glue a new key onto an unterminated final line', () => {
  const after = upsertEnv('FOO=1', { BAR: '2' });
  assert.equal(after, 'FOO=1\nBAR=2\n');
});

test('upsertEnv leaves a key whose name is a suffix of another alone', () => {
  // AMAZON_ADS_REFRESH_TOKEN must not be matched by a pattern for REFRESH_TOKEN.
  const before = 'AMAZON_ADS_REFRESH_TOKEN=keepme\n';
  const after = upsertEnv(before, { REFRESH_TOKEN: 'other' });

  assert.match(after, /^AMAZON_ADS_REFRESH_TOKEN=keepme$/m);
  assert.match(after, /^REFRESH_TOKEN=other$/m);
});
