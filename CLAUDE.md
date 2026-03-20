# SEO Claude Team

This project builds a team of AI agents and skills for auditing, improving, and growing the SEO performance of Shopify ecommerce stores. The initial target is a single Shopify site used to validate the system before expanding to additional clients.

## Integrations

- **Ahrefs MCP** — Keyword research, backlink analysis, site metrics, rank tracking, site audit
- **Google Search Console** — Organic traffic data, indexing status, search performance, crawl errors
- **Shopify** — Page content, product/collection structure, blog posts, sitemap

## Agent Team

### Sitemap Indexer Agent
- Reads the site's XML sitemap
- Builds a structured index of all pages: blog posts, collections, product pages
- Outputs a normalized page map with URLs, titles, and page types
- Used as input by other agents (linking auditor, content gap, etc.)

### Internal Link Auditor Agent
- Consumes the sitemap index
- Crawls page content to map all internal links
- Identifies: orphaned pages (no inbound links), dead internal links (404s), link distribution imbalances, missing cross-links between related products/collections/blog posts
- Output: structured audit report with prioritized issues and recommended link additions

### Blog Post Verifier Agent
- Reads existing blog posts from Shopify
- Validates factual claims (uses web search to verify)
- Checks all outbound links are valid (not 404 or redirected)
- Checks internal links exist and point to correct pages
- Output: verification report per post flagging issues with specific line references

### Blog Post Writer Agent
- Writes SEO-optimized blog posts for Shopify
- Uses keyword research from Ahrefs and GSC data to target the right terms
- Incorporates internal links to relevant products, collections, and other blog posts
- Output: complete blog post in clean HTML, ready to paste directly into Shopify's HTML editor

### Keyword Research Agent
- Uses Ahrefs to identify keyword opportunities: high volume, low difficulty, relevant to the store's niche
- Cross-references GSC data to find keywords the site already ranks for but hasn't optimized
- Identifies content gaps vs competitors
- Output: keyword report with opportunity scores, recommended target page type (blog, product, collection)

### Technical SEO Auditor Agent
- Audits on-page SEO across all page types: title tags, meta descriptions, H1s, structured data (JSON-LD), image alt text, canonical tags
- Flags missing, duplicate, or over-length fields
- Checks page speed signals and mobile usability where accessible
- Output: structured audit report with per-page issues and fix recommendations

### Product/Collection Page Optimizer Agent
- Reviews product and collection page content for SEO quality
- Identifies thin content, missing keywords, poor descriptions
- Suggests or rewrites product descriptions and collection page copy
- Output: optimization recommendations per page; rewrites in HTML format when requested

### Content Gap Agent
- Uses Ahrefs competitor analysis to identify topics competitors rank for that this site does not cover
- Maps gaps to content type recommendations (blog post, new collection, FAQ section)
- Output: prioritized content gap report with suggested titles and target keywords

### SEO Reporting Agent
- Aggregates data from Ahrefs, GSC, and audit runs
- Tracks rank changes, traffic trends, backlink growth, and issue resolution over time
- Output: periodic SEO performance report summarizing wins, regressions, and next priority actions

## Output Standards

| Agent | Output Format |
|---|---|
| Blog Post Writer | HTML (Shopify-ready) |
| Blog Post Verifier | Markdown report with flagged issues |
| Internal Link Auditor | Markdown report, prioritized issue list |
| Sitemap Indexer | Structured JSON index |
| Keyword Research | Markdown table with metrics |
| Technical SEO Auditor | Markdown report, per-page issues |
| Product/Collection Optimizer | Recommendations in Markdown; rewrites in HTML |
| Content Gap | Markdown report with priority ranking |
| SEO Reporting | Markdown summary report |

## Development Rules

These rules are non-negotiable and apply to every change in every conversation:

1. **Always work on a branch** — never commit directly to `main`. Create a feature branch (`feature/<name>`) or fix branch (`fix/<name>`) before writing any code.
2. **Test locally before pushing to the server** — run the agent or script locally, verify output, and check the local dashboard if UI is involved. Only push to the server after local verification passes.
3. **These rules apply even for small fixes** — a one-line bug fix still requires a branch and local test.

Failure to follow these rules risks deploying broken code to the production server and losing work that cannot be recovered from context.

## Project Conventions

- All agents operate on a single configured Shopify site at a time (site config stored in project settings)
- Agents should be composable — the sitemap index is a shared input used by multiple agents
- When writing content (blog posts, product copy), always incorporate internal links informed by the current sitemap index
- Ahrefs monetary values are returned in USD cents — always divide by 100 before displaying
- Store no sensitive credentials in code; use environment variables or config files excluded from version control
