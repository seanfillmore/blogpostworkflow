// tests/dashboard/giveaway-upload.test.js
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { validateUpload, createUploadHandler } from '../../agents/dashboard/routes/giveaway.js';

const tinyPng = 'iVBORw0KGgoAAAANSUhEUg==';

/** Fake IncomingMessage delivering `body` synchronously once 'end' is wired up. */
function makeReq(body) {
  const listeners = {};
  return {
    url: '/api/giveaway/upload',
    headers: {},
    socket: { remoteAddress: '127.0.0.1' },
    on(event, cb) {
      listeners[event] = cb;
      if (event === 'end') {
        if (listeners.data) listeners.data(Buffer.from(body));
        cb();
      }
      return this;
    },
  };
}

function makeRes() {
  const res = { statusCode: null, body: null };
  res.writeHead = (status) => { res.statusCode = status; };
  res.end = (body) => { res.body = body; };
  return res;
}

const validBody = JSON.stringify({
  email: 'a@b.com', filename: 'me.png', dataBase64: tinyPng, rightsGranted: true,
});

test('an upload without granted rights is rejected — an unlicensed asset is worthless to us', () => {
  const r = validateUpload({ email: 'a@b.com', filename: 'me.png', dataBase64: tinyPng, rightsGranted: false });
  assert.equal(r.ok, false);
  assert.match(r.error, /rights/i);
});

test('a valid upload passes and the filename is sanitised to a safe basename', () => {
  const r = validateUpload({
    email: 'a@b.com', filename: '../../etc/passwd.png', dataBase64: tinyPng, rightsGranted: true,
  });
  assert.equal(r.ok, true);
  assert.equal(r.value.filename, 'passwd.png', 'path traversal must not survive validation');
});

test('a non-image extension is rejected, because the CDN helper is image-only', () => {
  const r = validateUpload({ email: 'a@b.com', filename: 'payload.svg', dataBase64: tinyPng, rightsGranted: true });
  assert.equal(r.ok, false);
  assert.match(r.error, /jpg, jpeg, png, webp/i);
});

test('an oversized payload is rejected before it is decoded', () => {
  const huge = 'A'.repeat(9 * 1024 * 1024);
  const r = validateUpload({ email: 'a@b.com', filename: 'big.png', dataBase64: huge, rightsGranted: true });
  assert.equal(r.ok, false);
  assert.match(r.error, /too large/i);
});

test('a bad email is rejected', () => {
  const r = validateUpload({ email: 'nope', filename: 'me.png', dataBase64: tinyPng, rightsGranted: true });
  assert.equal(r.ok, false);
});

test('REGRESSION: nothing reaches the Shopify Files library until the entrant is resolved', async () => {
  // uploadImageToShopifyCDN is PERMANENT and this route is public and
  // unauthenticated. Uploading first meant any address — one that never entered,
  // one Klaviyo has never heard of — could push arbitrary images into production
  // Files and only then get a 502 when the profile lookup failed. The file stayed.
  let cdnCalls = 0;
  const handler = createUploadHandler({
    getProfileByEmail: async () => null,
    uploadImageToShopifyCDN: async () => { cdnCalls += 1; return 'https://cdn/x.png'; },
    computeAndPersistEntries: async () => { throw new Error('must not be reached'); },
    updateProfileProperties: async () => { throw new Error('must not be reached'); },
  });

  const res = makeRes();
  await handler(makeReq(validBody), res);

  assert.equal(res.statusCode, 404, 'an address with no entry gets a 404');
  assert.equal(cdnCalls, 0, 'the CDN must not be touched before the entrant is known');
});

test('a Klaviyo profile that never ENTERED cannot push files either', async () => {
  // Requiring gv_breakdown, not merely "a profile exists", keeps the store's
  // Files library closed to the 481 existing newsletter subscribers.
  let cdnCalls = 0;
  const handler = createUploadHandler({
    getProfileByEmail: async () => ({ id: 'P1', email: 'a@b.com', properties: { first_name: 'Sub' } }),
    uploadImageToShopifyCDN: async () => { cdnCalls += 1; return 'https://cdn/x.png'; },
    computeAndPersistEntries: async () => { throw new Error('must not be reached'); },
    updateProfileProperties: async () => { throw new Error('must not be reached'); },
  });

  const res = makeRes();
  await handler(makeReq(validBody), res);
  assert.equal(res.statusCode, 404);
  assert.equal(cdnCalls, 0);
});

test('a real entrant uploads, is credited, and gets the CDN url back', async () => {
  const order = [];
  const handler = createUploadHandler({
    getProfileByEmail: async () => {
      order.push('profile');
      return { id: 'P1', email: 'a@b.com', properties: { gv_breakdown: { confirmed: true, survey: false, referrals: 0, instagram: false, upload: false } } };
    },
    uploadImageToShopifyCDN: async () => { order.push('cdn'); return 'https://cdn/x.png'; },
    computeAndPersistEntries: async () => { order.push('persist'); return { entries: 13, breakdown: { upload: true } }; },
    updateProfileProperties: async () => { order.push('url'); return { id: 'P1' }; },
  });

  const res = makeRes();
  await handler(makeReq(validBody), res);

  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.url, 'https://cdn/x.png');
  assert.equal(body.entries, 13);
  assert.deepEqual(order, ['profile', 'cdn', 'persist', 'url'], 'the profile lookup must come first');
});
