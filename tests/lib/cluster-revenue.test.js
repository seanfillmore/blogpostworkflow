import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyClusters, clusterStatus } from '../../lib/cluster-revenue.js';

// Shape mirrors data/reports/seo-impact/latest.json → clusters[]
const REAL = [
  { cluster: 'body lotion', revenue: 87.09, clicks: 34,  pages: 20 },
  { cluster: 'lip balm',    revenue: 48,    clicks: 3,   pages: 6  },
  { cluster: 'deodorant',   revenue: 17.26, clicks: 109, pages: 21 },
  { cluster: 'toothpaste',  revenue: 0,     clicks: 725, pages: 26 },
  { cluster: 'hand soap',   revenue: 0,     clicks: 1,   pages: 2  },
];

test('a cluster earning revenue is earning, however few clicks it took', () => {
  const c = classifyClusters(REAL);
  assert.equal(c['lip balm'].status, 'earning');
  assert.equal(c['body lotion'].status, 'earning');
});

test('traffic with no revenue is a proven dud, not an unknown', () => {
  const c = classifyClusters(REAL);
  // 725 clicks across 26 pages and $0 is the toothpaste cluster CLAUDE.md flags.
  assert.equal(c.toothpaste.status, 'proven_dud');
});

test('a cluster with too little traffic to judge is unproven, not a dud', () => {
  const c = classifyClusters(REAL);
  // 1 click across 2 pages has not been given a fair shot — blocking it would
  // stop us ever testing a new category.
  assert.equal(c['hand soap'].status, 'unproven');
});

test('a cluster needs BOTH enough clicks and enough pages before it can be a dud', () => {
  const c = classifyClusters([
    { cluster: 'few pages', revenue: 0, clicks: 900, pages: 2 },
    { cluster: 'few clicks', revenue: 0, clicks: 4, pages: 30 },
  ]);
  assert.equal(c['few pages'].status, 'unproven', 'one viral page is not a tested cluster');
  assert.equal(c['few clicks'].status, 'unproven', 'pages nobody visits prove nothing');
});

test('thresholds are configurable', () => {
  const c = classifyClusters([{ cluster: 'x', revenue: 0, clicks: 50, pages: 6 }],
    { minClicks: 40, minPages: 5 });
  assert.equal(c.x.status, 'proven_dud');
});

test('classifyClusters is case- and whitespace-insensitive on cluster names', () => {
  const c = classifyClusters([{ cluster: '  ToothPaste ', revenue: 0, clicks: 725, pages: 26 }]);
  assert.equal(c.toothpaste.status, 'proven_dud');
});

test('classifyClusters tolerates missing input', () => {
  assert.deepEqual(classifyClusters(null), {});
  assert.deepEqual(classifyClusters([{ revenue: 5 }]), {}, 'an entry with no cluster name is skipped');
});

test('clusterStatus looks a category up leniently and defaults to unproven', () => {
  const c = classifyClusters(REAL);
  assert.equal(clusterStatus(c, 'Toothpaste'), 'proven_dud');
  assert.equal(clusterStatus(c, 'Body Lotion'), 'earning');
  assert.equal(clusterStatus(c, 'Something New'), 'unproven');
  assert.equal(clusterStatus(c, null), 'unproven');
});

test('revenue is carried through so callers can report dollars, not just a label', () => {
  const c = classifyClusters(REAL);
  assert.equal(c.toothpaste.revenue, 0);
  assert.equal(c.toothpaste.clicks, 725);
  assert.equal(c['body lotion'].revenue, 87.09);
});
