#!/bin/bash
# setup-cron.sh — Install system cron jobs for the SEO pipeline
#
# Run once to register all recurring tasks:
#   chmod +x scripts/setup-cron.sh && ./scripts/setup-cron.sh
#
# ALL times are UTC. This host's cron (3.0pl1) supports neither CRON_TZ nor a TZ
# crontab variable, so a TZ= prefix cannot move a job — see the note above
# GIVEAWAY_CLOSE_ENTRY_PERIOD. Change the UTC fields, never add a TZ= prefix.
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

# GSC opportunity report (daily — runs after gsc-collector at 13:15, before next
# day's performance-engine reads its latest.json). Re-lights the GSC half of the
# optimization loop: feeds the digest, performance-engine, and the ideas inbox.
DAILY_GSC_OPPORTUNITY="30 13 * * * cd \"$PROJECT_DIR\" && $NODE agents/gsc-opportunity/index.js >> data/reports/scheduler/gsc-opportunity.log 2>&1"

# Post performance (daily — 30/60/90-day milestone review, after gsc-collector).
# Verified live on the server 2026-08-21; was missing from this script.
DAILY_POST_PERFORMANCE="30 13 * * * cd \"$PROJECT_DIR\" && $NODE agents/post-performance/index.js >> data/reports/scheduler/post-performance.log 2>&1"

# Pipeline prioritizer (daily — runs after signal agents at 13:30–13:45 UTC and
# before calendar-runner at 10:00 UTC the next morning). Injects unmapped queries
# as just-in-time backlog ideas and ranks them against all other signals.
# Supersedes unmapped-query-promoter, and as of 2026-08-23 that cutover is DONE:
# the promoter's `45 13 * * *` entry was removed here and from the live crontab.
# Both had been running daily, 15 minutes apart, against the same content calendar
# since 2026-06. Evidence the prioritizer fully covers it: it reads the same
# gsc-opportunity `unmapped[]` feed at the same 500-impression floor
# (config/pipeline-priority.json signals.unmapped.minImpressions), and the
# promoter's own last runs qualified ZERO items — every candidate was either under
# the floor (18) or already covered by the prioritizer's backlog (5).
# The agent file is kept and is still runnable by hand; only the schedule is gone.
DAILY_PIPELINE_PRIORITIZER="0 14 * * * cd \"$PROJECT_DIR\" && $NODE agents/pipeline-prioritizer/index.js >> data/reports/scheduler/pipeline-prioritizer.log 2>&1"

# Content pipeline (daily)
DAILY_SCHEDULER="0 15 * * * cd \"$PROJECT_DIR\" && $NODE scheduler.js >> data/reports/scheduler/scheduler.log 2>&1"
DAILY_PIPELINE_SCHEDULER="0 16 * * * cd \"$PROJECT_DIR\" && $NODE agents/pipeline-scheduler/index.js >> data/reports/scheduler/pipeline-scheduler.log 2>&1"
DAILY_CALENDAR_RUNNER="0 10 * * * cd \"$PROJECT_DIR\" && $NODE agents/calendar-runner/index.js --run --all >> data/logs/calendar-runner.log 2>&1"

# Indexing (daily)
DAILY_INDEXING_CHECKER="0 11 * * * cd \"$PROJECT_DIR\" && $NODE agents/indexing-checker/index.js >> data/reports/scheduler/indexing-checker.log 2>&1"
DAILY_INDEXING_FIXER="30 11 * * * cd \"$PROJECT_DIR\" && $NODE agents/indexing-fixer/index.js >> data/reports/scheduler/indexing-fixer.log 2>&1"

# Ads (daily)
DAILY_ADS_OPTIMIZER="45 6 * * * cd \"$PROJECT_DIR\" && $NODE agents/ads-optimizer/index.js >> data/reports/ads-optimizer.log 2>&1"
DAILY_CAMPAIGN_MONITOR="30 7 * * * cd \"$PROJECT_DIR\" && $NODE agents/campaign-monitor/index.js >> data/reports/campaign-monitor.log 2>&1"

# Campaign status + ad fixer (high frequency)
HOURLY_CAMPAIGN_STATUS="0 * * * * cd \"$PROJECT_DIR\" && $NODE agents/campaign-status-checker/index.js --scheduled >> data/logs/campaign-status-checker.log 2>&1"
FREQUENT_CAMPAIGN_AD_FIXER="5 * * * * cd \"$PROJECT_DIR\" && $NODE agents/campaign-ad-fixer/index.js --scheduled >> data/logs/campaign-ad-fixer.log 2>&1"

# Publish-drift detector (daily) — alerts when a post we consider published has
# reverted to a Shopify draft (or vanished). Auto-heals with --fix: republishes
# drafts (the safe root-cause fix — they were published before). Intentional
# unpublishes (cannibalization/kill) are excluded by the agent, and 'missing'/
# deleted posts are reported only, never auto-recreated — so it can't fight an
# intentional unpublish.
DAILY_PUBLISH_DRIFT="45 13 * * * cd \"$PROJECT_DIR\" && $NODE agents/publish-drift/index.js --fix >> data/reports/scheduler/publish-drift.log 2>&1"

# Performance engine (daily)
DAILY_PERFORMANCE_ENGINE="30 7 * * * cd \"$PROJECT_DIR\" && $NODE agents/performance-engine/index.js >> data/logs/performance-engine.log 2>&1"

# Post-meta drift gate (daily, DETECT ONLY) — does data/posts/*/meta.json on
# this box diverge from origin/main in a way a deploy cannot resolve by itself?
#
# That file is tracked in git AND rewritten continuously by cron, and on
# 2026-08-23 the stash-pop deploy recovery turned five of them into invalid JSON
# on production. scripts/reconcile-post-metas.mjs is the semantic merge that
# replaced it; this wrapper runs its GATE mode and routes the verdict into the
# 5 AM digest, deferred, never immediate. It NEVER writes a meta.json — the
# arguments are a frozen constant and --apply is refused, because a reconcile
# applying on a timer would resolve contested fields nobody reviewed.
#
# Exit 2 (a field changed on both sides with no owner) and exit 3 (a file on the
# box already will not parse — silent today, since every reader catch{}es a
# parse failure) render as digest failures. Exit 1 is the ordinary state of a
# live box and is reported quietly so it does not cry wolf.
#
# 12:40 UTC, deliberately expressed in UTC — this host's cron (3.0pl1) supports
# neither CRON_TZ nor a TZ crontab variable, so a TZ= prefix schedules nothing;
# see the note above GIVEAWAY_CLOSE_ENTRY_PERIOD. The hour is chosen against two
# UTC landmarks, neither of which is a Pacific wall-clock time, so DST cannot
# move it out from between them: 20 minutes BEFORE the 13:00 UTC daily-summary,
# so the row lands in the SAME morning's digest rather than tomorrow's; and
# ~2h20m before the 15:00 UTC scheduler, so it reports a settled tree instead of
# one mid-pipeline. It is a cheap read (git fetch + one local pass over ~200
# JSON files) and shares the slot with nothing.
DAILY_POST_META_GATE="40 12 * * * cd \"$PROJECT_DIR\" && $NODE scripts/check-post-meta-drift.mjs >> data/reports/scheduler/post-meta-gate.log 2>&1"

# Daily digest (runs last — collects everything from the day)
DAILY_SUMMARY="0 13 * * * cd \"$PROJECT_DIR\" && $NODE agents/daily-summary/index.js >> data/logs/daily-summary.log 2>&1"

# Weekly (Monday)
WEEKLY_INSIGHTS="30 7 * * 1 cd \"$PROJECT_DIR\" && $NODE agents/insight-aggregator/index.js >> data/reports/scheduler/insights.log 2>&1"
WEEKLY_CRO_ANALYZER="45 14 * * 1 cd \"$PROJECT_DIR\" && $NODE agents/cro-analyzer/index.js >> data/reports/scheduler/cro-analyzer.log 2>&1"
# Meta A/B loop (Mondays, after gsc-opportunity 13:30 + cro-analyzer 14:45):
#   1. meta-ab-checker concludes due tests and auto-reverts measured losers;
#   2. meta-optimizer rewrites low-CTR titles/metas, starting fresh A/B tests.
# (Supersedes the legacy meta-ab-tracker, which read an empty data/meta-tests/.)
WEEKLY_META_AB_CHECKER="50 14 * * 1 cd \"$PROJECT_DIR\" && $NODE agents/meta-ab-checker/index.js >> data/reports/scheduler/meta-ab-checker.log 2>&1"
# --limit 5: cap to 5 fresh meta tests/week — bounded live edits + cleaner A/B
# attribution (fewer simultaneous changes) than the default limit of 25.
WEEKLY_META_OPTIMIZER="0 15 * * 1 cd \"$PROJECT_DIR\" && $NODE agents/meta-optimizer/index.js --apply --limit 5 >> data/reports/scheduler/meta-optimizer.log 2>&1"
WEEKLY_QUICK_WIN="0 15 * * 1 cd \"$PROJECT_DIR\" && $NODE agents/quick-win-targeter/index.js >> data/reports/scheduler/quick-win-targeter.log 2>&1"
WEEKLY_KEYWORD_RESEARCH="0 8 * * 1 cd \"$PROJECT_DIR\" && $NODE agents/keyword-research/index.js >> data/reports/scheduler/keyword-research.log 2>&1"
# SEO opportunity analyzer (Mon 14:10, after GSC collectors): clusters the
# queries we already rank for, prices them via DataForSEO (cached 30d), and
# surfaces a ranked opportunity report. meta_rewrite items are auto-handled by
# meta-optimizer (15:00); rank_push/refresh items are staged in the dashboard
# queue for approval.
WEEKLY_SEO_OPPORTUNITY="10 14 * * 1 cd \"$PROJECT_DIR\" && $NODE agents/seo-opportunity-analyzer/index.js >> data/reports/scheduler/seo-opportunity-analyzer.log 2>&1"
# SEO impact / "what's working" — weekly Mon 14:30 UTC (after GA4/GSC/Shopify
# collectors at 13:xx). Organic revenue by page/cluster; the feedback loop.
WEEKLY_SEO_IMPACT="30 14 * * 1 cd \"$PROJECT_DIR\" && $NODE agents/seo-impact/index.js >> data/reports/scheduler/seo-impact.log 2>&1"
WEEKLY_META_ADS_COLLECTOR="0 10 * * 1 cd \"$PROJECT_DIR\" && $NODE agents/meta-ads-collector/index.js >> data/logs/meta-ads-collector.log 2>&1"
WEEKLY_META_ADS_ANALYZER="10 10 * * 1 cd \"$PROJECT_DIR\" && $NODE agents/meta-ads-analyzer/index.js >> data/logs/meta-ads-analyzer.log 2>&1"
# Competitor watcher (Monday 02:00 UTC — no TZ prefix on the live line, so this
# is a fixed UTC time, not a fixed Pacific time. The agent's own header docstring
# calls it "weekly Sun 7:00 PM PT", which is 02:00 UTC Monday only while PT is on
# PDT (UTC-7); it will read as 6 PM PT once PST (UTC-8) resumes. Not fixed here —
# adding TZ= would change live behavior; flagged in cron-mirror-report.md.
# Fires at 02:00 UTC Monday = Sunday 19:00 PDT / 18:00 PST. The hour MOVES across
# DST and that cannot be fixed with a TZ= prefix on this box: `cron 3.0pl1` here
# supports neither CRON_TZ nor a TZ crontab variable (verified 2026-08-23 against
# the binary), and an inline `TZ=... cd ... && node` assignment applies only to
# `cd` — node sees TZ unset. Every job on this server is scheduled in UTC, full
# stop. The agent's header now states the UTC truth instead of claiming a fixed
# PT hour. A weekly competitor crawl does not care which hour it lands on.
WEEKLY_COMPETITOR_WATCHER="0 2 * * 1 cd \"$PROJECT_DIR\" && $NODE agents/competitor-watcher/index.js >> data/reports/scheduler/competitor-watcher.log 2>&1"

# Weekly (Sunday)
WEEKLY_ADS_RECAP="0 7 * * 0 cd \"$PROJECT_DIR\" && $NODE scripts/ads-weekly-recap.js >> data/reports/ads-weekly-recap.log 2>&1"
WEEKLY_CAMPAIGN_ANALYZER="0 6 * * 0 cd \"$PROJECT_DIR\" && $NODE agents/campaign-analyzer/index.js >> data/reports/campaign-analyzer.log 2>&1"

# Offsite snapshot backup (Sundays 17:00 UTC, after the Sunday jobs above) — see
# CLAUDE.md's "Snapshot backups" section. data/snapshots/ is the only copy of
# GSC/Clarity history past those APIs' retention windows; this is the sole
# offsite copy, so its absence from this script was the exact risk this task
# exists to close.
WEEKLY_OFFSITE_BACKUP="0 17 * * 0 cd \"$PROJECT_DIR\" && /bin/bash scripts/backup-snapshots-offsite.sh >> data/reports/scheduler/offsite-backup.log 2>&1"

# Ad Studio / creatives disk hygiene (Sundays). Two complementary sweeps:
# prune-ad-studio does deep age-only pruning past 90 days; creatives-budget
# enforces the hard CREATIVES_BUDGET_BYTES ceiling (4 GiB on this box) tier by
# tier. See CLAUDE.md's "`--formats` is required" section.
WEEKLY_PRUNE_AD_STUDIO="30 17 * * 0 cd \"$PROJECT_DIR\" && $NODE scripts/prune-ad-studio.mjs --apply >> data/reports/prune-ad-studio.log 2>&1"
WEEKLY_CREATIVES_BUDGET="0 18 * * 0 cd \"$PROJECT_DIR\" && $NODE scripts/creatives-budget.mjs --apply >> data/reports/scheduler/creatives-budget.log 2>&1"

# Biweekly (every other Sunday)
BIWEEKLY_STRATEGIST="0 12 * * 0 [ \$(( \$(date +%W) % 2 )) -eq 0 ] && cd \"$PROJECT_DIR\" && $NODE agents/content-strategist/index.js >> data/reports/scheduler/content-strategist.log 2>&1"

# Monthly (1st of each month — content gap analysis)
MONTHLY_CONTENT_GAP="0 8 1 * * cd \"$PROJECT_DIR\" && $NODE agents/content-gap/index.js >> data/reports/scheduler/content-gap.log 2>&1"

# Monthly (1st of each month — closed-loop weight tuner; runs after daily signal
# agents at 13:xx, after pipeline-prioritizer at 14:00, and after seo-impact
# which runs weekly but is guaranteed available by the 1st).
MONTHLY_PRIORITY_TUNER="0 16 1 * * cd \"$PROJECT_DIR\" && $NODE agents/priority-tuner/index.js >> data/reports/scheduler/priority-tuner.log 2>&1"

# ── Soap giveaway (daily, UTC) — installed on the server 2026-08-12 ──────────
# These three jobs run the live soap-giveaway campaign. They are recorded here
# for the first time on 2026-08-21 — until now the server crontab was the only
# copy, and a server rebuild or crontab restore would have silently reverted
# the TZ fix below. Verify against `ssh root@137.184.119.230 'crontab -l'`
# before assuming this block is still current; it is not auto-synced.
#
# Credits the confirmation (+2) and referral (+5) rungs. These rungs are written
# ONLY here; without this line the entry ladder silently never advances.
# Idempotent — safe to re-run and safe to leave running before launch (no-op at
# 0 entrants). Must run BEFORE the 13:00 UTC digest.
DAILY_GIVEAWAY_RECONCILE="30 8 * * * cd \"$PROJECT_DIR\" && $NODE scripts/giveaway/reconcile-referrals.mjs --apply >> data/reports/scheduler/giveaway-reconcile.log 2>&1"

# Classify every referral pair by WHY it is not paying, mail the reachable half
# of each broken one, and report the rest for a human decision. Runs BETWEEN the
# reconciler and the report: after 08:30 so pairs the reconciler just credited
# are not mailed about, before 08:45 so the report's numbers and this audit
# describe the same moment.
#
# It never writes gv_referred_by. Official Rules §5 identifies a referral "solely
# by the referrer's email address entered in that field" and §6 awards a second
# prize to the referrer "named at the time of entry", so a mistyped address is
# reported, never repaired — prevention lives in the entry form instead. See the
# header of scripts/giveaway/audit-referrals.mjs.
#
# Sends via the metric-triggered flow built by build-referral-audit-flow.mjs. If
# that flow is deleted or set to draft, this job still runs and still reports,
# but the emails silently stop — the events fire into nothing.
DAILY_GIVEAWAY_REFERRAL_AUDIT="40 8 * * * cd \"$PROJECT_DIR\" && $NODE scripts/giveaway/audit-referrals.mjs --apply >> data/reports/scheduler/giveaway-referral-audit.log 2>&1"

# Daily giveaway report + day-5/day-10 spend gates. NOTIFY_DEFERRED=1 appends to
# the daily-summary JSONL so the gates land in the 13:00 UTC digest. Runs AFTER
# the reconciler so the digest reads freshly credited numbers.
DAILY_GIVEAWAY_REPORT="45 8 * * * cd \"$PROJECT_DIR\" && NOTIFY_DEFERRED=1 $NODE scripts/giveaway/report.mjs >> data/reports/scheduler/giveaway-report.log 2>&1"

# Re-send the double-opt-in confirmation to entrants who submitted but never
# clicked. Measured 2026-08-21, day three of the paid campaign: 108 submissions,
# 26 confirmed — and 36% even among the cohort mature enough to have decided. An
# unconfirmed entrant is on no list, so they get no nurture email, cannot be
# credited as anyone's referrer, and cannot be sold to; the whole gap is this one
# step. Re-issuing the subscribe makes Klaviyo re-send its opt-in email, which is
# a CONSENT REQUEST, not marketing — that is the only reason it may reach an
# unconsented profile, and why this line must never be pointed at a promotional
# send. Capped at 3 per address, 48h apart, stamped on the profile; skips anyone
# already confirmed. Idempotent.
#
# 16:00 UTC = 9 AM PT, a sane send hour for a US list, and AFTER the 08:45 report
# so the daily funnel snapshot is taken before the nudge moves it.
DAILY_GIVEAWAY_NUDGE="0 16 * * * cd \"$PROJECT_DIR\" && $NODE scripts/giveaway/nudge-unconfirmed.mjs --apply >> data/reports/scheduler/giveaway-nudge.log 2>&1"

# Entry Period close: stop the nurture flow. Klaviyo has no flow end date, and
# PATCH /flows accepts only status, so the boundary is enforced from outside.
# Idempotent.
#
# TIMING, AND THE TRAP IT SPENT THREE DAYS IN:
# Entries close 2026-09-14T23:59:59-07:00 (config/giveaway.json entryClosesAt),
# which is 06:59:59 UTC on Sep 15. This fires at 08:05 UTC = 01:05 PDT Sep 15,
# about an hour AFTER close. It must never fire before.
#
# It previously read `5 5 15 9 * TZ=America/Los_Angeles ...` — 05:05 UTC =
# 22:05 PT, i.e. 1.92 hours BEFORE entries closed, drafting the nurture flow
# while people were still entering and killing the `01-confirm` email's
# +2-entry rung for last-minute entrants. Adding that TZ= prefix on 2026-08-20
# was believed to be the fix. It was not, and could not be:
#   * this box runs `cron 3.0pl1`, whose binary contains NEITHER `CRON_TZ` nor a
#     `TZ` crontab variable, so every job here is scheduled on the UTC clock; and
#   * an inline `TZ=x cd ... && node` is a SHELL assignment scoped to `cd` —
#     verified on the server, node saw TZ unset.
# The prefix was inert twice over. Only the UTC fields move a job on this host.
#
# Do NOT re-add a TZ= prefix and assume it schedules anything. If entryClosesAt
# ever changes, recompute the UTC fields by hand — nothing here follows it.
GIVEAWAY_CLOSE_ENTRY_PERIOD="5 8 15 9 * cd \"$PROJECT_DIR\" && $NODE scripts/giveaway/close-entry-period.mjs --apply >> data/reports/scheduler/giveaway-close.log 2>&1"

# Re-send the double-opt-in confirmation to entrants who submitted but never
# clicked. ~64% of paid submissions never confirm, and an unconfirmed entrant
# gets no nurture email, cannot be credited as a referrer and cannot be sold to.
# Consent request, not marketing — capped at 3 per address, 48h apart, stamped
# on the profile. Idempotent. Runs AFTER the 08:45 report so the daily funnel
# snapshot is taken before nudging. 16:00 UTC = 9 AM PT, a reasonable send hour
# for a US list — deliberately expressed in UTC, so no TZ= prefix needed.
# Installed on the server 2026-08-21; recorded here for the first time.
DAILY_GIVEAWAY_NUDGE="0 16 * * * cd \"$PROJECT_DIR\" && $NODE scripts/giveaway/nudge-unconfirmed.mjs --apply >> data/reports/scheduler/giveaway-nudge.log 2>&1"

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
# ── GSC opportunity (daily) ──
$DAILY_GSC_OPPORTUNITY
# ── Post performance (daily) ──
$DAILY_POST_PERFORMANCE
# ── Pipeline prioritizer (daily — after signals, before calendar-runner) ──
$DAILY_PIPELINE_PRIORITIZER
# ── Content pipeline (daily) ──
$DAILY_SCHEDULER
$DAILY_PIPELINE_SCHEDULER
$DAILY_CALENDAR_RUNNER
# ── Indexing (daily) ──
$DAILY_INDEXING_CHECKER
$DAILY_INDEXING_FIXER
# ── Ads + campaigns (daily / high-frequency) ──
$DAILY_ADS_OPTIMIZER
$DAILY_CAMPAIGN_MONITOR
$HOURLY_CAMPAIGN_STATUS
$FREQUENT_CAMPAIGN_AD_FIXER
# ── Publish-drift detector (daily) ──
$DAILY_PUBLISH_DRIFT
# ── Performance engine (daily) ──
$DAILY_PERFORMANCE_ENGINE
# ── Post-meta drift gate (daily, detect only — before the digest) ──
$DAILY_POST_META_GATE
# ── Daily digest ──
$DAILY_SUMMARY
# ── Weekly (Monday) ──
$WEEKLY_INSIGHTS
$WEEKLY_CRO_ANALYZER
$WEEKLY_META_AB_CHECKER
$WEEKLY_META_OPTIMIZER
$WEEKLY_QUICK_WIN
$WEEKLY_SEO_OPPORTUNITY
$WEEKLY_KEYWORD_RESEARCH
$WEEKLY_META_ADS_COLLECTOR
$WEEKLY_META_ADS_ANALYZER
$WEEKLY_SEO_IMPACT
$WEEKLY_COMPETITOR_WATCHER
# ── Weekly (Sunday) ──
$WEEKLY_ADS_RECAP
$WEEKLY_CAMPAIGN_ANALYZER
$WEEKLY_OFFSITE_BACKUP
$WEEKLY_PRUNE_AD_STUDIO
$WEEKLY_CREATIVES_BUDGET
# ── Biweekly ──
$BIWEEKLY_STRATEGIST
# ── Monthly ──
$MONTHLY_CONTENT_GAP
$MONTHLY_PRIORITY_TUNER
# ── Soap giveaway (daily, UTC) ──
$DAILY_GIVEAWAY_RECONCILE
$DAILY_GIVEAWAY_REFERRAL_AUDIT
$DAILY_GIVEAWAY_REPORT
$DAILY_GIVEAWAY_NUDGE
$GIVEAWAY_CLOSE_ENTRY_PERIOD
"

echo "Installing cron jobs..."
echo "$NEW_CRONTAB" | crontab -

echo ""
echo "Installed:"
echo ""
echo "  HIGH FREQUENCY"
echo "  Hourly   — campaign-status-checker"
echo "  Hourly   — campaign-ad-fixer"
echo ""
echo "  DAILY"
echo "  06:00 UTC — blog-index refresh"
echo "  06:05 UTC — topical-map refresh"
echo "  06:45 PT  — ads-optimizer"
echo "  07:00 UTC — rank-tracker (DataForSEO)"
echo "  07:30 PT  — campaign-monitor"
echo "  07:30 UTC — performance-engine"
echo "  10:00 UTC — calendar-runner (--run --all)"
echo "  11:00 UTC — indexing-checker"
echo "  11:30 UTC — indexing-fixer"
echo "  13:00 UTC — clarity, shopify, gsc, ga4, google-ads collectors"
echo "  13:00 UTC — daily summary digest"
echo "  13:30 UTC — gsc-opportunity report"
echo "  13:30 UTC — rank-alerter"
echo "  13:30 UTC — post-performance (30/60/90-day milestone review)"
echo "  13:45 UTC — publish-drift detector"
echo "  14:00 UTC — pipeline-prioritizer (rank backlog, inject unmapped queries)"
echo "  15:00 UTC — scheduler (publish-due + pipeline)"
echo "  16:00 UTC — pipeline-scheduler (brief drip)"
echo ""
echo "  WEEKLY (Monday)"
echo "  02:00 UTC Mon — competitor-watcher (UTC, like every job here; PT hour shifts with DST)"
echo "  07:30 UTC — insight-aggregator"
echo "  08:00 UTC — keyword-research (DataForSEO)"
echo "  10:00 UTC — meta-ads-collector"
echo "  10:10 UTC — meta-ads-analyzer"
echo "  14:45 UTC — cro-analyzer"
echo "  14:30 UTC — seo-impact (what's working / organic revenue)"
echo "  14:10 UTC — seo-opportunity-analyzer (rank winnable opportunities, stage bigger moves)"
echo "  14:50 UTC — meta-ab-checker (conclude tests, auto-revert losers)"
echo "  15:00 UTC — meta-optimizer (rewrite low-CTR metas) + quick-win-targeter"
echo ""
echo "  WEEKLY (Sunday)"
echo "  06:00 PT  — campaign-analyzer"
echo "  07:00 PT  — ads-weekly-recap"
echo "  17:00 UTC — offsite snapshot backup (DigitalOcean Spaces, keeps 12 weekly)"
echo "  17:30 UTC — prune-ad-studio (deep age-only prune, past 90 days)"
echo "  18:00 UTC — creatives-budget (hard disk ceiling sweep)"
echo ""
echo "  BIWEEKLY (every other Sunday)"
echo "  12:00 UTC — content-strategist calendar refresh"
echo ""
echo "  MONTHLY (1st of each month)"
echo "  08:00 UTC — content-gap analysis (DataForSEO)"
echo "  16:00 UTC — priority-tuner (closed-loop weight tuner)"
echo ""
echo "  SOAP GIVEAWAY (daily, UTC — see comments in this script for the TZ trap)"
echo "  08:30 UTC — giveaway reconcile-referrals (confirmation/referral rungs)"
echo "  08:40 UTC — giveaway referral audit (why a referral isn't paying; reports near-misses)"
echo "  08:45 UTC — giveaway daily report (spend gates)"
echo "  16:00 UTC — giveaway nudge-unconfirmed (re-send opt-in confirmation)"
echo "  08:05 UTC 2026-09-15 — giveaway close-entry-period (~1h AFTER entries close; UTC clock, no TZ prefix)"
echo ""
echo "View with: crontab -l"
echo "Logs in:   $PROJECT_DIR/data/reports/scheduler/"
