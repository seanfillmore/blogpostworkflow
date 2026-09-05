// tests/agents/meta-optimizer-treatment.test.js
//
// THE MISSING HALF OF THE WAVE.
//
// `excludeHoldout` enforced what must NOT be rewritten. Nothing enforced what
// must BE rewritten — `wave.treatment` was read by no code anywhere, though
// writeWave's own comment calls the two lists "what to rewrite, and what it
// must refuse to rewrite".
//
// Measured on production 2026-09-05 against the 2026-08-31 wave: of five weekly
// slots, two went to `individual` pages (correct), two to pages the wave had
// DEFERRED, and ONE landed in the treatment arm. And only 1 of the 10 treatment
// pages was even SELECTABLE, because candidates are gsc-opportunity's top-20
// low-CTR QUERIES while the wave designates PAGES — so no reordering alone
// could ever have treated the arm.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { prioritiseTreatment, excludeHoldout } from '../../agents/meta-optimizer/lib/hold.js';

const u = (h) => `https://www.realskincare.com/blogs/news/${h}`;

/** A temp root holding a wave.json, cleaned up by the caller. */
function rootWith(wave) {
  const root = mkdtempSync(join(tmpdir(), 'ctrwave-'));
  if (wave !== null) {
    mkdirSync(join(root, 'data', 'reports', 'ctr-program'), { recursive: true });
    writeFileSync(join(root, 'data', 'reports', 'ctr-program', 'wave.json'), JSON.stringify(wave));
  }
  return root;
}

const WAVE = {
  individual: [{ url: u('flagship') }],
  treatment: [{ url: u('t1') }, { url: u('t2') }, { url: u('t3') }],
  holdout: [{ url: u('h1') }],
};

const kwPage = { 'kw-flagship': u('flagship'), 'kw-t1': u('t1'), 'kw-other': u('other'), 'kw-h1': u('h1') };
const pageForKeyword = (kw) => kwPage[kw] || null;
const cand = (keyword) => ({ keyword });

test('designated work is pulled to the FRONT of the pick list', () => {
  const root = rootWith(WAVE);
  try {
    const { ordered, designated } = prioritiseTreatment(
      [cand('kw-other'), cand('kw-t1'), cand('kw-flagship')],
      { root, pageForKeyword },
    );
    // individual leads (highest-traffic pages, ordinary per-page path), then
    // treatment in the wave's own ranked order, then everything else.
    assert.deepEqual(ordered.map((c) => c.keyword).slice(0, 2), ['kw-flagship', 'kw-t1']);
    assert.equal(ordered[ordered.length - 1].keyword, 'kw-other');
    assert.equal(designated.length >= 2, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('THE 9-OF-10 PROBLEM: a designated page with no candidate query is SYNTHESISED', () => {
  // This is what reordering alone could not fix. t2 and t3 are in the wave but
  // no candidate query points at them; they exist in the quick-win pool, which
  // is where their query comes from.
  const root = rootWith(WAVE);
  try {
    const pool = [
      { keyword: 'q-t2-small', url: u('t2'), impressions: 100 },
      { keyword: 'q-t2-big', url: u('t2'), impressions: 9000 },
      { keyword: 'q-t3', url: u('t3'), impressions: 500 },
    ];
    const { ordered, designated } = prioritiseTreatment([cand('kw-other')], { root, pageForKeyword, pool });
    const kws = ordered.map((c) => c.keyword);
    assert.ok(kws.includes('q-t2-big'), 't2 must be reachable via a synthesised candidate');
    assert.ok(kws.includes('q-t3'), 't3 must be reachable via a synthesised candidate');
    // Highest-impression query for the page: the rewrite is judged against the
    // demand the page really has, not a long-tail phrase.
    assert.ok(!kws.includes('q-t2-small'), 'pick the page\'s biggest query, not any query');
    assert.equal(designated.filter((d) => d.synthesised).length, 2);
    assert.equal(kws[kws.length - 1], 'kw-other', 'filler still sorts last');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a page already covered by a real candidate is NOT also synthesised', () => {
  const root = rootWith(WAVE);
  try {
    const pool = [{ keyword: 'q-t1', url: u('t1'), impressions: 900 }];
    const { ordered } = prioritiseTreatment([cand('kw-t1')], { root, pageForKeyword, pool });
    const forT1 = ordered.filter((c) => ['kw-t1', 'q-t1'].includes(c.keyword));
    assert.equal(forT1.length, 1, 'one candidate per page, or the cap is spent twice on it');
    assert.equal(forT1[0].keyword, 'kw-t1');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('ONE SLOT PER PAGE: two queries on one designated page do not eat two slots', () => {
  // The cap is a budget of PAGES — a rewrite mutates a page, not a query.
  // Simulated against the live wave before this guard, one page took two of the
  // five weekly slots, halving the wave's throughput for no second effect.
  const root = rootWith(WAVE);
  try {
    const forKw = (kw) => ({ 'kw-t1-a': u('t1'), 'kw-t1-b': u('t1'), 'kw-other': u('other') }[kw] || null);
    const { ordered } = prioritiseTreatment(
      [{ keyword: 'kw-t1-a', impressions: 100 }, { keyword: 'kw-t1-b', impressions: 9000 }, cand('kw-other')],
      { root, pageForKeyword: forKw },
    );
    assert.equal(ordered[0].keyword, 'kw-t1-b', 'the page\'s biggest query leads');
    // LAST, not merely second: sitting next in line it still lands inside a cap
    // of five, which is the defect. Nothing is dropped, though.
    assert.equal(ordered[ordered.length - 1].keyword, 'kw-t1-a', 'the duplicate goes to the very end');
    assert.ok(ordered.some((c) => c.keyword === 'kw-t1-a'), 'the smaller query is demoted, never dropped');
    assert.equal(ordered.length, 3, 'no candidate is lost');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('A SYNTHESISED CANDIDATE CARRIES ITS OWN PAGE, because the keyword map lies', () => {
  // Measured on production 2026-09-05: the pool's biggest query for the
  // treatment page `best-toothpaste-without-sls-2025` is "sls free toothpaste",
  // and `kwToPage` — first-wins over GSC rows — resolves THAT SAME STRING to a
  // different page. An optimizer trusting the map would have rewritten the
  // wrong page, and one already being treated.
  const root = rootWith(WAVE);
  try {
    const pool = [{ keyword: 'shared-query', url: u('t2'), impressions: 900 }];
    const { ordered } = prioritiseTreatment([], { root, pageForKeyword: () => u('somewhere-else'), pool });
    const synth = ordered.find((c) => c.keyword === 'shared-query');
    assert.ok(synth, 'the page should be reachable');
    assert.equal(synth.url, u('t2'), 'it must carry the page the wave meant, not the one the keyword maps to');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a synthesised candidate never REUSES a keyword an existing candidate holds', () => {
  // The A/B tracker keys on keyword; two rows sharing one are indistinguishable
  // in it. The page is reached on a later wave via its own next query instead.
  const root = rootWith(WAVE);
  try {
    const pool = [{ keyword: 'kw-t1', url: u('t2'), impressions: 9000 }];
    const { ordered } = prioritiseTreatment([cand('kw-t1')], { root, pageForKeyword, pool });
    assert.equal(ordered.filter((c) => c.keyword === 'kw-t1').length, 1, 'no duplicate keyword rows');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('THE SAFETY PROPERTY: it never promotes — or synthesises — a HOLDOUT page', () => {
  // A rewritten holdout page does not degrade the measurement a little, it
  // removes the control for the whole wave, unreconstructably. Prioritisation
  // must not be able to undo the exclusion that runs before it.
  const root = rootWith(WAVE);
  try {
    const pool = [{ keyword: 'q-h1', url: u('h1'), impressions: 50_000 }]; // biggest in the pool
    const { ordered, designated } = prioritiseTreatment([cand('kw-other')], { root, pageForKeyword, pool });
    assert.ok(!ordered.some((c) => c.keyword === 'q-h1'), 'a holdout page must never be synthesised in');
    assert.ok(!designated.some((d) => String(d.url).includes('h1')));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the two filters COMPOSE: holdout excluded, then treatment prioritised', () => {
  // The real pipeline order in agents/meta-optimizer/index.js.
  const root = rootWith(WAVE);
  try {
    const all = [cand('kw-h1'), cand('kw-other'), cand('kw-t1')];
    const { kept, excluded } = excludeHoldout(all, { root, pageForKeyword });
    assert.equal(excluded.length, 1);
    const { ordered } = prioritiseTreatment(kept, { root, pageForKeyword });
    assert.deepEqual(ordered.map((c) => c.keyword), ['kw-t1', 'kw-other']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('FAILS OPEN — no wave, unreadable wave, or empty arms leave the list untouched', () => {
  // A planner that has not run must never stop the optimiser working. Same
  // contract as excludeHoldout.
  const input = [cand('kw-other'), cand('kw-t1')];
  const before = input.map((c) => c.keyword);

  const noWave = rootWith(null);
  const empty = rootWith({ treatment: [], holdout: [], individual: [] });
  const broken = mkdtempSync(join(tmpdir(), 'ctrwave-'));
  mkdirSync(join(broken, 'data', 'reports', 'ctr-program'), { recursive: true });
  writeFileSync(join(broken, 'data', 'reports', 'ctr-program', 'wave.json'), '{ not json');

  try {
    for (const root of [noWave, empty, broken]) {
      const { ordered, designated } = prioritiseTreatment(input, { root, pageForKeyword });
      assert.deepEqual(ordered.map((c) => c.keyword), before, `should pass through untouched: ${root}`);
      assert.deepEqual(designated, []);
    }
  } finally {
    for (const r of [noWave, empty, broken]) rmSync(r, { recursive: true, force: true });
  }
});

test('a candidate whose keyword maps to no page is filler, not a crash', () => {
  const root = rootWith(WAVE);
  try {
    const { ordered } = prioritiseTreatment([cand('unknown-kw'), cand('kw-t1')], { root, pageForKeyword });
    assert.deepEqual(ordered.map((c) => c.keyword), ['kw-t1', 'unknown-kw']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('handles match across hosts — the www/myshopify split that silently matches nothing', () => {
  const root = rootWith({ treatment: [{ url: 'https://rsc.myshopify.com/blogs/news/t1' }], holdout: [] });
  try {
    const { ordered } = prioritiseTreatment([cand('kw-other'), cand('kw-t1')], { root, pageForKeyword });
    assert.equal(ordered[0].keyword, 'kw-t1', 'must join on handle, not the whole URL');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
