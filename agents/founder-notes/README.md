# founder-notes

Asks Sean a few questions each week, files his answers as notes, and lets the blog writer, the content refresher and press outreach use those notes as first-hand material.

## Usage

```
node agents/founder-notes/index.js --send   [--apply] [--now <iso>]
node agents/founder-notes/index.js --ingest [--apply] [--now <iso>]
```

- `--send`: builds 2 to 4 numbered questions and emails them to sean@realskincare.com from the same Hushmail account. Questions are anchored to recent Judge.me reviews (last 7 days), a news item (Tavily, from `newsQueries`) and a blog post due in 7 to 21 days. Questions already asked are not repeated.
- `--ingest`: reads replies to the question email, splits them into answers, redacts private names and files each answer as a note.
- `--apply`: send or write. Without it, both modes are dry: `--send` prints the email it would send, `--ingest` reports what it would file. Dry runs still make real read-only calls (Judge.me, Tavily, IMAP, LLM).
- `--now <iso>`: override the clock.

## Config

`config/founder-notes.json`:

- `enabled`: off switch.
- `sendVia`: `resend` (default) or the Hushmail transport.
- `newsQueries`: search queries used to find the news question.
- `newsDomains`: the only outlets a news question may come from (beauty trade press, major news, fda.gov). Homepages, section, author, tag and sponsored pages are skipped. Without this list Tavily's news search returned a brand's own blog post.

## Crons (UTC, no `TZ=` prefix)

- Send: `35 15 * * 1` (`--send --apply`).
- Ingest: `12 16 * * *` (`--ingest --apply`).

Both are defined in `scripts/setup-cron.sh`. Output goes to `data/reports/scheduler/founder-notes.log`. Every notification is deferred to the morning digest.

## How a reply is matched and parsed

- A message counts as a reply if it references our question email (Message-ID or In-Reply-To) or its body starts with the email's opening line, `Reply under each number.`
- Numbered answers (`1.`, `2.` and so on) are split by number.
- Note ids are `fn-<week>-<8 hex of sha1(Message-ID)>-<answer position>`, so a re-file after a partial write is caught by the id dedupe.
- A trailing mobile signature ("Sent from my iPhone", "Get Outlook for iOS") is stripped from the last answer.
- Inline replies, where Sean types under the quoted questions, are parsed by marker.
- A reply that parses to nothing is never marked read. It is reported in the digest until the question set expires (14 days).
- Private names are redacted by a fast model. If redaction fails or removes too little, the note is stored but withheld everywhere.

## Where notes are used

- Editorial: `agents/blog-post-writer` and `agents/content-refresher`, through `founderNotesFor`. Attribution is "Sean, Co-Founder of Real Skin Care" when it helps.
- Commercial: press pitches and follow-ups, through `pressEligibleNotes`, in first person. Open drafts count as pending uses and only one draft per run may take a note.
- Every note passes the health-claim gate for its surface.
- A note may be used 2 times (`MAX_USES`). Uses are stamped when content ships (publisher, `lib/queue-apply.js` `publishBlogRefresh`, the press send), not when drafted, and recorded in the note's `uses[]` and the post's `founder_notes_used`. A stamping failure is logged and never blocks a publish or send.

## Data

`data/founder-notes/` is server-only and gitignored, because this repository is public. It is in the offsite backup set `founder-notes`. Access goes through `lib/founder-notes-store.js`.
