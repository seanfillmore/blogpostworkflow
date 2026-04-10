/**
 * Shared Meta A/B Test Creator
 *
 * Creates a test file at data/meta-tests/{slug}.json tracking the CTR
 * impact of a meta title change. Does NOT apply the title to Shopify
 * (caller already did that).
 *
 * Usage:
 *   import { createMetaTest } from '../lib/meta-test.js';
 *   await createMetaTest({ slug, url, resourceType, resourceId, blogId, originalTitle, newTitle });
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const META_TESTS_DIR = join(ROOT, 'data', 'meta-tests');
const GSC_DIR = join(ROOT, 'data', 'snapshots', 'gsc');

function getBaselineCTR(url) {
  if (!existsSync(GSC_DIR)) return null;
  let pagePath;
  try { pagePath = new URL(url).pathname; } catch { return null; }

  const end = new Date();
  const start = new Date(end.getTime() - 28 * 86400000);

  const snapFiles = readdirSync(GSC_DIR)
    .filter(f => f.endsWith('.json'))
    .filter(f => {
      const d = new Date(f.replace('.json', '') + 'T12:00:00Z');
      return d >= start && d < end;
    });

  const ctrs = [];
  for (const f of snapFiles) {
    try {
      const snap = JSON.parse(readFileSync(join(GSC_DIR, f), 'utf8'));
      const pg = (snap.topPages || []).find(p => p.page && p.page.endsWith(pagePath));
      if (pg?.ctr != null) ctrs.push(pg.ctr);
    } catch { /* skip */ }
  }
  return ctrs.length ? ctrs.reduce((a, b) => a + b, 0) / ctrs.length : null;
}

export async function createMetaTest({ slug, url, resourceType, resourceId, blogId, originalTitle, newTitle }) {
  mkdirSync(META_TESTS_DIR, { recursive: true });

  const testPath = join(META_TESTS_DIR, `${slug}.json`);
  if (existsSync(testPath)) {
    try {
      const existing = JSON.parse(readFileSync(testPath, 'utf8'));
      if (existing.status === 'active') {
        console.log(`  A/B test already active for "${slug}" — skipping`);
        return null;
      }
    } catch { /* overwrite corrupt file */ }
  }

  const baselineCTR = getBaselineCTR(url);
  const startDate = new Date().toISOString().slice(0, 10);
  const concludeDate = new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10);

  const testData = {
    slug,
    url,
    resourceType,
    resourceId,
    blogId: blogId || null,
    startDate,
    concludeDate,
    variantA: originalTitle,
    variantB: newTitle,
    baselineCTR,
    status: 'active',
    baselineMean: baselineCTR,
    testMean: null,
    currentDelta: null,
    daysRemaining: 14,
  };

  writeFileSync(testPath, JSON.stringify(testData, null, 2));
  console.log(`  A/B test created: ${slug} (${resourceType}, 14-day window)`);
  return testData;
}
