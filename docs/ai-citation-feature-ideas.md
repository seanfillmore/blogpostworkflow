# AI Citation Optimization — Feature Ideas

Goal: increase citations of realskincare.com in ChatGPT, Perplexity, and Google AI Overviews. Conversions attributed to ChatGPT referrals are already trending up; these features close the feedback loop and systematically improve citation likelihood.

## Background

LLM search engines (ChatGPT Search, Perplexity, Google AI Overviews) pick citations based on:

1. **Crawlability** — can their bot fetch the page (GPTBot, OAI-SearchBot, PerplexityBot, Google-Extended, ClaudeBot)
2. **Extractability** — is the answer in clean, parseable text near the top of the page
3. **Specificity** — concrete claims, numbers, named entities, dates
4. **Structure** — schema markup (FAQ, Product, Review), Q&A blocks, lists
5. **Trust signals** — author bylines, citations, third-party brand mentions, review counts

ChatGPT Search is Bing-powered, so Bing index health is foundational. Perplexity uses its own crawler plus Bing. AI Overviews use Google's index.

## Six Features to Build

### 1. AI Citation Tracker Agent

**What:** Run a fixed list of 20-30 target prompts through ChatGPT, Perplexity, and Gemini on a weekly schedule. Parse responses for `realskincare.com` mentions plus competitor mentions. Log share-of-voice over time.

**Why it matters:** Without measurement we can't tell whether any of the other improvements are working. This is the feedback loop for the entire AI-SEO effort.

**Cost:** ~$10/mo total. Perplexity Sonar API ~$5/mo, OpenAI API pay-per-call, Gemini API has a free tier.

**Inputs:**
- Target prompt list (e.g. "best natural deodorant", "is aluminum deodorant safe", "natural deodorant that actually works", brand-specific queries)
- Competitor brand list

**Outputs:**
- Weekly markdown report: cited yes/no per prompt per LLM, competitor citations, week-over-week trend
- JSON history file for charting in dashboard

**Build notes:** Fits the existing agent pattern in `agents/`. Schedule via the existing pipeline-scheduler. Surface results in the dashboard.

---

### 2. Answer-First Rewriter Agent

**What:** Audit blog post intros. Flag any post where the first 60 words do not directly answer the question in the title. Offer LLM-generated rewrites.

**Why it matters:** LLMs extract the first clear answer they find on a page. "Deodorant has been around for centuries..." gets skipped; "Natural deodorant works by neutralizing odor-causing bacteria with magnesium and baking soda..." gets cited.

**Cost:** $0 (uses existing Claude API access).

**Inputs:** All published blog posts from Shopify (already accessible via shopify-collector).

**Outputs:**
- Markdown report listing posts that fail the answer-first check
- Suggested rewrites for the first paragraph
- Optional: auto-apply rewrites via the existing publisher agent (with human approval gate)

**Build notes:** Reuses blog-post-verifier infrastructure. Heuristic check first (does the intro contain the noun phrase from the title?), then Claude evaluates intent.

---

### 3. FAQ Schema Coverage Report

**What:** Scan all products, collections, and blog posts. Flag pages missing `FAQPage` JSON-LD schema. For pages with FAQs in the body but no schema, auto-generate the schema block.

**Why it matters:** `FAQPage` schema is disproportionately favored by AI Overviews and gets pulled verbatim into ChatGPT responses. Currently underused on the site.

**Cost:** $0.

**Inputs:** Sitemap index + page HTML.

**Outputs:**
- Coverage report: pages with FAQs vs pages with FAQ schema
- Generated JSON-LD for any gap pages, ready to inject via schema-injector agent
- Recommendations for product pages that need 5-8 customer FAQs added (sourced from Judge.me reviews)

**Build notes:** Extends the existing schema-injector. Pulls candidate FAQ content from Judge.me review text where customers ask questions.

---

### 4. llms.txt Generator

**What:** Auto-generate an `/llms.txt` file at the site root listing the best content with one-line descriptions, organized by category (products, collections, top blog posts).

**Why it matters:** Emerging convention respected by Perplexity, Anthropic, and others. Low effort, no downside, future-proofs against the standard becoming more important. Acts as a curated sitemap specifically for LLMs.

**Cost:** $0.

**Inputs:** Output from sitemap-indexer + page metadata.

**Outputs:** Generated `llms.txt` file, deployed as a Shopify static asset or via theme.

**Build notes:** Standalone agent, runs after sitemap-indexer. Should regenerate on a schedule (weekly) so new content shows up automatically.

---

### 5. Specificity Audit Agent

**What:** Scan product page copy for vague marketing language ("premium", "high-quality", "crafted with care", "luxurious"). Flag and suggest concrete replacements drawn from Judge.me review text — customers describe products specifically while marketing copy tends toward abstraction.

**Why it matters:** LLMs prefer specific, fact-based statements when picking what to cite. "Contains 15% zinc oxide and lasts 24 hours" gets cited; "Premium natural protection" does not.

**Cost:** $0.

**Inputs:**
- Product descriptions from Shopify
- Judge.me review text per product
- Banned/flagged word list (configurable)

**Outputs:**
- Per-product report: flagged phrases, suggested specific replacements pulled from review language
- Optional auto-rewrite via product-optimizer agent

**Build notes:** Extends product-optimizer. The clever piece is mining review language — customers naturally use the specific phrasing LLMs want to cite.

---

### 6. Brand SERP Monitor

**What:** Weekly check of Google and Bing search results for brand queries: "realskincare.com", "real skincare reviews", "real skincare deodorant". Capture top 10 results and flag any negative or off-brand content.

**Why it matters:** When ChatGPT answers "is real skincare legit?", it pulls from the brand SERP. If Trustpilot 3-star results dominate, that's what gets cited. We need visibility into what LLMs see when they research the brand.

**Cost:** ~$0-15/mo. Free via scraping (fragile) or via SerpApi/DataForSEO at low query volumes.

**Inputs:** Brand query list, target search engines.

**Outputs:**
- Weekly snapshot of top 10 results per brand query per engine
- Alert when a new negative result appears or rank position drops
- Recommendations for owned content to crowd out negative results

**Build notes:** New agent. Pairs with rank-tracker but is brand-query specific rather than keyword-rank specific.

## Foundational Hygiene (Do First, Not a Build)

Before or alongside these features, verify the basics:

- `robots.txt` allows GPTBot, OAI-SearchBot, ChatGPT-User, PerplexityBot, Google-Extended, ClaudeBot
- Site is registered and healthy in Bing Webmaster Tools (ChatGPT Search runs on Bing)
- Product pages have `Product`, `AggregateRating`, and `Review` schema rendering correctly
- Wikidata entry exists for the brand if eligible

## Suggested Build Order

1. **AI Citation Tracker** — measurement first; nothing else can be evaluated without it
2. **Answer-First Rewriter** — highest content-quality leverage, zero cost
3. **FAQ Schema Coverage** — high-leverage structural fix, zero cost
4. **Specificity Audit** — content quality, zero cost
5. **llms.txt Generator** — cheap insurance, zero cost
6. **Brand SERP Monitor** — useful but lowest urgency
