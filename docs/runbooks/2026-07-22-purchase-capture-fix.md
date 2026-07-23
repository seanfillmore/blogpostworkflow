# Runbook — Close the Purchase-Capture Gap (GA4 7 of 13 → parity)

**Date:** 2026-07-22 · **Owner:** Sean (GA4 / Shopify / Google Ads UIs) · **Context:** [tracking diagnosis](../reports/2026-07-22-tracking-diagnosis.md)

## The problem, precisely
Google Ads' purchase conversion is a **GA4 import** from property **358754048** (measurement ID **G-PYV4WG2QL8**). That property records ~**7 purchases** for a window with **13 Shopify orders** (~54% capture). Fixing GA4 capture fixes Ads automatically.

## Root cause: overlapping tag stack (found on the live storefront)
- **Two GA4 properties fire on the site:** `G-PYV4WG2QL8` (canonical, 358754048) **and** `G-12BJ5N9FNX` (a stray second property). Ads imports only from 358754048, so any purchases landing on the other property are lost to Ads.
- Plus a **GTM container** (`GTM-MKJBFZ8M`), a **standalone Google Tag** (`GT-TBVN96Q`), the **theme gtag** (`layout/theme.liquid` line ~158, `gtag('config','G-PYV4WG2QL8')`), **and** the **Shopify Google & YouTube channel** web pixel (app 390103210, whose config lists all of `G-PYV4WG2QL8`, `GT-TBVN96Q`, `G-12BJ5N9FNX`).
- Net: multiple systems firing the same events → races, partial double-counts, and dropped purchases.

## Fix — in order (verify each with GA4 DebugView + a real/test order)

1. **Confirm the canonical property.** GA4 → Admin → Data streams for property **358754048**; confirm its measurement ID is **G-PYV4WG2QL8**. This is the source of truth (Ads import + the purchase key-event live here).
2. **Identify `G-12BJ5N9FNX`.** In GA4, find which property owns it. Decide: it is the stray. Do **not** keep two properties collecting the same store.
3. **Pick ONE tagging path — recommend the Shopify Google & YouTube channel** (Customer Events pixel; server-side, survives ad-blockers/ITP — the reason it's the reliable purchase source). In that channel's settings:
   - Ensure it's linked to GA4 **G-PYV4WG2QL8** and Google Ads **AW-10923654107**.
   - **Remove `G-12BJ5N9FNX`** from its tag list.
   - Confirm **Conversion tracking / purchase** is enabled (it references `purchase`; verify it actually sends `purchase` to G-PYV4WG2QL8).
4. **Remove the redundant client-side duplicates — carefully, one at a time, re-checking DebugView after each:**
   - The **theme gtag** (`layout/theme.liquid` ~157–164) duplicates what the channel does and does **not** fire on the hosted checkout — a common source of "pageviews yes, purchases no." If the channel covers GA4, this can go. **Back up theme.liquid first** (`docs/reports/theme-backups/`).
   - **Before touching `GTM-MKJBFZ8M` or `GT-TBVN96Q`, open them** and list what tags they contain — they may host other important tags. Only remove/merge if they're redundant GA4/Ads duplicates.
5. **Verify a real purchase reaches G-PYV4WG2QL8 once, and only once.** Place a test order (or watch a real one) in **GA4 → Admin → DebugView** / Realtime: exactly one `purchase` event, correct value, on property 358754048.
6. **Enable Enhanced Conversions (attribution quality, layered on top).** GA4/Google tag → Enhanced Conversions on (hashed first-party data) so the purchases that ARE captured match to ad clicks better. This improves match rate; it does **not** replace steps 1–5, which fix the *count*.
7. **Also disconnect the leftover Twitter/X app pixel** (Shopify Customer Events, app 6455335 — `tw-odnr8-*`) — it's the last `twq` error source and isn't used.

## Success check (over 3–7 days)
- `node scripts/growth-scoreboard.mjs` → GA4 "conversions" ≈ Shopify orders (**overcount → ~1.0×**).
- `node scripts/ga4-conversion-events.mjs` → `purchase` count ≈ Shopify order count for the window.
- Only **one** GA4 measurement ID observed firing on the storefront (`curl -s https://www.realskincare.com/ | grep -oE 'G-[A-Z0-9]{8,}' | sort -u`).

Once purchases reconcile to Shopify, the Phase-0 tracking gate is fully met and paid scaling can begin on trustworthy numbers.
