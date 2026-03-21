# Campaign Card Redesign

## Goal

Redesign the Campaign Proposals cards in the Ads tab dashboard to match the existing dashboard design language, expose full proposal data, and add a live budget editor with projection recalculation.

## Context

The existing cards are unstyled gray boxes with truncated rationale and minimal data. The rest of the dashboard uses a polished design system (Inter font, card shells with accent borders, metric grids, badges, clean action buttons). The campaign cards must match that standard.

## Changes

All changes are confined to `agents/dashboard/index.js` — CSS, HTML template, and client-side JS.

### Card Structure (per proposal)

Each proposal renders as a bordered item inside the card with five sections:

**1. Header**
- Campaign name (bold, 14px)
- Landing page URL (muted, 11px)
- Badge row: network type (`Search`) + status (`Proposed` amber / `Approved` green with budget amount)
- Date created (right-aligned, muted)

**2. Metrics Row** — 5-column grid, each column has label + value + note
- **Daily Budget**: editable `<input type="number">` with `$` prefix; pre-populated with `proposal.suggestedBudget` for proposed campaigns, or `proposal.approvedBudget` for approved campaigns (budget is locked/display-only in approved state — show as metric value, not an input); "Update" button appears on change (proposed only)
- **Est. Clicks/day**: from `projections.dailyClicks`; note shows CTR %
- **Monthly Cost**: from `projections.monthlyCost` formatted as `$N`; note shows avg CPC
- **Est. Conversions**: from `projections.monthlyConversions`; note shows CVR %
- **Est. Revenue**: from `projections.monthlyRevenue` in green; note shows avg order value (revenue ÷ conversions)

When the user changes the budget input and clicks "Update", the client recalculates monthly cost, daily clicks, conversions, and revenue proportionally (new budget ÷ suggested budget × baseline projection values) and updates the DOM — no server round-trip needed.

**3. Rationale** — full text, no truncation. Label: "Why this campaign" (uppercase, muted). Body: 12px, line-height 1.6.

**4. Ad Groups row** — pills showing each ad group name + keyword count (e.g. "Fluoride Free Toothpaste · 5 kw"). Negative keyword count shown right-aligned in muted text.

**5. Actions row**
- **Proposed status**: "✓ Approve & Set Budget" (green) + "Dismiss" (outlined)
  - Approve sends `{ approvedBudget: <current input value> }` to `POST /api/campaigns/:id/approve`. The current input value is used directly — no need to click Update first; the Approve action reads whatever is in the input at click time.
  - Dismiss calls the existing `dismissCampaign(id)` JS function (already implemented), which posts to `POST /api/campaigns/:id/dismiss`
- **Approved status**: "▶ Launch in Google Ads" (green) + "Dismiss" (outlined)
  - Launch calls the existing `launchCampaign(id)` JS function (already implemented), which spawns `campaign-creator` via the `/run-agent` SSE endpoint
  - Dismiss calls `dismissCampaign(id)` same as above
- Right-aligned note: "Approval sets budget — launch is a separate step" or "Budget approved — ready to go live"

### CSS

New classes to add (matching existing design tokens):
- `.proposal` — bordered container, `border: 1px solid var(--border); border-radius: 8px; overflow: hidden`
- `.proposal-head` — light `#fafbff` background header section
- `.proposal-name` — 14px bold
- `.proposal-sub` — 11px muted
- `.metrics-row` — 5-column CSS grid with `border-bottom`
- `.metric` — padding 12px 16px, `border-right: 1px solid var(--border)`
- `.metric-label` — 9px uppercase muted label
- `.metric-value` — 18px 800-weight
- `.metric-unit` — 11px muted suffix
- `.metric-note` — 10px muted subscript
- `.budget-input` — 72px wide, styled to match metric value size
- `.update-btn` — indigo button, hidden by default, shown via `.visible` class on input change
- `.rationale-row` — padded section with label + full text
- `.adgroup-pill` — `#f1f5f9` background pill with border
- `.adgroups-label` — 9px uppercase muted

Remove old classes: `.camp-proposal`, `.camp-proposal-header`, `.camp-proposal-name`, `.camp-proposal-meta`, `.camp-proposal-rationale`, `.camp-proposal-actions`, `.camp-budget-input`.

### JS — `renderCampaignCards()`

Rewrite the proposals rendering section:
- Build the 5-section HTML per proposal
- `handleBudgetChange(input)` — show the Update button
- `updateProjections(id, newBudget)` — recalculate proportionally, update DOM cells; recalculation formula: `newBudget / suggestedBudget × baseline` for monthlyCost, dailyClicks, monthlyConversions, monthlyRevenue
- `approveCampaign(id)` — already exists; update it to read the current budget input value and send `{ approvedBudget: value }` in the POST body

## What Does Not Change

- API routes (`/api/campaigns`, `/api/campaigns/:id`, approve, dismiss, clarify, resolve)
- Clarifications Needed card
- Active Campaigns card
- All other dashboard tabs and cards
- All agent code (campaign-analyzer, campaign-creator, campaign-monitor)
- Tests

## Testing

Manual verification only (UI change). After implementation:
1. Confirm 3 proposal cards render with all 5 sections visible
2. Change a budget value — verify Update button appears
3. Click Update — verify monthly cost, conversions, revenue update proportionally
4. Approve a proposal — verify status badge changes to "Approved · $N/day" and Launch button appears
5. Confirm old `.camp-proposal-*` CSS classes are gone
