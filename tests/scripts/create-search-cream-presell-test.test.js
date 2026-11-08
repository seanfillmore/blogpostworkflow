import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { copyProblems, buildOperations, AD_GROUPS, NAME, finalUrl, URL_SUFFIX } from '../../scripts/create-search-cream-presell-test.mjs';

const content = JSON.parse(readFileSync(new URL('../../data/presell/coconut-cream/content.json', import.meta.url), 'utf8'));

test('the ad copy passes every check', () => {
  assert.deepEqual(copyProblems(), []);
});

test('copyProblems catches length, dashes, claims and a 7-ingredient total on the wrong scent', () => {
  const bad = [{ name: 'x', variant: 'coconut', path: ['a', 'b'], keywords: [], headlines: ['A headline that is far too long to fit', 'Heals Dry Skin — Fast', 'Just 7 Ingredients'], descriptions: ['ok one', 'ok two'] }];
  const p = copyProblems(bad, []).join('\n');
  assert.match(p, /chars > 30/);
  assert.match(p, /dash/);
  assert.match(p, /claim gate/);
  assert.match(p, /claims 7 ingredients total on a scent that has 8/);
});

test('every ad lands on the pre-sell page with a headline variant the page knows', () => {
  const keys = new Set(content.headlineVariants.map((v) => v.key));
  for (const g of AD_GROUPS) assert.ok(keys.has(g.variant), `no headline variant "${g.variant}" in content.json`);
  const unscented = content.headlineVariants.find((v) => v.key === 'unscented');
  assert.equal(unscented.scent, 'Pure Unscented');
  assert.equal(finalUrl('coconut'), 'https://www.realskincare.com/pages/coconut-body-cream?v=coconut');
  assert.match(URL_SUFFIX, /utm_campaign=gsearch-cream-presell/);
});

test('operations: one PAUSED Search campaign, Google Search only, exact keywords, manual CPC under break-even', () => {
  const ops = buildOperations('customers/1');
  const camp = ops.find((o) => o.campaignOperation).campaignOperation.create;
  assert.equal(camp.name, NAME);
  assert.ok(NAME.startsWith('RSC | '), 'shopping-test-monitor watches "RSC | " campaigns');
  assert.equal(camp.status, 'PAUSED');
  assert.equal(camp.advertisingChannelType, 'SEARCH');
  assert.deepEqual(camp.networkSettings, { targetGoogleSearch: true, targetSearchNetwork: false, targetContentNetwork: false, targetPartnerSearchNetwork: false });
  assert.ok(camp.manualCpc);
  const kws = ops.filter((o) => o.adGroupCriterionOperation).map((o) => o.adGroupCriterionOperation.create.keyword);
  assert.equal(kws.length, AD_GROUPS.reduce((n, g) => n + g.keywords.length, 0));
  assert.ok(kws.every((k) => k.matchType === 'EXACT'));
  for (const g of ops.filter((o) => o.adGroupOperation)) assert.ok(g.adGroupOperation.create.cpcBidMicros <= 550000, 'bid above the ~$0.55 break-even click value');
  const ads = ops.filter((o) => o.adGroupAdOperation).map((o) => o.adGroupAdOperation.create.ad);
  assert.equal(ads.length, AD_GROUPS.length);
  assert.ok(ads.every((a) => /\/pages\/coconut-body-cream\?v=[a-z-]+$/.test(a.finalUrls[0])));
});
