import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderCampaign, campaignCopy } from '../../lib/email-campaign.js';
import { CAMPAIGNS } from '../../scripts/klaviyo-designed-campaigns.mjs';

test('every designed campaign renders inside the brand palette with no dashes', () => {
  for (const c of Object.values(CAMPAIGNS)) {
    const html = renderCampaign(c);
    assert.ok(!/[–—]/.test(html), 'no em/en dash');
    assert.ok(html.includes('{% unsubscribe_link %}'));
    assert.ok(html.includes('class="col'), 'columns carry the stacking class');
    assert.ok(html.includes('max-width: 480px'), 'the stacking media query reaches <head>');
  }
});

test('an unknown section type throws instead of rendering nothing', () => {
  assert.throws(() => renderCampaign({ preheader: 'x', sections: [{ type: 'nope' }] }), /unknown campaign section/);
});

test('an off-palette colour is refused by the shared renderer', () => {
  assert.throws(() => renderCampaign({ preheader: 'x', sections: [{ type: 'text', html: '<span style="color:#123456">x</span>' }] }), /off-palette/);
});

test('the gate sees every visible string, including product cards', () => {
  const copy = campaignCopy(CAMPAIGNS.holiday);
  assert.ok(Object.values(copy).includes('Lip Balm'));
  assert.ok(Object.values(copy).includes('Order by Thursday, Dec 10 for Christmas delivery'));
});
