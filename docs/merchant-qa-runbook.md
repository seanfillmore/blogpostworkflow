# Merchant Center Q&A feed — runbook and two open tasks

Handoff for a fresh session. Everything below is built, deployed and verified on
production as of **2026-09-06**; the two tasks at the end are what is left.

## What exists

| file | what it is |
|---|---|
| `lib/merchant-qa.js` | pure: question extraction, dedupe, routing, filtering, feed rendering. 15 tests in `tests/lib/merchant-qa.test.js` |
| `scripts/build-merchant-qa-feed.mjs` | the runner. Dry by default; `--product <handle>` or `--all`; `--apply` drafts answers and writes files |
| `data/reports/merchant-qa/` | output: `supplemental-qa-<date>.tsv` and `review-<date>.md`. **Untracked, not gitignored — never commit these** |

It turns real GSC buyer questions into a Merchant Center **supplemental feed** of
`question_and_answer` pairs. **Nothing uploads to Google** — the TSV is a file a
human reviews and submits by hand.

**Why this is worth doing at all, and why it is not the tactic already
falsified.** The 2026-08-19 falsification was **Shopify Catalog → ChatGPT**,
where listing completeness read "4 of 4 checks passed" both before and after the
taxonomy work and the real block turned out to be reviews and sales velocity.
This is **Google Merchant Center → AI Overview / AI Mode**, and
`question_and_answer` is content that exists nowhere in the feed today rather
than a checkbox Google already scores. It is **still unproven**: nothing Google
publishes establishes these attributes move a ranking, and `popularity_rank` —
the one that sounds like a lever — is self-asserted relative to your OWN
catalogue, so it cannot touch the incumbent problem. Do it because it is cheap
and the questions are measured, not because it is expected to fix visibility.
Background: the `marketing-ai-search-visibility` skill.

## Five things that will waste your time if you do not know them

1. **DataForSEO is IP-whitelisted to the production box.** Calls from a laptop
   return `Access denied. Your IP is not whitelisted`. Run SERP work over SSH.
2. **`DATAFORSEO_PASSWORD` in `.env` is ALREADY the base64 token.** The house
   client uses it verbatim as `Authorization: Basic ${...}`. Base64-encoding it
   again does not error — it returns **zero items**, which reads exactly like a
   query with no results.
3. **`lib/dataforseo.js`'s `extractSerpPayload` drops what you need.** It keeps
   PAA *questions* and ignores `ai_overview` entirely. To read overview text you
   must call `/v3/serp/google/organic/live/advanced` directly and walk
   `items.find(i => i.type === 'ai_overview')` recursively over `.items[].text`;
   sources are in `.references[].domain`.
4. **GSC snapshots are server-written and gitignored.** A local run finds none
   and throws. Run the builder on the box, then `scp` the report down:
   ```bash
   scp root@137.184.119.230:'~/seo-claude/data/reports/merchant-qa/*' data/reports/merchant-qa/
   ```
5. **AI Overviews are non-deterministic.** One pull returned an empty overview
   for a query that had one minutes earlier. Treat a single pull as a sample —
   the same 3-5 run rule `marketing-ai-search-visibility` applies to citation
   tracking applies here.

## Current state

Corpus: **28 GSC snapshots / 28,000 query rows → 586 distinct questions**,
routing to 16 products, with 78 withheld (see below).

**One product has been generated and reviewed: `coconut-oil-deodorant`, 7
answers, all gated clean.** Nothing has been submitted to Google.

Three properties the answers already have, verified rather than assumed:

- **Every specific traces to the live PDP verbatim** — "Coconut oil firms below
  76°F — warm in your hand", "Patch test before daily use", "odor control, not
  sweat plugging". Nothing invented.
- **All 7 pass `checkSeoCopyFields`**, and the gate is live rather than vacuous:
  `"our antiperspirant is made with coconut oil"` blocks on `product-category`,
  `"helps heal irritated skin and treats eczema"` blocks on `disease` +
  `therapeutic`.
- **Gate-passing is necessary, not sufficient.** Google's own overview says
  "lauric acid kills the bacteria that cause odour" and that *passes* our gate,
  because the subject is the ingredient. The same sentence with the PRODUCT as
  subject is exactly what `scripts/remediate-ingredient-benefit-headings.js`
  toned down. The prompt permits ingredient-level mechanism and forbids the
  product being the subject of kills/treats/heals/prevents.

## Task 1 — run `--all` and review

15 products remain. One LLM call each; the questions are already measured, so
there is no SERP spend here.

```bash
ssh root@137.184.119.230 'cd ~/seo-claude && node scripts/build-merchant-qa-feed.mjs --all --apply'
scp root@137.184.119.230:'~/seo-claude/data/reports/merchant-qa/*' data/reports/merchant-qa/
```

**What to check in the review file, in order:**

- **Anything a gate blocked.** A gated batch prints its violations and is
  skipped, never written. That is the policy working — re-run the product rather
  than editing the answer by hand.
- **Products with few or zero answers.** The prompt tells the model to return an
  empty answer rather than invent a spec, so a thin PDP produces few answers.
  That is correct behaviour and the fix is the PDP, not the prompt.
- **Whether each answer runs the four beats** (below). Beat 3 and beat 4 are
  where drafts regress first.
- **Repetition across answers for one product.** Some is unavoidable — every
  answer restates the formulation — but if four answers are interchangeable, the
  paraphrase dedupe let near-duplicate questions through and the threshold is
  worth re-measuring.

**The four beats.** Pulled live on 2026-09-06, every AI Overview for a
product-relevant question ran the same structure, so the prompt targets it:

1. direct answer, one short sentence
2. mechanism, at the **ingredient** level
3. the distinction that resolves the confusion — usually deodorant vs
   antiperspirant, which Google itself leads with
4. the practical caveat, stated rather than dodged

**Then submit by hand.** The TSV is a supplemental feed: `id` +
`question_and_answer` and nothing else. It must NOT restate title, price or
availability, or it overwrites the primary feed's live values. Merchant Center →
Data sources → add a supplemental source.

## Task 2 — measure the AI Overview citation rate

**The question this answers, and why the existing number does not.**
`agents/ai-citation-tracker` reports **~2% mention (4 of 180)**, and that is a
real measurement of a *different* thing: 75 branded and category prompts run
against **LLM APIs**, at n=1 per prompt×engine cell. It does not measure "does
Google cite realskincare.com in the AI Overview for a query we already rank
for", and the two answers appear to diverge sharply.

**The evidence that prompted this.** Of **8 queries pulled ad hoc on
2026-09-06**, `realskincare.com` was a cited source in the AI Overview for
**4**: "can you use coconut oil as deodorant" (our biggest question, 719 imp,
where we also rank #5 organically), "is coconut oil a good moisturizer", "is
coconut soap good for your skin", "is body wash antibacterial". **Eight queries
is not a rate** — that is the point of the task.

**What to build.** A read-only script that, for the top ~30 questions by
impressions across clusters:

- calls `/v3/serp/google/organic/live/advanced` from the server (see trap 2
  and 3 above for the auth and parsing shapes)
- records, per query: whether an `ai_overview` item exists at all, whether
  `realskincare.com` is in `.references[].domain`, our organic rank if present,
  and which domains ARE cited
- **runs each query 3 times** and reports a rate with its n, because overviews
  are non-deterministic and a single pull already produced one empty result
- writes `data/reports/ai-overview-citations/<date>.json` and a markdown summary

**Cost.** One DataForSEO SERP call per query per run — 30 queries × 3 runs = 90
calls. That is real spend on an unattended-capable script, so keep it a
hand-run tool and do not put it on cron without a decision.

**What would change from the answer.** If the citation rate is genuinely high,
the trust-rung conclusion in `marketing-ai-search-visibility` needs qualifying:
we would be well cited on **Google AI surfaces** while near-zero on standalone
assistants, which is a different diagnosis from "thin third-party corroboration
everywhere" and points at different work. If it is low, it corroborates the
existing reading and the four ad-hoc hits were luck. **Either way the number
belongs in the skill**, which currently carries only the ~2% figure.

**Do not merge this into `ai-citation-tracker`.** That agent answers the
LLM-API question and its n=1 sampling defect is separate and already documented.
Two measurements, two scripts — the same reasoning that keeps sources A and B
distinct in `lib/cluster-hold.js`.

## What the feed deliberately withholds

`isUnsuitableQuestion` drops two classes **before clustering and before the
cap**, so they can never take a slot they would have won on impressions. They
are **79 of 586 questions — 13.5% of slots but 42% of impressions**, so they
sorted to the top.

- **competitor-fact** ("does sensodyne have sodium lauryl sulfate", 1,249 imp).
  We cannot answer accurately — that overview cites `sensodyne.com` and
  `pronamel.us` and enumerates their SKUs — and answering about a rival inside
  our own product feed is what `agents/editor`'s rule 8 already treats as a
  BLOCKER for FAQ content.
- **diy** ("how to make natural moisturizer", 3,165 imp — the single biggest
  question in the corpus). Anti-commercial by construction, and its overview is
  a recipe with a double boiler and numbered steps.

Both are **named and counted in the run output**, never silently dropped.

The brand list is seeded from `config/competitors.json` and extended from the
data: that config holds five natural-DTC brands for content monitoring and only
**one** ("Native") appears in a real question, while the corpus is dominated by
mass-market names it was never meant to cover. Word boundaries keep "natural"
and "naturally" safe from the "native" entry.

## Two limits that are open, not solved

- **The paraphrase dedupe stops at 2, not 1.** `SAME_QUESTION_THRESHOLD` is
  0.35, measured: it collapses 8 phrasings of one question to 2 while keeping
  4/4 genuinely-distinct questions, and 0.30 also keeps 4/4 so it sits inside a
  band. Two near-duplicate "sensitive skin" answers still reached the deodorant
  feed. One wasted slot of thirty; not worth another threshold move without a
  reason.
- **Long AI-fan-out queries are in the corpus and unhandled.** GSC now returns
  prompt-shaped queries such as *"i am a 25-45 year-old parent or caregiver…
  what's the best gentle bar soap for the whole family? list some brands…"*.
  They route and answer, but they ask for multi-brand comparison, which a
  single-product Q&A cannot give. Nobody has decided whether they deserve a slot.
