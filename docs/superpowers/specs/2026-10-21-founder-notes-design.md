# Founder Notes: a weekly email that puts Sean's voice into the content

Date: 2026-10-21. Status: design, awaiting Sean's approval.

## Why

Every post the fleet writes is built from SERP data and a brief, so it reads like every other post on the topic. What it lacks is the material only Sean has: personal voice, anecdotes from running the business, reactions to what customers are saying right now, and takes on what is happening in the world. That first-hand material is what Google's E-E-A-T guidance rewards, what AI assistants cite, and what makes a press pitch read like a person wrote it.

The idea came from a "Head of Content" thread (x.com/wizofecom, 2026-10-21) whose one transferable move is a short weekly founder interview that feeds everything else. We are taking that move and nothing else: no hire, no personal-brand program.

## What Sean experiences

Once a week, Monday morning, an email arrives in sean@realskincare.com with 3-4 numbered questions. He replies inline from his phone, in plain words, skipping any he likes. That is all. Nothing chases him, nothing asks for approval or fact-checking, and it never takes more than about 15 minutes.

## Goals

1. Collect Sean's anecdotes, opinions and reactions every week with near-zero effort from him.
2. Make those answers available to the blog writer, the content refresher and press outreach (pitches and follow-ups), so new content carries real first-hand material.
3. Track which posts used a founder note, so we can later see whether those posts do better.

## Non-goals

- No edits to live posts triggered by a new note. Notes are used only when a post is already being written or refreshed through the normal pipeline, under `lib/post-edit-gate.js` exactly as today.
- No approval queue and no fact-check requests to Sean.
- No Amazon reviews as question sources (the repo has no Amazon review fetcher). Judge.me only.
- No Gmail, ever. RSC mail is Hushmail only.

## Anti-goals (failure even if it technically works)

- Generic questions ("tell me a story about your brand"). Every question must be anchored to something concrete: a specific review, a specific news item, or a specific upcoming post.
- Nagging. No reminders, no re-asking skipped questions.
- Sean's words carrying a health claim into print. "A customer told me it cleared her eczema" must never appear as a claim.
- A customer's name appearing in published content.
- The same anecdote showing up in every post.

## How it works

### 1. The weekly email (`agents/founder-notes --send`)

Cron: Monday `35 15 * * 1` UTC (8:35 AM PT during PDT; minute checked free against the live crontab at build time).

Question sources, built deterministically before any model call:

| slot | source | count |
|---|---|---|
| Review | `lib/judgeme.js` `fetchRecentReviews(7)`. Pick reviews with substantive text (not "Great!"), prefer ones never asked about, prefer 5-star and critical (≤3-star) over middling. | 1-2 |
| World | `lib/tavily.js` news search on the category (natural deodorant, clean body care, cosmetic regulation, ingredient news). Add a recency/news option to `searchWeb`. One item from the last 7 days, never one already asked about. | 1 |
| Upcoming post | `data/calendar/calendar.json`: the next item due to be drafted in the coming 14 days. "Anything from your own experience on X?" | 1 |

If a source yields nothing (no reviews this week, Tavily down), that slot is dropped, not filled with a generic question. Fewer than 2 questions total means no email that week, with an info row in the digest.

One `standard`-tier LLM call phrases the questions: short, conversational, one sentence each, the source quoted or linked under it. No em dashes (Sean's standing rule for anything in his voice). The review's text is quoted in full in the email (it is a private internal email), with the reviewer's first name only.

Email shape (plain text):

```
Subject: Founder notes, week of Oct 26 [FN-2026-W44]

Reply under each number. Skip any you like.

1. A customer wrote this about the lotion on Oct 19:
   "..." (Jenna, 5 stars)
   What's the story behind someone switching from a prescription cream to this?

2. ...
```

Sent with `lib/hushmail.js` `sendMail` from sean@realskincare.com to sean@realskincare.com, `via: 'resend'` on the droplet (SMTP is blocked there), with the copy appended to Sent. The returned Message-ID and the question set are saved to `data/founder-notes/questions/<week>.json`.

### 2. Reading the reply (`agents/founder-notes --ingest`)

Cron: daily `12 16 * * *` UTC. Reply latency of up to a day does not matter.

- `fetchFromAllFolders(creds, { senders: ['sean@realskincare.com'], since: <send date> })`.
- A message is a reply only if its `inReplyTo`/`references` contain the stored question Message-ID, or its subject carries the `[FN-…]` tag. Drop anything where `isAgentMessageId` is true; that is the question email itself landing in the same inbox.
- Dedupe on Message-ID. A second reply to the same week appends; it never overwrites.
- `stripQuoted` the body, then split answers by leading number (`1.`, `1)`, `#1`). Each answer is matched to its question. Text that cannot be matched to a number is stored as one unassigned "general" note for that week, never discarded.
- If nothing arrives, nothing happens. Questions for a week expire silently after 14 days.

### 3. The store (`data/founder-notes/`)

Server-only and gitignored (the repo is public), added as a set in `scripts/backup-snapshots-offsite.sh`, and pinned by a test like `tests/repo/press-contacts-private.test.js`.

`notes.jsonl`, one row per answer:

```
{ id, week, asked_at, answered_at, question, source: { type: review|world|upcoming|general, ref },
  answer, clusters: [...], gate: { editorial: ok|blocked, commercial: ok|blocked, hits: [...] },
  uses: [{ surface, ref, at }] }
```

- `clusters` comes from `clusterForText` over question + answer (the fleet's one taxonomy), so consumers can pick notes relevant to a topic.
- `gate` is computed once at ingest with `checkSeoCopyFields` on both surfaces and stored. It never blocks storage: a note that names a condition or carries a claim is kept, because the story may still be usable in a compliant form on an editorial page.
- Reviewer names from the source review are replaced with "a customer" in the stored answer.

### 4. Using the notes (`lib/founder-notes.js`)

One pure loader: `selectFounderNotes({ clusters, surface, limit })`. It returns the most relevant notes for a cluster, newest first, at most `limit` (default 3). It skips any note blocked on that surface and any note already used `MAX_USES` (2) times, so one anecdote does not end up in every post. A `founderNotesBlock(notes, { surface })` builds the prompt text. Consumers:

| consumer | where | surface | attribution |
|---|---|---|---|
| `agents/blog-post-writer` | a block next to `vocBlock` in `buildSystemPrompt` | editorial | writer decides from context; when it helps, attribute as "Sean, Co-Founder of Real Skin Care" |
| `agents/content-refresher` | a block beside the existing FOUNDER FEEDBACK block | editorial | same |
| press-outreach pitch | `buildFactSheet` gains an optional founder-notes tier | commercial | first person; Sean IS the sender |
| press-outreach follow-up | `pickNewFact` may pick a founder note as the one new detail | commercial | first person |

The prompt rule, in every block: use a note only where it genuinely fits; paraphrase or quote; never name a customer; never turn an anecdote into a claim that the product treats, heals or prevents anything; never invent detail the note does not contain. Existing output gates (the editor, `checkOutgoingCopy`, the health-claim gates) still run on the result. This is context, not a bypass.

When a consumer actually ships content that used a note, it records the use (`uses[]` on the note, and `founder_notes_used: [ids]` in the post's `state.json` via `writePostMeta`). That stamp is the measurement hook.

### 5. Reporting

Deferred `notify()` rows only, never `immediate: true`, never `status: 'error'` unless the agent itself broke:

- Send: "Founder notes sent: 4 questions (2 reviews, 1 news, 1 upcoming post)" or "skipped: only 1 question sourced".
- Ingest: "Founder notes: 3 answers filed for W44" (silent when there is nothing new).
- Weekly with the send: notes on file, notes used this week and where.

Measurement: after 90 days, compare post-performance verdicts and CTR for posts stamped `founder_notes_used` against comparable posts without it. That is a read of existing reports, not new machinery, and it is directional at this volume.

## Constraints

- Hushmail only (`lib/hushmail.js`); Resend transport on the droplet.
- LLM through `lib/anthropic.js` and a tier from `config/llm-models.js`; never a hardcoded model ID.
- `isDirectRun` guard on the agent; pure logic (question selection, reply parsing, note selection) lives in `lib/founder-notes.js` so it is testable.
- Tests use fake fixtures on `example.com`; no real answers or reviews committed.
- Cron in UTC, no `TZ=` prefix, mirrored in `scripts/setup-cron.sh`.

## Settled after builder review

- **Press use is safe without a separate fact-check because Sean already approves every pitch and follow-up** in the Outreach tab before it sends. Notes enter the fact sheet as a distinct "founder notes (Sean's own words)" tier: first-person colour, never restated as a brand fact. Any number in a note may be used only verbatim. Each note still passes `checkFact` on the commercial surface like every other fact.
- **A "use" is counted when content ships, not when it is drafted.** Drafts carry candidate note IDs (`founder_notes_candidate` in the post's `state.json`; a field on the press draft). The publisher's publish path and press-outreach's send path promote them to `uses[]` / `founder_notes_used`. The 2-use cap counts shipped uses only, so a held or unsent draft burns nothing.
- **Upcoming-post questions are tied to that post.** The calendar item chosen must be due at least 7 days out, so a reply that takes a day still lands before drafting. The note's `source.ref` is the item's slug, and `selectFounderNotes` puts a note whose ref matches the post being written first, ahead of cluster matches.
- **Every private person is anonymised, not just the reviewer.** At ingest, one `fast`-tier pass replaces names of private individuals (customers, staff, family, contacts) with a role ("a customer", "my business partner"). Sean, public figures and brands are left alone. The raw reply is kept as `answer_raw` for the record; consumers only ever see `answer`. Every prompt block also states the rule, as a second layer.
- **Selection is by relevance only.** A note reaches a post only through a cluster match or a source-ref match, so a toothpaste note only goes into toothpaste content. No efficiency ranking.

## Left to the builder

- Exact Tavily query wording and the recency parameter shape.
- The answer-splitting regex details, as long as unmatched text is kept as a general note.
- Whether the press fact-sheet tier needs its own small prompt line.

## Calls made without Sean's explicit say (so he can check them)

1. Monday morning send, daily reply check.
2. Questions anchored only to reviews, news and upcoming posts; a week with fewer than 2 anchored questions sends nothing.
3. Notes feed only content already being written or refreshed; no live-post edits triggered by a note.
4. Each note used at most twice.
5. Blocked-claim notes are stored but withheld from that surface.
6. Notes go into pitches as your first-person words, relying on your existing approval of every pitch.
7. A model pass strips names of private people from your answers before anything else sees them.
8. Upcoming-post questions only ask about posts at least 7 days from drafting.
