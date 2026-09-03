import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { applySwaps, renderQuote, SLOTS, UNANSWERED, SECTION } from '../../scripts/map-testimonial-objections.mjs';
import { checkSeoCopyFields } from '../../lib/seo-copy-health-gate.js';
import { hasHealthClaim } from '../../agents/ad-studio/health-claims.js';

const swap = SLOTS.find((s) => s.change);

const liveTemplate = () => ({
  sections: {
    [SECTION]: {
      blocks: {
        'ugc-1': { type: 'column', settings: { image: 'a.jpg', title: swap.change.fromName, text: swap.change.fromBody } },
        'ugc-2': { type: 'column', settings: { image: 'b.jpg', title: 'Ariel M.', text: '<p>"unchanged"</p>' } },
        'ugc-3': { type: 'column', settings: { image: 'c.jpg', title: 'Michaela', text: '<p>"unchanged"</p>' } },
        'ugc-4': { type: 'column', settings: { image: 'd.jpg', title: 'Nicole H.', text: '<p>"unchanged"</p>' } },
      },
      block_order: ['ugc-1', 'ugc-2', 'ugc-3', 'ugc-4'],
    },
  },
});

test('every slot names an objection it answers', () => {
  for (const s of SLOTS) assert.ok(s.objection && s.objection.length > 8, s.slot);
});

test('NO TWO SLOTS ANSWER THE SAME OBJECTION', () => {
  // The defect this whole change exists to fix: 4 of 5 slots were on
  // greasy/absorption, so three of them bought nothing.
  const seen = SLOTS.map((s) => s.objection);
  assert.equal(new Set(seen).size, seen.length, `duplicate objection: ${seen.join(' | ')}`);
});

test('each quote actually contains the evidence for its objection', () => {
  // An objection nothing in the quote supports is a label, not a job.
  for (const s of SLOTS) {
    assert.ok(s.evidence.length, `${s.slot} has no evidence`);
    for (const e of s.evidence) {
      const hay = s.body.replace(/&amp;/g, '&').replace(/[’']/g, "'");
      assert.ok(hay.includes(e.replace(/[’']/g, "'")), `${s.slot}: quote lacks evidence "${e}"`);
    }
  }
});

test('the objections are real ones from voice-of-customer research, not invented', () => {
  const voc = readFileSync(new URL('../../data/context/voice-of-customer.md', import.meta.url), 'utf8').toLowerCase();
  const anchors = ['greasy', 'scent', 'ingredient', 'cerave', 'comedogenic'];
  for (const a of anchors) assert.ok(voc.includes(a), `VOC should discuss "${a}"`);
});

test('every quote passes both health gates', () => {
  for (const s of SLOTS) {
    assert.equal(checkSeoCopyFields({ t: s.body }).ok, true, s.slot);
    assert.equal(hasHealthClaim(s.body), false, s.slot);
  }
});

test('a swapped-in quote is verbatim and carries provenance', () => {
  assert.ok(swap.source, 'a swap must record where the quote came from');
  assert.equal(swap.source.rating, 5);
  assert.ok(swap.source.verified && swap.source.verified !== 'nothing',
    'never feature an unverified review — the surfaces claim "verified customer"');
  assert.equal(renderQuote(swap.body), `<p>"${swap.body}"</p>`);
});

test('unverified reviews are excluded even when they answer a gap', () => {
  // The one quote answering the comedogenic objection is verified:"nothing".
  const pores = UNANSWERED.find((u) => /comedogenic/.test(u.objection));
  assert.ok(pores, 'the pores objection must be recorded as unanswered');
  assert.match(pores.why, /verified/);
  assert.ok(!SLOTS.some((s) => /clog|pore/i.test(s.body)), 'that quote must not be live');
});

test('unanswered objections are recorded with a route to fixing them', () => {
  assert.ok(UNANSWERED.length >= 2);
  for (const u of UNANSWERED) {
    assert.ok(u.objection && u.why && u.fix, `${u.objection} needs why + fix`);
    assert.ok(Number.isInteger(u.mentions), u.objection);
  }
});

test('the swap is applied and the other three slots are untouched', () => {
  const before = liveTemplate();
  const { template, applied } = applySwaps(before);
  assert.equal(applied.length, 1);
  const b = (t, id) => t.sections[SECTION].blocks[id].settings;
  assert.equal(b(template, 'ugc-1').title, swap.name);
  assert.equal(b(template, 'ugc-1').text, renderQuote(swap.body));
  for (const id of ['ugc-2', 'ugc-3', 'ugc-4']) assert.deepEqual(b(template, id), b(before, id));
});

test('photos never move', () => {
  const before = liveTemplate();
  const { template } = applySwaps(before);
  for (const id of ['ugc-1', 'ugc-2', 'ugc-3', 'ugc-4']) {
    assert.equal(template.sections[SECTION].blocks[id].settings.image, before.sections[SECTION].blocks[id].settings.image);
  }
});

test('re-running is a no-op', () => {
  const once = applySwaps(liveTemplate()).template;
  const again = applySwaps(once);
  assert.equal(again.applied.length, 0);
  assert.equal(again.skipped[0].why, 'already applied');
});

test('a drifted block is skipped, never overwritten', () => {
  const t = liveTemplate();
  t.sections[SECTION].blocks['ugc-1'].settings.text = '<p>"hand edited"</p>';
  const { template, applied, skipped } = applySwaps(t);
  assert.equal(applied.length, 0);
  assert.equal(skipped[0].why, 'live value matches neither BEFORE nor AFTER');
  assert.equal(template.sections[SECTION].blocks['ugc-1'].settings.text, '<p>"hand edited"</p>');
});

test('no reviewer PII in the map', () => {
  const blob = JSON.stringify(SLOTS);
  assert.doesNotMatch(blob, /@/);
  assert.doesNotMatch(blob, /\b\d{10,}\b/);
});
