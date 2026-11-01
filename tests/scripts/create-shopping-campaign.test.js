import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildShoppingCampaignOperations, MASTER_NEGATIVES_SHARED_SET } from '../../scripts/create-shopping-campaign.mjs';

const build = (extra = {}) => buildShoppingCampaignOperations({
  customer: '123', name: 'Toothpaste', budget: 5, bid: 0.3, items: ['shopify_US_1_2', 'rsc_pack_3'], enable: false, ...extra,
});

test('copies the audited settings: manual CPC, US presence, master negatives attached', () => {
  const ops = build();
  const camp = ops.find((o) => o.campaignOperation).campaignOperation.create;
  assert.equal(camp.name, 'RSC | Shopping Test | Toothpaste');
  assert.equal(camp.status, 'PAUSED');
  assert.deepEqual(camp.manualCpc, { enhancedCpcEnabled: false });
  assert.equal(camp.geoTargetTypeSetting.positiveGeoTargetType, 'PRESENCE');
  assert.equal(ops.find((o) => o.campaignCriterionOperation).campaignCriterionOperation.create.location.geoTargetConstant, 'geoTargetConstants/2840');
  assert.match(ops.find((o) => o.campaignSharedSetOperation).campaignSharedSetOperation.create.sharedSet, new RegExp(`${MASTER_NEGATIVES_SHARED_SET}$`));
  assert.equal(ops.find((o) => o.campaignBudgetOperation).campaignBudgetOperation.create.amountMicros, 5_000_000);
});

test('each item is a biddable unit (lower-cased), everything else excluded', () => {
  const units = build().map((o) => o.adGroupCriterionOperation?.create).filter((c) => c?.listingGroup?.type === 'UNIT');
  const bidding = units.filter((u) => !u.negative);
  assert.deepEqual(bidding.map((u) => u.listingGroup.caseValue.productItemId.value), ['shopify_us_1_2', 'rsc_pack_3']);
  assert.ok(bidding.every((u) => u.cpcBidMicros === 300_000));
  const other = units.filter((u) => u.negative);
  assert.equal(other.length, 1);
  assert.deepEqual(other[0].listingGroup.caseValue.productItemId, {});
  const ids = units.map((u) => u.resourceName);
  assert.equal(new Set(ids).size, ids.length);
});

test('--enable creates it enabled; bad input refuses', () => {
  assert.equal(build({ enable: true }).find((o) => o.campaignOperation).campaignOperation.create.status, 'ENABLED');
  assert.throws(() => build({ items: [] }), /at least one/);
  assert.throws(() => build({ bid: 0 }), /positive/);
});
