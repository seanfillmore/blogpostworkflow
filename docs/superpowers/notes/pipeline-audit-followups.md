# Pipeline Audit Follow-Ups

**Source:** notes captured 2026-04-16 from a content-pipeline audit session
**Promoted to docs:** 2026-05-09 (was sitting as `/stages` in repo root, untracked)

## Context

Stage 1 (meta-optimizer year refresh) was completed, plus significant editor improvements that weren't in the original spec. The items below are what's left from the original pipeline-audit design.

## Outstanding stages

- **Stage 3 — `post-analyst` (NEW agent):** pulls GSC keywords + DataForSEO competitive intel + topical position into a per-post analysis JSON. Pure research, no mutations.
- **Stage 4 — `post-health-scorer`:** evolves `legacy-triage` with Shopify / GA4 / structural signals to produce Protect / Enhance / Rebuild tiers. Makes the rebuilder respect winners.
- **Stage 5 — link-repair alternate-source mode:** when a source 404s, find equivalent content at a working URL instead of just stripping the link.
- **Stage 6 — writer target word count:** brief includes word count range from competitive analysis (shorter explainers, longer guides).
- **Stage 7 — `image-generator --evaluate-existing`:** Claude Vision review of existing images, decide keep vs. regenerate.
