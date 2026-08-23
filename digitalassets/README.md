# digitalassets/

Long-form source texts fed to `agents/marketing-learner` via `--file`.

**Contents are gitignored.** Only this README is committed. Source texts are
large, re-derivable from the original the operator owns, and have no review value
in a diff — the same reasoning that keeps `data/marketing-corpus/` out of git.
The extraction JSON and the scoring report *are* committed, so the auditable
record of what was concluded survives without the source sitting in git history.

## What goes here

Plain `.txt` or `.md` only. No PDFs — the learner refuses them, and Node has no
good built-in PDF extractor ("no new npm dependencies" is a standing constraint
on this repo). Convert once, by hand:

```bash
brew install poppler
pdftotext -layout ~/Downloads/some-book.pdf digitalassets/some-book.txt
wc -w digitalassets/some-book.txt          # sanity check
```

`-layout` preserves reading order across two-column pages and callout boxes;
without it, sidebars interleave into body text mid-sentence. Afterwards, eyeball
the first and last ~40 lines for page-number and running-header noise. A little
is harmless — the extractor ignores it. A lot means the PDF needs a different
tool.

## Using one

```bash
# 1. Report first — no skills written, no PR opened.
npm run learn -- --file digitalassets/some-book.txt \
  --author "Author Name" --title "Book Title" --published 2025 --extract-only

# 2. Read data/reports/marketing-learner/<slug>.md, then re-run without
#    --extract-only. Extraction and consolidation hit cache; only the skill
#    merges are re-paid.
```

That cache claim was false until 2026-08-23 and is worth knowing about, because it
decides what a re-run costs. The chunk cache keys on the extraction prompt, which
included every skill's full text — so any successful merge changed the key and
invalidated every cached chunk of every source. Three consecutive retries of one book
re-extracted all six chunks. The prompt now carries claim headings instead of bodies,
so the key only moves when a claim is added, removed or reworded: a same-day re-run
after a failed merge hits cache, and a re-run months later probably does not.

## Ingested

What has already been through the pipeline. Re-running a source is not harmful — the
merge deduplicates — but it re-pays extraction, so check here first.

| Source | Words | Ingested | Report |
|---|---:|---|---|
| `100m-offers.txt` — Hormozi, *$100M Offers* | 46k | 2026-07-28 | `100m-offers.md` |
| `100m-money-models.txt` — Hormozi, *$100M Money Models* | 45k | 2026-07-28 | `100m-money-models.md` |
| `100m-leads.txt` — Hormozi, *$100M Leads* | 68k | 2026-08-23 | `100m-leads.md` |

Reports live in `data/reports/marketing-learner/` and are committed, so that column is
the durable record even though the source texts here are not.

`--author` and `--title` are required: there is no metadata endpoint for a local
file, so those two flags *are* the provenance that ends up on every claim.

## Copyright

Extracting notes from a book you own, into this private repo, for your own
business decisions, is ordinary reading. Keep the resulting skills internal —
do not publish them. Some copyright pages explicitly reserve text-and-data-mining
rights, which is a further reason not to commit source texts here or republish
what comes out.
