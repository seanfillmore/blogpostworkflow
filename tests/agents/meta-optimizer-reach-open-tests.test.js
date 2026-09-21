import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readWaveDesignated, designatedMissingFromPool, openTestHandles, excludeOpenTests, prioritiseTreatment,
} from '../../agents/meta-optimizer/lib/hold.js';

const W = 'https://www.realskincare.com/blogs/news/';
const MOIST = 'how-to-make-a-natural-moisturizer-at-home-easy-recipes-1';

function rootWithWave(wave) {
  const root = mkdtempSync(join(tmpdir(), 'wave-'));
  mkdirSync(join(root, 'data', 'reports', 'ctr-program'), { recursive: true });
  writeFileSync(join(root, 'data', 'reports', 'ctr-program', 'wave.json'), JSON.stringify(wave));
  return root;
}

describe('reaching every designated page', () => {
  const root = rootWithWave({
    individual: [{ url: W + 'toothpaste-without-sls-what-to-know-best-options' }],
    treatment: [{ url: W + 'best-deodorant-for-sensitive-skin-what-to-look-for' }, { url: W + MOIST }],
  });

  test('the 2026-09-21 case: a treatment page outside the quick-win pool is found', () => {
    const pool = [{ keyword: 'sls free toothpaste', url: W + 'toothpaste-without-sls-what-to-know-best-options' }];
    const missing = designatedMissingFromPool(readWaveDesignated(root), pool);
    assert.deepEqual(missing.map((d) => d.handle), ['best-deodorant-for-sensitive-skin-what-to-look-for', MOIST]);
  });

  test('once its own top query is in the pool, the synthesiser treats it', () => {
    const pool = [{ keyword: 'how to make natural moisturizer', url: W + MOIST, impressions: 7321 }];
    const { designated } = prioritiseTreatment([], { root, pool });
    assert.ok(designated.some((d) => d.url === W + MOIST && d.synthesised));
  });

  test('a page with an open test is not fetched for', () => {
    const missing = designatedMissingFromPool(readWaveDesignated(root), [], { skipHandles: new Set([MOIST]) });
    assert.ok(!missing.some((d) => d.handle === MOIST));
  });

  test('no wave → nothing designated', () => {
    assert.deepEqual(readWaveDesignated(mkdtempSync(join(tmpdir(), 'nowave-'))), []);
  });
});

describe('never rewriting a page whose test is still running', () => {
  const tracker = [
    { keyword: 'best soap for tattoos', pageUrl: W + 'best-soap-for-tattoos-what-to-use-for-safe-healing-2', outcome: 'confounded' },
    { keyword: 'x', pageUrl: W + 'old-page', status: 'concluded', outcome: 'regressed' },
  ];

  test('confounded/underpowered/unchecked stay open; only concluded frees a page', () => {
    const open = openTestHandles(tracker);
    assert.ok(open.has('best-soap-for-tattoos-what-to-use-for-safe-healing-2'));
    assert.ok(!open.has('old-page'));
  });

  test('an open-test page is withheld before the cap, by url or by keyword map', () => {
    const openHandles = openTestHandles(tracker);
    const { kept, excluded } = excludeOpenTests([
      { keyword: 'best soap for tattoos' },
      { keyword: 'old', url: W + 'old-page' },
    ], { openHandles, pageForKeyword: (kw) => (kw === 'best soap for tattoos' ? W + 'best-soap-for-tattoos-what-to-use-for-safe-healing-2' : null) });
    assert.deepEqual(kept.map((c) => c.keyword), ['old']);
    assert.equal(excluded.length, 1);
  });
});

test('meta-optimizer applies the open-test filter after the wave ordering and before the cap', () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../agents/meta-optimizer/index.js'), 'utf8');
  const iOpen = src.indexOf('excludeOpenTests(waveReady');
  const iWave = src.indexOf('prioritiseTreatment(notHeldOut');
  const iCap = src.indexOf('holdMetaCandidates(waveOrdered');
  assert.ok(iWave > 0 && iOpen > iWave && iCap > iOpen);
  assert.match(src, /designatedMissingFromPool\(readWaveDesignated\(ROOT\)/);
});
