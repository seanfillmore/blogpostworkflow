/**
 * The shared generate → check → regenerate-once → skip loop.
 *
 * meta-optimizer had this inline; three more unattended writers needed it
 * verbatim, so it moved here. These tests pin the two properties the 2026-08-22
 * incident review asked for by name — fail closed on the WRITE not the
 * CANDIDATE, and exactly one retry — plus the thing that generalising it made
 * newly possible to get wrong: a caller whose copy is not shaped like
 * {title, meta} silently receiving a free pass.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';

import { gateGeneratedCopy } from '../../lib/seo-copy-gate-loop.js';
import { checkSeoCopy, checkSeoCopyFields, plainText, renderGateRefusalLines, renderGateSkipLines } from '../../lib/seo-copy-health-gate.js';

const CLEAN = { seo_title: 'Unscented Coconut Body Lotion for Dry Skin', seo_description: 'Fragrance-free, dye-free, one ingredient.', body_html: '<p>Two ingredients. Nothing else.</p>' };
const DIRTY = { seo_title: 'Coconut Lotion That Heals Eczema', seo_description: 'Treats dry patches fast.', body_html: '<p>Clinically proven to cure dermatitis.</p>' };
const EXTRACT = (p) => ({ title: p?.seo_title, meta: p?.seo_description, body: p?.body_html });

describe('gateGeneratedCopy — the loop', () => {
  test('a clean first attempt is used, unconstrained, with no retry', async () => {
    const calls = [];
    const r = await gateGeneratedCopy(async (c) => { calls.push(c); return CLEAN; }, { extract: EXTRACT });
    assert.equal(r.ok, true);
    assert.deepEqual(r.proposed, CLEAN);
    assert.equal(r.attempts, 1);
    assert.deepEqual(calls, ['']);
  });

  test('a first-attempt violation costs a RETRY, not the candidate', async () => {
    const calls = [];
    const r = await gateGeneratedCopy(async (c) => { calls.push(c); return calls.length === 1 ? DIRTY : CLEAN; }, { extract: EXTRACT });
    assert.equal(r.ok, true);
    assert.deepEqual(r.proposed, CLEAN);
    assert.equal(r.attempts, 2);
  });

  test('the retry prompt names the exact words that tripped', async () => {
    const calls = [];
    await gateGeneratedCopy(async (c) => { calls.push(c); return calls.length === 1 ? DIRTY : CLEAN; }, { extract: EXTRACT });
    assert.equal(calls[0], '');
    assert.match(calls[1], /Heals/i);
    assert.match(calls[1], /Eczema/i);
    assert.match(calls[1], /cosmetic/i);
  });

  test('exactly one retry — a second violation is not retried again', async () => {
    let n = 0;
    const r = await gateGeneratedCopy(async () => { n++; return DIRTY; }, { extract: EXTRACT });
    assert.equal(n, 2);
    assert.equal(r.attempts, 2);
    assert.equal(r.ok, false);
    assert.equal(r.proposed, null);
    assert.deepEqual(r.rejected, DIRTY);
  });

  test('advisory-tier language never triggers a retry', async () => {
    const calls = [];
    const r = await gateGeneratedCopy(
      async (c) => { calls.push(c); return { seo_title: 'Toxic Chemicals In Soap To Keep An Eye On', body_html: '<p>Which toxins to avoid.</p>' }; },
      { extract: EXTRACT },
    );
    assert.equal(r.ok, true);
    assert.equal(calls.length, 1);
    assert.ok(r.advisory.some((v) => v.category === 'toxicity'));
  });
});

describe('gateGeneratedCopy — fail closed on malformed output', () => {
  test('a null return does not become a write of undefined over live copy', async () => {
    const r = await gateGeneratedCopy(async () => null, { extract: EXTRACT, required: ['title'] });
    assert.equal(r.ok, false);
    assert.equal(r.proposed, null);
    assert.ok(r.violations.some((v) => v.category === 'malformed'));
  });

  test('a missing REQUIRED body fails even when the title is clean', async () => {
    const r = await gateGeneratedCopy(async () => ({ seo_title: 'Fine Title' }), { extract: EXTRACT, required: ['title', 'body'] });
    assert.equal(r.ok, false);
    assert.deepEqual(r.violations.map((v) => v.field), ['body']);
  });

  test('a field that is merely optional and absent is not a violation', async () => {
    const r = await gateGeneratedCopy(async () => ({ seo_title: 'Fine Title' }), { extract: EXTRACT, required: ['title'] });
    assert.equal(r.ok, true);
  });

  test('a malformed return is never argued with in the retry constraint', async () => {
    const calls = [];
    await gateGeneratedCopy(async (c) => { calls.push(c); return null; }, { extract: EXTRACT, required: ['title'] });
    assert.equal(calls.length, 2);
    assert.equal(calls[1], '', 'there is no word to name, so there is no constraint to send');
  });

  test('a caller with no extract is a programming error, not a silent pass', async () => {
    await assert.rejects(() => gateGeneratedCopy(async () => CLEAN, {}), TypeError);
  });
});

describe('checkSeoCopyFields — arbitrary named fields', () => {
  test('the field NAME is what the report shows, so callers name the surface', () => {
    const r = checkSeoCopyFields({ 'product title': 'Wound Care Balm' });
    assert.equal(r.ok, false);
    assert.equal(r.blocking[0].field, 'product title');
  });

  test('checkSeoCopy is the two-field special case of it', () => {
    const a = checkSeoCopy({ title: 'Heals fast', meta: 'x' });
    const b = checkSeoCopyFields({ title: 'Heals fast', meta: 'x' });
    assert.deepEqual(a, b);
  });

  test('a bare STRING passed to checkSeoCopy still returns ok — which is why nobody may pass one', () => {
    // Pinned deliberately: this is the trap the named-field API exists to close.
    // If this ever starts failing, checkSeoCopy grew string handling and the
    // warning in lib/seo-copy-health-gate.js should be revisited.
    assert.equal(checkSeoCopy('Coconut Lotion That Heals Eczema').ok, true);
    assert.equal(checkSeoCopyFields({ title: 'Coconut Lotion That Heals Eczema' }).ok, false);
  });

  test('markup is stripped before matching, and tags become a space not nothing', () => {
    assert.equal(plainText('<li>pre</li><li>vent</li>'), 'pre vent');
    assert.equal(checkSeoCopyFields({ body: '<li>pre</li><li>vent</li>' }).ok, true, 'two harmless fragments must not be glued into a claim nobody wrote');
    assert.equal(checkSeoCopyFields({ body: '<p>It <em>prevents</em> odour.</p>' }).ok, false, 'a claim split by an inline tag must still be caught');
  });

  test('a script block cannot smuggle a claim past the reader-facing check', () => {
    assert.equal(plainText('<script>var x = "heals";</script><p>Clean.</p>'), 'Clean.');
  });

  test('an empty field set is ok, and an all-empty one too', () => {
    assert.equal(checkSeoCopyFields({}).ok, true);
    assert.equal(checkSeoCopyFields({ title: null, meta: undefined, body: '  ' }).ok, true);
  });
});

describe('the two digest renderers say different things', () => {
  const one = [{ label: 'Tattoo Soap', resource: 'collections/tattoo', violations: [{ field: 'meta description_tag', match: 'healing' }] }];

  test('the retry renderer says the retry was spent', () => {
    const lines = renderGateSkipLines([{ keyword: 'best soap for tattoos', pageUrl: '/x', violations: one[0].violations }]);
    assert.match(lines[0], /one permitted retry/);
  });

  test('the refusal renderer says regeneration was impossible, and that nothing was deleted', () => {
    const lines = renderGateRefusalLines(one);
    assert.doesNotMatch(lines[0], /retry/);
    assert.match(lines[0], /cannot regenerate/);
    assert.match(lines[0], /not dismissed, not deleted/);
    assert.match(lines[1], /Tattoo Soap/);
    assert.match(lines[1], /healing/);
  });

  test('both are empty on a clean run — a normal run gains no noise', () => {
    assert.deepEqual(renderGateSkipLines([]), []);
    assert.deepEqual(renderGateRefusalLines([]), []);
  });
});
