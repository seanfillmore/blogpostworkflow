import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { identifyPillar } from '../../lib/cluster-architecture.js';

test('pillar = highest impressions', () => {
  const posts = [
    { slug: 'a', keyword: 'natural deodorant for men', impressions: 100, position: 8 },
    { slug: 'b', keyword: 'natural deodorant', impressions: 900, position: 12 },
  ];
  assert.equal(identifyPillar(posts).slug, 'b');
});

test('tie on impressions → better position wins', () => {
  const posts = [
    { slug: 'a', keyword: 'x', impressions: 500, position: 20 },
    { slug: 'b', keyword: 'y', impressions: 500, position: 5 },
  ];
  assert.equal(identifyPillar(posts).slug, 'b');
});

test('tie on impressions+position → shorter (broader) keyword wins', () => {
  const posts = [
    { slug: 'a', keyword: 'natural deodorant for sensitive skin', impressions: 500, position: 10 },
    { slug: 'b', keyword: 'natural deodorant', impressions: 500, position: 10 },
  ];
  assert.equal(identifyPillar(posts).slug, 'b');
});

test('empty → null', () => {
  assert.equal(identifyPillar([]), null);
  assert.equal(identifyPillar(null), null);
});

test('missing metrics default to 0 impressions / worst position', () => {
  const posts = [{ slug: 'a', keyword: 'x' }, { slug: 'b', keyword: 'y', impressions: 10, position: 50 }];
  assert.equal(identifyPillar(posts).slug, 'b');
});
