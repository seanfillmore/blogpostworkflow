import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchRecentReviews } from '../../lib/judgeme.js';

test('fetchRecentReviews carries the product title and handle through', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      reviews: [{
        product_external_id: 1, rating: 5, body: 'Lovely', created_at: new Date().toISOString(),
        reviewer: { name: 'Pat Example', verified_buyer: true },
        product_title: 'Coconut Bar Soap', product_handle: 'coconut-soap',
      }],
    }),
  });
  try {
    const [r] = await fetchRecentReviews(7, 'example.myshopify.com', 'token');
    assert.equal(r.product_title, 'Coconut Bar Soap');
    assert.equal(r.product_handle, 'coconut-soap');
    assert.equal(r.reviewer, 'Pat Example');
  } finally {
    globalThis.fetch = realFetch;
  }
});
