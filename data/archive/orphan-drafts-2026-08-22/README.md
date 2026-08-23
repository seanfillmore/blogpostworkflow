# Abandoned duplicate blog drafts — archived before deletion (2026-08-22)

Full Shopify article objects for 15 unpublished blog drafts deleted from blog
`48998449187` ("news") on 2026-08-22, saved here **before** deletion per the
standing rule in `data/archive/README.md`: download full-resolution/full-content
before any destructive Shopify call. Deleting a Shopify article (like deleting
a product image) is not reversible through the API — there is no undelete.

## What these are

In April 2026 the content pipeline independently regenerated the same 9 topics
2–3 times within days of each other (handles suffixed `-1`, `-2`, or duplicated
without a suffix). It self-corrected by publishing only the latest generation
of each topic, but nothing ever cleaned up the earlier, never-published
attempts. These 15 articles are those earlier attempts — full drafts,
generated and immediately superseded, sitting unpublished in Shopify for
4+ months with zero redirect and zero recorded traffic.

A prior audit (whose report file was lost when its worktree was removed)
estimated 17 such orphans. This archive covers **15**, not 17 — see
"Discrepancy from the prior estimate of 17" below for the fully-evidenced
reason two fewer qualified.

## The four criteria every article here met

A draft was archived-and-deleted only if **all four** held, verified against
live Shopify data immediately before deletion:

1. **No redirect** — no Shopify redirect (checked both by exact source-path
   match against `/blogs/news/<handle>` and by substring scan of every
   redirect's path and target) points at or away from the article.
2. **Zero GSC traffic** — scanned every daily GSC snapshot on the production
   server (`data/snapshots/gsc/*.json`, 163 days back to 2026-03-02, which
   covers the full lifetime of every one of these drafts) for the article's
   exact URL path. Zero clicks and zero impressions on every single day, for
   every one of the 15.
3. **A published sibling covering the same topic** — for every article here,
   at least one other article on the same topic is live on the blog right
   now (`published_at` not null), confirmed by an exact or near-exact title
   match, in most cases with the identical title live under a `-1`/`-2`-free
   or differently-suffixed handle. This is the actual "winner" of the April
   regeneration the pipeline never cleaned up after itself.
4. **No scheduled/rebuild/kill marker** — no `data/posts/<slug>/meta.json`
   anywhere in the repo references the article's `shopify_article_id`, and a
   repo-wide grep for each id turned up nothing in any script, report, or
   config. No local intermediate ever existed for these — consistent with
   "generated, superseded before anything downstream touched it, and never
   picked back up."

Every article was also **re-fetched live immediately before deletion** (not
from an earlier snapshot) to reconfirm its handle matched what the evidence
gathering expected and that it was still unpublished. All 15 matched.

## Discrepancy from the prior estimate of 17

Re-deriving from live evidence found **15** qualifying orphans, not the
context estimate of 17. Two candidates that would otherwise fit the pattern
were excluded because they fail criterion 3:

| id | handle | why excluded |
|---|---|---|
| 563474006186 | `is-coconut-oil-good-for-your-hair-benefits-how-to-use-it-1` | No published sibling. Every article on the blog with "hair" in its handle is unpublished — RSC sells no hair products, and the entire hair cluster was deliberately taken offline in the two days before this cleanup (`scripts/unpublish-hair-posts-2026-08-22.mjs`, `scripts/unpublish-hair-duplicate-2026-08-22.mjs`). |
| 563473809578 | `best-diy-natural-hair-masks-for-dry-hair-that-work` | Same reason — no live hair-topic sibling remains. |

These two most likely genuinely were orphans at the time of the prior
(lost) audit — the hair cluster still had a published anchor page then.
Since that audit, the hair cluster's own live sibling was itself
deliberately unpublished (and redirected) as unrelated cleanup, which
retroactively broke criterion 3 for these two. They were **not deleted**
and remain live drafts in Shopify; if the hair cluster is ever revisited,
re-run the same four-criteria check on them rather than assuming they're
still orphans.

The remaining accounting for all 34 originally-unpublished articles on this
blog (confirmed exhaustive): 15 deleted here + 7 pending-cannibalization
drafts redirected to a live sibling + 2 deliberate drafts redirected to a
converting page + 4 scheduled drafts awaiting a future publish date + 4
hair-cluster posts deliberately unpublished-and-redirected in the two days
before this cleanup + the 2 hair-cluster leftovers above = 34.

## Contents

One JSON file per deleted article, named `<shopify_article_id>.json`,
containing the **complete** object returned by
`GET /blogs/48998449187/articles/{id}.json` — `id`, `handle`, `title`,
`body_html`, `summary_html`, `author`, `tags`, `created_at`, `updated_at`,
`published_at` (null for all — never published), `blog_id`, `user_id`,
`template_suffix`, `image`, `admin_graphql_api_id`. Nothing was trimmed.

| id | handle | title |
|---|---|---|
| 563474104490 | unscented-deodorant-what-it-is-why-it-works-1 | Unscented Deodorant: What It Is & Why It Works |
| 563474071722 | organic-coconut-oil-types-uses-benefits-for-skin-1 | Organic Coconut Oil: Types, Uses & Benefits for Skin |
| 563474038954 | natural-soap-bar-the-clean-skin-guide-you-need-1 | Natural Soap Bar: The Clean Skin Guide You Need |
| 563473973418 | how-to-dry-brush-your-body-step-by-step-guide-1 | How to Dry Brush Your Body: Step-by-Step Guide |
| 563473907882 | dry-brushing-skin-benefits-technique-what-to-expect-1 | Dry Brushing Skin: Benefits, Technique & What to Expect |
| 563473875114 | charcoal-toothpaste-does-it-work-is-it-safe-1 | Charcoal Toothpaste: Does It Work & Is It Safe? |
| 563473776810 | antibacterial-body-soap-what-to-look-for-why-it-matters-1 | Antibacterial Body Soap: What to Look For & Why It Matters |
| 563473744042 | aluminum-free-antiperspirant-what-it-is-does-it-work-1 | Aluminum-Free Antiperspirant: What It Is & Does It Work |
| 563473711274 | natural-lip-balm-recipe-easy-diy-in-15-minutes | Natural Lip Balm Recipe: Easy DIY in 15 Minutes |
| 563473678506 | coconut-oil-deodorant-benefits-diy-recipes-what-to-know | Coconut Oil Deodorant: Benefits, DIY Recipes & What to Know |
| 563473612970 | is-coconut-oil-good-for-stretch-marks-heres-the-truth | Is Coconut Oil Good for Stretch Marks? Here's the Truth |
| 563472072874 | clean-body-lotion-what-to-look-for-best-picks | Clean Body Lotion: What to Look For & Best Picks |
| 563471941802 | does-coconut-oil-help-with-stretch-marks-the-truth | Does Coconut Oil Help With Stretch Marks? The Truth |
| 563471909034 | best-non-toxic-body-lotion-clean-ingredients-guide | Best Non Toxic Body Lotion: Clean Ingredients Guide |
| 563469910186 | coconut-oil-for-stretch-marks-does-it-really-work | Coconut Oil for Stretch Marks: Does It Really Work? |

## How to restore one

Read the saved JSON and recreate it with `createArticle` from `lib/shopify.js`
(the same helper `deleteArticle` was called from — both derive the API
version from `lib/shopify-api-version.js`):

```js
import { createArticle } from '../lib/shopify.js';
import { readFileSync } from 'fs';

const saved = JSON.parse(readFileSync('data/archive/orphan-drafts-2026-08-22/<id>.json', 'utf8'));
const restored = await createArticle(48998449187, {
  title: saved.title,
  body_html: saved.body_html,
  summary_html: saved.summary_html,
  author: saved.author,
  tags: saved.tags,
  handle: saved.handle,
  published: false, // it was never published — restore it as a draft, not live
});
console.log('Restored as new article id', restored.id);
```

Shopify assigns a **new** article id on recreation — the original id in the
saved JSON is historical record only, not reusable. If the handle collides
with a live article, Shopify will suffix it; check before assuming the
restored URL matches the original.
