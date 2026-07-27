import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchAllReviews } from '../../lib/judgeme.js';

function pagedFetch(pages) {
  return async (url) => {
    const page = Number(new URL(url).searchParams.get('page'));
    return { ok: true, json: async () => ({ reviews: pages[page - 1] || [] }) };
  };
}

function review(id) {
  return { id, product_handle: 'coconut-lotion', rating: 5, body: `body ${id}`, created_at: '2026-01-01' };
}

test('fetchAllReviews follows pages until a short page ends it', async () => {
  const full = Array.from({ length: 100 }, (_, i) => review(i + 1));
  const tail = [review(101), review(102)];
  const out = await fetchAllReviews('shop.myshopify.com', 'tok', { fetchImpl: pagedFetch([full, tail]) });
  assert.equal(out.length, 102);
  assert.equal(out[101].body, 'body 102');
});

test('fetchAllReviews stops at maxPages instead of looping forever', async () => {
  const full = Array.from({ length: 100 }, (_, i) => review(i + 1));
  const fetchImpl = pagedFetch([full, full, full, full]);
  const out = await fetchAllReviews('shop.myshopify.com', 'tok', { maxPages: 2, fetchImpl });
  assert.equal(out.length, 200);
});

test('fetchAllReviews returns what it has when a page errors', async () => {
  const full = Array.from({ length: 100 }, (_, i) => review(i + 1));
  const fetchImpl = async (url) => {
    const page = Number(new URL(url).searchParams.get('page'));
    if (page === 2) return { ok: false, status: 500, json: async () => ({}) };
    return { ok: true, json: async () => ({ reviews: full }) };
  };
  const out = await fetchAllReviews('shop.myshopify.com', 'tok', { fetchImpl });
  assert.equal(out.length, 100);
});

test('fetchAllReviews drops reviews with an empty body', async () => {
  const fetchImpl = pagedFetch([[review(1), { id: 2, product_handle: 'coconut-lotion', rating: 5, body: '   ' }]]);
  const out = await fetchAllReviews('shop.myshopify.com', 'tok', { fetchImpl });
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 1);
});
