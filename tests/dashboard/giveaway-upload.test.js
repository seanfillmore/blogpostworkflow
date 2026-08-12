// tests/dashboard/giveaway-upload.test.js
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { validateUpload } from '../../agents/dashboard/routes/giveaway.js';

const tinyPng = 'iVBORw0KGgoAAAANSUhEUg==';

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
