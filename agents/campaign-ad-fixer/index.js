/**
 * Campaign Ad Fixer
 *
 * Runs hourly (alongside campaign-status-checker). For each active campaign:
 *   1. Queries Google Ads for disapproved ads + violation reasons
 *   2. Sends current copy + violations to Claude for compliant rewrites
 *   3. Updates the ads via Google Ads API
 *   4. Sends a notification summarising what was changed
 *
 * Exits silently if no disapproved ads are found.
 *
 * Usage:
 *   node agents/campaign-ad-fixer/index.js [--dry-run]
 *
 * Cron (server):
 *   0 * * * * cd ~/seo-claude && node agents/campaign-ad-fixer/index.js >> data/logs/campaign-ad-fixer.log 2>&1
 */

import { readFileSync, existsSync, readdirSync, mkdirSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const CAMPAIGNS_DIR = join(ROOT, 'data', 'campaigns');
const LOG_DIR = join(ROOT, 'data', 'logs');
const isDryRun = process.argv.includes('--dry-run');

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(join(LOG_DIR, 'campaign-ad-fixer.log'), line + '\n');
  } catch { /* ignore */ }
}

function loadEnv() {
  try {
    return Object.fromEntries(
      readFileSync(join(ROOT, '.env'), 'utf8').split('\n')
        .filter(l => l.includes('='))
        .map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()])
    );
  } catch { return {}; }
}

function loadActiveCampaigns() {
  if (!existsSync(CAMPAIGNS_DIR)) return [];
  return readdirSync(CAMPAIGNS_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => { try { return JSON.parse(readFileSync(join(CAMPAIGNS_DIR, f), 'utf8')); } catch { return null; } })
    .filter(c => c && c.status === 'active' && c.googleAds?.campaignId);
}

// Safely read a field that may be camelCase or snake_case
function field(obj, camel, snake) {
  return obj?.[camel] ?? obj?.[snake];
}

async function getDisapprovedAds(gaqlQuery, campaignIds) {
  const rows = await gaqlQuery(`
    SELECT
      campaign.id,
      campaign.name,
      ad_group.resource_name,
      ad_group.name,
      ad_group_ad.resource_name,
      ad_group_ad.ad.id,
      ad_group_ad.ad.final_urls,
      ad_group_ad.ad.responsive_search_ad.headlines,
      ad_group_ad.ad.responsive_search_ad.descriptions,
      ad_group_ad.policy_summary.review_status,
      ad_group_ad.policy_summary.approval_status,
      ad_group_ad.policy_summary.policy_topic_entries
    FROM ad_group_ad
    WHERE campaign.id IN (${campaignIds})
      AND ad_group_ad.status != 'REMOVED'
  `);

  return rows
    .map(r => {
      const ada = field(r, 'adGroupAd', 'ad_group_ad');
      const approvalStatus = field(ada?.policySummary ?? ada?.policy_summary, 'approvalStatus', 'approval_status') ?? 'UNKNOWN';
      if (approvalStatus !== 'DISAPPROVED') return null;

      const ad = field(ada, 'ad', 'ad');
      const rsa = field(ad, 'responsiveSearchAd', 'responsive_search_ad');
      const headlines = (field(rsa, 'headlines', 'headlines') ?? []).map(h => field(h, 'text', 'text') ?? h);
      const descriptions = (field(rsa, 'descriptions', 'descriptions') ?? []).map(d => field(d, 'text', 'text') ?? d);

      const violations = (field(ada?.policySummary ?? ada?.policy_summary, 'policyTopicEntries', 'policy_topic_entries') ?? [])
        .map(e => ({
          topic: field(e, 'topic', 'topic') ?? String(e),
          type: field(e, 'type', 'type') ?? '',
          evidences: (field(e, 'evidences', 'evidences') ?? []).map(ev => field(ev, 'textList', 'text_list')?.texts ?? []).flat(),
        }));

      const adGroupRN = field(r.adGroup ?? r.ad_group, 'resourceName', 'resource_name');
      const finalUrls = field(field(ada, 'ad', 'ad'), 'finalUrls', 'final_urls') ?? [];

      return {
        resourceName: field(ada, 'resourceName', 'resource_name'),
        adGroupResourceName: adGroupRN,
        finalUrl: finalUrls[0] ?? null,
        campaignId: String(field(r.campaign, 'id', 'id')),
        campaignName: field(r.campaign, 'name', 'name'),
        adGroupName: field(r.adGroup ?? r.ad_group, 'name', 'name'),
        headlines,
        descriptions,
        violations,
      };
    })
    .filter(Boolean);
}

async function rewriteAd(client, ad) {
  const violationText = ad.violations.map(v =>
    `- Policy: ${v.topic}${v.type ? ` (${v.type})` : ''}${v.evidences.length ? `\n  Flagged text: ${v.evidences.join(', ')}` : ''}`
  ).join('\n');

  const prompt = `You are a Google Ads compliance specialist. An RSA was disapproved for the following policy violations:

${violationText}

Current ad copy:
Headlines (current):
${ad.headlines.map((h, i) => `${i + 1}. "${h}" (${h.length} chars)`).join('\n')}

Descriptions (current):
${ad.descriptions.map((d, i) => `${i + 1}. "${d}" (${d.length} chars)`).join('\n')}

Ad group: ${ad.adGroupName}
Campaign: ${ad.campaignName}

Rewrite the ad copy to comply with Google Ads policies while preserving the original intent. Rules:
- Headlines: ≤30 characters each
- Descriptions: ≤90 characters each
- Keep the same number of headlines and descriptions
- Do not make unverifiable claims (no "best", "cheapest", "#1" without evidence)
- Do not use excessive capitalisation or punctuation
- Return ONLY valid JSON in this exact format, no other text:

{
  "headlines": ["headline 1", "headline 2", ...],
  "descriptions": ["description 1", "description 2", ...]
}`;

  const response = await client.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 1024,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = response.content[0]?.text ?? '';
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`Claude returned no JSON for ad in ${ad.adGroupName}`);
  const parsed = JSON.parse(match[0]);

  // Enforce limits
  parsed.headlines = parsed.headlines.map(h => h.slice(0, 30));
  parsed.descriptions = parsed.descriptions.map(d => d.slice(0, 90));

  return parsed;
}

async function main() {
  log(`Campaign Ad Fixer starting${isDryRun ? ' [DRY RUN]' : ''}`);

  const campaigns = loadActiveCampaigns();
  if (!campaigns.length) {
    log('No active campaigns — exiting.');
    return;
  }

  const env = loadEnv();
  const apiKey = process.env.ANTHROPIC_API_KEY || env.ANTHROPIC_API_KEY;
  // Make env available in the fix loop via closure
  if (!apiKey) throw new Error('Missing ANTHROPIC_API_KEY');

  const { gaqlQuery, mutate } = await import('../../lib/google-ads.js');
  const client = new Anthropic({ apiKey });

  const campaignIds = campaigns.map(c => c.googleAds.campaignId).join(',');
  log(`Checking campaigns: ${campaigns.map(c => c.googleAds.campaignId).join(', ')}`);

  const disapproved = await getDisapprovedAds(gaqlQuery, campaignIds);

  if (!disapproved.length) {
    log('No disapproved ads found — exiting.');
    return;
  }

  log(`Found ${disapproved.length} disapproved ad(s)`);

  const fixed = [];
  const failed = [];

  // RSAs are fully immutable — every fix requires REMOVE + CREATE
  const URL_VIOLATIONS = new Set(['DESTINATION_NOT_WORKING', 'DESTINATION_NOT_CRAWLABLE', 'BAD_DESTINATION_URL_TAG']);
  const storeDomain = process.env.STORE_DOMAIN || env.STORE_DOMAIN;

  for (const ad of disapproved) {
    log(`  Fixing: ${ad.campaignName} / ${ad.adGroupName}`);
    log(`  Violations: ${ad.violations.map(v => v.topic).join(', ')}`);

    const hasUrlViolation = ad.violations.some(v => URL_VIOLATIONS.has(v.topic));
    const hasCopyViolation = ad.violations.some(v => !URL_VIOLATIONS.has(v.topic));

    // Determine correct final URL
    const landingPath = (ad.finalUrl ?? '').replace(/^https?:\/\/[^/]+/, '').replace(/^\//, '');
    const correctedUrl = storeDomain
      ? `https://${storeDomain}/${landingPath}`
      : ad.finalUrl;

    if (hasUrlViolation) {
      log(`  URL fix: ${ad.finalUrl} → ${correctedUrl}`);
    }

    try {
      // Get rewritten copy if needed; otherwise keep existing copy
      let headlines = ad.headlines;
      let descriptions = ad.descriptions;

      if (hasCopyViolation) {
        const rewritten = await rewriteAd(client, ad);
        headlines = rewritten.headlines;
        descriptions = rewritten.descriptions;
        log(`  New headlines: ${headlines.join(' | ')}`);
        log(`  New descriptions: ${descriptions.join(' | ')}`);
      }

      if (!isDryRun) {
        await mutate([{ adGroupAdOperation: { remove: ad.resourceName } }]);
        log(`  Removed: ${ad.resourceName}`);

        await mutate([{
          adGroupAdOperation: {
            create: {
              adGroup: ad.adGroupResourceName,
              status: 'ENABLED',
              ad: {
                finalUrls: [correctedUrl],
                responsiveSearchAd: {
                  headlines: headlines.map(text => ({ text })),
                  descriptions: descriptions.map(text => ({ text })),
                },
              },
            },
          },
        }]);
        log(`  Created replacement ad`);
      } else {
        log(`  [DRY RUN] Would remove and recreate with URL: ${correctedUrl}`);
      }

      fixed.push({ ad, urlFix: hasUrlViolation ? { from: ad.finalUrl, to: correctedUrl } : null, rewritten: hasCopyViolation ? { headlines, descriptions } : null });
    } catch (err) {
      log(`  Error: ${err.message}`);
      failed.push({ ad, error: err.message });
    }
  }

  // Notify
  const { notify } = await import('../../lib/notify.js');
  const lines = [];

  if (urlIssues.length) {
    lines.push(`⚠ ${urlIssues.length} ad(s) disapproved for DESTINATION_NOT_WORKING — manual action required:\n`);
    for (const { ad, finalUrl } of urlIssues) {
      lines.push(`  Campaign: ${ad.campaignName} / ${ad.adGroupName}`);
      lines.push(`  Final URL: ${finalUrl}`);
      lines.push(`  Fix: Verify the URL is publicly accessible (not password-protected), then re-submit for review.\n`);
    }
  }

  if (fixed.length) {
    lines.push(`Fixed ${fixed.length} disapproved ad(s)${isDryRun ? ' [DRY RUN]' : ''}:\n`);
    for (const { ad, rewritten, urlFix } of fixed) {
      lines.push(`Campaign: ${ad.campaignName} / ${ad.adGroupName}`);
      lines.push(`Violations: ${ad.violations.map(v => v.topic).join(', ')}`);
      if (urlFix) {
        lines.push(`URL updated: ${urlFix.from} → ${urlFix.to}`);
      }
      if (rewritten) {
        lines.push(`New headlines:\n${rewritten.headlines.map((h, i) => `  ${i + 1}. ${h}`).join('\n')}`);
        lines.push(`New descriptions:\n${rewritten.descriptions.map((d, i) => `  ${i + 1}. ${d}`).join('\n')}`);
      }
      lines.push('');
    }
  }

  if (failed.length) {
    lines.push(`Failed to fix ${failed.length} ad(s):`);
    for (const { ad, error } of failed) {
      lines.push(`  • ${ad.campaignName} / ${ad.adGroupName}: ${error}`);
    }
  }

  if (!urlIssues.length && !fixed.length && !failed.length) {
    log('Nothing to report.');
    return;
  }

  await notify({
    subject: `Campaign Ad Fixer — ${fixed.length} fixed, ${failed.length} failed`,
    body: lines.join('\n'),
    status: failed.length ? 'error' : 'success',
  }).catch(() => {});

  log('Done.');
}

main().catch(err => {
  log(`Fatal: ${err.message}`);
  process.exit(1);
});
