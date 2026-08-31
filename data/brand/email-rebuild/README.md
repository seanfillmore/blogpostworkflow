# Email rebuilds

Brand-corrected HTML for the Klaviyo flow emails. One folder pair per template:
`<templateId>.before.html` (exactly what was live when it was pulled) and
`<templateId>.after.html` (the rebuild).

## These push through the API — the "paste it by hand" rule was wrong

This section used to say flow-owned templates could not be written and every rebuild
had to be pasted into the Klaviyo UI. **That was wrong, and the way it was wrong is
worth keeping:** it tested revisions `2024-10-15`, `2025-01-15` and `2025-07-15`, saw
the same 404 on all three, and concluded "not a versioning artifact". All three predate
the endpoint. `PATCH /api/flow-actions/{id}` went GA in revision **`2025-10-15`**
("Update flow actions within a flow, including associated message content"). Testing N
revisions proves nothing unless one of them postdates the feature.

Re-measured live 2026-08-30 on revision `2026-07-15`:

| Call | Result |
|---|---|
| `GET /api/templates/{id}` | **200** — full HTML |
| `PATCH /api/templates/{id}` on a flow-owned template | **404** — still true |
| `PATCH /api/flow-messages/{id}` | **405** — still true, wrong endpoint |
| `PATCH /api/flow-actions/{id}` @ `2026-07-15` | **200** — writes, on live and draft flows |
| same call @ `2025-07-15` | **404** "No valid revisions found for method" |

**A push is a REPLACEMENT, not an edit.** The flow action rejects raw HTML
(`'body' is not a valid field for the resource 'FlowEmail'`), so content moves by
`template_id`: create a library template, repoint the action at it, and Klaviyo
**snapshots** it into a brand-new flow-owned copy. Nothing is ever updated in place, and
every push strands the copy it replaced.

## Applying one

```bash
node scripts/klaviyo-push-flow-template.mjs <id>            # dry run
node scripts/klaviyo-push-flow-template.mjs <id> --apply
node scripts/klaviyo-push-flow-template.mjs --sweep-orphans --apply
```

It backs the live body up **before** writing, refuses if the live email has drifted from
`.before.html` (pass `--allow-drift` only after diffing), verifies through the consumer
(`GET /api/flow-messages/{id}/template/`) rather than trusting the PATCH's 200, and rolls
back if the verify fails. On success it refreshes `.before.html` from what Klaviyo
actually stored and records the mapping in `flow-map.json`.

**`flow-map.json` is what makes a second push possible.** The filename is the template id
that was live when the rebuild was pulled, and a push changes that id — so after one push
the filename no longer resolves to anything. The map records the **message id**, which is
stable across every repoint, and later runs resolve through it.

Still worth doing by hand after a push: send yourself a preview and check the coupon
renders a real code, the unsubscribe link resolves, the logo loads, and dark mode swaps
it. Then re-run `node scripts/klaviyo-email-audit.mjs`.

## Sweeping the strays

Each push strands the previous flow-owned snapshot. `--sweep-orphans` deletes them —
and **only** them. It works from an allowlist of ids recorded in `flow-map.json`, never
from "what does no flow reference", because those are very different questions:
`GET /api/templates` enumerates **library templates only** (measured: 47 listed, sharing
*zero* ids with the 33 a flow actually serves), so a sweep driven by that list proposed
deleting 47 templates including `camp_*` campaign snapshots and the named library sources
`build-nurture-flow.mjs` finds through `upsertTemplateByName`. Flow-owned snapshots are
readable by id and invisible to the list endpoint.

## The unsubscribe tag: all 22 shipped with the wrong one

`{% unsubscribe %}` expands to a **complete `<a>` element**, not a URL. Put it in an
href and the anchor nests inside an attribute, the browser closes the outer tag early,
and the rest of the footer markup leaks into the email as visible text — readers see a
stray `" style="font-family:Outfit…">Don't want these?…` after the link.

Klaviyo's tag for the bare URL is **`{% unsubscribe_link %}`**, and that is what belongs
inside `<a href="">`. ([docs](https://help.klaviyo.com/hc/en-us/articles/115006054267))

Every one of the 22 live templates uses `href="{% unsubscribe %}"`, so this is inherited
breakage, not something a rebuild introduced. No rebuild may carry it forward —
`verify-email-rebuild.mjs` now fails on it, and both the tag and link checks treat the
two spellings as the same destination so the repair doesn't read as a dropped link.

## Copying a rebuild to the clipboard

Use `LC_CTYPE=UTF-8 pbcopy < <id>.after.html`. Plain `pbcopy` under `LC_CTYPE=C` tags the
pasteboard as Mac Roman, so every em dash and arrow arrives in Klaviyo as `‚Äî` / `‚Üí`.
A `pbcopy | pbpaste` round-trip **cannot detect this** — both ends share the same wrong
assumption and it looks clean. Check with `osascript -e 'the clipboard as text'`, which
reads the pasteboard the way a GUI app does.

## What Klaviyo rewrites when you save

Measured on the Winback 03 paste (8,313 bytes in, 8,583 out):

- **CSS is pretty-printed** and single quotes become double. Harmless.
- **CSS comments are stripped.** Never put load-bearing explanation in `/* … */`
  inside `<style>` — it will not survive. HTML comments *do* survive.
- Everything functional came through untouched: all template tags, the
  `@media (prefers-color-scheme: dark)` block, `!important` rules, and the webfont
  `@import`.

So after pasting, refresh `.before.html` from live rather than assuming it matches what
you pasted — otherwise every later run reports phantom drift.

## Before pasting anything

Diff the `.before.html` against what is live right now. These files are a snapshot; if
someone edited the email in the UI since, pasting the rebuild silently reverts their
work.

## What the rebuild changes, and what it must not

There are two modes, and they differ in what they are allowed to touch.

**Restyle** (`verify-email-rebuild.mjs <id>`) — **copy is untouched**, so a change in
performance is attributable to the design rather than the words. The single text
difference is the wordmark, which moves from `REAL SKIN CARE` set in Georgia to the
hosted logo image carrying `alt="Real Skin Care"`. Every link is preserved.

**Redesign** (`--redesign`) — copy and link set are both in scope. This is the mode for
the 21 templates that have no performance history: there is no baseline to protect, so
they are rebuilt against `../email-format-matrix.md` rather than merely repainted.

Preserved in **both** modes, and enforced as hard failures:

- every Klaviyo tag — a dropped `{% coupon_code %}` ships a broken offer
- the **compliance** links: unsubscribe, preference management, policy pages
- the CAN-SPAM postal address
- an on-palette colour set

**Why the link rule is split.** The format matrix mandates one ask per objective and at
most two destinations, but the live templates carry up to eleven links (`TA5Wi4` 11,
`ThCS7T` 10, `Y8wJn7` 10). A correct redesign therefore *drops* most of them. Failing on
that would have pressured every rebuild into keeping all eleven — the exact opposite of
the rule — so under `--redesign` a dropped **marketing** link is reported as a warning
you must eyeball, while a dropped **compliance** link still fails hard. The classifier
lives in `lib/email-rebuild-checks.js` and is unit-tested.
