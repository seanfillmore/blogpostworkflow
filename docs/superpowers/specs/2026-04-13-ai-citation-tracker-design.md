# AI Citation Tracker Agent

**Date:** 2026-04-13
**Status:** Approved

## Problem

Conversions from ChatGPT referrals are trending up but we have no visibility into how often LLMs cite or mention realskincare.com, which competitors get cited instead, or whether our content optimizations improve citation rates over time.

## Architecture

Two new files plus scheduler/dashboard integration:

1. **`lib/llm-clients.js`** — thin wrappers for each LLM API (Perplexity, ChatGPT, Gemini, Claude, Google AI Overview). Each returns `{ text, citations }`.
2. **`agents/ai-citation-tracker/index.js`** — runs prompts through all sources, detects mentions/citations, saves weekly snapshots and markdown report.

## Prompt List

**File:** `config/ai-citation-prompts.json`

A flat JSON array of 30 strings. Same prompts sent to every source for apples-to-apples comparison.

Categories:
- **Product queries** (10): "best natural deodorant", "best coconut oil toothpaste", "best organic body lotion", "natural roll on deodorant", "fluoride free toothpaste that works", "coconut oil lip balm", "natural bar soap for sensitive skin", "aluminum free deodorant for women", "coconut body lotion for dry skin", "sls free toothpaste"
- **Problem queries** (8): "how to stop sweating naturally", "is aluminum in deodorant safe", "why switch to natural deodorant", "how to whiten teeth without fluoride", "what is sls in toothpaste", "best ingredients for dry skin", "how to choose natural skincare", "is coconut oil good for skin"
- **Comparison queries** (6): "natural deodorant vs regular deodorant", "coconut oil toothpaste vs regular", "organic lotion vs regular lotion", "bar soap vs liquid soap", "natural lip balm vs chapstick", "fluoride vs fluoride free toothpaste"
- **Brand queries** (6): "real skin care reviews", "is realskincare.com legit", "real skin care deodorant", "real skin care toothpaste", "best natural skincare brands", "small natural skincare companies"

## LLM Client Module

**File:** `lib/llm-clients.js`

Exports one function per source. Each takes a prompt string, returns `{ text, citations }` where `citations` is an array of URLs (empty if the source doesn't provide them).

### Perplexity
- Endpoint: `POST https://api.perplexity.ai/chat/completions`
- Model: `sonar`
- Auth: `Bearer $PERPLEXITY_API`
- Returns `citations` array from response — actual URLs

### ChatGPT
- Endpoint: `POST https://api.openai.com/v1/chat/completions`
- Model: `gpt-4o-mini`
- Auth: `Bearer $CHATGPT_API`
- No citations — text only

### Gemini
- Endpoint: `POST https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=$GEMINI_API_KEY`
- No auth header (key in URL)
- No citations — text only

### Claude
- Endpoint: `POST https://api.anthropic.com/v1/messages`
- Model: `claude-haiku-4-5-20251001`
- Auth: `x-api-key: $ANTHROPIC_API_KEY`
- No citations — text only

### Google AI Overview
- Uses existing `getSerpResults()` from `lib/dataforseo.js` with `load_async_ai_overview: true`
- Parses the `ai_overview` item's markdown for source URLs and text
- Citations extracted from markdown link URLs

All calls use `max_tokens: 500` (or equivalent). Each function catches errors and returns `{ text: null, citations: [], error: message }` on failure — one failed source doesn't stop the run.

## Detection Logic

**File:** `agents/ai-citation-tracker/index.js`

For each prompt × source response:

1. **Citation check** (Perplexity, AI Overview only): does any citation URL contain `realskincare.com`?
2. **Mention check** (all sources): does the response text (lowercased) contain any of: `realskincare`, `real skin care`, `realskincare.com`?
3. **Competitor detection**: check response text for a configured list of competitor brand names. Competitors stored in `config/ai-citation-prompts.json` alongside prompts:

```json
{
  "prompts": ["best natural deodorant", ...],
  "our_brand": ["realskincare", "real skin care", "realskincare.com"],
  "competitors": {
    "native": ["native deodorant", "native"],
    "schmidts": ["schmidt's", "schmidts"],
    "primallypure": ["primally pure", "primallypure"],
    "desertessence": ["desert essence"],
    "littleseedfarm": ["little seed farm"],
    "drgingers": ["dr. ginger's", "dr gingers"],
    "tomsofmaine": ["tom's of maine", "toms of maine"],
    "burtsbees": ["burt's bees", "burts bees"],
    "ethique": ["ethique"]
  }
}
```

## Output

### Weekly snapshot: `data/reports/ai-citations/YYYY-MM-DD.json`

```json
{
  "date": "2026-04-13",
  "prompts_run": 30,
  "sources": ["perplexity", "chatgpt", "gemini", "claude", "google_ai_overview"],
  "results": [
    {
      "prompt": "best natural deodorant",
      "responses": {
        "perplexity": {
          "cited": false,
          "mentioned": false,
          "citations": ["primallypure.com", "littleseedfarm.com"],
          "competitor_mentions": ["native", "schmidts", "primallypure"]
        },
        "chatgpt": {
          "cited": null,
          "mentioned": false,
          "competitor_mentions": ["native", "schmidts"]
        }
      }
    }
  ],
  "summary": {
    "citation_rate": {
      "perplexity": 0.03,
      "google_ai_overview": 0.0
    },
    "mention_rate": {
      "perplexity": 0.07,
      "chatgpt": 0.03,
      "gemini": 0.0,
      "claude": 0.0,
      "google_ai_overview": 0.0
    },
    "top_competitor_mentions": {
      "native": 18,
      "schmidts": 12,
      "primallypure": 8
    }
  }
}
```

Latest snapshot copied to `data/reports/ai-citations/latest.json`.

### Markdown report: `data/reports/ai-citations/ai-citation-report.md`

Includes:
- Summary table: citation/mention rate per source
- Top competitor mentions ranked by frequency
- Week-over-week comparison (if previous snapshot exists): arrows for improving/declining rates
- Per-prompt detail: which prompts cite us, which cite competitors

## Dashboard Card

Add `renderAICitationCard(d)` to the SEO tab.

Shows:
- Our mention rate per LLM as a simple table row
- Top 5 competitor mention counts
- Trend arrows vs previous week

Data loaded in `data-loader.js` from `data/reports/ai-citations/latest.json` as `aiCitations`.

## Scheduler

Weekly Sunday, after cannibalization resolver:

```javascript
// Step 8b: AI citation tracking across LLMs
runStep('ai-citation-tracker', `"${NODE}" agents/ai-citation-tracker/index.js`, { indent: '    ' });
```

## Notification

Wire into `daily-summary` — if `latest.json` exists and was generated in the last 7 days, include a one-line summary: "AI Citations: mentioned in X/150 responses (Y%), top competitor: native (18 mentions)".

## Files

| File | Change |
|------|--------|
| `lib/llm-clients.js` | Create — 5 LLM client functions |
| `agents/ai-citation-tracker/index.js` | Create — main agent |
| `config/ai-citation-prompts.json` | Create — prompt list + competitor brands |
| `agents/dashboard/public/js/dashboard.js` | Add `renderAICitationCard()` |
| `agents/dashboard/lib/data-loader.js` | Load `aiCitations` from latest.json |
| `scheduler.js` | Add weekly step |
| `agents/daily-summary/index.js` | Add AI citation summary line |

## Cost

30 prompts × 5 sources × 4 weeks/month ≈ $1.08/month total.

## Not in scope

- Auto-optimizing content based on citation data (that's the answer-first rewriter, a separate agent)
- Responding to brand queries or reputation management
- Real-time alerts (weekly cadence is sufficient for tracking trends)
