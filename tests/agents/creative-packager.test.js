// tests/agents/creative-packager.test.js
import { strict as assert } from 'node:assert';
import {
  placementSizes,
  formatCopyFile,
  formatSpecsFile,
  buildStylePrompt,
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

console.log('✓ creative-packager unit tests pass');
