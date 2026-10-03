import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { parseOverlayCopy, gateCopy, writeOverlayCopy, writeFlexibleCopy, buildOverlayCopyPrompt } from '../../agents/ad-concepts/copy.js';

const sourceIndex = { pdp: 'One fat: organic virgin coconut oil, cold-pressed and unrefined, turned into soap.' };
const concept = { id: 'the-receipt', title: 'The Receipt', picture: 'An endless receipt.', twist: 'ingredient list', headlineIdea: "Your soap's ingredient list.", awareness: 'problem' };
const product = { handle: 'coconut-soap', title: 'Moisturizing Coconut Soap' };
const reply = (obj) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(obj) }] });
const scripted = (...replies) => { const calls = []; return { calls, messages: { create: async (req) => { calls.push(req); return replies.shift(); } } }; };

test('gateCopy rejects em dash, health claims, misnomers, overlong lines and unsourced claims', () => {
  assert.deepEqual(gateCopy({ headline: "Your soap's ingredient list.", sub: 'Ours: one fat.' }, [{ text: 'one fat', sourceId: 'pdp' }], { sourceIndex }), { ok: true, reasons: [] });
  const bad = gateCopy({ headline: 'Our antiperspirant stick heals — seven words long here now', sub: '' }, [{ text: 'clinically proven', sourceId: 'pdp' }], { sourceIndex });
  assert.equal(bad.ok, false);
  const r = bad.reasons.join(' | ');
  for (const re of [/em dash/, /health/i, /antiperspirant|category/i, /headline has \d+ words/, /unsourced/i]) assert.match(r, re);
});

test('gateCopy gates Ad Studio shaped claims (with evidence) through assertClaimsSourced', () => {
  const ok = gateCopy({ primaryText1: 'x' }, [{ zone: 'primaryText1', text: 'one fat', factual: true, sourceId: 'pdp', evidence: 'One fat: organic virgin coconut oil' }], { sourceIndex });
  assert.equal(ok.ok, true);
  const bad = gateCopy({ primaryText1: 'x' }, [{ zone: 'primaryText1', text: 'y', factual: true, sourceId: 'pdp', evidence: 'made on the moon' }], { sourceIndex });
  assert.equal(bad.ok, false);
  assert.match(bad.reasons.join(' '), /unsourced/i);
});

test('parseOverlayCopy reads the JSON', () => {
  assert.deepEqual(parseOverlayCopy('x {"headline":"A","sub":"B","claims":[]} y'), { headline: 'A', sub: 'B', claims: [] });
});

test('writeOverlayCopy regenerates once naming the failure, then succeeds', async () => {
  const anthropic = scripted(
    reply({ headline: 'Clean — finally', sub: '', claims: [] }),
    reply({ headline: "Your soap's ingredient list.", sub: 'Ours: one fat.', claims: [{ text: 'one fat', sourceId: 'pdp' }] }),
  );
  const r = await writeOverlayCopy({ anthropic, model: 'm', concept, product, pdpBody: '', sourceIndex });
  assert.equal(r.ok, true);
  assert.equal(r.copy.headline, "Your soap's ingredient list.");
  assert.match(anthropic.calls[1].messages[0].content, /em dash/);
});

test('writeOverlayCopy gives up after the second failure', async () => {
  const anthropic = scripted(reply({ headline: 'a — b', sub: '', claims: [] }), reply({ headline: 'c — d', sub: '', claims: [] }));
  const r = await writeOverlayCopy({ anthropic, model: 'm', concept, product, pdpBody: '', sourceIndex });
  assert.equal(r.ok, false);
});

test('a truncated copy response throws', async () => {
  const anthropic = scripted({ stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"headline":"' }] });
  await assert.rejects(() => writeOverlayCopy({ anthropic, model: 'm', concept, product, pdpBody: '', sourceIndex }), /cut off/);
});

test('writeFlexibleCopy gates primary texts and headlines the same way', async () => {
  const good = { primaryTexts: ['One fat. Organic virgin coconut oil, turned into soap. That is the whole ingredient story.', 'Swap the ingredient list for one fat. Coconut oil soap, made in small batches.'], headlines: ['One fat. Real soap.', 'Coconut oil soap'], claims: [{ text: 'one fat', sourceId: 'pdp' }] };
  const anthropic = scripted(reply(good));
  const r = await writeFlexibleCopy({ anthropic, model: 'm', product, concepts: [concept, concept, concept], sourceIndex, pdpBody: '', persona: null, reviews: [] });
  assert.equal(r.ok, true);
  assert.equal(r.primaryTexts.length, 2);
});

test('writeFlexibleCopy rejects an em dash and retries once', async () => {
  const mk = (t) => ({ primaryTexts: [t, 'Swap the ingredient list for one fat. Coconut oil soap.'], headlines: ['One fat. Real soap.', 'Coconut oil soap'], claims: [] });
  const anthropic = scripted(reply(mk('One fat — that is all.')), reply(mk('One fat. That is all.')));
  const r = await writeFlexibleCopy({ anthropic, model: 'm', product, concepts: [concept, concept, concept], sourceIndex, pdpBody: '' });
  assert.equal(r.ok, true);
  assert.match(anthropic.calls[1].messages[0].content, /em dash/);
});

test('buildOverlayCopyPrompt states the word limit and the verbatim-quote rule', () => {
  const p = buildOverlayCopyPrompt({ concept, product, pdpBody: '', sourceIds: ['pdp'] });
  assert.match(p, /6 words or fewer/);
  assert.match(p, /EXACT contiguous quote/);
  assert.match(p, /letter for letter/);
});

// ── final-review fixes ────────────────────────────────────────────────────────

test('gateCopy rejects a named competitor (case-sensitive proper noun), not the ordinary word', () => {
  const bad = gateCopy({ headline: 'Gentler than Piperwai.', sub: '' }, [], { sourceIndex, competitorNames: ['Piperwai', 'Native'] });
  assert.equal(bad.ok, false);
  assert.match(bad.reasons.join(' '), /names a competitor: Piperwai/);
  const fine = gateCopy({ headline: 'A native-screenshot joke.', sub: '' }, [], { sourceIndex, competitorNames: ['Native'] });
  assert.equal(fine.ok, true);
});

test('writeOverlayCopy regenerates once when the first attempt names a competitor', async () => {
  const anthropic = scripted(
    reply({ headline: 'Better than Native.', sub: '', claims: [] }),
    reply({ headline: "Your soap's ingredient list.", sub: '', claims: [] }),
  );
  const r = await writeOverlayCopy({ anthropic, model: 'm', concept, product, pdpBody: '', sourceIndex, competitorNames: ['Native'] });
  assert.equal(r.ok, true);
  assert.match(anthropic.calls[1].messages[0].content, /names a competitor: Native/);
});

test('writeFlexibleCopy rejects a competitor in a primary text and retries once', async () => {
  const mk = (t) => ({ primaryTexts: [t, 'Swap the ingredient list for one fat. Coconut oil soap.'], headlines: ['One fat. Real soap.', 'Coconut oil soap'], claims: [] });
  const anthropic = scripted(reply(mk('Weleda has a long list. Ours has one fat.')), reply(mk('Long lists are common. Ours has one fat.')));
  const r = await writeFlexibleCopy({ anthropic, model: 'm', product, concepts: [concept, concept], sourceIndex, pdpBody: '', competitorNames: ['Weleda'] });
  assert.equal(r.ok, true);
  assert.match(anthropic.calls[1].messages[0].content, /names a competitor: Weleda/);
});

test('writeFlexibleCopy prompt carries the price and each image\'s on-image headline, and says the images carry text', async () => {
  const good = { primaryTexts: ['One fat. Organic virgin coconut oil, turned into soap.', 'Swap the ingredient list for one fat. Small batches.'], headlines: ['One fat. Real soap.', 'Coconut oil soap'], claims: [] };
  const anthropic = scripted(reply(good));
  const finals = [{ ...concept, overlayHeadline: "Your soap's ingredient list." }, { ...concept, id: 'two', title: 'Two', overlayHeadline: 'One fat.' }];
  const r = await writeFlexibleCopy({ anthropic, model: 'm', product: { ...product, priceLabel: '$12' }, concepts: finals, sourceIndex, pdpBody: '' });
  assert.equal(r.ok, true);
  const sent = anthropic.calls[0].messages[0].content;
  assert.match(sent, /\$12/);
  assert.doesNotMatch(sent, /undefined/);
  assert.match(sent, /on-image headline: "Your soap's ingredient list\."/);
  assert.match(sent, /on-image headline: "One fat\."/);
  assert.match(sent, /DO carry overlay text/);
});

const SELLING_PDP = 'Organic virgin coconut oil soap, cold pressed and unrefined, handmade in small batches in the USA. Gentle cleansing lather that rinses clean, leaves skin soft, never tight or dry. Fragrance free option, tea tree variant, nourishing moisturizing formula, biodegradable wrapper, plastic free packaging, long lasting bar, vegan cruelty free, family owned business, simple honest ingredients, sensitive skin friendly, everyday shower routine.';
const threaded = (t) => ({ primaryTexts: [t, 'Organic coconut oil soap. Cold pressed, gentle lather, handmade in small batches.'], headlines: ['One fat. Real soap.', 'Coconut oil soap'], claims: [] });

test('golden thread in a primary text: one shared regeneration naming it, then ships and records the finding', async () => {
  const anthropic = scripted(
    reply(threaded('Dinosaurs never bathed. Dinosaurs stomped volcanoes, dinosaurs roared at volcanoes.')),
    reply(threaded('Dinosaurs never bathed. Dinosaurs roared, dinosaurs stomped volcanoes all day.')),
  );
  const r = await writeFlexibleCopy({ anthropic, model: 'm', product, concepts: [concept, concept], sourceIndex, pdpBody: SELLING_PDP });
  assert.equal(anthropic.calls.length, 2, 'the golden thread shares the single regeneration');
  assert.match(anthropic.calls[1].messages[0].content, /GOLDEN THREAD/);
  assert.equal(r.ok, true, 'advisory: the second attempt ships');
  assert.equal(r.goldenThread.length, 1);
  assert.equal(r.goldenThread[0].primaryText, 1);
  assert.match(r.goldenThread[0].reason, /dinosaur/);
});

test('golden thread fixed on the retry: nothing recorded', async () => {
  const anthropic = scripted(
    reply(threaded('Dinosaurs never bathed. Dinosaurs stomped volcanoes, dinosaurs roared at volcanoes.')),
    reply(threaded('Dinosaurs never bathed. Organic coconut oil soap, cold pressed, gentle lather.')),
  );
  const r = await writeFlexibleCopy({ anthropic, model: 'm', product, concepts: [concept, concept], sourceIndex, pdpBody: SELLING_PDP });
  assert.equal(r.ok, true);
  assert.deepEqual(r.goldenThread, []);
});

// ── acceptance fix 2: rhetorical questions are not factual claims ────────────

test('writeFlexibleCopy: a question marked factual with no sourceId is rejected, the retry restates the rule, factual:false passes', async () => {
  const texts = ['Tried every lotion and still dry? Swap the soap first. One fat: organic virgin coconut oil.', 'Still dry? Swap the soap first. Coconut oil soap, one fat, small batches.'];
  const base = { primaryTexts: texts, headlines: ['One fat. Real soap.', 'Coconut oil soap'] };
  const anthropic = scripted(
    reply({ ...base, claims: [{ zone: 'primaryText1', text: 'Tried every lotion and still dry?', factual: true }] }),
    reply({ ...base, claims: [{ zone: 'primaryText1', text: 'Tried every lotion and still dry?', factual: false }, { zone: 'primaryText1', text: 'One fat', factual: true, sourceId: 'pdp', evidence: 'One fat: organic virgin coconut oil' }] }),
  );
  const r = await writeFlexibleCopy({ anthropic, model: 'm', product, concepts: [concept, concept, concept], sourceIndex, pdpBody: '' });
  assert.equal(r.ok, true, JSON.stringify(r.reasons));
  const first = anthropic.calls[0].messages[0].content;
  const second = anthropic.calls[1].messages[0].content;
  assert.match(first, /questions, hooks and persuasion lines are "factual": false/i);
  assert.match(second, /factual claim with no sourceId/);
  assert.match(second.split('YOUR PREVIOUS ATTEMPT WAS REJECTED')[1], /questions, hooks and persuasion lines are "factual": false/i);
});

test('writeFlexibleCopy does not weaken the gate: a factual:true claim with no evidence still fails twice', async () => {
  const base = { primaryTexts: ['One fat. Organic virgin coconut oil, turned into soap.', 'Swap the list for one fat. Coconut oil soap.'], headlines: ['One fat. Real soap.', 'Coconut oil soap'] };
  const bad = { ...base, claims: [{ zone: 'primaryText1', text: 'Dermatologist approved', factual: true, sourceId: 'pdp' }] };
  const anthropic = scripted(reply(bad), reply(bad));
  const r = await writeFlexibleCopy({ anthropic, model: 'm', product, concepts: [concept, concept, concept], sourceIndex, pdpBody: '' });
  assert.equal(r.ok, false);
  assert.match(r.reasons.join(' '), /no evidence quote|unsourced/);
});

// ── acceptance fix 2, review round 1 ─────────────────────────────────────────

test('gateCopy never throws on a bare-string claim: it goes down the strict path and is rejected', () => {
  let r;
  assert.doesNotThrow(() => { r = gateCopy({ headline: 'x' }, ['One fat', 42], { sourceIndex }); });
  assert.equal(r.ok, false);
  assert.match(r.reasons.join(' '), /unsourced/i);
});

test('only an explicit factual:false is persuasion: factual null / missing-with-zone stays factual and needs a source', () => {
  for (const factual of [null, 0, '', undefined]) {
    const claim = { zone: 'primaryText1', text: 'Dermatologist approved', factual };
    if (factual === undefined) delete claim.factual;
    const r = gateCopy({ primaryText1: 'x' }, [claim], { sourceIndex });
    assert.equal(r.ok, false, `factual=${JSON.stringify(factual)} must be gated`);
    assert.match(r.reasons.join(' '), /unsourced/i);
  }
  assert.equal(gateCopy({ primaryText1: 'x' }, [{ zone: 'primaryText1', text: 'Still dry?', factual: false }], { sourceIndex }).ok, true);
});
