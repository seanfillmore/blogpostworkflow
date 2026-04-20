#!/bin/bash
# setup-cron.sh — Install system cron jobs for the SEO pipeline
#
# Run once to register all recurring tasks:
#   chmod +x scripts/setup-cron.sh && ./scripts/setup-cron.sh
#
# All times are UTC unless marked with TZ=America/Los_Angeles.
# The script strips ALL previous seo-claude entries (any path variant)
# before installing, so re-running is always safe and idempotent.

set -e

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$(which node)"

mkdir -p "$PROJECT_DIR/data/reports"
mkdir -p "$PROJECT_DIR/data/reports/scheduler"
mkdir -p "$PROJECT_DIR/data/logs"

echo "Project: $PROJECT_DIR"
echo "Node:    $NODE"
echo ""

# ── Job definitions ──────────────────────────────────────────────────────────
# Data collectors (daily)
DAILY_SHOPIFY="5 13 * * * cd \"$PROJECT_DIR\" && $NODE agents/shopify-collector/index.js >> data/reports/scheduler/shopify-collector.log 2>&1"
DAILY_GSC="15 13 * * * cd \"$PROJECT_DIR\" && $NODE agents/gsc-collector/index.js >> data/reports/scheduler/gsc-collector.log 2>&1"
DAILY_GA4="20 13 * * * cd \"$PROJECT_DIR\" && $NODE agents/ga4-collector/index.js >> data/reports/scheduler/ga4-collector.log 2>&1"
DAILY_GOOGLE_ADS="25 13 * * * cd \"$PROJECT_DIR\" && $NODE agents/google-ads-collector/index.js >> data/reports/scheduler/google-ads-collector.log 2>&1"
DAILY_CLARITY="0 13 * * * cd \"$PROJECT_DIR\" && $NODE agents/clarity-collector/index.js >> data/reports/scheduler/clarity-collector.log 2>&1"

# Index + map refreshes (daily)
DAILY_BLOG_INDEX="0 6 * * * cd \"$PROJECT_DIR\" && $NODE agents/blog-content/index.js list >> data/reports/scheduler/blog-index.log 2>&1"
DAILY_TOPICAL_MAP="5 6 * * * cd \"$PROJECT_DIR\" && $NODE agents/topical-mapper/index.js >> data/reports/scheduler/topical-map.log 2>&1"

# Rank tracking + alerts (daily — DataForSEO ~$0.02/run)
DAILY_RANK_TRACKER="0 7 * * * cd \"$PROJECT_DIR\" && $NODE agents/rank-tracker/index.js >> data/reports/scheduler/rank-tracker.log 2>&1"
DAILY_RANK_ALERTER="30 13 * * * cd \"$PROJECT_DIR\" && $NODE agents/rank-alerter/index.js >> data/reports/scheduler/rank-alerter.log 2>&1"

# Content pipeline (daily)
DAILY_SCHEDULER="0 15 * * * cd \"$PROJECT_DIR\" && $NODE scheduler.js >> data/reports/scheduler/scheduler.log 2>&1"
DAILY_PIPELINE_SCHEDULER="0 16 * * * cd \"$PROJECT_DIR\" && $NODE agents/pipeline-scheduler/index.js >> data/reports/scheduler/pipeline-scheduler.log 2>&1"
DAILY_CALENDAR_RUNNER="0 10 * * * cd \"$PROJECT_DIR\" && $NODE agents/calendar-runner/index.js --run --all >> data/logs/calendar-runner.log 2>&1"

# Indexing (daily)
DAILY_INDEXING_CHECKER="0 11 * * * cd \"$PROJECT_DIR\" && $NODE agents/indexing-checker/index.js >> data/reports/scheduler/indexing-checker.log 2>&1"
DAILY_INDEXING_FIXER="30 11 * * * cd \"$PROJECT_DIR\" && $NODE agents/indexing-fixer/index.js >> data/reports/scheduler/indexing-fixer.log 2>&1"

# Ads (daily)
DAILY_ADS_OPTIMIZER="45 6 * * * TZ=America/Los_Angeles cd \"$PROJECT_DIR\" && $NODE agents/ads-optimizer/index.js >> data/reports/ads-optimizer.log 2>&1"
DAILY_CAMPAIGN_MONITOR="30 7 * * * TZ=America/Los_Angeles cd \"$PROJECT_DIR\" && $NODE agents/campaign-monitor/index.js >> data/reports/campaign-monitor.log 2>&1"

# Daily digest (runs last — collects everything from the day)
DAILY_SUMMARY="0 13 * * * cd \"$PROJECT_DIR\" && $NODE agents/daily-summary/index.js >> data/logs/daily-summary.log 2>&1"

# Weekly (Monday)
WEEKLY_INSIGHTS="30 7 * * 1 cd \"$PROJECT_DIR\" && $NODE agents/insight-aggregator/index.js >> data/reports/scheduler/insights.log 2>&1"
WEEKLY_CRO_ANALYZER="45 14 * * 1 cd \"$PROJECT_DIR\" && $NODE agents/cro-analyzer/index.js >> data/reports/scheduler/cro-analyzer.log 2>&1"
WEEKLY_META_AB_TRACKER="0 15 * * 1 cd \"$PROJECT_DIR\" && $NODE agents/meta-ab-tracker/index.js >> data/reports/scheduler/meta-ab-tracker.log 2>&1"
WEEKLY_QUICK_WIN="0 15 * * 1 cd \"$PROJECT_DIR\" && $NODE agents/quick-win-targeter/index.js >> data/reports/scheduler/quick-win-targeter.log 2>&1"
WEEKLY_KEYWORD_RESEARCH="0 8 * * 1 cd \"$PROJECT_DIR\" && $NODE agents/keyword-research/index.js >> data/reports/scheduler/keyword-research.log 2>&1"

# Weekly (Sunday)
WEEKLY_ADS_RECAP="0 7 * * 0 TZ=America/Los_Angeles cd \"$PROJECT_DIR\" && $NODE scripts/ads-weekly-recap.js >> data/reports/ads-weekly-recap.log 2>&1"
WEEKLY_CAMPAIGN_ANALYZER="0 6 * * 0 TZ=America/Los_Angeles cd \"$PROJECT_DIR\" && $NODE agents/campaign-analyzer/index.js >> data/reports/campaign-analyzer.log 2>&1"

# Biweekly (every other Sunday)
BIWEEKLY_STRATEGIST="0 12 * * 0 [ \$(( \$(date +%W) % 2 )) -eq 0 ] && cd \"$PROJECT_DIR\" && $NODE agents/content-strategist/index.js >> data/reports/scheduler/content-strategist.log 2>&1"

# Monthly (1st of each month — content gap analysis)
MONTHLY_CONTENT_GAP="0 8 1 * * cd \"$PROJECT_DIR\" && $NODE agents/content-gap/index.js >> data/reports/scheduler/content-gap.log 2>&1"

# ── Install ──────────────────────────────────────────────────────────────────
# Strip ALL previous seo-claude entries (covers ~/seo-claude, /root/seo-claude,
# and any other path variant) to prevent duplicates from accumulating.
EXISTING=$(crontab -l 2>/dev/null || true)
CLEANED=$(echo "$EXISTING" | grep -v "seo-claude" || true)

NEW_CRONTAB="$CLEANED
# SEO Pipeline — auto-generated by setup-cron.sh ($(date +%Y-%m-%d))
# ── Collectors (daily) ──
$DAILY_CLARITY
$DAILY_SHOPIFY
$DAILY_GSC
$DAILY_GA4
$DAILY_GOOGLE_ADS
# ── Index + map (daily) ──
$DAILY_BLOG_INDEX
$DAILY_TOPICAL_MAP
# ── Rank tracking (daily) ──
$DAILY_RANK_TRACKER
$DAILY_RANK_ALERTER
# ── Content pipeline (daily) ──
$DAILY_SCHEDULER
$DAILY_PIPELINE_SCHEDULER
$DAILY_CALENDAR_RUNNER
# ── Indexing (daily) ──
$DAILY_INDEXING_CHECKER
$DAILY_INDEXING_FIXER
# ── Ads (daily) ──
$DAILY_ADS_OPTIMIZER
$DAILY_CAMPAIGN_MONITOR
# ── Daily digest ──
$DAILY_SUMMARY
# ── Weekly (Monday) ──
$WEEKLY_INSIGHTS
$WEEKLY_CRO_ANALYZER
$WEEKLY_META_AB_TRACKER
$WEEKLY_QUICK_WIN
$WEEKLY_KEYWORD_RESEARCH
# ── Weekly (Sunday) ──
$WEEKLY_ADS_RECAP
$WEEKLY_CAMPAIGN_ANALYZER
# ── Biweekly ──
$BIWEEKLY_STRATEGIST
# ── Monthly ──
$MONTHLY_CONTENT_GAP
"

echo "Installing cron jobs..."
echo "$NEW_CRONTAB" | crontab -

echo ""
echo "Installed:"
echo ""
echo "  DAILY"
echo "  06:00 UTC — blog-index refresh"
echo "  06:05 UTC — topical-map refresh"
echo "  06:45 PT  — ads-optimizer"
echo "  07:00 UTC — rank-tracker (DataForSEO)"
echo "  07:30 PT  — campaign-monitor"
echo "  10:00 UTC — calendar-runner (--run --all)"
echo "  11:00 UTC — indexing-checker"
echo "  11:30 UTC — indexing-fixer"
echo "  13:00 UTC — clarity, shopify, gsc, ga4, google-ads collectors"
echo "  13:00 UTC — daily summary digest"
echo "  13:30 UTC — rank-alerter"
echo "  15:00 UTC — scheduler (publish-due + pipeline)"
echo "  16:00 UTC — pipeline-scheduler (brief drip)"
echo ""
echo "  WEEKLY (Monday)"
echo "  07:30 UTC — insight-aggregator"
echo "  08:00 UTC — keyword-research (DataForSEO)"
echo "  14:45 UTC — cro-analyzer"
echo "  15:00 UTC — meta-ab-tracker + quick-win-targeter"
echo ""
echo "  WEEKLY (Sunday)"
echo "  06:00 PT  — campaign-analyzer"
echo "  07:00 PT  — ads-weekly-recap"
echo ""
echo "  BIWEEKLY (every other Sunday)"
echo "  12:00 UTC — content-strategist calendar refresh"
echo ""
echo "  MONTHLY (1st of each month)"
echo "  08:00 UTC — content-gap analysis (DataForSEO)"
echo ""
echo "View with: crontab -l"
echo "Logs in:   $PROJECT_DIR/data/reports/scheduler/"
