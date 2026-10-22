# Founder Notes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Email Sean 3-4 anchored questions every Monday, file his reply as founder notes, and feed those notes to the blog writer, the content refresher and press outreach, recording which shipped content used them.

**Architecture:** Pure logic in three small `lib/founder-notes-*.js` modules (questions/email, reply parsing, selection/usage), one I/O store module, one agent `agents/founder-notes/index.js` with `--send` and `--ingest` modes, and thin wiring into five existing consumers. Usage is detected from the SHIPPED text against the notes that were offered, so nothing has to carry IDs through the model.

**Tech Stack:** Node 22 ESM, `node --test`, `lib/hushmail.js`, `lib/judgeme.js`, `lib/tavily.js`, `lib/anthropic.js` + `config/llm-models.js`, `lib/seo-copy-health-gate.js`, `lib/notify.js`.

**Spec:** `docs/superpowers/specs/2026-10-21-founder-notes-design.md`

## Global Constraints

- RSC mail goes through `lib/hushmail.js` only. From and to `sean@realskincare.com` (`creds.user`). `via` comes from `config/founder-notes.json` `sendVia`, default `'resend'` (droplet blocks SMTP).
- LLM through `lib/anthropic.js`; models only as `LLM_MODELS.standard` (question phrasing) and `LLM_MODELS.fast` (name redaction). No hardcoded model IDs.
- No em or en dashes in anything sent to Sean: run every generated question through `stripDashes` from `lib/press-outreach.js`.
- `data/founder-notes/` is server-only: gitignored, in the offsite backup, never in a commit. Test fixtures use invented text and `example.com`.
- Agent entry uses `isDirectRun(import.meta.url)`. Dry by default; `--apply` sends/writes.
- Every `notify()` is deferred (never `immediate: true`); `status: 'error'` only from a `main()` catch.
- Cron in UTC with no `TZ=` prefix: send `35 15 * * 1`, ingest `12 16 * * *` (both verified free on the live crontab 2026-10-21).
- Constants: `MAX_QUESTIONS = 4`, `MIN_QUESTIONS = 2`, `REVIEW_DAYS = 7`, `UPCOMING_MIN_DAYS = 7`, `UPCOMING_MAX_DAYS = 21`, `QUESTION_EXPIRY_DAYS = 14`, `MAX_USES = 2`, `DEFAULT_NOTE_LIMIT = 3`.
- Attribution in blog/refresher prompts: when it helps, "Sean, Co-Founder of Real Skin Care". In press: first person.
- A failure in any usage-stamping hook is logged and swallowed. It must never fail a publish or a send.

## Review Focus

1. **The question email landing in the same inbox it is sent from**: ingest must not file Sean's own question email as his answer. Owned by Task 2 (`isReplyTo` rejects agent Message-IDs) and Task 6.
2. **A reply with no numbers, or numbers that don't match** ("all good, nothing this week"): kept as one `general` note, never dropped and never mis-assigned. Task 2.
3. **Two replies to the same week, or the same reply seen twice on two ingest runs**: second reply appends, same Message-ID is a no-op. Task 4 + Task 6.
4. **Redaction model fails or returns something far shorter than the input**: the note is stored with `redaction: 'failed'` and is withheld from every surface. Task 3 (`selectFounderNotes`) + Task 6.
5. **A thin week** (no reviews, Tavily down, nothing on the calendar in the window): fewer than 2 questions means no email and an info digest row, never a generic filler question. Task 1 + Task 5.

---

### Task 1: Question set and email body (pure)

**Files:**
- Create: `lib/founder-notes-questions.js`
- Test: `tests/lib/founder-notes-questions.test.js`

**Interfaces:**
- Produces:
  - `weekId(date: Date) -> string`: ISO week, e.g. `'2026-W44'`.
  - `pickReviews(reviews, { asked: Set<string>, max = 2 }) -> review[]`: reviews are `lib/judgeme.js` `fetchRecentReviews` rows. Keep bodies with ≥ 12 words. Skip any whose key (`${created_at}|${reviewer}`) is in `asked`. Prefer rating 5 and rating ≤ 3 over 4. Ties go newest first.
  - `pickNews(results, { askedUrls: Set<string> }) -> {url,title,content}|null`: first result not asked, with a non-empty title.
  - `pickUpcoming(items, { now, asked: Set<string>, minDays = 7, maxDays = 21 }) -> item|null`: calendar items whose `publish_date` falls in [now+min, now+max] and whose slug is not asked. Earliest wins.
  - `buildSources({ reviews, news, upcoming }) -> Source[]`, where `Source = { type: 'review'|'world'|'upcoming', ref: string, context: string }`. The ref is the review key, the news URL or the calendar slug. Order: reviews, world, upcoming. Capped at `MAX_QUESTIONS`.
  - `templateQuestion(source) -> string`: deterministic fallback wording per type.
  - `renderEmail({ week, questions: [{ text, source }] , now }) -> { subject, text }`: the subject is `Founder notes, week of <Mon D> [FN-<week>]`. The body opens with "Reply under each number. Skip any you like.", then numbered blocks. A review block quotes the body and shows "(<first name>, <n> stars)". A world block shows the title and URL. Signed off with nothing.
  - `MAX_QUESTIONS, MIN_QUESTIONS` exported.

- [ ] **Step 1: Write failing tests**: `weekId(new Date('2026-10-26T15:35Z')) === '2026-W44'`; `pickReviews` drops a 3-word review, drops an asked key, and puts a 2-star ahead of a 4-star; `pickUpcoming` with now=2026-10-21 includes an item publishing 2026-10-30, excludes 2026-10-26 (5 days) and 2026-11-20 (30 days); `buildSources` with 3 reviews + news + upcoming returns 4 (2 reviews, world, upcoming); `renderEmail` subject matches `/^Founder notes, week of Oct 26 \[FN-2026-W44\]$/`, the body contains `1.` and `2.`, contains no `—` or `–`, and a review block shows the first name only (input reviewer `'Jenna Smith'` renders `Jenna`).
- [ ] **Step 2: Run** `node --test tests/lib/founder-notes-questions.test.js`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement** the functions above in `lib/founder-notes-questions.js`.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(founder-notes): question selection and email body`.

### Task 2: Reply matching and answer parsing (pure)

**Files:**
- Create: `lib/founder-notes-replies.js`
- Test: `tests/lib/founder-notes-replies.test.js`

**Interfaces:**
- Consumes: `isAgentMessageId`, `stripQuoted` from `lib/hushmail.js`.
- Produces:
  - `isReplyTo(message, { messageId, week }) -> boolean`: false when `isAgentMessageId(message.messageId)`. True when `message.inReplyTo === messageId` or `message.references` includes it, or the subject contains `[FN-<week>]`.
  - `parseAnswers(text, questionCount) -> [{ index: number|null, answer: string }]`. Split on line-leading `1.`, `1)` or `#1` markers in 1..questionCount. Blank answers are dropped. If no marker is found, or any text precedes the first marker, that text becomes `{ index: null }` (general). An index outside 1..questionCount stays in the previous block. Input is already `stripQuoted`.

- [ ] **Step 1: Write failing tests**:
  - `isReplyTo` is false for a message whose `messageId` passes `isAgentMessageId` even with the right subject; true by `inReplyTo`; true by subject tag only.
  - `parseAnswers('1. yes\n\n2) a story\nmore\n', 3)` returns indexes [1, 2], and answer 2 is `'a story\nmore'`.
  - `parseAnswers('all good this week', 3)` returns `[{ index: null, answer: 'all good this week' }]`.
  - `parseAnswers('Quick note\n1. x', 2)` returns a null-index `'Quick note'` plus index 1.
  - `parseAnswers('1. a\n7. b', 2)`: `'7. b'` stays in answer 1.
- [ ] **Step 2: Run** `node --test tests/lib/founder-notes-replies.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(founder-notes): reply matching and answer parsing`.

### Task 3: Note selection, prompt block and usage detection (pure)

**Files:**
- Create: `lib/founder-notes.js`
- Test: `tests/lib/founder-notes.test.js`

**Interfaces:**
- Produces:
  - Note shape: `{ id, week, asked_at, answered_at, question, source: { type, ref }, answer, answer_raw, redaction: 'ok'|'failed', clusters: string[], gate: { editorial: 'ok'|'blocked', commercial: 'ok'|'blocked', hits: [] }, uses: [{ surface, ref, at }] }`. `id` = `fn-<week>-<n>`.
  - `selectFounderNotes(notes, { clusters = [], ref = null, surface: 'editorial'|'commercial', limit = 3 }) -> Note[]`. Exclude `redaction !== 'ok'`, `gate[surface] !== 'ok'`, and `uses.length >= MAX_USES`. Keep notes whose `source.ref === ref`, or whose clusters intersect `clusters`, or `source.type === 'general'` with empty clusters. Order: ref match first, then cluster match, then general; newest `answered_at` first within each group. Truncate to `limit`.
  - `founderNotesBlock(notes, { surface }) -> string`: `''` for no notes. Otherwise a block headed `FOUNDER NOTES (Sean's own words, gathered by email)` listing each note's question and answer, plus these rules verbatim: use a note only where it genuinely fits; paraphrase or quote; never name a customer or any private person; never turn an anecdote into a claim that a product treats, heals, cures or prevents anything; never add detail the note does not contain. Then by surface: editorial gets "When attribution helps the reader, attribute it to Sean, Co-Founder of Real Skin Care; otherwise weave it in without a name"; commercial gets "Write it in first person: Sean is the sender. Use any number only exactly as written."
  - `notesUsedIn(text, notes) -> string[]` (ids). Strip HTML tags, lowercase, and drop stopwords and words under 4 letters to get content words. A note counts as used when at least 3 of its adjacent content-word bigrams appear as adjacent content words in the text, or 2 if the note has fewer than 8 content words. Export `MAX_USES`, `DEFAULT_NOTE_LIMIT`.

- [ ] **Step 1: Write failing tests**:
  - `selectFounderNotes` drops `redaction: 'failed'`; drops a commercial-blocked note for `surface: 'commercial'` but keeps it for editorial; drops a note with 2 uses; puts a `ref` match ahead of a newer cluster match; returns `[]` for a toothpaste note when `clusters: ['lotion']`.
  - `founderNotesBlock([], …) === ''`; the editorial block contains `Sean, Co-Founder of Real Skin Care`; the commercial block contains `first person`.
  - `notesUsedIn('<p>When I started making lotion in my kitchen the coconut oil kept separating</p>', [note('I started making lotion in my kitchen and the coconut oil kept separating on me')])` returns that id. A text sharing only topic words (`coconut oil lotion ingredients`) returns `[]`.
- [ ] **Step 2: Run** `node --test tests/lib/founder-notes.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(founder-notes): note selection, prompt block, usage detection`.

### Task 4: Store, privacy and backup

**Files:**
- Create: `lib/founder-notes-store.js`
- Modify: `.gitignore` (add `data/founder-notes/` with a comment beside `data/press/`)
- Modify: `scripts/backup-snapshots-offsite.sh` (new set `founder-notes`, copied from the set-5 block; update the set-count header comment)
- Test: `tests/lib/founder-notes-store.test.js`, `tests/repo/founder-notes-private.test.js`

**Interfaces:**
- Produces (all take `{ dir = 'data/founder-notes' }` relative to repo root, so tests can pass a tmp dir):
  - `loadNotes(opts) -> Note[]` (reads `notes.jsonl`; a missing file gives `[]`).
  - `appendNotes(notes, opts)`: appends; skips an id already present.
  - `recordUses(ids, { surface, ref, at }, opts) -> number`: rewrites `notes.jsonl` via temp file + rename, adding a use to each id. The same `{surface, ref}` is never added twice to one note. Returns the count added.
  - `saveQuestionSet(set, opts)` / `loadQuestionSets(opts) -> set[]`, where a set is `{ week, sent_at, message_id, questions: [{ n, text, source }], replies: [messageId], expired?: true }`. One file per week: `questions/<week>.json`.
  - `askedRefs(sets) -> { reviews: Set, urls: Set, slugs: Set }`.
  - `stampFounderNoteUses({ text, offered: string[], surface, ref, at }, opts) -> string[]`: loads notes, filters to `offered`, runs `notesUsedIn`, calls `recordUses`, and returns the used ids. It catches everything and returns `[]` on error, logging one line.

- [ ] **Step 1: Write failing tests**:
  - `appendNotes` twice with the same id leaves one row.
  - `recordUses` adds a use and is idempotent for the same surface+ref.
  - `stampFounderNoteUses` returns the matching offered id, ignores a matching note that was not offered, and returns `[]` (no throw) when the dir is unreadable.
  - The repo test: `git check-ignore data/founder-notes/notes.jsonl` succeeds, and `git ls-files data/founder-notes` is empty.
- [ ] **Step 2: Run** `node --test tests/lib/founder-notes-store.test.js tests/repo/founder-notes-private.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** the store, the `.gitignore` entry and the backup set. The backup set skips with a notice when `data/founder-notes/` is absent and never aborts the snapshot set.
- [ ] **Step 4: Run** both tests and `bash -n scripts/backup-snapshots-offsite.sh`. Expected: PASS, no syntax error.
- [ ] **Step 5: Commit** `feat(founder-notes): store, gitignore, offsite backup`.

### Task 5: Tavily news search option

**Files:**
- Modify: `lib/tavily.js` (`searchWeb`)
- Test: `tests/lib/tavily.test.js` (create if absent)

**Interfaces:**
- Produces: `searchWeb(apiKey, query, { maxResults, includeDomains, topic = null, timeRange = null, fetchImpl })`. When set, the body carries `topic` and `time_range`. Existing callers are unchanged.

- [ ] **Step 1: Write failing test**: a stub `fetchImpl` captures the body. Called with `{ topic: 'news', timeRange: 'week' }`, the body has `topic: 'news'` and `time_range: 'week'`. Called without them, neither key is present.
- [ ] **Step 2: Run** `node --test tests/lib/tavily.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(tavily): optional news topic and time range`.

### Task 6: The agent (`--send`, `--ingest`)

**Files:**
- Create: `agents/founder-notes/index.js`, `config/founder-notes.json`
- Test: `tests/agents/founder-notes.test.js`

**Interfaces:**
- Consumes: Tasks 1-5. Also `hushmailCredentials`, `sendMail`, `fetchFromAllFolders`, `stripQuoted` (hushmail); `fetchRecentReviews` (judgeme; env `JUDGEME_API_TOKEN` + `SHOPIFY_STORE` exactly as `agents/review-monitor/index.js:45-77` reads them); `searchWeb`; `clusterForText` (`lib/cluster-revenue.js`); `checkSeoCopyFields`, `EDITORIAL_SURFACE`, `COMMERCIAL_SURFACE`; `stripDashes`; `notify`; `isDirectRun`.
- Config `config/founder-notes.json`: `{ "enabled": true, "sendVia": "resend", "newsQueries": [ "natural deodorant news", "clean beauty ingredient news", "FDA cosmetics regulation MoCRA", "skincare ingredient safety study", "body care industry trend" ] }`. The query index is `ISO week number % length`; if that query yields nothing, try the next one, at most 2 tries.
- Produces exported, dependency-injected functions (so tests stub I/O):
  - `runSend({ now, apply, deps }) -> { status: 'sent'|'skipped'|'dry-run', week, questions }`. Skip when a set for this week already exists (`already sent`). Gather sources. Phrase them with one `standard` call: the prompt returns a JSON array of strings, one per source in order, each one short conversational sentence. Validate the count, then apply `stripDashes`. On any failure use `templateQuestion` for every source. If there are fewer than `MIN_QUESTIONS` sources, return `skipped`. With `apply`, call `sendMail` and `saveQuestionSet`.
  - `runIngest({ now, apply, deps }) -> { filed: number, weeks: string[] }`. For each non-expired set, `fetchFromAllFolders` with sender `creds.user` since `sent_at`; filter with `isReplyTo`; skip Message-IDs already in `set.replies`. Then `stripQuoted`, `parseAnswers`, and per answer:
    - redaction with one `fast` call ("replace names of private individuals with their role; keep Sean, public figures and brand names; change nothing else; return only the text"). If the call fails, or the output is under 60% of the input length, the note keeps `answer = answer_raw` and gets `redaction: 'failed'`.
    - `clusters` = `[clusterForText(question + ' ' + answer)]`, minus null.
    - `gate` from `checkSeoCopyFields({ answer }, { surface })` for both surfaces.
    - `appendNotes`, then add the Message-ID to `set.replies` and save.
    - Sets older than `QUESTION_EXPIRY_DAYS` get `expired: true`.
  - `main()`: parse `--send|--ingest`, `--apply`, `--now <iso>`; `enabled: false` exits 0 with a log line. One deferred `notify` per run with `category: 'founder-notes'`:
    - send: `Founder notes sent: N questions (a reviews, b news, c upcoming)`, or `skipped: …` as `info`.
    - ingest: `Founder notes: N answers filed for <weeks>`, only when N > 0. Its body lists notes on file and uses recorded in the last 7 days.
    - a `main()` catch: `status: 'error'`.

- [ ] **Step 1: Write failing tests** with stubbed deps:
  - A send with 0 reviews, no news and no upcoming item returns `skipped` and never calls `sendMail`.
  - A send whose LLM stub throws still sends with template questions.
  - A second send in the same week returns `skipped` ("already sent").
  - An ingest given the question email itself (agent Message-ID) files nothing.
  - An ingest given a reply with `'1. a story about Jenna\n2. take'` files 2 notes, with Jenna redacted by the stub.
  - An ingest whose redaction stub returns `''` files the note with `redaction: 'failed'`.
  - Running ingest twice over the same reply files once.
- [ ] **Step 2: Run** `node --test tests/agents/founder-notes.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** with the `isDirectRun` guard.
- [ ] **Step 4: Run.** Expected: PASS. Then a dry run: `node agents/founder-notes/index.js --send` prints the email it would send and writes nothing.
- [ ] **Step 5: Commit** `feat(founder-notes): weekly send and reply ingest agent`.

### Task 7: Blog writer and content refresher

**Files:**
- Modify: `agents/blog-post-writer/index.js` (`buildSystemPrompt` near `vocBlock` ~:267/:504; after the draft is written, `writePostMeta(slug, { founder_notes_offered: ids })`)
- Modify: `agents/content-refresher/index.js` (a block beside the FOUNDER FEEDBACK block ~:290; the same `founder_notes_offered` stamp on the refreshed post)
- Modify: `lib/post-meta-reconcile.js` (`FIELD_OWNERS`: `founder_notes_offered` and `founder_notes_used` → `server`)
- Test: `tests/agents/founder-notes-wiring.test.js` (source scan; agents run on import)

**Interfaces:**
- Consumes: `loadNotes`, `selectFounderNotes(notes, { clusters: [clusterForText(keyword)].filter(Boolean), ref: slug, surface: 'editorial' })`, `founderNotesBlock(selected, { surface: 'editorial' })`.
- A load failure gives an empty block, never a thrown error.

- [ ] **Step 1: Write failing test**: both agent files import `selectFounderNotes` and `founderNotesBlock`, call them with `surface: 'editorial'`, and contain `founder_notes_offered`. `FIELD_OWNERS.founder_notes_offered === 'server'` and `FIELD_OWNERS.founder_notes_used === 'server'`.
- [ ] **Step 2: Run** `node --test tests/agents/founder-notes-wiring.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** it plus `node --test tests/lib/post-meta-reconcile*.test.js`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(founder-notes): feed notes to blog writer and refresher`.

### Task 8: Press outreach pitches and follow-ups

**Files:**
- Modify: `lib/press-pitch.js` (`buildFactSheet(pressFacts, products, { founderNotes = [] } = {})`: after brand facts, a section `FOUNDER NOTES (your own words; first person; never restate as a brand fact; numbers only exactly as written):`, each note through `checkFact`; `draftPitch` accepts `founderNotes` and passes it through, and its success return gains `founder_notes_offered: ids`)
- Modify: `lib/press-followup.js` (`factTiers` gains a `founder` tier right after `own`, built from `pressFacts.founder_notes` (`[{ id, fact }]`). `pickNewFact` is unchanged in shape; `draftFollowUp` records `founder_notes_offered: [id]` when the chosen fact came from that tier.)
- Modify: `agents/press-outreach/index.js` (load notes once per draft run: `selectFounderNotes(loadNotes(), { clusters, surface: 'commercial', limit: 2 })`, where clusters are `clusterForText` over each pitched product's name; pass them to `draftPitch` and set `pressFacts.founder_notes` for follow-ups; persist `founder_notes_offered` on the draft object)
- Test: extend `tests/lib/press-pitch.test.js` and `tests/lib/press-followup.test.js`

- [ ] **Step 1: Write failing tests**:
  - `buildFactSheet(facts, ['lotion'], { founderNotes: [note] })` text contains `FOUNDER NOTES` and the note's answer.
  - A note containing `cures eczema` is left out and listed in `skippedFacts`.
  - With no `founderNotes`, the text is byte-identical to the previous output for the existing fixture.
  - `pickNewFact` with a `founder_notes` entry and no product `facts` returns the founder fact ahead of brand facts.
- [ ] **Step 2: Run** `node --test tests/lib/press-pitch.test.js tests/lib/press-followup.test.js`. Expected: FAIL on the new cases only.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** those plus `node --test 'tests/agents/press-outreach*.test.js'`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(founder-notes): offer notes to press pitches and follow-ups`.

### Task 9: Stamp uses where content ships

**Files:**
- Modify: `agents/publisher/index.js`. After a successful create/update (~:370-396), when `meta.founder_notes_offered?.length`, call `stampFounderNoteUses({ text: articleFields.body_html, offered, surface: 'editorial', ref: slug, at })` and merge the returned ids into `meta.founder_notes_used` before `replacePostMeta`. Do the same in the queue refresh path (~:147).
- Modify: `lib/queue-apply.js` `publishBlogRefresh`. After `updateArticle` (~:208), do the same through an injected `deps.stampFounderNoteUses` (default: the real one). `writePostMeta(slug, { founder_notes_used })`.
- Modify: `agents/press-outreach/index.js`. Right after `markSent` (~:850, not the repair path at :793), when `d.founder_notes_offered?.length`, call `stampFounderNoteUses({ text: d.body, offered, surface: 'commercial', ref: d.id, at })`.
- Test: `tests/lib/queue-apply.test.js` (extend) and `tests/agents/founder-notes-wiring.test.js` (source-scan the publisher and press-outreach calls)

- [ ] **Step 1: Write failing tests**:
  - `publishBlogRefresh` with a post carrying `founder_notes_offered` calls the stub stamp with the refreshed HTML and writes `founder_notes_used`.
  - A stamp stub that throws does not fail the publish.
  - The source scan finds `stampFounderNoteUses` in the publisher and in press-outreach next to `markSent(`.
- [ ] **Step 2: Run** `node --test tests/lib/queue-apply.test.js tests/agents/founder-notes-wiring.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement**, with each hook in try/catch.
- [ ] **Step 4: Run** those plus the full suite `npm test`. Expected: PASS, cancelled 0.
- [ ] **Step 5: Commit** `feat(founder-notes): record uses when content ships`.

### Task 10: Cron and docs

**Files:**
- Modify: `scripts/setup-cron.sh`. Add `WEEKLY_FOUNDER_NOTES_SEND="35 15 * * 1 cd \"$PROJECT_DIR\" && $NODE agents/founder-notes/index.js --send --apply >> data/reports/scheduler/founder-notes.log 2>&1"` under the Weekly (Monday) block, and `DAILY_FOUNDER_NOTES_INGEST="12 16 * * * … --ingest --apply …"` under the daily block. No `TZ=`.
- Modify: `CLAUDE.md`. Add a short paragraph after the press-outreach section saying what it is, the two crons, the store being server-only/backed up, where notes are used, the 2-use cap counted at ship, and that the redaction failure withholds a note. Add a Data Layout bullet for `data/founder-notes/`.
- Modify: `agents/founder-notes/README.md` (create): usage, flags, config.
- Test: `tests/scripts/post-meta-drift-gate.test.js` already asserts no `TZ=`. Run it.

- [ ] **Step 1:** Add the cron variables and list entries.
- [ ] **Step 2: Verify** with the mirror diff procedure from CLAUDE.md (re-derive the `sed` line with `grep -n 'crontab -' scripts/setup-cron.sh`). Expected: exactly two `>` lines, the two new jobs.
- [ ] **Step 3:** Write the docs.
- [ ] **Step 4: Run** `npm test`. Expected: PASS, cancelled 0.
- [ ] **Step 5: Commit** `docs+cron(founder-notes): schedule and document`.

### After the plan (deploy, done by the controller)

1. Open the PR, merge, deploy (`git pull && pm2 restart seo-dashboard`).
2. On the server: `node agents/founder-notes/index.js --send` dry run, and read the email it would send.
3. Install the crontab via `scripts/setup-cron.sh`, then re-run the mirror diff (expect empty).
4. Send the first real email with `--send --apply`, and confirm it is in Hushmail Sent.
