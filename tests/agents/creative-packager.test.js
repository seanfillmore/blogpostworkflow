// tests/agents/creative-packager.test.js
import { strict as assert } from 'node:assert';
import {
  placementSizes,
  formatCopyFile,
  formatSpecsFile,
  buildStylePrompt,
  buildReferenceQuery,
  buildCopyBrief,
  buildCopyPrompt,
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

console.log('✓ creative-packager unit tests pass');
