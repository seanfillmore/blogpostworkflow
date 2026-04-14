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
2. **Always merge via pull request — never merge directly to `main`.** Every change, no matter how small, must land on main via an opened PR. Do not fast-forward, squash-merge locally, or push to `main` from the feature branch. Open the PR with `gh pr create` and let it go through the normal review surface.
3. **Test locally before pushing to the server** — run the agent or script locally, verify output, and check the local dashboard if UI is involved. Only push to the server after local verification passes.
4. **Test a fix on one post before bulk-applying** — when a bug affects many posts (HTML issues, metadata fixes, etc.), verify the fix on a single post end-to-end (edit → upload → check live site) before writing batch scripts or applying changes across all posts.
5. **These rules apply even for small fixes** — a one-line bug fix still requires a branch, a PR, and a local test.

## Dashboard Code Layout

Browser HTML, CSS, and JavaScript for the dashboard live in `agents/dashboard/public/`. Edit those files directly — they are served as static assets, so no template literal escaping rules apply.

## Code Review Checklist — Blog Post Writer (`agents/blog-post-writer/index.js`)

These checks must be in the writer and must throw (not warn) before saving the HTML file:

1. **`stop_reason === 'max_tokens'`** — the Claude API reports this when output is cut off at the token limit. If true, the post is incomplete. **Throw an error, do not save.** The file will be truncated mid-tag and produce broken links when published.
2. **Unclosed `href` attribute** — regex `/href="[^"]*$/` on the HTML. If matched, output was truncated mid-link. **Throw an error, do not save.** Shopify will auto-close the broken tag into a malformed URL (e.g. `https://domain.com/blogs/news/best`) that 404s.
3. Both checks must be fatal (throw), not warnings, because truncated HTML published to Shopify creates broken links that require a manual audit cycle to discover and fix.

## Code Review Checklist — Technical SEO Agent (`agents/technical-seo/index.js`)

**Cloudflare `cdn-cgi/l/email-protection` false positives:**

Ahrefs flags `https://www.realskincare.com/cdn-cgi/l/email-protection` as a 404 on every page that has the site footer email address. This is Cloudflare's email obfuscation feature — it replaces email addresses in the rendered HTML with a script-decoded URL. Ahrefs crawls the raw HTML and sees a 404.

**This is not a real broken link. Do not include it in audit reports or attempt to fix it.**

Rules:
- Filter `cdn-cgi/l/email-protection` from all broken-link counts and listings in the audit report
- Filter it from `fix-links` processing — the URL lives in the theme template, not `body_html`, so it cannot be fixed by editing article content
- If the filter removes all broken links for a given page, skip that page entirely
- Add a note in the audit report explaining how many pages were filtered and why

## Project Conventions

- All agents operate on a single configured Shopify site at a time (site config stored in project settings)
- Agents should be composable — the sitemap index is a shared input used by multiple agents
- When writing content (blog posts, product copy), always incorporate internal links informed by the current sitemap index
- Ahrefs monetary values are returned in USD cents — always divide by 100 before displaying
- `JUDGEME_API_TOKEN` — Judge.me private API token (from Judge.me dashboard → Settings → API); shop domain is read from `SHOPIFY_STORE`
- Store no sensitive credentials in code; use environment variables or config files excluded from version control

## Server Deployment

**Server:** `root@137.184.119.230` (DigitalOcean, Ubuntu)
**Project path:** `/root/seo-claude`
**Process manager:** PM2 — process name `seo-dashboard`
**SSH:** Key-based auth configured (no password needed from this machine)

### Deploy command

```bash
ssh root@137.184.119.230 'cd ~/seo-claude && git pull && pm2 restart seo-dashboard'
```

### Check server status

```bash
ssh root@137.184.119.230 'pm2 status && pm2 logs seo-dashboard --lines 20 --nostream'
```

### Deploy workflow

1. Merge PR to `main` on GitHub
2. Run the deploy command above
3. Verify dashboard is still `online` in PM2 output

**Never commit passwords or credentials to the repo.** SSH key auth is set up — no password required.
