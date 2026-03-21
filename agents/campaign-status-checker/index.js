/**
 * Campaign Status Checker
 *
 * Runs hourly. For each active campaign, queries Google Ads for the
 * RSA review/approval status of every ad. Sends a notification with
 * the current state. Exits silently (no notification) if all ads in
 * all active campaigns are already APPROVED or APPROVED_LIMITED.
 *
 * Usage:
 *   node agents/campaign-status-checker/index.js
 *
 * Cron (server):
 *   0 * * * * cd ~/seo-claude && node agents/campaign-status-checker/index.js >> data/logs/campaign-status-checker.log 2>&1
 */

import { readFileSync, existsSync, readdirSync, mkdirSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const CAMPAIGNS_DIR = join(ROOT, 'data', 'campaigns');
const LOG_DIR = join(ROOT, 'data', 'logs');

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(join(LOG_DIR, 'campaign-status-checker.log'), line + '\n');
  } catch { /* ignore */ }
}

function loadActiveCampaigns() {
  if (!existsSync(CAMPAIGNS_DIR)) return [];
  return readdirSync(CAMPAIGNS_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => { try { return JSON.parse(readFileSync(join(CAMPAIGNS_DIR, f), 'utf8')); } catch { return null; } })
    .filter(c => c && c.status === 'active' && c.googleAds?.campaignId);
}

const APPROVED_STATUSES = new Set(['APPROVED', 'APPROVED_LIMITED']);

async function main() {
  const campaigns = loadActiveCampaigns();
  if (!campaigns.length) {
    log('No active campaigns — exiting.');
    return;
  }

  const { gaqlQuery } = await import('../../lib/google-ads.js');

  const campaignIds = campaigns.map(c => c.googleAds.campaignId).join(',');

  const rows = await gaqlQuery(`
    SELECT
      campaign.id,
      campaign.name,
      campaign.status,
      ad_group.name,
      ad_group_ad.policy_summary.review_status,
      ad_group_ad.policy_summary.approval_status,
      ad_group_ad.policy_summary.policy_topic_entries
    FROM ad_group_ad
    WHERE campaign.id IN (${campaignIds})
      AND ad_group_ad.status != 'REMOVED'
  `);

  if (!rows.length) {
    log('No ad data returned from API.');
    return;
  }

  // Group by campaign
  const byCampaign = {};
  for (const r of rows) {
    const id = String(r.campaign?.id);
    if (!byCampaign[id]) {
      byCampaign[id] = {
        name: r.campaign?.name,
        status: r.campaign?.status,
        ads: [],
      };
    }
    const reviewStatus = r.adGroupAd?.policySummary?.reviewStatus ?? r.ad_group_ad?.policy_summary?.review_status ?? 'UNKNOWN';
    const approvalStatus = r.adGroupAd?.policySummary?.approvalStatus ?? r.ad_group_ad?.policy_summary?.approval_status ?? 'UNKNOWN';
    const policyIssues = (r.adGroupAd?.policySummary?.policyTopicEntries ?? r.ad_group_ad?.policy_summary?.policy_topic_entries ?? [])
      .map(e => e.topic ?? e).filter(Boolean);
    const adGroupName = r.adGroup?.name ?? r.ad_group?.name ?? '—';
    byCampaign[id].ads.push({ adGroupName, reviewStatus, approvalStatus, policyIssues });
  }

  // Check if everything is already approved — skip notification if so
  const allApproved = Object.values(byCampaign).every(c =>
    c.ads.every(a => APPROVED_STATUSES.has(a.approvalStatus))
  );

  if (allApproved) {
    log('All ads approved — no notification needed.');
    return;
  }

  // Build notification body
  const lines = [];
  for (const [id, c] of Object.entries(byCampaign)) {
    lines.push(`Campaign: ${c.name} (ID: ${id}) — Google Ads status: ${c.status}`);
    for (const ad of c.ads) {
      const issues = ad.policyIssues.length ? ` [${ad.policyIssues.join(', ')}]` : '';
      lines.push(`  • ${ad.adGroupName}: ${ad.reviewStatus} / ${ad.approvalStatus}${issues}`);
    }
  }

  const pendingCount = Object.values(byCampaign)
    .flatMap(c => c.ads)
    .filter(a => !APPROVED_STATUSES.has(a.approvalStatus)).length;

  const subject = `Campaign Review Status — ${pendingCount} ad(s) pending approval`;
  const body = lines.join('\n');

  log(`${subject}\n${body}`);

  const { notify } = await import('../../lib/notify.js');
  await notify({ subject, body }).catch(() => {});
}

main().catch(err => {
  log(`Error: ${err.message}`);
  process.exit(1);
});
