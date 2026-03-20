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
    case 'copy_rewrite':
      // copy_rewrite requires a GAQL fetch of current headlines before mutating.
      // This is handled in applyCopyRewrite() below — not a pure buildMutateOperation call.
      throw new Error('copy_rewrite must be applied via applyCopyRewrite(), not buildMutateOperation()');
    default:
      throw new Error(`Unknown suggestion type: ${type}`);
  }
}

export function parseDoneLine(line) {
  if (!line.startsWith('DONE ')) return null;
  try { return JSON.parse(line.slice(5)); } catch { return null; }
}
