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
  const bad = gateCopy({ headline: 'Our antiperspirant heals — seven words long here now', sub: '' }, [{ text: 'clinically proven', sourceId: 'pdp' }], { sourceIndex });
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
