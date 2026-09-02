import test from 'node:test';
import assert from 'node:assert/strict';

import {
  mergeSoapCards, serializeTemplate,
  SECTION_ID, NEW_BLOCK_ID, DROPPED_BLOCKS, COLUMNS_DESKTOP, SOAP_CARD,
} from '../../scripts/merge-homepage-soap-cards.mjs';

/** The live homepage section as measured on 2026-09-02, before the merge. */
const liveTemplate = () => ({
  sections: {
    hero: { type: 'hero-landing-section' },
    [SECTION_ID]: {
      type: 'multicolumn',
      settings: { columns_desktop: 4, columns_mobile: '2', image_ratio: 'square' },
      blocks: {
        'prod-lotion': { type: 'column', settings: { title: 'Body Lotion' } },
        'prod-cream': { type: 'column', settings: { title: 'Body Cream' } },
        'prod-toothpaste': { type: 'column', settings: { title: 'Toothpaste' } },
        'prod-deodorant': { type: 'column', settings: { title: 'Deodorant' } },
        'prod-liquidsoap': { type: 'column', settings: { title: 'Liquid Soap' } },
        'prod-barsoap': { type: 'column', settings: { title: 'Bar Soap' } },
        'prod-lipbalm': { type: 'column', settings: { title: 'Lip Balm' } },
      },
      block_order: ['prod-lotion', 'prod-cream', 'prod-toothpaste', 'prod-deodorant',
        'prod-liquidsoap', 'prod-barsoap', 'prod-lipbalm'],
    },
  },
});

const titles = (t) => t.sections[SECTION_ID].block_order.map((id) => t.sections[SECTION_ID].blocks[id].settings.title);

test('Soap keeps its place between Deodorant and Lip Balm', () => {
  const { template } = mergeSoapCards(liveTemplate());
  assert.deepEqual(titles(template), [
    'Body Lotion', 'Body Cream', 'Toothpaste', 'Deodorant', 'Soap', 'Lip Balm',
  ]);
  // Appending would put Soap after Lip Balm and contradict the header, which
  // PR #755 set to ... Deodorant · Soap · Lip Balm.
  assert.equal(titles(template)[4], 'Soap');
});

test('both soap card blocks are removed, not just reordered', () => {
  const { template, dropped } = mergeSoapCards(liveTemplate());
  const blocks = template.sections[SECTION_ID].blocks;
  for (const id of DROPPED_BLOCKS) assert.ok(!(id in blocks), `${id} should be gone`);
  assert.deepEqual(dropped, DROPPED_BLOCKS);
  assert.equal(Object.keys(blocks).length, 6);
});

test('the new card points at the collection, not a PDP', () => {
  const { template } = mergeSoapCards(liveTemplate());
  const card = template.sections[SECTION_ID].blocks[NEW_BLOCK_ID];
  assert.match(card.settings.text, /href="\/collections\/soap"/);
  assert.doesNotMatch(card.settings.text, /\/products\//);
  assert.equal(card.settings.title, 'Soap');
});

test('six cards get an even 3+3 desktop grid instead of a 4+2 orphan row', () => {
  const { template } = mergeSoapCards(liveTemplate());
  const s = template.sections[SECTION_ID];
  assert.equal(s.settings.columns_desktop, COLUMNS_DESKTOP);
  assert.equal(s.block_order.length % COLUMNS_DESKTOP, 0);
  // mobile is untouched and still divides evenly
  assert.equal(s.settings.columns_mobile, '2');
});

test('re-running on a merged template is a no-op', () => {
  const once = mergeSoapCards(liveTemplate()).template;
  const again = mergeSoapCards(once);
  assert.equal(again.changed, false);
  assert.deepEqual(titles(again.template), titles(once));
  assert.equal(again.template.sections[SECTION_ID].block_order.filter((id) => id === NEW_BLOCK_ID).length, 1);
});

test('the input template is never mutated', () => {
  const input = liveTemplate();
  const snapshot = JSON.stringify(input);
  mergeSoapCards(input);
  assert.equal(JSON.stringify(input), snapshot);
});

test('other sections and other cards are left alone', () => {
  const { template } = mergeSoapCards(liveTemplate());
  assert.ok(template.sections.hero);
  assert.equal(template.sections[SECTION_ID].blocks['prod-lotion'].settings.title, 'Body Lotion');
  assert.equal(template.sections[SECTION_ID].settings.image_ratio, 'square');
});

test('a missing section is refused rather than silently guessed at', () => {
  assert.throws(() => mergeSoapCards({ sections: { hero: {} } }), /not found/);
});

test('serializing an UNCHANGED template round-trips byte-identically', () => {
  // The guard that keeps the upload diff to the two cards. Plain JSON.stringify
  // does not escape `/`, which rewrites all 350 lines of the live template and
  // buries the real edit. Verified against the live file on 2026-09-02.
  const live = '{\n  "sections": {\n    "hero": {\n      "cta": "\\/products\\/x"\n    }\n  }\n}\n';
  assert.equal(serializeTemplate(JSON.parse(live)), live);
});

test('the new card\'s own link survives serialization escaped, not doubled', () => {
  const { template } = mergeSoapCards(liveTemplate());
  const text = serializeTemplate(template);
  assert.ok(text.includes('\\/collections\\/soap'), 'link should be escaped once');
  assert.ok(!text.includes('\\\\/'), 'no double-escaping');
  assert.deepEqual(JSON.parse(text).sections[SECTION_ID].block_order.length, 6);
});

test('the card copy names all three formats the collection holds', () => {
  for (const word of ['Bar', 'liquid', 'refill']) {
    assert.match(SOAP_CARD.settings.text, new RegExp(word));
  }
});
