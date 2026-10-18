# Merchant Center Q&A feed — runbook

**BOTH TASKS WERE DONE ON 2026-09-07.** Task 1 produced a **15-product feed with
174 answers** (`data/reports/merchant-qa/supplemental-qa-2026-09-07.tsv`), 0
failed and **1 gated** — `hand-soap-set` was withheld by the health gate on
`"medicated"` (drug) and `"treatment"` (therapeutic), across FOUR attempts in two
separate runs. That is persistent rather than stochastic, so it is the source
copy that needs fixing, not another re-run; the gate is working. The feed is
**reviewed and not yet submitted** — submitting it by hand is the one thing still
outstanding. Task 2 shipped
`scripts/measure-ai-overview-citations.mjs` and its answer:
**83.3% of commercial questions (20/24), 80.6% by run (54/67)**, with
`realskincare.com` the most-cited domain in the sample. The finding is written up
in `marketing-ai-search-visibility`; both task sections below are kept as the
record of what was run and what it cost.

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

## Task 1 — run `--all` and review — DONE 2026-09-07

**Result: 15 products in the feed, 174 answers, 0 failed, 1 gated.** Four defects
had to be fixed to get there, and all four are now in the code rather than in a
reader's memory.

**1. One product's truncation discarded the whole run, including work already
paid for.** The first `--all` died on the SECOND of 16 products: a truncated
batch threw out of the per-product loop to `main().catch()`, so the 14 behind it
were never attempted and the first product's LLM call — already spent — was
thrown away, because the feed is written after the loop. Failures are now caught
per product, named in the console and in the review file, and the run continues.

**2. The token ceiling is bounded on BOTH sides, and both bounds bit.** Too low
truncates; too high is refused outright — **the SDK rejects a non-streaming
request whose `max_tokens` implies a call over ten minutes**, and raising the
rate to 700/pair put a 30-question batch at 21,800 where all 14 large products
failed at once. Probed live: 16,000 OK, 18,000 OK, 20,000 OK, **21,800
REFUSED**. So `max_tokens` is `min(20000, max(6000, 800 + n*700))`, and more
headroom than that needs streaming or a smaller batch, not a bigger number.

**2b. Within that window it needed a FLOOR as well as a rate.** 200/pair came from a run where the model answered 7 of 30
questions and left 23 empty (~1,900 tokens against a 6,600 ceiling — generous
looking, and not). Measured properly the per-pair cost **rises as the batch
shrinks**: 182/pair at n=30, 285/pair at the corpus peak, but **472/pair at
n=7**, because a short list gets answered in full while a 30-question list is
mostly questions the product cannot honestly answer and correctly comes back
empty. Now `max(6000, 800 + n*400)`, and every run prints the tokens it actually
used so the constant stays measured. `max_tokens` is a ceiling, not a
reservation — an unused token is not billed, so a tight one buys nothing but this
failure.

**3. FOUR products shipped a Q&A pair whose "question" was AI-assistant
plumbing.** The feed carried, verbatim and customer-facing:
`context: location: united states (not for language). do not include location
references in your response. question: i'm sensitive to strong fragrance—…`.
Measured over the same 28 snapshots, **20 GSC queries carry that shape**,
identical but for the country name. `stripAssistantScaffolding` in
`lib/merchant-qa.js` strips it and keeps the real question — it is measured
demand, and cleaning also lets it dedupe against its naturally-typed twins.
Anything not matching the known shape passes through byte-identical.

**Non-English questions STAY — decided by Sean, 2026-09-07: "people can translate
the answers."** Two of the 174 pairs answer a non-English question (one
Vietnamese, one Indonesian) in English. Do not add a language filter. The
questions are real measured demand, the answers are competent, and every surface
that renders them — browser, phone, the assistant reading the feed — translates.
A filter would drop demand to fix a problem the reader does not have.

### The answers WERE checked against Google — `npm run compare-qa-to-overviews`

Nothing had done this before 2026-09-07. The four beats were derived by reading
overviews once, by hand, in an earlier session; **no run ever compared the
ANSWERS to them.** That was a verification gap on copy going to Google under the
brand's name, and it is free to close — the citation measurement already captures
`overview_text` for every question it pulls, so the check is a join of two
reports that already exist and costs no API call.

`scripts/compare-qa-to-overviews.mjs` prints our answer next to Google's for
every question in both. **15 of 174 answers were checkable on 2026-09-07** — the
overlap is small by construction, since the measurement samples ~30 questions
site-wide while the feed answers up to 30 per product; raise it with `--limit` on
the measurement, at $0.002 a pull.

**Zero factual contradictions.** Every answer is consistent with Google's account
of the same question, and beat 3 — the distinction that resolves the confusion —
is running WELL: our fragrance-free answer draws the same fragrance-free vs
"unscented" line Google draws, and the deodorant answers hold the
deodorant-vs-antiperspirant distinction Google itself leads with.

**Beat 4 is the one that regresses, exactly as this checklist predicted — and it
clusters: 8 of 9 flags are toothpaste.** The failure is not a false claim, it is
an INVERTED FRAME. On *"are coconut oil toothpastes effective for everyday use?"*
and *"is coconut oil toothpaste worth it?"* Google LEADS with the limitation —
"should not replace fluoride toothpaste for cavity protection", "Without it, you
may have a higher risk of tooth decay" — while our answer presents fluoride-free
as a clean-ingredients feature and never names the trade-off. Same fact, opposite
direction. **The prompt already forbids this**: *"Do NOT pretend the objection
does not exist; an answer that dodges a concern Google itself raises is the one a
model will not repeat."* So this is an instruction not being followed, not a
missing instruction — which is why the fix is not simply more prompt text.

**THAT ONE IS A DECISION FOR THE OPERATOR, NOT A BUG TO PATCH.** Whether Real
Skin Care's own product feed should tell a shopper that fluoride-free carries a
higher cavity risk is a commercial and regulatory judgement, and it brushes the
health-claim gate from the other side. Do not have an agent decide it.

**One answer answers a different question.** *"is coconut oil toothpaste worth
it?"* routed to `coconut-toothpaste-3-pack` and came back about PRICE ($34 vs
$39 for three tubes) where Google answers efficacy. Bundle products draw the
cluster's questions and answer them as bundles; worth watching whenever a bundle
takes a substance question.

**Two mechanical flags, and neither is a verdict.** The script marks an answer
with no caveat language at all, and one under a quarter of the overview's length.
They point at pairs worth reading. **No flags is not a pass** — the inverted
frame above trips neither, because it is fluent, specific and wrong only in
emphasis, which no regex sees.

**Thin products are working as designed, not failing.** `hand-soap-set` and
`head-to-toe` produced 2 answers each, `coconut-oil-lip-balm`,
`99-coconut-reset-digital` and `organic-foaming-hand-soap` 4 each. The prompt
tells the model to return an empty answer rather than invent a spec, so a thin
PDP produces few answers — the fix is the PDP.

**To re-run** (one LLM call per product; the questions are already measured, so
there is no SERP spend):

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

## Task 2 — measure the AI Overview citation rate — DONE 2026-09-07

**`npm run measure-ai-overview-citations` — dry by default, `--apply` spends
~$0.25 (30 questions × 3 runs).** Pure logic in `lib/ai-overview-citations.js`
(12 tests), network and I/O in `scripts/measure-ai-overview-citations.mjs`,
report to `data/reports/ai-overview-citations/<date>.{json,md}` (gitignored).

**The answer: 83.3% by query (20/24 commercial), 80.6% by run (54/67).**
`realskincare.com` is the most-cited domain in the whole sample — 32 overviews
against `reddit.com`'s 26. The withheld classes score **0/15**, which
independently validates `isUnsuitableQuestion`: competitor-fact overviews cite
the competitor and DIY overviews cite recipe blogs, so the questions this feed
refuses are the ones we are never cited on anyway.

**It does not contradict the ~2%, and the reason must be stated whenever either
number is quoted.** They are different RUNGS: the tracker runs branded and
category *shortlisting* prompts against standalone LLM APIs (the **recommended**
rung), this runs informational questions we already rank for against Google AI
Overviews (the **cited** rung). Full write-up, including the two other findings
— citation is not a function of organic rank, and the first run's 100% was
wrong-by-omission — is in `marketing-ai-search-visibility`.

**Four live-API traps are documented in the lib header rather than here**, but
the one that decides the arithmetic: `asynchronous_ai_overview: true` is **not**
"no overview". Pass `load_async_ai_overview: true` and the same item arrives with
its content, flag still true; without it, 41 of 90 runs come back empty — and not
at random, so discarding them biases the rate rather than thinning it.

### The original brief



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

## Two traps found on 2026-09-07 that are NOT fixed

- **A single-product `--apply` OVERWRITES the whole day's feed.** The TSV is named
  `supplemental-qa-<date>.tsv` and written from that run's rows alone, so
  `--product X --apply` after an `--all` leaves a one-row file where a sixteen-row
  one was. It cost a re-run here. Do the `--all` last, or copy the feed aside
  before a single-product run.
- **Answers are being written past the limit Google will keep.**
  `MAX_SIDE_CHARS` truncates each answer at 1,000 characters (~250 tokens), and
  measured output runs 181-472 tokens per pair — so the longest answers are
  already being trimmed by `formatQuestionAnswer` after the model was paid to
  write them. Nothing in the prompt states the 1,000-character limit. Telling it
  would cut spend and stop silent trimming, but it changes the shape of every
  answer, so it is a content decision rather than a fix to bolt on.

## Two limits that are open, not solved

- **The paraphrase dedupe stops at 2, not 1.** `SAME_QUESTION_THRESHOLD` is
  0.35, measured: it collapses 8 phrasings of one question to 2 while keeping
  4/4 genuinely-distinct questions, and 0.30 also keeps 4/4 so it sits inside a
  band. Two near-duplicate "sensitive skin" answers still reached the deodorant
  feed. One wasted slot of thirty; not worth another threshold move without a
  reason.
- **Long AI-fan-out queries are in the corpus and only HALF handled.** GSC now
  returns prompt-shaped queries such as *"i am a 25-45 year-old parent or
  caregiver… what's the best gentle bar soap for the whole family? list some
  brands…"*. They route and answer, but they ask for multi-brand comparison,
  which a single-product Q&A cannot give. Nobody has decided whether they deserve
  a slot. **What IS handled since 2026-09-07 is the scaffolding some of them
  carry** — `stripAssistantScaffolding` removes the `context: … question:`
  wrapper that put machine plumbing into four products' feed rows. That fixes the
  text, not the question type: a cleaned fan-out query is still a comparison
  request wearing a shorter prefix.
