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

## Before pasting anything

Diff the `.before.html` against what is live right now. These files are a snapshot; if
someone edited the email in the UI since, pasting the rebuild silently reverts their
work.

## What the rebuild changes, and what it must not

Restyle only — **copy is untouched**, so a change in performance is attributable to the
design rather than the words. The single text difference is the wordmark, which moves
from `REAL SKIN CARE` set in Georgia to the hosted logo image carrying
`alt="Real Skin Care"`, so the accessible text survives.

Preserved exactly: every Klaviyo tag (`{% coupon_code %}`, `{% unsubscribe %}`), every
link, and the CAN-SPAM postal address. `verify-rebuild.mjs` checks all of that
mechanically — run it before pasting.
