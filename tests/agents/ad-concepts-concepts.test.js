// tests/agents/ad-concepts-concepts.test.js
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  normalizeConcept, parseConceptsResponse, preGate, parseJudgeResponse, pickConcepts, nextReplacement,
  buildConceptPrompt, FAMILIES, checkClaimsSourced,
} from '../../agents/ad-concepts/concepts.js';

const raw = (o = {}) => ({
  id: 'the-receipt', title: 'The Receipt', picture: 'A soap box spews an endless receipt down the hallway.',
  anchor: 'the endless pharmacy receipt', twist: 'it is a soap ingredient list', family: 'scale-gag',
  productRole: 'our bar sits calm beside a thumb-length slip', sceneText: 'illegible-print', people: 'none',
  typeBand: 'top', awareness: 'problem', headlineIdea: "Your soap's ingredient list.",
  claims: [{ text: 'one fat', sourceId: 'pdp' }], ...o,
});
const sourceIndex = { pdp: 'One fat: organic virgin coconut oil, cold-pressed and unrefined, turned into soap.' };
const ctx = { sourceIndex, competitorNames: ['Native', "Schmidt's Naturals"] };

test('normalizeConcept coerces enums and rejects incomplete entries', () => {
  const c = normalizeConcept(raw({ family: 'Weird New Thing', sceneText: 'lots', people: 'crowd', typeBand: 'middle' }), 0);
  assert.equal(c.family, 'other');
  assert.equal(c.sceneText, 'none');
  assert.equal(c.people, 'face', 'unknown people value takes the strict reading: a person is present');
  assert.equal(c.typeBand, 'top');
  assert.equal(normalizeConcept(raw({ picture: '' }), 0), null);
  assert.equal(normalizeConcept(raw({ family: 'template:us-vs-them' }), 0).family, 'template:us-vs-them');
});

test('parseConceptsResponse de-duplicates ids and tolerates prose around the JSON', () => {
  const text = `Here you go:\n${JSON.stringify({ concepts: [raw(), raw({ title: 'Dup' }), raw({ id: '' , title: 'No Id Given' })] })}`;
  const out = parseConceptsResponse(text);
  assert.deepEqual(out.map(c => c.id), ['the-receipt', 'the-receipt-2', 'no-id-given']);
  assert.throws(() => parseConceptsResponse('no json here'), /no JSON/);
});

test('preGate passes a category jab and drops each banned shape with a reason', () => {
  assert.deepEqual(preGate(normalizeConcept(raw(), 0), ctx), { ok: true, reasons: [] });
  const cases = [
    [{ twist: 'it cures eczema overnight' }, /health/],
    [{ headlineIdea: 'Our antiperspirant, reinvented' }, /antiperspirant|category/i],
    [{ picture: 'A Native deodorant stick in an evidence bag' }, /competitor/],
    [{ picture: 'Before and after shots of an armpit' }, /before\/after/],
    [{ claims: [{ text: 'clinically proven', sourceId: 'pdp' }] }, /unsourced|claim/i],
  ];
  for (const [o, re] of cases) {
    const r = preGate(normalizeConcept(raw(o), 0), ctx);
    assert.equal(r.ok, false, JSON.stringify(o));
    assert.match(r.reasons.join(' '), re);
  }
});

test('parseJudgeResponse clamps scores and totals them', () => {
  const out = parseJudgeResponse(JSON.stringify({ scores: [
    { i: 0, thumbStop: 5, oneSecondRead: 4, productClarity: 4, renderability: 3, brandFit: 4 },
    { i: 1, thumbStop: 9, oneSecondRead: -2, productClarity: 'x', renderability: 3, brandFit: 3 },
  ] }), 2);
  assert.equal(out[0].total, 20);
  assert.deepEqual(out[1].scores, { thumbStop: 5, oneSecondRead: 1, productClarity: 1, renderability: 3, brandFit: 3 });
});

test('pickConcepts: requested first, then best by total with distinct families', () => {
  const mk = (id, family, total, requested = false) => ({ ...normalizeConcept(raw({ id, family }), 0), total, requested });
  const scored = [
    mk('a', 'scale-gag', 22), mk('b', 'scale-gag', 21), mk('c', 'genre-parody', 20),
    mk('d', 'other', 19), mk('e', 'other', 18), mk('mine', 'scale-gag', 5, true),
  ];
  const { picked, runnersUp } = pickConcepts(scored, { slots: 3 });
  assert.deepEqual(picked.map(c => c.id), ['mine', 'c', 'd'], 'requested takes a slot; scale-gag then used; two "other" never both');
  assert.deepEqual(runnersUp.map(c => c.id), ['a', 'b', 'e']);
  assert.equal(nextReplacement(runnersUp, new Set(['scale-gag', 'genre-parody'])).id, 'e', "'e' is family other, unused");
  assert.equal(nextReplacement([mk('p', 'product-art', 10)], new Set(['scale-gag'])).id, 'p');
  assert.equal(nextReplacement([mk('q', 'scale-gag', 10)], new Set(['scale-gag'])), null);
});

test('the concept prompt carries the rules and the operator ideas', () => {
  const p = buildConceptPrompt({
    product: { title: 'Moisturizing Coconut Soap', handle: 'coconut-soap' }, catalogEntry: {}, pdpBody: 'One fat.',
    brandKit: {}, persona: null, reviews: [], tactics: 'TACTICS MENU', requested: ['a dog sniffing the bar'], count: 18,
    sourceIds: ['pdp', 'catalog'],
  });
  for (const re of [/never an antiperspirant/i, /named competitor/i, /before\/after/i, /em dash/i, /a dog sniffing the bar/, /TACTICS MENU/, /"concepts"/]) {
    assert.match(p, re);
  }
  for (const f of FAMILIES) assert.match(p, new RegExp(f));
});

test('prompt demands verbatim claim quotes', () => {
  const p = buildConceptPrompt({ product: { title: 'T', handle: 't' }, catalogEntry: {}, pdpBody: '', brandKit: {}, persona: null, reviews: [], tactics: '', requested: [], count: 3, sourceIds: ['pdp'] });
  assert.match(p, /EXACT contiguous quote/);
});

test('claim text is screened for health claims', () => {
  const idx = { ...sourceIndex, reviews: 'I tried prescription strength lotions and nothing worked.' };
  const r = preGate(normalizeConcept(raw({ claims: [{ text: 'tried prescription strength lotions', sourceId: 'reviews' }] }), 0), { ...ctx, sourceIndex: idx });
  assert.equal(r.ok, false);
  assert.match(r.reasons.join(' '), /health/);
});

test('competitor match is case-sensitive and spares our own family wording', () => {
  assert.equal(preGate(normalizeConcept(raw({ picture: 'a native-feed screenshot of a soap' }), 0), ctx).ok, true);
  assert.equal(preGate(normalizeConcept(raw({ picture: 'a native look, shot on a phone' }), 0), ctx).ok, true);
  assert.equal(preGate(normalizeConcept(raw({ picture: 'A Native deodorant stick in an evidence bag' }), 0), ctx).ok, false);
});

test('overflow requested concepts head the runners-up', () => {
  const mk = (id, requested) => ({ ...normalizeConcept(raw({ id, family: id }), 0), total: 1, requested });
  const { picked, runnersUp } = pickConcepts([mk('r1', true), mk('r2', true), mk('x', false)], { slots: 1 });
  assert.deepEqual(picked.map(c => c.id), ['r1']);
  assert.equal(runnersUp[0].id, 'r2');
});

test('checkClaimsSourced is directly usable', () => {
  assert.deepEqual(checkClaimsSourced([{ text: 'one fat', sourceId: 'pdp' }], sourceIndex), { ok: true, reasons: [] });
  const bad = checkClaimsSourced([{ text: 'made on the moon', sourceId: 'pdp' }], sourceIndex);
  assert.equal(bad.ok, false);
  assert.match(bad.reasons[0], /unsourced claim/);
});
