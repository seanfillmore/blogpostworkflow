#!/usr/bin/env node
/**
 * Fix Shopping Test targeting (2026-07-25)
 *
 * Applies the structural fixes from the Shopping-test analysis:
 *
 *   1. Bidding TARGET_SPEND (Maximize Clicks) -> MANUAL_CPC, cap $0.65
 *      Maximize Clicks was buying the cheapest inventory available, which is why
 *      68% of traceable spend went to Spanish-language, competitor-brand and
 *      wrong-product queries. Manual CPC activates the (currently dormant) $0.40
 *      listing-group bids, which we raise to the $0.65 cap.
 *   2. Location = United States (neither campaign had ANY location criteria).
 *      NOTE: Standard Shopping campaigns reject campaign-level LANGUAGE criteria
 *      (OPERATION_NOT_PERMITTED_FOR_CONTEXT, trigger SHOPPING), so the Spanish
 *      spend leak — 30% of traceable spend — is closed with Spanish negative
 *      keywords in the shared set instead.
 *   3. Shared negative keyword list built from the 113 negatives stranded on the
 *      legacy paused campaigns + competitor/wrong-product additions, attached to
 *      both campaigns (Pure Unscented had zero negatives).
 *   4. Fold Pure Unscented's $6/day into Coconut Breeze: pause PU, CB budget
 *      $4 -> $10/day. CB has 4.5x the impression pool at half the CPC.
 *
 * Pure Unscented still gets the full config treatment so it is correct if it is
 * ever re-enabled.
 *
 * Usage:
 *   node scripts/fix-shopping-test-targeting.mjs            # dry run (default)
 *   node scripts/fix-shopping-test-targeting.mjs --apply
 */

import { gaqlQuery, mutate } from '../lib/google-ads.js';

const APPLY = process.argv.includes('--apply');

const CPC_CAP_MICROS = 650_000;      // $0.65
const CB_BUDGET_MICROS = 10_000_000; // $10/day (absorbs PU's $6)

const GEO_UNITED_STATES = 'geoTargetConstants/2840';

const SHARED_SET_NAME = 'RSC | Shopping — Master Negatives';

// Queries the campaigns MUST stay eligible for. Any legacy negative that would
// block one of these is dropped rather than inherited blindly.
const CORE_QUERIES = [
  'coconut oil body lotion',
  'coconut body lotion',
  'coconut oil lotion',
  'natural body lotion',
  'unscented body lotion',
  'body lotion for dry skin',
  'non toxic body lotion',
  'clean body lotion',
  'coconut oil moisturizing cream',
  'coconut oil for body',
];

// Additions from the search-term report: competitor brands + wrong-product terms.
const NEW_NEGATIVES = [
  // competitor brands seen or likely in the auction
  ['nivea', 'PHRASE'],
  ['the ordinary', 'PHRASE'],
  ['aveeno', 'PHRASE'],
  ['cerave', 'PHRASE'],
  ['eucerin', 'PHRASE'],
  ['jergens', 'PHRASE'],
  ['vaseline', 'PHRASE'],
  ['gold bond', 'PHRASE'],
  ['cetaphil', 'PHRASE'],
  ['lubriderm', 'PHRASE'],
  ['olay', 'PHRASE'],
  ['dove', 'PHRASE'],
  ['bath and body works', 'PHRASE'],
  // wrong product / wrong intent
  ['cocoa butter', 'PHRASE'],
  ['shea butter', 'PHRASE'],
  ['face cream', 'PHRASE'],
  ['facial', 'PHRASE'],
  ['for face', 'PHRASE'],
  ['face treatment', 'PHRASE'],
  ['sunscreen', 'PHRASE'],
  ['hand cream', 'PHRASE'],
  ['tanning', 'PHRASE'],
  ['self tanner', 'PHRASE'],
  ['hair', 'PHRASE'],
  ['baby', 'PHRASE'],
  ['garden', 'PHRASE'],
  // research / non-commercial
  ['diy', 'PHRASE'],
  ['homemade', 'PHRASE'],
  ['recipe', 'PHRASE'],
  ['how to make', 'PHRASE'],
  ['free sample', 'PHRASE'],
  ['wholesale', 'PHRASE'],
  ['coupon', 'PHRASE'],
  // retail poaching
  ['walmart', 'PHRASE'],
  ['target', 'PHRASE'],
  ['amazon', 'PHRASE'],
  ['costco', 'PHRASE'],
  ['cvs', 'PHRASE'],
  ['walgreens', 'PHRASE'],
  // Spanish-language queries. Standard Shopping campaigns cannot take a
  // campaign-level LANGUAGE criterion, so the leak is closed lexically. These
  // are the high-frequency Spanish stems for this product category.
  ['crema', 'PHRASE'],
  ['cremas', 'PHRASE'],
  ['piel', 'PHRASE'],
  ['reseca', 'PHRASE'],
  ['mejor', 'PHRASE'],
  ['para la', 'PHRASE'],
  ['aceite de coco', 'PHRASE'],
  ['cuerpo', 'PHRASE'],
  ['humectante', 'PHRASE'],
  ['hidratante', 'PHRASE'],
  ['locion', 'PHRASE'],
  ['loción', 'PHRASE'],
  ['natural para', 'PHRASE'],
  ['comprar', 'PHRASE'],
  ['precio', 'PHRASE'],
];

// ── helpers ───────────────────────────────────────────────────────────────────

const norm = (s) => String(s || '').toLowerCase().trim().replace(/\s+/g, ' ');

/**
 * Would this negative keyword block one of our core queries?
 * PHRASE: blocks if the negative appears as a contiguous phrase in the query.
 * EXACT:  blocks only on an exact string match.
 * BROAD:  blocks if every word of the negative appears anywhere in the query.
 */
export function blocksCoreQuery(text, matchType, coreQueries = CORE_QUERIES) {
  const neg = norm(text);
  if (!neg) return false;
  return coreQueries.some((q) => {
    const query = norm(q);
    if (matchType === 'EXACT') return query === neg;
    if (matchType === 'PHRASE') return query.includes(neg);
    const words = neg.split(' ');
    return words.every((w) => query.split(' ').includes(w));
  });
}

function log(...a) { console.log(...a); }

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  log(`\n=== Fix Shopping Test targeting — ${APPLY ? 'APPLY' : 'DRY RUN'} ===\n`);

  // Resolve live resource names rather than hardcoding them.
  const campaigns = await gaqlQuery(`
    SELECT campaign.id, campaign.name, campaign.resource_name, campaign.status,
           campaign.bidding_strategy_type, campaign_budget.resource_name,
           campaign_budget.amount_micros
    FROM campaign
    WHERE campaign.name LIKE 'RSC | Shopping Test | Lotion%' AND campaign.status != 'REMOVED'`);

  const cb = campaigns.find((c) => c.campaign.name.includes('Coconut Breeze'));
  const pu = campaigns.find((c) => c.campaign.name.includes('Pure Unscented'));
  if (!cb || !pu) throw new Error(`Expected both lotion campaigns; found ${campaigns.length}`);

  const adGroups = await gaqlQuery(`
    SELECT campaign.id, ad_group.resource_name, ad_group.cpc_bid_micros
    FROM ad_group
    WHERE campaign.name LIKE 'RSC | Shopping Test | Lotion%'`);

  const listingUnits = await gaqlQuery(`
    SELECT campaign.id, ad_group_criterion.resource_name, ad_group_criterion.cpc_bid_micros
    FROM ad_group_criterion
    WHERE campaign.name LIKE 'RSC | Shopping Test | Lotion%'
      AND ad_group_criterion.type = 'LISTING_GROUP'
      AND ad_group_criterion.negative = FALSE
      AND ad_group_criterion.listing_group.type = 'UNIT'`);

  const forCampaign = (rows, id) => rows.filter((r) => r.campaign.id === id);

  // Already-applied state, so a re-run does not duplicate criteria.
  const locRows = await gaqlQuery(`
    SELECT campaign.id FROM campaign_criterion
    WHERE campaign.name LIKE 'RSC | Shopping Test | Lotion%' AND campaign_criterion.type = 'LOCATION'`);
  const existingLocations = new Set(locRows.map((r) => r.campaign.id));

  // ── 1. Gather + vet negatives ───────────────────────────────────────────────
  const legacy = await gaqlQuery(`
    SELECT campaign_criterion.keyword.text, campaign_criterion.keyword.match_type
    FROM campaign_criterion
    WHERE campaign_criterion.negative = TRUE AND campaign_criterion.type = 'KEYWORD'`);

  const seen = new Set();
  const keep = [];
  const dropped = [];
  for (const [text, matchType] of [
    ...legacy.map((r) => [r.campaignCriterion.keyword.text, r.campaignCriterion.keyword.matchType]),
    ...NEW_NEGATIVES,
  ]) {
    const key = `${norm(text)}::${matchType}`;
    if (!text || seen.has(key)) continue;
    seen.add(key);
    if (blocksCoreQuery(text, matchType)) { dropped.push([text, matchType]); continue; }
    keep.push([text, matchType]);
  }

  log(`Negatives: ${keep.length} to add (${legacy.length} legacy found, ${NEW_NEGATIVES.length} new, ${dropped.length} dropped as unsafe)`);
  for (const [t, m] of dropped) log(`  DROPPED (would block a core query): ${m} "${t}"`);

  // ── 2. Build campaign-level operations ──────────────────────────────────────
  const ops = [];
  const plan = [];

  for (const c of [cb, pu]) {
    const id = c.campaign.id;
    const name = c.campaign.name.split('| ').pop();
    const res = c.campaign.resourceName;

    // Bidding: TARGET_SPEND -> MANUAL_CPC. The field mask must name the LEAF
    // field — masking 'manual_cpc' alone fails with FIELD_HAS_SUBFIELDS.
    if (c.campaign.biddingStrategyType !== 'MANUAL_CPC') {
      ops.push({
        campaignOperation: {
          update: { resourceName: res, manualCpc: { enhancedCpcEnabled: false } },
          updateMask: 'manual_cpc.enhanced_cpc_enabled',
        },
      });
      plan.push(`[${name}] bidding ${c.campaign.biddingStrategyType} -> MANUAL_CPC (enhanced off)`);
    }

    // Location targeting. Shopping campaigns reject LANGUAGE criteria, so only
    // location is set here; Spanish traffic is handled by negatives.
    if (!existingLocations.has(id)) {
      ops.push({
        campaignCriterionOperation: {
          create: { campaign: res, location: { geoTargetConstant: GEO_UNITED_STATES } },
        },
      });
      plan.push(`[${name}] + location targeting: United States`);
    }

    // Bids: ad-group default and the serving listing-group unit -> $0.65.
    for (const ag of forCampaign(adGroups, id)) {
      ops.push({
        adGroupOperation: {
          update: { resourceName: ag.adGroup.resourceName, cpcBidMicros: String(CPC_CAP_MICROS) },
          updateMask: 'cpc_bid_micros',
        },
      });
      plan.push(`[${name}] ad group default bid ${(Number(ag.adGroup.cpcBidMicros) / 1e6).toFixed(2)} -> $0.65`);
    }
    for (const lu of forCampaign(listingUnits, id)) {
      const before = Number(lu.adGroupCriterion.cpcBidMicros || 0) / 1e6;
      ops.push({
        adGroupCriterionOperation: {
          update: { resourceName: lu.adGroupCriterion.resourceName, cpcBidMicros: String(CPC_CAP_MICROS) },
          updateMask: 'cpc_bid_micros',
        },
      });
      plan.push(`[${name}] listing-group bid $${before.toFixed(2)} -> $0.65`);
    }
  }

  // ── 3. Budget consolidation ─────────────────────────────────────────────────
  if (Number(cb.campaignBudget.amountMicros) !== CB_BUDGET_MICROS) {
    ops.push({
      campaignBudgetOperation: {
        update: { resourceName: cb.campaignBudget.resourceName, amountMicros: String(CB_BUDGET_MICROS) },
        updateMask: 'amount_micros',
      },
    });
    plan.push(`[Coconut Breeze] budget $${(Number(cb.campaignBudget.amountMicros) / 1e6).toFixed(2)} -> $10.00/day`);
  }

  if (pu.campaign.status !== 'PAUSED') {
    ops.push({
      campaignOperation: {
        update: { resourceName: pu.campaign.resourceName, status: 'PAUSED' },
        updateMask: 'status',
      },
    });
    plan.push(`[Pure Unscented] status ${pu.campaign.status} -> PAUSED (budget folded into Coconut Breeze)`);
  }

  log('\nPlanned changes:');
  for (const p of plan) log(`  - ${p}`);
  log(`  - shared negative list "${SHARED_SET_NAME}" with ${keep.length} keywords, attached to both campaigns`);

  if (!APPLY) {
    log('\nDry run — nothing applied. Re-run with --apply.\n');
    return;
  }

  // ── 4. Apply: shared negative list first (3 dependent calls) ────────────────
  log('\nApplying...');

  // Reuse the shared set if a prior run already created it.
  const existingSets = await gaqlQuery(`
    SELECT shared_set.resource_name, shared_set.name FROM shared_set
    WHERE shared_set.type = 'NEGATIVE_KEYWORDS' AND shared_set.status = 'ENABLED'`);
  let sharedSet = existingSets.find((s) => s.sharedSet.name === SHARED_SET_NAME)?.sharedSet.resourceName;

  if (sharedSet) {
    log(`  reusing shared set ${sharedSet}`);
  } else {
    const setRes = await mutate([
      { sharedSetOperation: { create: { name: SHARED_SET_NAME, type: 'NEGATIVE_KEYWORDS' } } },
    ]);
    sharedSet = setRes.mutateOperationResponses[0].sharedSetResult.resourceName;
    log(`  created shared set ${sharedSet}`);
  }

  // Only add negatives that are not already in the set.
  const present = new Set(
    (await gaqlQuery(`
      SELECT shared_criterion.keyword.text, shared_criterion.keyword.match_type
      FROM shared_criterion WHERE shared_set.resource_name = '${sharedSet}'`))
      .map((r) => `${norm(r.sharedCriterion.keyword.text)}::${r.sharedCriterion.keyword.matchType}`)
  );
  const toAdd = keep.filter(([t, m]) => !present.has(`${norm(t)}::${m}`));
  log(`  ${present.size} negatives already in set, ${toAdd.length} to add`);

  // Shared criteria in chunks — the API caps operations per request.
  for (let i = 0; i < toAdd.length; i += 100) {
    const chunk = toAdd.slice(i, i + 100);
    await mutate(chunk.map(([text, matchType]) => ({
      sharedCriterionOperation: { create: { sharedSet, keyword: { text, matchType } } },
    })));
    log(`  added negatives ${i + 1}-${i + chunk.length}`);
  }

  // Attach only where not already attached.
  const attached = new Set(
    (await gaqlQuery(`
      SELECT campaign.id FROM campaign_shared_set
      WHERE campaign.name LIKE 'RSC | Shopping Test | Lotion%'`)).map((r) => r.campaign.id)
  );
  const toAttach = [cb, pu].filter((c) => !attached.has(c.campaign.id));
  if (toAttach.length) {
    await mutate(toAttach.map((c) => ({
      campaignSharedSetOperation: { create: { campaign: c.campaign.resourceName, sharedSet } },
    })));
    log(`  attached shared set to ${toAttach.length} campaign(s)`);
  } else {
    log(`  shared set already attached to both campaigns`);
  }

  // ── 5. Apply: campaign structural changes ───────────────────────────────────
  if (ops.length) {
    await mutate(ops);
    log(`  applied ${ops.length} campaign/bid/targeting operations`);
  } else {
    log(`  no campaign/bid/targeting changes needed`);
  }

  log('\nDone. Verifying...\n');
  await verify();
}

async function verify() {
  const rows = await gaqlQuery(`
    SELECT campaign.name, campaign.status, campaign.bidding_strategy_type, campaign_budget.amount_micros
    FROM campaign WHERE campaign.name LIKE 'RSC | Shopping Test | Lotion%'`);
  for (const r of rows) {
    log(`  ${r.campaign.name.split('| ').pop().padEnd(18)} ${String(r.campaign.status).padEnd(8)} ${String(r.campaign.biddingStrategyType).padEnd(12)} $${(Number(r.campaignBudget.amountMicros) / 1e6).toFixed(2)}/day`);
  }

  const crit = await gaqlQuery(`
    SELECT campaign.name, campaign_criterion.type
    FROM campaign_criterion
    WHERE campaign.name LIKE 'RSC | Shopping Test | Lotion%'
      AND campaign_criterion.type IN ('LANGUAGE','LOCATION')`);
  log(`  language/location criteria now present: ${crit.length}`);

  const sets = await gaqlQuery(`
    SELECT campaign.name, shared_set.name FROM campaign_shared_set
    WHERE campaign.name LIKE 'RSC | Shopping Test | Lotion%'`);
  for (const s of sets) log(`  ${s.campaign.name.split('| ').pop()} <- "${s.sharedSet.name}"`);

  const bids = await gaqlQuery(`
    SELECT campaign.name, ad_group_criterion.cpc_bid_micros
    FROM ad_group_criterion
    WHERE campaign.name LIKE 'RSC | Shopping Test | Lotion%'
      AND ad_group_criterion.type = 'LISTING_GROUP' AND ad_group_criterion.negative = FALSE
      AND ad_group_criterion.listing_group.type = 'UNIT'`);
  for (const b of bids) {
    log(`  ${b.campaign.name.split('| ').pop().padEnd(18)} listing bid $${(Number(b.adGroupCriterion.cpcBidMicros || 0) / 1e6).toFixed(2)}`);
  }
}

// Only run when executed directly — the guard keeps blocksCoreQuery importable
// from tests without firing a live API call.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error('\nFAILED:', e.message); process.exit(1); });
}
