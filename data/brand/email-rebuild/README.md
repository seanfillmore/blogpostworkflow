# Email rebuilds

Brand-corrected HTML for the Klaviyo flow emails. One folder pair per template:
`<templateId>.before.html` (exactly what was live when it was pulled) and
`<templateId>.after.html` (the rebuild).

## Why these are files and not API calls

**Flow-owned templates are readable but not writable.** Measured 2026-07-30:

| Call | Result |
|---|---|
| `GET /api/templates/{id}` | **200** — full HTML |
| `PATCH /api/templates/{id}` | **404** "Template … does not exist" |
| `PATCH /api/flow-messages/{id}` | **405** method_not_allowed |
| `POST` + `PATCH /api/templates` (your own) | **200** — works fine |

The 404 is identical across revisions `2024-10-15`, `2025-01-15` and `2025-07-15`, so
it is not a versioning artifact — Klaviyo returns 404 rather than 403 to mean "not in
the writable set". A *library* template you create is writable; a *flow-owned* one is
not. Confusing those two is what led an earlier note to claim flow emails were
API-editable. They are not.

Every flow template here is `editor_type: CODE`, so this is still a paste, not a
block-by-block rebuild.

## Applying one

1. Klaviyo → Flows → the flow → the message → **Edit email** → code editor.
2. Select all, paste the `.after.html` body, save.
3. Send a preview to yourself. Check specifically:
   - the coupon renders a real code (`{% coupon_code %}` is live, not literal text)
   - the unsubscribe link resolves
   - the logo loads (it is a Shopify CDN URL, not an attachment)
   - dark mode swaps the logo — toggle your client's appearance
4. Re-run `node scripts/klaviyo-email-audit.mjs` and confirm that row is on-brand.

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
