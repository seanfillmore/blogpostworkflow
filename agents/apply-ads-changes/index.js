// agents/apply-ads-changes/index.js
/**
 * Apply Ads Changes Agent
 *
 * Reads today's suggestion file, applies approved changes to Google Ads
 * via the Mutate API, and updates suggestion statuses.
 *
 * stdout protocol: streams progress lines, final line is:
 *   DONE {"applied":N,"failed":N}
 *
 * Usage: node agents/apply-ads-changes/index.js [--date YYYY-MM-DD]
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');

// ── Pure exports (tested) ──────────────────────────────────────────────────────

export function filterApprovedSuggestions(data) {
  return (data.suggestions || []).filter(s => s.status === 'approved');
}

export function resolveEditValue(suggestion) {
  const edited = suggestion.editedValue;
  if (edited !== null && edited !== undefined && edited !== '') return edited;
  return suggestion.proposedChange?.suggested ?? '';
}

export function buildMutateOperation(suggestion) {
  const { type, proposedChange: pc } = suggestion;
  switch (type) {
    case 'keyword_pause':
      return {
        adGroupCriterionOperation: {
          update: { resourceName: pc.criterionResourceName, status: 'PAUSED' },
          updateMask: 'status',
        },
      };
    case 'keyword_add':
      return {
        adGroupCriterionOperation: {
          create: {
            adGroup: pc.adGroupResourceName,
            keyword: { text: pc.keyword, matchType: pc.matchType },
            status: 'ENABLED',
          },
        },
      };
    case 'negative_add':
      return {
        campaignCriterionOperation: {
          create: {
            campaign: pc.campaignResourceName,
            keyword: { text: pc.keyword, matchType: pc.matchType },
            negative: true,
          },
        },
      };
    case 'bid_adjust':
      return {
        adGroupOperation: {
          update: {
            resourceName: pc.adGroupResourceName,
            cpcBidMicros: String(pc.proposedCpcMicros),
          },
          updateMask: 'cpc_bid_micros',
        },
      };
    case 'copy_rewrite':
      // copy_rewrite requires a GAQL fetch of current headlines before mutating.
      // This is handled in applyCopyRewrite() below — not a pure buildMutateOperation call.
      throw new Error('copy_rewrite must be applied via applyCopyRewrite(), not buildMutateOperation()');
    case 'landing_page_update':
      // landing_page_update requires a GAQL fetch of ad resource names before mutating.
      // This is handled in applyLandingPageUpdate() below — not a pure buildMutateOperation call.
      throw new Error('landing_page_update must be applied via applyLandingPageUpdate(), not buildMutateOperation()');
    default:
      throw new Error(`Unknown suggestion type: ${type}`);
  }
}

export function parseDoneLine(line) {
  if (!line.startsWith('DONE ')) return null;
  try { return JSON.parse(line.slice(5)); } catch { return null; }
}

// ── Copy rewrite helper (requires API call) ────────────────────────────────────

async function applyCopyRewrite(suggestion, mutate, gaqlQuery) {
  const pc = suggestion.proposedChange;
  const newText = resolveEditValue(suggestion);

  // Fetch current RSA headlines/descriptions
  const query = `
    SELECT
      ad_group_ad.ad.responsive_search_ad.headlines,
      ad_group_ad.ad.responsive_search_ad.descriptions
    FROM ad_group_ad
    WHERE ad_group_ad.resource_name = '${pc.adGroupAdResourceName}'
  `;
  const rows = await gaqlQuery(query);
  if (!rows.length) throw new Error(`Ad not found: ${pc.adGroupAdResourceName}`);

  const currentAd = rows[0].ad_group_ad?.ad?.responsive_search_ad;
  const headlines = [...(currentAd?.headlines || [])];
  const descriptions = [...(currentAd?.descriptions || [])];

  // Determine field type and index (headline_4 → index 3, description_2 → index 1)
  const field = pc.field; // e.g. "headline_4"
  const match = field.match(/^(headline|description)_(\d+)$/);
  if (!match) throw new Error(`Unknown field format: ${field}`);
  const fieldType = match[1];
  const idx = parseInt(match[2], 10) - 1;

  if (fieldType === 'headline') {
    if (!headlines[idx]) throw new Error(`No headline at index ${idx}`);
    headlines[idx] = { ...headlines[idx], text: newText };
    return mutate([{
      adGroupAdOperation: {
        update: {
          resourceName: pc.adGroupAdResourceName,
          ad: { responsiveSearchAd: { headlines } },
        },
        updateMask: 'ad.responsive_search_ad.headlines',
      },
    }]);
  } else {
    if (!descriptions[idx]) throw new Error(`No description at index ${idx}`);
    descriptions[idx] = { ...descriptions[idx], text: newText };
    return mutate([{
      adGroupAdOperation: {
        update: {
          resourceName: pc.adGroupAdResourceName,
          ad: { responsiveSearchAd: { descriptions } },
        },
        updateMask: 'ad.responsive_search_ad.descriptions',
      },
    }]);
  }
}

// ── Landing page update helper (requires API call) ────────────────────────────

async function applyLandingPageUpdate(suggestion, mutate, gaqlQuery) {
  const pc = suggestion.proposedChange || {};

  // Get final URL — from proposedChange or parse from rationale
  let finalUrl = pc.finalUrl;
  if (!finalUrl) {
    const urlMatch = (suggestion.rationale || '').match(/https?:\/\/[^\s,)]+/);
    if (!urlMatch) throw new Error('landing_page_update: no target URL found in suggestion');
    finalUrl = urlMatch[0].replace(/[.,]+$/, '');
  }

  // Get campaign resource name — from proposedChange or suggestion.campaign
  const campaignResourceName = pc.campaignResourceName || suggestion.campaign;
  if (!campaignResourceName) {
    throw new Error('landing_page_update: missing campaign resource name. Re-add the action item from chat to capture campaign data automatically.');
  }

  // Query all non-removed ads in the campaign
  const adRows = await gaqlQuery(`
    SELECT ad_group_ad.resource_name
    FROM ad_group_ad
    WHERE campaign.resource_name = '${campaignResourceName}'
      AND ad_group_ad.status != 'REMOVED'
  `);
  if (!adRows.length) throw new Error('landing_page_update: no active ads found in campaign');

  const operations = adRows.map(row => ({
    adGroupAdOperation: {
      update: {
        resourceName: row.adGroupAd?.resourceName,
        ad: { finalUrls: [finalUrl] },
      },
      updateMask: 'ad.final_urls',
    },
  }));

  return mutate(operations);
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  const { mutate, gaqlQuery } = await import('../../lib/google-ads.js');

  const dateArg = process.argv.find(a => a.startsWith('--date='))?.split('=')[1]
    ?? (process.argv.includes('--date') ? process.argv[process.argv.indexOf('--date') + 1] : null);
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  const date = dateArg || today;

  const filePath = join(ROOT, 'data', 'ads-optimizer', `${date}.json`);

  if (!existsSync(filePath)) {
    console.log('No suggestion file for today');
    console.log('DONE {"applied":0,"failed":0}'); // always emit DONE — dashboard SSE needs it to fire event:done
    return;
  }

  const data = JSON.parse(readFileSync(filePath, 'utf8'));
  const approved = filterApprovedSuggestions(data);

  if (!approved.length) {
    console.log('No approved suggestions to apply');
    console.log('DONE {"applied":0,"failed":0}'); // always emit DONE — dashboard SSE needs it to fire event:done
    return;
  }

  console.log(`Applying ${approved.length} approved suggestion(s) for ${date}...`);
  let applied = 0, failed = 0;

  for (const s of approved) {
    console.log(`  ${s.id} (${s.type}: ${s.target})...`);
    try {
      if (s.type === 'copy_rewrite') {
        const result = await applyCopyRewrite(s, mutate, gaqlQuery);
        if (result?.partialFailureError) throw new Error(JSON.stringify(result.partialFailureError));
      } else if (s.type === 'landing_page_update') {
        const result = await applyLandingPageUpdate(s, mutate, gaqlQuery);
        if (result?.partialFailureError) throw new Error(JSON.stringify(result.partialFailureError));
      } else {
        const op = buildMutateOperation(s);
        const result = await mutate([op]);
        if (result?.partialFailureError) throw new Error(JSON.stringify(result.partialFailureError));
      }
      s.status = 'applied';
      applied++;
      console.log(`  ✓ ${s.id} applied`);
    } catch (err) {
      console.log(`  ✗ ${s.id} failed: ${err.message}`);
      // Leave status as 'approved' for retry
      failed++;
    }
  }

  writeFileSync(filePath, JSON.stringify(data, null, 2));
  console.log(`\nDone: ${applied} applied, ${failed} failed`);
  console.log(`DONE {"applied":${applied},"failed":${failed}}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(e => { console.error('Error:', e.message); process.exit(1); });
}
