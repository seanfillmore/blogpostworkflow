import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(__dirname, '..', '..');

// ── Pure exports ───────────────────────────────────────────────────────────────

export function campaignFilePath(date, slug, rootDir) {
  return join(rootDir, 'data', 'campaigns', `${date}-${slug}.json`);
}

export function buildAnalyzerPrompt(context) {
  const { activeSlugs, adsSnaps, gscSnaps, ga4Snaps, shopifySnaps, ahrefsPresent, pastOutcomes } = context;

  const sections = [
    `## Active/Proposed Campaigns (do not duplicate these)\n${activeSlugs.length ? activeSlugs.join('\n') : 'None yet.'}`,
    `## Google Ads (last ${adsSnaps.length} days)\n${adsSnaps.length ? JSON.stringify(adsSnaps, null, 2) : 'No Google Ads snapshots available.'}`,
    `## Google Search Console\n${gscSnaps.length ? JSON.stringify(gscSnaps, null, 2) : 'No GSC snapshots available.'}`,
    `## Google Analytics 4\n${ga4Snaps.length ? JSON.stringify(ga4Snaps, null, 2) : 'No GA4 snapshots available.'}`,
    `## Shopify\n${shopifySnaps.length ? JSON.stringify(shopifySnaps, null, 2) : 'No Shopify snapshots available.'}`,
    `## Ahrefs\n${ahrefsPresent ? 'See uploaded CSV data.' : 'No Ahrefs exports found.'}`,
    `## Past Campaign Outcomes\n${pastOutcomes.length ? JSON.stringify(pastOutcomes, null, 2) : 'No past campaign data.'}`,
  ];

  return sections.join('\n\n');
}

export function parseAnalyzerResponse(raw) {
  const cleaned = raw.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim();
  const parsed = JSON.parse(cleaned);
  return parsed;
}

export function isClarification(parsed) {
  return Array.isArray(parsed.clarificationNeeded) && parsed.clarificationNeeded.length > 0;
}
