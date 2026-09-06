/**
 * meta-optimizer's health-claim gate: generate → check → regenerate once → skip.
 *
 * The behaviour under test is the one the 2026-08-22 incident review asked for
 * explicitly: fail closed on the WRITE, not on the candidate. A first-attempt hit
 * must cost a retry, not the candidate — dropping it on the first hit quietly
 * removes CTR work from the queue, and silent removal is the class of bug this
 * whole change exists to prevent.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';

import { gateProposedCopy } from '../../agents/meta-optimizer/lib/gate.js';

// CLEAN must be clean on EVERY gate this loop runs, which since 2026-09-06
// includes the SERP length check. The title here is 37 characters, so the
// theme's appended " – Real Skin Care" brings the RENDERED title to 54 — under
// the 60 limit. The previous fixture was the real live title
// 'Best Soap for Tattoos: Clean, Gentle, Fragrance-Free' (51 chars), which
// renders at 68 and genuinely truncates in Google; it is pinned as a
// regression case below rather than quietly relaxed.
const CLEAN = { title: 'Best Soap for Tattoos: Fragrance-Free', meta_description: 'Washing new ink calls for a fragrance-free, dye-free bar. See what to look for.' };
const LIVE_OVERLONG_TITLE = 'Best Soap for Tattoos: Clean, Gentle, Fragrance-Free';
const DIRTY = { title: 'Best Soap for Tattoos: Clean Ingredients That Heal', meta_description: 'Supports real healing on new ink.' };

describe('meta-optimizer gate — happy path', () => {
  test('a clean first attempt is used, with no retry', async () => {
    const calls = [];
    const r = await gateProposedCopy(async (constraint) => { calls.push(constraint); return CLEAN; });
    assert.equal(r.ok, true);
    assert.deepEqual(r.proposed, CLEAN);
    assert.equal(r.attempts, 1);
    assert.deepEqual(calls, ['']);
  });

  test('a real live title that OVERFLOWS once the theme appends the brand is retried', async () => {
    // 51 authored characters looks fine and is what shipped; the storefront
    // renders it at 68. This is the defect the length gate exists to catch, and
    // it is a title this site actually served.
    const calls = [];
    const r = await gateProposedCopy(async (c) => {
      calls.push(c);
      return calls.length === 1
        ? { ...CLEAN, title: LIVE_OVERLONG_TITLE }
        : CLEAN;
    });
    assert.equal(r.attempts, 2, 'the overlong rendered title costs exactly one retry');
    assert.match(calls[1], /Real Skin Care/, 'the retry explains the appended brand');
    assert.equal(r.ok, true);
    assert.deepEqual(r.proposed, CLEAN);
  });

  test('the generator is not asked to retry when only advisory language is present', async () => {
    const calls = [];
    const r = await gateProposedCopy(async (c) => {
      calls.push(c);
      return { title: 'Toxic Chemicals In Soap To Keep An Eye On', meta_description: 'The most toxic ingredients to watch for when buying soap.' };
    });
    assert.equal(r.ok, true);
    assert.equal(r.attempts, 1);
    assert.equal(calls.length, 1);
    assert.ok(r.advisory.length >= 1);
    assert.equal(r.advisory[0].category, 'toxicity');
  });
});

describe('meta-optimizer gate — regenerate once', () => {
  test('a first-attempt violation costs a retry, not the candidate', async () => {
    const calls = [];
    const r = await gateProposedCopy(async (c) => { calls.push(c); return calls.length === 1 ? DIRTY : CLEAN; });
    assert.equal(r.ok, true);
    assert.deepEqual(r.proposed, CLEAN);
    assert.equal(r.attempts, 2);
  });

  test('the retry prompt names the exact words that tripped', async () => {
    const calls = [];
    await gateProposedCopy(async (c) => { calls.push(c); return calls.length === 1 ? DIRTY : CLEAN; });
    assert.equal(calls[0], '');
    assert.match(calls[1], /Heal/i);
    assert.match(calls[1], /healing/i);
    assert.match(calls[1], /cosmetic/i);
  });

  test('exactly one retry — a second violation is not retried again', async () => {
    let n = 0;
    const r = await gateProposedCopy(async () => { n++; return DIRTY; });
    assert.equal(n, 2);
    assert.equal(r.attempts, 2);
    assert.equal(r.ok, false);
  });
});

describe('meta-optimizer gate — the skip', () => {
  test('when the retry also trips, nothing is proposed and the violations are kept', async () => {
    const r = await gateProposedCopy(async () => DIRTY);
    assert.equal(r.ok, false);
    assert.equal(r.proposed, null);
    assert.ok(r.violations.length >= 1);
    // The violations reported are the RETRY's, since that is the copy that was
    // rejected last and the text a human would look at.
    assert.ok(r.violations.every((v) => v.field === 'title' || v.field === 'meta'));
    assert.ok(r.violations.some((v) => /heal/i.test(v.match)));
  });

  test('the rejected copy is retained so the report can show what was refused', async () => {
    const r = await gateProposedCopy(async () => DIRTY);
    assert.equal(r.rejected.title, DIRTY.title);
    assert.equal(r.rejected.meta_description, DIRTY.meta_description);
  });

  test('a violation only in the meta description is caught too', async () => {
    let n = 0;
    const r = await gateProposedCopy(async () => {
      n++;
      return { title: 'Best Body Cream for Very Dry Skin', meta_description: 'Treats and prevents cracked skin.' };
    });
    assert.equal(r.ok, false);
    assert.equal(n, 2);
    assert.ok(r.violations.every((v) => v.field === 'meta'));
  });
});

describe('meta-optimizer gate — malformed generator output', () => {
  test('a missing meta description is checked as empty, not as a crash', async () => {
    const r = await gateProposedCopy(async () => ({ title: 'Best Unscented Lotion for Dry Skin' }));
    assert.equal(r.ok, true);
    assert.equal(r.attempts, 1);
  });

  test('a null return fails closed rather than proposing null', async () => {
    const r = await gateProposedCopy(async () => null);
    assert.equal(r.ok, false);
    assert.equal(r.proposed, null);
  });
});
