import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { excludeHoldout } from '../../agents/meta-optimizer/lib/hold.js';

function fixture(wave) {
  const root = mkdtempSync(join(tmpdir(), 'ctr-holdout-'));
  if (wave !== null) {
    mkdirSync(join(root, 'data', 'reports', 'ctr-program'), { recursive: true });
    writeFileSync(
      join(root, 'data', 'reports', 'ctr-program', 'wave.json'),
      typeof wave === 'string' ? wave : JSON.stringify(wave),
    );
  }
  return root;
}

const CANDIDATES = [
  { keyword: 'best soap for tattoos' },
  { keyword: 'coconut oil deodorant' },
  { keyword: 'best unscented lotion' },
];
const PAGES = {
  'best soap for tattoos': 'https://www.realskincare.com/blogs/news/best-soap-for-tattoos-what-to-use-for-safe-healing-2',
  'coconut oil deodorant': 'https://www.realskincare.com/blogs/news/coconut-oil-deodorant-the-natural-way',
  'best unscented lotion': 'https://www.realskincare.com/blogs/news/best-unscented-lotion-clean-fragrance-free-picks',
};
const pageForKeyword = (kw) => PAGES[kw] || null;

test('a holdout page is withheld from the pick list', () => {
  const root = fixture({
    holdout: [{ url: 'https://www.realskincare.com/blogs/news/coconut-oil-deodorant-the-natural-way' }],
  });
  try {
    const { kept, excluded } = excludeHoldout(CANDIDATES, { root, pageForKeyword });
    assert.equal(excluded.length, 1);
    assert.equal(excluded[0].keyword, 'coconut oil deodorant');
    assert.deepEqual(kept.map((c) => c.keyword), ['best soap for tattoos', 'best unscented lotion']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('matches on the article handle, so a host difference cannot silently miss', () => {
  // The wave is built from GSC page rows (www); the blog index has been known to
  // carry the myshopify host. Comparing whole URLs would match nothing — and
  // matching nothing looks exactly like a clean run.
  const root = fixture({
    holdout: [{ url: 'https://real-skin-care.myshopify.com/blogs/news/coconut-oil-deodorant-the-natural-way' }],
  });
  try {
    const { excluded } = excludeHoldout(CANDIDATES, { root, pageForKeyword });
    assert.equal(excluded.length, 1);
    assert.equal(excluded[0].keyword, 'coconut oil deodorant');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the treatment arm is NOT withheld — only the holdout is', () => {
  const root = fixture({
    treatment: [{ url: PAGES['best soap for tattoos'] }],
    holdout: [{ url: PAGES['best unscented lotion'] }],
  });
  try {
    const { kept, excluded } = excludeHoldout(CANDIDATES, { root, pageForKeyword });
    assert.equal(excluded.length, 1);
    assert.ok(kept.some((c) => c.keyword === 'best soap for tattoos'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ── fails open, four ways ────────────────────────────────────────────────────
// A planner that has not run must never be able to stop the optimiser working.

test('no wave file → nothing withheld', () => {
  const root = fixture(null);
  try {
    const { kept, excluded } = excludeHoldout(CANDIDATES, { root, pageForKeyword });
    assert.equal(excluded.length, 0);
    assert.equal(kept.length, 3);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('unparseable wave file → nothing withheld, no throw', () => {
  const root = fixture('{ not json');
  try {
    const { kept, excluded } = excludeHoldout(CANDIDATES, { root, pageForKeyword });
    assert.equal(excluded.length, 0);
    assert.equal(kept.length, 3);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('wave with an empty holdout → nothing withheld', () => {
  const root = fixture({ treatment: [{ url: PAGES['best soap for tattoos'] }], holdout: [] });
  try {
    assert.equal(excludeHoldout(CANDIDATES, { root, pageForKeyword }).excluded.length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a candidate whose page cannot be resolved is kept, not dropped', () => {
  const root = fixture({ holdout: [{ url: PAGES['best unscented lotion'] }] });
  try {
    const { kept } = excludeHoldout([{ keyword: 'unmapped query' }], { root, pageForKeyword });
    assert.equal(kept.length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('does not mutate the candidate list and tolerates junk input', () => {
  const root = fixture({ holdout: [{ url: PAGES['best unscented lotion'] }] });
  try {
    const input = [...CANDIDATES];
    excludeHoldout(input, { root, pageForKeyword });
    assert.deepEqual(input, CANDIDATES);
    assert.deepEqual(excludeHoldout(null, { root, pageForKeyword }).kept, []);
    assert.deepEqual(excludeHoldout(undefined, {}).kept, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
