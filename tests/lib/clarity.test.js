process.env.MICROSOFT_CLARITY_TOKEN ??= 'test';

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { buildClarityUrl } from '../../lib/clarity.js';

const ENDPOINT = 'www.clarity.ms/export-data/api/v1/project-live-insights';

test('buildClarityUrl: no filter returns base endpoint with default numOfDays', () => {
  const url = buildClarityUrl({ endpoint: ENDPOINT });
  assert.equal(url, `https://${ENDPOINT}?numOfDays=1`);
});

test('buildClarityUrl: numOfDays override is reflected', () => {
  const url = buildClarityUrl({ endpoint: ENDPOINT, numOfDays: 3 });
  assert.equal(url, `https://${ENDPOINT}?numOfDays=3`);
});

test('buildClarityUrl: url filter adds dimension1 params, URL-encoded', () => {
  const url = buildClarityUrl({
    endpoint: ENDPOINT,
    url: '/products/sensitive-skin-starter-set',
  });
  assert.equal(
    url,
    `https://${ENDPOINT}?numOfDays=1&dimension1=URL&dimension1Value=%2Fproducts%2Fsensitive-skin-starter-set`
  );
});

test('buildClarityUrl: url + numOfDays combined', () => {
  const url = buildClarityUrl({
    endpoint: ENDPOINT,
    numOfDays: 3,
    url: '/products/coconut-lotion',
  });
  assert.equal(
    url,
    `https://${ENDPOINT}?numOfDays=3&dimension1=URL&dimension1Value=%2Fproducts%2Fcoconut-lotion`
  );
});
