// tests/agents/creative-packager.test.js
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  placementSizes,
  formatCopyFile,
  formatSpecsFile,
  buildStylePrompt,
  buildReferenceQuery,
  buildCopyBrief,
  buildCopyPrompt,
  loadPersonas,
  formatManifest,
  ALL_PLACEMENTS, sizesByName, safeZonesFor, buildGuideSvg,
} from '../../agents/creative-packager/index.js';

// placementSizes — instagram only
{
  const sizes = placementSizes(['instagram']);
  const keys = sizes.map(s => s.name);
  assert.ok(keys.includes('instagram-feed-1080x1080'), 'must include instagram feed square');
  assert.ok(keys.includes('instagram-feed-1080x1350'), 'must include instagram feed portrait');
  assert.ok(keys.includes('instagram-stories-1080x1920'), 'must include instagram stories');
  assert.ok(!keys.some(k => k.startsWith('facebook')), 'must not include facebook if not in platforms');
}

// placementSizes — facebook only
{
  const sizes = placementSizes(['facebook']);
  const keys = sizes.map(s => s.name);
  assert.ok(keys.includes('facebook-feed-1200x628'), 'must include facebook feed landscape');
  assert.ok(keys.includes('facebook-feed-1080x1080'), 'must include facebook feed square');
  assert.ok(keys.includes('facebook-stories-1080x1920'), 'must include facebook stories');
  assert.ok(!keys.some(k => k.startsWith('instagram')), 'must not include instagram');
}

// placementSizes — both platforms
{
  const sizes = placementSizes(['facebook', 'instagram']);
  const keys = sizes.map(s => s.name);
  assert.ok(keys.some(k => k.startsWith('facebook')));
  assert.ok(keys.some(k => k.startsWith('instagram')));
}

// placementSizes — unknown platform (graceful empty)
{
  const sizes = placementSizes(['audience_network']);
  assert.ok(Array.isArray(sizes));
}

// placementSizes — each size has width and height
{
  for (const s of placementSizes(['instagram', 'facebook'])) {
    assert.ok(typeof s.width === 'number', `${s.name} missing width`);
    assert.ok(typeof s.height === 'number', `${s.name} missing height`);
  }
}

// formatCopyFile
{
  const variations = [
    { headline: 'H1', body: 'B1', cta: 'CTA1', placement: 'instagram-feed' },
    { headline: 'H2', body: 'B2', cta: 'CTA2', placement: 'facebook-feed' },
  ];
  const text = formatCopyFile(variations);
  assert.ok(text.includes('H1'));
  assert.ok(text.includes('B2'));
  assert.ok(text.includes('Variation'));
}

// formatSpecsFile
{
  const sizes = placementSizes(['instagram']);
  const text = formatSpecsFile(sizes);
  assert.ok(text.includes('1080'));
  assert.ok(text.includes('instagram'));
  assert.ok(text.includes('px') || text.includes('×') || text.includes('x'));
}

// buildStylePrompt — contains key instructions
{
  const ad = {
    adCreativeBody: 'Stay fresh all day',
    adCreativeLinkTitle: 'Shop now',
    analysis: { messagingAngle: 'Social proof', whyEffective: 'Because...' },
  };
  const prompt = buildStylePrompt(ad);
  assert.ok(prompt.includes('Stay fresh all day'));
  assert.ok(prompt.includes('Gemini'));
  assert.ok(prompt.includes('mood') || prompt.includes('color') || prompt.includes('style'));
}

// buildReferenceQuery — uses job override when provided
{
  const ad = { pageSlug: 'natural-deodorant', analysis: { messagingAngle: 'Stay fresh' } };
  assert.equal(buildReferenceQuery(ad, { referenceQuery: 'custom query' }), 'custom query');
}

// buildReferenceQuery — derives from pageSlug + messaging angle
{
  const ad = { pageSlug: 'natural-deodorant', analysis: { messagingAngle: 'Stay fresh' } };
  const q = buildReferenceQuery(ad);
  assert.ok(q.includes('natural deodorant'));
  assert.ok(q.includes('Stay fresh'));
  assert.ok(q.includes('photography'));
}

// buildReferenceQuery — falls back when pageSlug + analysis are missing
{
  assert.ok(buildReferenceQuery({}).includes('natural skincare'));
}

// buildCopyBrief — maps ad fields
{
  const ad = {
    pageName: 'Sensitive Skin Set',
    landingUrl: 'https://www.realskincare.com/products/sensitive-skin-set',
    adCreativeBody: 'Gentle for reactive skin',
    analysis: { messagingAngle: 'gentle', copyInsights: 'social proof' },
  };
  const b = buildCopyBrief(ad);
  assert.equal(b.product, 'Sensitive Skin Set');
  assert.equal(b.angle, 'gentle');
  assert.equal(b.destinationUrl, 'https://www.realskincare.com/products/sensitive-skin-set');
  assert.equal(b.competitorBody, 'Gentle for reactive skin');
  assert.equal(b.copyInsights, 'social proof');
}

// buildCopyBrief — falls back safely
{
  const b = buildCopyBrief({});
  assert.equal(b.product, 'Real Skin Care');
  assert.equal(typeof b.angle, 'string');
  assert.equal(b.destinationUrl, '');
}

// buildCopyPrompt — includes product/angle and JSON instruction; tolerates missing fields
{
  const p = buildCopyPrompt({ product: 'Coconut Lotion', angle: 'dry skin', destinationUrl: '' });
  assert.ok(p.includes('Coconut Lotion'));
  assert.ok(p.includes('dry skin'));
  assert.ok(p.includes('JSON'));
  assert.ok(!p.includes('undefined'));
}

// formatManifest — shape + empty destinationUrl becomes null
{
  const sizes = placementSizes(['instagram']);
  const brief = { product: 'X', angle: 'a', destinationUrl: '' };
  const m = JSON.parse(formatManifest(brief, sizes, '2026-07-23T00:00:00Z'));
  assert.equal(m.product, 'X');
  assert.equal(m.destinationUrl, null);
  assert.ok(Array.isArray(m.placements) && m.placements.length === sizes.length);
  assert.equal(m.generatedAt, '2026-07-23T00:00:00Z');
}

// ALL_PLACEMENTS has all six
{
  assert.equal(ALL_PLACEMENTS.length, 6);
  const names = ALL_PLACEMENTS.map(s => s.name);
  assert.ok(names.includes('instagram-stories-1080x1920'));
  assert.ok(names.includes('facebook-feed-1200x628'));
}

// sizesByName filters to requested, in ALL_PLACEMENTS order, ignoring unknowns
{
  const got = sizesByName(['facebook-feed-1200x628', 'instagram-feed-1080x1080', 'bogus']);
  assert.equal(got.length, 2);
  assert.ok(got.every(s => typeof s.width === 'number'));
  assert.ok(got.some(s => s.name === 'instagram-feed-1080x1080'));
}

// safeZonesFor: stories get big top/bottom; feed gets ~6% margins
{
  const story = safeZonesFor('instagram-stories-1080x1920');
  assert.ok(story.top >= 200 && story.bottom >= 300, 'story reserves UI margins');
  const feed = safeZonesFor('facebook-feed-1080x1080');
  assert.ok(feed.top > 0 && feed.top < 200);
  const unknown = safeZonesFor('nope');
  assert.deepEqual(unknown, { top: 0, bottom: 0, left: 0, right: 0 });
}

// buildGuideSvg: contains copy text, safe-zone marker, correct dims
{
  const size = { name: 'instagram-stories-1080x1920', width: 1080, height: 1920 };
  const svg = buildGuideSvg(size, { headline: 'Fresh All Day', body: 'Coconut clean', cta: 'Shop Now' });
  assert.ok(svg.includes('width="1080"') && svg.includes('height="1920"'));
  assert.ok(svg.includes('Fresh All Day'));
  assert.ok(svg.includes('Coconut clean'));
  assert.ok(svg.includes('Shop Now'));
  assert.ok(svg.includes('SAFE ZONE'));
  assert.ok(svg.trim().startsWith('<svg'));
}

// buildGuideSvg escapes XML-special chars in copy
{
  const size = { name: 'facebook-feed-1080x1080', width: 1080, height: 1080 };
  const svg = buildGuideSvg(size, { headline: 'Tom & Jerry', body: '<b>', cta: 'Go' });
  assert.ok(svg.includes('Tom &amp; Jerry'));
  assert.ok(!svg.includes('<b>'));
}

const PERSONAS = {
  personas: [
    {
      id: 'eczema-flare-parent',
      name: 'The eczema flare parent',
      summary: 'Buys for a child whose skin reacts to everything.',
      angles: [
        { id: 'steroid-off-ramp', label: 'The steroid-cream off-ramp', awareness: 'problem-aware',
          objection_addressed: 'Will natural actually work?', proof: '97 reviews at 4.91',
          hook_examples: ['Off the steroid cream in three weeks'], source_quotes: ['q'] },
      ],
    },
    {
      id: 'ingredient-reader',
      name: 'The ingredient reader',
      summary: 'Reads every label.',
      angles: [
        { id: 'four-ingredients', label: 'Four ingredients, that is it', awareness: 'solution-aware',
          objection_addressed: 'What is actually in it?', proof: 'Full INCI on the PDP',
          hook_examples: ['Four ingredients. Read them out loud.'], source_quotes: ['q'] },
      ],
    },
  ],
};

const AD = {
  pageName: 'Rival Brand',
  pageSlug: 'rival-brand',
  landingUrl: 'https://realskincare.com/products/coconut-lotion',
  adCreativeBody: 'Competitor body copy',
  analysis: { messagingAngle: 'competitor-derived angle', copyInsights: 'insight' },
};

test('buildCopyBrief falls back to the competitor angle when no personas exist', () => {
  const brief = buildCopyBrief(AD, { personas: null });
  assert.equal(brief.angle, 'competitor-derived angle');
  assert.equal(brief.persona, undefined);
});

test('buildCopyBrief defaults to the top-ranked persona angle when personas exist', () => {
  const brief = buildCopyBrief(AD, { personas: PERSONAS });
  assert.equal(brief.angle, 'The steroid-cream off-ramp');
  assert.equal(brief.persona, 'The eczema flare parent');
  assert.equal(brief.awareness, 'problem-aware');
});

test('buildCopyBrief honours an explicit personaId and angleId', () => {
  const brief = buildCopyBrief(AD, {
    personas: PERSONAS, personaId: 'ingredient-reader', angleId: 'four-ingredients',
  });
  assert.equal(brief.angle, 'Four ingredients, that is it');
  assert.equal(brief.persona, 'The ingredient reader');
});

test('buildCopyBrief drops the competitor reference copy once a persona drives the angle', () => {
  const brief = buildCopyBrief(AD, { personas: PERSONAS });
  assert.ok(!brief.competitorBody, 'reference ad should drive style only, not copy');
});

test('buildCopyBrief throws on an unknown personaId rather than silently defaulting', () => {
  assert.throws(
    () => buildCopyBrief(AD, { personas: PERSONAS, personaId: 'nope' }),
    /nope/,
  );
});

test('buildCopyPrompt surfaces the persona and objection to the model', () => {
  const brief = buildCopyBrief(AD, { personas: PERSONAS });
  const prompt = buildCopyPrompt(brief);
  assert.match(prompt, /The eczema flare parent/);
  assert.match(prompt, /Will natural actually work\?/);
});

// loadPersonas — a persona with no angles would reach persona.angles[0] in
// buildCopyBrief and throw a bare TypeError inside a live creative job.
function personasRoot(payload) {
  const root = mkdtempSync(join(tmpdir(), 'packager-'));
  mkdirSync(join(root, 'data', 'context'), { recursive: true });
  writeFileSync(join(root, 'data', 'context', 'personas.json'), JSON.stringify(payload), 'utf8');
  return root;
}

test('loadPersonas drops personas with no usable angles', () => {
  const root = personasRoot({
    personas: [
      { id: 'no-angles', name: 'No angles', angles: [] },
      { id: 'missing-angles', name: 'Missing angles' },
      PERSONAS.personas[1],
    ],
  });
  const loaded = loadPersonas(root);
  assert.deepEqual(loaded.personas.map((p) => p.id), ['ingredient-reader']);
  // and the survivor is usable end-to-end, not just present
  assert.equal(buildCopyBrief(AD, { personas: loaded }).angle, 'Four ingredients, that is it');
});

test('loadPersonas returns null when no persona has an angle, so callers degrade', () => {
  const root = personasRoot({ personas: [{ id: 'no-angles', name: 'No angles', angles: [] }] });
  assert.equal(loadPersonas(root), null);
  // degradation path: the competitor angle, exactly as before personas existed
  assert.equal(buildCopyBrief(AD, { personas: loadPersonas(root) }).angle, 'competitor-derived angle');
});

test('loadPersonas returns null when personas.json is absent', () => {
  assert.equal(loadPersonas(mkdtempSync(join(tmpdir(), 'packager-'))), null);
});

// ── health claims are withheld from the copy writer, on the way IN ────────────
//
// buildCopyBrief hands persona.name, persona.summary, angle.label, objection_addressed,
// proof and hook_examples straight to Claude. personas.json is generated monthly by an LLM
// reading real reviews, and the live 2026-07-27 file named steroids, prescriptions and
// eczema in every one of those fields on its TOP-RANKED persona — the default. Catching
// that at the health-claims gate after the copy call is detection without prevention; the
// same lesson selectQuotableReviews already encodes for reviews.
//
// The fixture above is deliberately that shape: "The eczema flare parent" whose only angle
// is "The steroid-cream off-ramp".

test('loadPersonas withholds a persona whose name and angles carry health claims', () => {
  const root = personasRoot(PERSONAS);
  const loaded = loadPersonas(root);
  assert.deepEqual(loaded.personas.map((p) => p.id), ['ingredient-reader'],
    'the eczema/steroid persona must never reach a copy prompt');
  // Fall back to the NEXT persona rather than to no persona at all.
  const brief = buildCopyBrief(AD, { personas: loaded });
  assert.equal(brief.angle, 'Four ingredients, that is it');
  assert.equal(brief.persona, 'The ingredient reader');
  assert.ok(!buildCopyPrompt(brief).match(/steroid|eczema/i), 'nothing withheld may survive into the prompt');
});

test('loadPersonas strips only the offending hook and keeps the angle', () => {
  const root = personasRoot({
    personas: [{
      id: 'p1', name: 'The dry skin buyer', summary: 'Nothing has worked.',
      angles: [{
        id: 'p1a1', label: 'Tried everything', awareness: 'problem-aware',
        objection_addressed: 'Why would this be different?', proof: 'Reviewers say it lasts all day',
        hook_examples: ['I tried everything — until this.', 'It healed my cracked hands.'],
        source_quotes: ['q'],
      }],
    }],
  });
  const loaded = loadPersonas(root);
  assert.deepEqual(loaded.personas[0].angles[0].hook_examples, ['I tried everything — until this.']);
  assert.match(buildCopyPrompt(buildCopyBrief(AD, { personas: loaded })), /I tried everything/);
});

test('loadPersonas returns null when EVERY persona is withheld, so callers degrade', () => {
  const root = personasRoot({ personas: [PERSONAS.personas[0]] });
  assert.equal(loadPersonas(root), null, 'never an empty persona set, never a throw');
  // Same documented degradation as a missing file: the competitor angle.
  assert.equal(buildCopyBrief(AD, { personas: loadPersonas(root) }).angle, 'competitor-derived angle');
});

console.log('✓ creative-packager unit tests pass');
