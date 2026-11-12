# Automated Culina Inbound Shipments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When Travis emails Sean a Culina case list, book the FBA share at the lowest total cost from Springville, email Travis the labels in his thread (CC Sean), hand Sean the AWD share to enter in Seller Central, and forward the AWD labels once that shipment exists.

**Architecture:** Pure decision logic lives in small `lib/amazon-inbound-*.js` modules with unit tests: parse, split, cost, state/dedupe, AWD match and email copy. All I/O is injected through `deps`, following `agents/culina-report`: SP-API through `lib/amazon/sp-api-client.js`, mail through `lib/hushmail.js`, and `notify`. `lib/amazon-inbound-fba.js` drives Fulfillment Inbound v2024-03-20 as a resumable step machine whose every step is recorded in a state file. `agents/amazon-inbound/index.js` is the CLI and cron entry.

**Tech Stack:** Node 22 ESM, `node:test`, existing SP-API client, `lib/hushmail.js` (IMAP read, Resend send with attachments), `lib/culina-data.js`, `lib/culina-forecast.js`.

**Spec:** `docs/superpowers/specs/2026-11-12-amazon-inbound-shipments-design.md`

## Global Constraints

- Culina only. A SKU not in `config/amazon-inbound.json` `skus` is refused. Never use an `amzn.gr.*` SKU.
- Trigger sender: `travis@traviswales.com`. Reply To Travis, CC `sean@realskincare.com`, From `sean@realskincare.com`, `fromName` `'Sean at Culina'`, threaded with `inReplyTo` and `references`.
- Ship-from: CMS, 41007 Harris Rd, Springville CA 93265, US, phone 8662238199.
- FBA need window: 30 days. Duplicate window: 7 days. AWD reminder after 3 days.
- Cheapest = lowest TOTAL (placement fee net of discounts + cheapest partnered transport per shipment). An unquoted fee is never cheapest; if no option is quoted, stop.
- Modes compared: partnered small parcel and partnered LTL. LTL is quoted only when `AMAZON_INBOUND_CONTACT_PHONE` is set. That phone number is never written to any committed file.
- Pallets: 48 × 40 in, at most 60 in tall including the pallet, non-stackable, 40 lb pallet weight.
- Item labels and prep: `labelOwner` SELLER, `prepOwner` SELLER (no prep). Case labels only.
- No em dashes in any email body or subject.
- Dry by default. `--apply` on cron. `config.enabled: false` makes the run a no-op that says so.
- Failures: `notify({ immediate: true, status: 'error' })` to Sean only, naming the message, step, plan ID and Amazon's error. Every run that acts writes one deferred digest row (`status: 'info'`/`'success'`).
- State `data/amazon-inbound/state.json` is gitignored, written via temp file + rename, and **throws when unreadable**. A message is claimed before the first create call.
- Entry guarded by `isDirectRun(import.meta.url)`. Cron in UTC with no `TZ=` prefix; added to `scripts/setup-cron.sh` and installed live in the same change.
- Every SP-API request and response shape is checked against Amazon's current reference (developer-docs.amazon.com/sp-api, or the `amzn/selling-partner-api-models` JSON models), never recalled.

## Review Focus

1. **A reply from Travis that quotes the earlier list** below new text. Only the unquoted top text is parsed; a "thanks!" reply quoting the list books nothing. Tested in Task 2.
2. **A crash between `createInboundPlan` and the state write.** The plan is named `culina-<msgHash8>`, so on resume an existing plan with that name is adopted and never re-created. Tested in Task 6.
3. **Amazon returns an option with no quote, or none at all.** The unquoted option is skipped; with none quoted the run stops and alerts Sean with nothing confirmed. Tested in Task 4 and Task 6.
4. **A pallet build that does not fit** (one case taller than the 60 in limit, or mixed case heights). `palletize` throws, and LTL is dropped from the comparison rather than declared wrong. Tested in Task 4.
5. **Two pending AWD shares with identical contents.** The oldest pending share claims the first matching AWD shipment, and one shipment never satisfies two shares. Tested in Task 5.

---

### Task 1: Config, ignore rules and backup

**Files:**
- Create: `config/amazon-inbound.json`
- Modify: `.gitignore` (add `data/amazon-inbound/`)
- Modify: `scripts/backup-snapshots-offsite.sh` (add `data/amazon-inbound` to the `SERVER_STATE_PATHS` loop, ~line 255)
- Test: `tests/config/amazon-inbound-config.test.js`

**Interfaces:**
- Produces: `config/amazon-inbound.json` with keys:
  - `enabled`, `sender`, `to`, `cc`, `from`, `fromName`
  - `fba_cover_days` (30), `duplicate_window_days` (7), `awd_reminder_days` (3)
  - `ship_from` (Amazon `sourceAddress` shape, name `CMS`)
  - `pallet` (`{ length_in: 48, width_in: 40, max_height_in: 60, pallet_weight_lb: 40, stackable: false }`)
  - `skus`: an array of `{ key, aliases[], sku, asin, units_per_case, case_in: {l,w,h}, case_lb }`

  Seed `skus` with these four rows:

  | key | aliases | sku | asin | units/case | case in (l, w, h) | case lb |
  |---|---|---|---|---|---|---|
  | `2-pack` | 2-pack, 2 pack, two pack | `BLI-029655_026708-028658-SET2_CLN_FBA` | B077LYR5SF | 20 | 18, 9, 12 | 27 |
  | `3-pack` | (same pattern) | `salt_Soap_conditioner` | B08BTQK5Z9 | 12 | 18, 10, 12 | 26 |
  | `4-pack` | (same pattern) | `soap_oil_stick_salt2` | B08K892JQG | 12 | 18, 10, 12 | 28 |
  | `6-pack` | (same pattern) | `soap_oil_salt_stick_scrubber_brush` | B08KHGYYKQ | 12 | 18, 10, 12 | 31 |

- [ ] **Step 1: Write the failing test.** It should cover:
  - **The four SKUs:** sku and units/case equal the table above.
  - **No used-item SKUs:** no sku starts with `amzn.gr.`.
  - **Aliases:** unique across SKUs, lower-case.
  - **No phone numbers:** the file contains no 10-digit run other than `8662238199`.
  - **Ignore and backup wiring:** `.gitignore` has a line `/^data\/amazon-inbound\/$/m`, and the backup script contains `data/amazon-inbound`.
- [ ] **Step 2:** Run `node --test tests/config/amazon-inbound-config.test.js`. Expected: FAIL (file missing).
- [ ] **Step 3:** Create the config and make the two edits.
- [ ] **Step 4:** Re-run. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(amazon-inbound): config, gitignore, offsite backup`.

### Task 2: Parse Travis's email

**Files:**
- Create: `lib/amazon-inbound-parse.js`
- Test: `tests/lib/amazon-inbound-parse.test.js`

**Interfaces:**
- Consumes: `config.skus`.
- Produces:

  ```
  parseShipmentEmail(text: string, skus) -> {
    kind: 'none' | 'invalid' | 'shipment',
    lines:    [{ key, sku, asin, cases, units, unitsPerCase, raw }],
    problems: [{ raw, reason }],
  }
  ```

  Also `linesSignature(lines) -> string`: sorted `sku:cases` pairs, used for duplicate detection.

The caller passes already-unquoted text (`lib/hushmail.js` rows carry `text = stripQuoted(...)`).

- **Line pattern:** `<name> (<n> case(s) - <m> unit(s)|unis)`. Accept en and em dashes, `x` or no separator, CRLF, and extra spaces. Case-insensitive.
- **"Shipment-looking" lines** are those containing `\bcases?\b` together with a number. Any such line that fails gives `kind: 'invalid'`, with the line quoted in `problems`.

- [ ] **Step 1: Write the failing tests.** Each is one fixture with assertions:
  1. Travis's real message (four lines, including "100 unis") gives `kind: 'shipment'`, 4 lines, 6-pack `{cases: 10, units: 120}`.
  2. `"thanks, see you friday"` gives `kind: 'none'`.
  3. `"5-pack (2 cases - 24 units)"` gives `invalid`, with `reason` naming the unknown pack.
  4. `"3-pack (9 cases - 100 units)"` gives `invalid`, with `reason` naming the mismatch (9 × 12 = 108).
  5. CRLF and `"3 pack (9 cases – 108 units)"` parse.
  6. One good line plus `"2-pack (five cases)"` gives `invalid` and books nothing.
  7. `linesSignature` is order-independent.
- [ ] **Step 2:** Run `node --test tests/lib/amazon-inbound-parse.test.js`. Expected: FAIL.
- [ ] **Step 3:** Implement `parseShipmentEmail` and `linesSignature`.
- [ ] **Step 4:** Re-run. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(amazon-inbound): parse case lists`.

### Task 3: FBA / AWD split

**Files:**
- Create: `lib/amazon-inbound-split.js`
- Test: `tests/lib/amazon-inbound-split.test.js`

**Interfaces:**
- Consumes: `forecastUnits(pace, startDate, days, seasonal)` from `lib/culina-forecast.js`, and parsed `lines`.
- Produces:

  ```
  splitCases({ lines, fbaBySku, paceBySku, today, seasonal, coverDays })
    -> [{ sku, key, fbaCases, awdCases, needUnits, coverDaysNow, reason }]
  ```

  - `fbaBySku[sku] = { fulfillable, inbound }`, FBA side only.
  - `paceBySku[sku]` is units/day or `null`.

  Also `readFbaBySku(deps) -> fbaBySku`, the I/O. It reads `/fba/inventory/v1/summaries` with `details: true`, paginated, keyed by `sellerSku`. `inbound` = working + shipped + receiving.

Rules:
- `need = forecastUnits(pace, today, coverDays, seasonal) - fulfillable - inbound`.
- `fbaCases = min(cases, ceil(max(0, need) / unitsPerCase))`; the remaining cases go to AWD.
- `pace` null → all cases to FBA, with reason `"no sales pace yet"`.
- `reason` is a plain sentence, e.g. `"14 days of FBA cover, 4 cases to FBA, 6 to AWD"`.

- [ ] **Step 1: Write the failing tests:**
  - pace 4/day, flat seasonal, fulfillable 50, inbound 0, unitsPerCase 12, 10 cases: need 70, so fbaCases 6, awdCases 4.
  - Need ≤ 0 gives fbaCases 0.
  - Need larger than the cases on hand: all to FBA.
  - Null pace: all to FBA.
  - `readFbaBySku` with a stubbed 2-page response sums FBA inbound and ignores AWD. Use a fake `deps.request`.
- [ ] **Step 2:** Run `node --test tests/lib/amazon-inbound-split.test.js`. Expected: FAIL.
- [ ] **Step 3:** Implement both functions.
- [ ] **Step 4:** Re-run. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(amazon-inbound): 30-day FBA/AWD split`.

### Task 4: Pallets and cheapest-total choice

**Files:**
- Create: `lib/amazon-inbound-cost.js`
- Test: `tests/lib/amazon-inbound-cost.test.js`

**Interfaces:**
- Produces:

  ```
  palletize(cases: [{ sku, count, case_in, case_lb }], pallet)
    -> [{ length_in, width_in, height_in, weight_lb, cases: [{ sku, count }] }]
  ```

  Throws `Error('palletize: ...')` when a case cannot fit.

  ```
  chooseCheapest(candidates: [{
    placementOptionId,
    placementFee: number | null,
    shipments: [{ shipmentId, options: [{ transportationOptionId, mode, amount: number | null }] }],
  }]) -> { placementOptionId, total, picks: [{ shipmentId, transportationOptionId, mode, amount }] } | null
  ```

  `feeAmount(feesOrQuote) -> number | null` normalises Amazon's money objects (`{ amount, code: 'USD' }`, discounts negative). It returns `null` when absent or not USD.

Rules:
- **Pallets:** single-SKU layers. Cases per layer = max over both orientations of `floor(48/l) * floor(40/w)`; never divide areas, which overcounts. Layers stop when the next layer would pass 60 in including `deck_in`. Fill pallets in config SKU order; mixed SKUs only on the last pallet.
- **Choosing:** a candidate with a null placement fee, or a shipment with no quoted option, is skipped. If none qualifies, return `null`. Ties go to the fewest shipments, then the first.

- [ ] **Step 1: Write the failing tests:**
  - 9 cases of 18×10×12 in at 26 lb: 8 per layer (2 × 4), so 2 layers, height 2 × 12 + 5 = 29 in (`deck_in: 5`), 1 pallet, weight 9 × 26 + 40 = 274 lb. Max 4 layers (53 in), so 32 cases per pallet.
  - 18×9 cases: 10 per layer (5 × 2).
  - 33 cases (the real batch): pallet count and weights sum to the case total.
  - One 61 in case throws.
  - `chooseCheapest`: fee 30 + parcel 120 beats fee 0 + parcel 80 + parcel 90; an LTL option beats parcel when cheaper; a null-fee candidate is skipped; all unquoted gives `null`.
  - `feeAmount({ amount: -5, code: 'USD' })` is −5; `feeAmount({ amount: 5, code: 'CAD' })` is `null`.
- [ ] **Step 2:** Run `node --test tests/lib/amazon-inbound-cost.test.js`. Expected: FAIL.
- [ ] **Step 3:** Implement. Add `deck_in: 5` to `config.pallet` in the same commit.
- [ ] **Step 4:** Re-run. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(amazon-inbound): palletize and cheapest-total selection`.

### Task 5: State, duplicates and AWD matching

**Files:**
- Create: `lib/amazon-inbound-state.js`
- Test: `tests/lib/amazon-inbound-state.test.js`

**Interfaces:**
- Produces:
  - `loadState(path) -> { messages: { [messageId]: Record } }`. Missing file gives an empty state; unreadable or invalid JSON **throws**.
  - `saveState(path, state)`: temp file + rename.
  - `planName(messageId) -> 'culina-' + first 8 hex of sha256(messageId)`.
  - `duplicateCheck(state, { messageId, signature, text, receivedAt, windowDays, resendOf })` -> `{ hold: false } | { hold: true, reason }`.
    - It holds when a booked record within `windowDays` has the same `signature`, or when the text matches `/\b(sorry|correction|instead|actually)\b/i` and any record was booked in the window.
    - `resendOf` (the message we asked to resend) is never held.
  - `manualBookingCheck(lines, laterShipments: [{ id, createdAt, casesBySku: { [sku]: number } }], receivedAt)` -> `{ verdict: 'placed' | 'partial' | 'none', covering: [ids] }`.
    - Only shipments created at or after `receivedAt` count.
    - `placed` when, for every line, the summed cases for that SKU ≥ the line's cases.
    - `partial` when any SKU appears but not every line is covered.
    - `none` otherwise.
  - `matchAwdShipment(pendingShares, awdShipments) -> [{ messageId, shipmentId }]`.
    - Exact SKU → case-count match, shipment created after the share's `handoffAt`.
    - Oldest share first; each shipment is used once.

  Record shape:

  ```
  { messageId, step, receivedAt, signature, planId, shipmentIds,
    fbaSplit, awdShare: { lines, handoffAt, remindedAt, awdShipmentId, labelsSentAt },
    error, updatedAt }
  ```

  `step` is one of: `claimed`, `plan_created`, `packing_confirmed`, `quoted`, `confirmed`, `labels_sent`, `held`, `invalid_replied`, `done`, `failed`.

- [ ] **Step 1: Write the failing tests:**
  - An unreadable file throws.
  - Save then load round-trips.
  - `planName` is stable.
  - Same signature 3 days later is held; 8 days later is not.
  - "sorry, 2-pack is 6 cases" after a booking is held.
  - `resendOf` is never held.
  - Two identical shares and one shipment give one match, to the oldest share.
  - A shipment created before `handoffAt` does not match.
  - Partial counts do not match.
  - `manualBookingCheck` cases:
    - Travis's four lines, with one later FBA plan holding 3-pack 9 cases and an AWD shipment holding the other three in full: `placed`.
    - Only the 3-pack covered: `partial`.
    - A matching shipment created BEFORE `receivedAt`: `none`.
    - No shipments: `none`.
- [ ] **Step 2:** Run `node --test tests/lib/amazon-inbound-state.test.js`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Re-run. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(amazon-inbound): state, duplicate hold, AWD match`.

### Task 6: FBA booking step machine

**Files:**
- Create: `lib/amazon-inbound-fba.js`
- Test: `tests/lib/amazon-inbound-fba.test.js`

**Interfaces:**
- Consumes: `planName`, `palletize`, `chooseCheapest`, `feeAmount`, `saveState`. Also `deps = { request(method, path, body|params), sleep, now, contactPhone, apply }`.
- Produces:

  ```
  bookFba({ record, items: [{ sku, cases, unitsPerCase, case_in, case_lb }], config, deps, persist: (record) => void })
    -> record   // step 'confirmed', or with `quote` and no confirm when !deps.apply
  ```

  `fetchFbaLabels({ record, deps }) -> [{ filename, content: Buffer }]`: case labels per shipment, plus pallet labels and BOL when LTL was chosen.

  `cancelDraft({ record, deps })`: the dry-run cleanup.

Flow:
1. Call `persist` after every step. Poll `getInboundOperationStatus` until `SUCCESS` (fail on `FAILED`) after each async POST, with backoff, honoring 429.
2. **Resume:** if `record.planId` is unset, first list inbound plans and adopt one named `planName(messageId)`. Only then call `createInboundPlan`, named that way.
3. **Packing, placement, transport:** generate packing options, then `setPackingInformation` with one box group per SKU (`quantity` = cases, dims in, weight lb, items `{ msku, quantity: unitsPerCase, labelOwner: 'SELLER', prepOwner: 'SELLER' }`), then confirm packing. Generate placement options. For EVERY placement option, generate transportation options with partnered small parcel and, if `deps.contactPhone`, LTL with pallets from `palletize` and the ready date today. `palletize` throwing means parcel only.
4. **Choose:** build candidates and pick with `chooseCheapest`. A `null` result throws `'no quoted option'`.
5. **Confirm:** without `deps.apply`, return the quote. With it, call `confirmPlacementOption`, then `confirmTransportationOptions` (plus delivery-window confirmation only if the reference requires it for the chosen mode), and set step `confirmed`.
6. **Labels:** `fetchFbaLabels` uses the reference's current label operation for partnered shipments (v0 `getLabels` with a `PackageLabel` page type for cases, `PalletLabel`/`getBillOfLading` for LTL), downloading each PDF URL.

- [ ] **Step 1: Write the failing tests** with a scripted fake `request` that records calls and returns canned responses:
  - A happy path ends `confirmed` with picks matching the cheapest total.
  - Dry mode (`apply` false) never calls a confirm endpoint, and `cancelDraft` calls `cancelInboundPlan`.
  - **Crash resume:** a record at `claimed` whose plan already exists by name is adopted, and `createInboundPlan` is called 0 times.
  - All options unquoted: throws `/no quoted option/` and calls no confirm.
  - No `contactPhone`: no LTL request body is sent.
  - `persist` is called with each step in order.
- [ ] **Step 2:** Run `node --test tests/lib/amazon-inbound-fba.test.js`. Expected: FAIL.
- [ ] **Step 3:** Implement. Verify every path and body against the v2024-03-20 reference first, and note the doc URL in the file header.
- [ ] **Step 4:** Re-run. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(amazon-inbound): resumable FBA booking at lowest total cost`.

### Task 7: Email copy

**Files:**
- Create: `lib/amazon-inbound-email.js`
- Test: `tests/lib/amazon-inbound-email.test.js`

**Interfaces:**
- Produces: these functions, each returning `{ subject, text, html }`:
  - `labelsReply({ record, shipments: [{ shipmentId, destination, cases: [{ key, count }], mode, carrier, pallets }], awdLines })`
  - `awdLabelsReply({ awdShipmentId, lines })`
  - `resendRequest({ problems })`
  - `awdHandoff({ lines, shipFrom, reasons })`, for Sean
  - `awdReminder(...)`, for Sean
  - `heldNotice({ reason, text })`, for Sean
  - `alreadyPlacedNotice({ covering })`, for Sean
  - `failureNotice({ messageId, step, planId, error })`, for Sean

Content rules:
- `labelsReply` lists per shipment: ID, destination, cases by pack, mode and carrier, and pickup or drop-off.
- For LTL it states the pallet count and which cases go on each pallet.
- It ends by naming the AWD cases whose labels follow.

- [ ] **Step 1: Write the failing tests:**
  - No output of any function contains `—` or `–`.
  - `labelsReply` names every shipment ID and every pack.
  - The LTL variant states the pallet count.
  - `resendRequest` quotes the bad line verbatim.
  - `awdHandoff` lists, per SKU, the ASIN, cases, units/case, case dims and weight.
- [ ] **Step 2:** Run `node --test tests/lib/amazon-inbound-email.test.js`. Expected: FAIL.
- [ ] **Step 3:** Implement. Keep the copy plain and short, in Sean's voice.
- [ ] **Step 4:** Re-run. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(amazon-inbound): email copy`.

### Task 8: Agent, cron and docs

**Files:**
- Create: `agents/amazon-inbound/index.js`
- Modify: `scripts/setup-cron.sh`: add `EVERY_15_AMAZON_INBOUND="*/15 * * * * cd \"$PROJECT_DIR\" && $NODE agents/amazon-inbound/index.js --apply >> data/reports/scheduler/amazon-inbound.log 2>&1"`, plus it in the job list and the printed summary.
- Modify: `CLAUDE.md`: one paragraph beside the Amazon keyword-coverage paragraph.
- Test: `tests/agents/amazon-inbound.test.js`

**Interfaces:**
- Consumes: everything above. Also `fetchFromAllFolders`, `sendMail` and `hushmailCredentials` from `lib/hushmail.js`; `fetchDailyUnits` from `lib/culina-data.js`; `dailyPace`, `inferStockoutDates` and `seasonalIndex` from `lib/culina-forecast.js`, with the seasonal cache read-only from `data/reports/culina-report/seasonal.json` (a missing cache means a flat index).
- Produces: `run(argv, deps) -> summary`, plus `parseArgs(argv)`. Arguments are `--apply`, `--dry-run`, `--text "<message>"` and `--since YYYY-MM-DD`.

`run` does, per invocation:
1. **Config.** `enabled: false` returns early with a log line.
2. **Inbox.** Load state (an unreadable state sends one immediate notify, then throws). Fetch Travis's mail since the latest of 14 days ago or `--since`. Skip messages already in state and auto-replies.
3. **Each new message:**
   - parse;
   - `none`: record `done`;
   - `invalid`: send `resendRequest` to Travis, record `invalid_replied`;
   - otherwise run `duplicateCheck`. On a hold, send Sean `heldNotice` and record `held`.
   - Then run `manualBookingCheck`. Build `laterShipments` from FBA inbound plans (items per plan via `listInboundPlanItems`, cases = quantity ÷ units_per_case) and from AWD inbound shipments (`shipmentSkuQuantities` in CASES), both filtered to `createdAt >= receivedAt`.
     - `placed`: send Sean `alreadyPlacedNotice`, record `done`.
     - `partial`: send `heldNotice`, record `held`.
   - If neither check holds it: claim (persist `claimed`), split, run `bookFba` for the FBA lines, fetch labels, send `labelsReply` with the attachments, and record `labels_sent`.
   - If there is an AWD share, also send Sean `awdHandoff` and set `awdShare.handoffAt`.
4. **Resume.** Records in any intermediate step resume from it.
5. **AWD.** Pending AWD shares: list AWD inbound shipments, run `matchAwdShipment`, fetch `getInboundShipmentLabels` (PDF), send `awdLabelsReply` in Travis's thread, and set `labelsSentAt`. Past `awd_reminder_days` with no match and no reminder, send `awdReminder`.
6. **Failure.** Any throw inside a message records `failed` with the error and sends `failureNotice` through `notify({ immediate: true, status: 'error' })`. The next run retries from the recorded step.
7. **Digest.** One deferred `notify` when anything happened.

`--text` runs steps 3 onward on that text without mail. Dry runs (no `--apply`) quote and then `cancelDraft`, send nothing, and print the parse, the split and the cheapest total.

- [ ] **Step 1: Write the failing tests** with injected deps (fake mail rows, fake `request`, recorded `sendMail` and `notify`, temp state dir):
  - Source scan: `isDirectRun` guard present.
  - The real four-line email with `--apply` sends exactly one reply To Travis CC Sean with PDF attachments, threaded on his Message-ID.
  - A second run with the same mail sends nothing and creates no plan.
  - An invalid email sends `resendRequest` and makes 0 SP-API calls.
  - A held duplicate makes 0 SP-API calls and sends 1 email to Sean only.
  - An email already covered by a later manual plan books nothing and sends Sean one note.
  - `bookFba` throwing gives exactly one immediate notify and record `failed`.
  - An AWD share plus a matching AWD shipment on a later run sends `awdLabelsReply`.
  - `enabled: false` makes no calls.
  - `setup-cron.sh` contains `agents/amazon-inbound/index.js --apply` and no `TZ=`.
- [ ] **Step 2:** Run `node --test tests/agents/amazon-inbound.test.js`. Expected: FAIL.
- [ ] **Step 3:** Implement the agent, the cron entry and the CLAUDE.md paragraph.
- [ ] **Step 4:** Run `node --test tests/agents/amazon-inbound.test.js tests/lib/amazon-inbound-*.test.js tests/config/amazon-inbound-config.test.js`. Expected: all PASS, 0 cancelled.
- [ ] **Step 5:** Run `npm test`. Expected: no new failures.
- [ ] **Step 6:** Commit: `feat(amazon-inbound): agent, cron, docs`.

### Task 9: Live dry run and rollout

- [ ] **Step 1:** Run `node agents/amazon-inbound/index.js --dry-run --text "<Travis's four lines>"` on the Mac. Expected: 4 lines parsed, a split per SKU with reasons, quotes for every placement option, the cheapest total named, the draft plan cancelled. Fix any request-shape errors Amazon reports and re-run until it is clean.
- [ ] **Step 2:** Open the PR with `gh pr create`, including the dry-run output in the body.
- [ ] **Step 2b:** Pre-rollout emails, including the 2026-11-12 list, follow the normal rules on the first `--apply` run: they book unless `manualBookingCheck` finds them already placed (Sean, 2026-11-12). Nothing to seed.
- [ ] **Step 3 (after merge):** Deploy (`git pull`, per the CLAUDE.md deploy section), run `scripts/setup-cron.sh` on the server, and confirm with `crontab -l | grep amazon-inbound`.
- [ ] **Step 4:** Run the server dry run once against the live inbox: `node agents/amazon-inbound/index.js --since 2026-11-12`. Expected: Travis's message found and parsed, nothing booked.
