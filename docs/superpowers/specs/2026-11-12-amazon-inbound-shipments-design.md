# Automated Culina inbound shipments — design

Status: draft for Sean's approval, 2026-11-12.

## Intent

Culina product is packed at CMS in Springville, CA. When it is ready, Travis emails Sean a short list, for example:

```
4-pack (9 cases - 108 units)
3-pack (9 cases - 108 units)
2-pack (5 cases - 100 unis)
6-pack (10 cases - 120 units)
```

Today Sean then works through Seller Central by hand: finds each ASIN, decides FBA or AWD, enters case sizes and weights, picks a carrier, and sends Travis the labels. He called finding the ASINs and choosing the shipping method "the most tedious" part. **Sean, verbatim: "This needs to be automated. If Travis sends in an email with the shipment quantities, the labels need to be generated and sent back to him."**

## Goals

1. Travis's email arrives → FBA case labels come back to him in the same email thread, CC Sean, with no human step when nothing goes wrong.
2. Each case goes to FBA or AWD by Sean's rule: **stock needed within 30 days goes to FBA; long-term refill goes to AWD.**
3. Fees: **"We pay whatever Amazon tells us to pay, go ahead and charge the fees unless there is a less expensive way of doing it."** The tool always takes the cheapest placement option and the cheapest Amazon-partnered transport option, and confirms them without asking.
4. The AWD share, which the API cannot book with the partnered carrier, reaches Sean as a ready-to-type Seller Central entry. Once Sean has created that AWD shipment, the tool finds it, fetches its labels and sends them to Travis the same way.

## Non-goals

- Real Skin Care shipments. RSC is not packed at Springville and is out of scope here. Any SKU not identified as Culina is refused.
- Booking AWD through the API with our own carrier. **Sean chose option 1 on 2026-11-12:** FBA fully automatic, AWD with one manual Seller Central step, so AWD keeps partnered rates. Reason: the AWD API only supports seller-managed transportation (Amazon's "Create an inbound order" doc: "If you want to use Partner Carrier Program (PCP), create your inbound shipment in Seller Central").
- Item (FNSKU) labels. Packs are already item-labeled before they are cased. Sean: "We need the case labels for each."
- Opening Amazon support cases. There is no API for that.

## Anti-goals (a failure even if everything else works)

- **Booking the same email twice.** That is a second paid shipment Travis never packed.
- **Guessing a quantity or a SKU.** A line that does not match exactly is asked about, never interpreted.
- **Paying more than a cheaper offered option.**
- **Failing silently.** A half-made plan with nobody told is worse than no plan.
- Sending Travis labels for a shipment that is not confirmed.

## Decided facts

| | Value | Source |
|---|---|---|
| Ship-from | CMS, 41007 Harris Rd, Springville CA 93265, phone 866-223-8199 | `sourceAddress` on every recent FBA plan; Sean: "everything Culina is shipping from Springville" |
| Carrier | Amazon partnered | Sean |
| Labels to | travis@traviswales.com, CC sean@realskincare.com, from sean@realskincare.com | Sean; same addresses as `config/culina-report.json` |
| Trigger | an email from travis@traviswales.com to Sean's Hushmail | Sean |
| Item labels / prep | `labelOwner` SELLER, prep owner SELLER, no prep, matching every past shipment. No FNSKU labels are generated. | shipment history; Sean |

**Pack names → SKUs and case packs.** Taken from each SKU's most recent shipment; Sean: "nothing is changing". The 4-pack ASIN was confirmed by Sean.

| Travis says | SKU | ASIN | Units/case | Case (in) | Case weight | Last shipped |
|---|---|---|---|---|---|---|
| 2-pack | `BLI-029655_026708-028658-SET2_CLN_FBA` | B077LYR5SF | 20 | 18 × 9 × 12 | 27 lb | 2026-08-14 AWD |
| 3-pack | `salt_Soap_conditioner` | B08BTQK5Z9 | 12 | 18 × 10 × 12 | 26 lb | 2026-10-01 FBA |
| 4-pack | `soap_oil_stick_salt2` | B08K892JQG | 12 | 18 × 10 × 12 | 28 lb | 2026-08-16 FBA |
| 6-pack | `soap_oil_salt_stick_scrubber_brush` | B08KHGYYKQ | 12 | 18 × 10 × 12 | 31 lb | 2026-08-14 FBA |

B08KHGYYKQ also has four `amzn.gr.*` SKUs (Amazon's used-item resale listings). The tool must use the SKU above and never one of those.

## How it works

### 1. Watch the inbox

A cron job on the production server (UTC, every 15 minutes) reads Travis's messages through `lib/hushmail.js`, the same IMAP read the press outreach agent uses. It looks at every Hushmail folder, so a message filtered out of the inbox is not missed. Reads never change the mailbox.

### 2. Recognise a shipment email

Each line is matched deterministically against the pattern `<pack name> (<n> cases - <m> units)`. Tolerated:
- an alias list per SKU (e.g. "2-pack", "2 pack", "two pack")
- the typo "unis"
- dash and spacing variants

Quoted reply text is stripped first (`stripQuoted`).

- **No line matches:** the email is ordinary correspondence and is ignored.
- **Some lines match but any one fails:**
  - an unknown pack name,
  - cases × units/case ≠ units, or
  - a line that looks like a shipment line but cannot be read.

  Then **nothing is booked.** The tool replies to Travis (CC Sean) quoting the exact line it could not use and asking him to resend.
- **Every shipment line matches:** the tool continues.

### 3. Claim the email before spending anything

`data/amazon-inbound/state.json` is gitignored and server-owned, and joins the offsite backup set. It records each message by Message-ID with its current step, and the IDs of the plan, shipments and AWD entry it created. The record is written **before** the first create call. A run that finds a record **resumes from its step** and never creates a new plan for that message. The anti-goal "booking the same email twice" depends on this and must be covered by tests, including a crash between create and record.

**A new Message-ID is not proof of a new shipment** (builder check). It is held for Sean, not booked, when:
- it repeats a list already booked within the last 7 days, line for line (a resend or a forward); or
- it reads as a correction ("sorry", "correction", "instead") after a booking.

Sean is told immediately and decides. A resend after a "please resend" reply is the exception: it is expected, so it books. *My call:* a held duplicate costs one email to Sean, while a wrong guess books a second paid shipment.

**Already booked by hand** (Sean, 2026-11-12: "Book the order in my inbox unless it detects the order has been placed already manually"). Before booking, look at FBA inbound plans and AWD inbound shipments created after the email arrived.
- **Every pack's cases covered:** if their combined case counts per SKU cover every line of the email, the order is treated as already placed. Nothing is booked, and Sean gets a note.
- **Partial overlap:** some of those SKUs appear, but not all cases are covered. The message is held for Sean.
- **No overlap:** it books.

This applies to every email, not only the backlog at rollout. The first run therefore handles the 2026-11-12 list by these rules.

An unreadable state file **throws**. It never reads as "nothing processed yet", because that is how every past email would be booked again. This is the same rule `agents/ugc-reels` and `agents/instagram-dm` follow.

### 4. Split FBA / AWD

For each SKU:

1. Daily pace comes from `lib/culina-data.js` (`fetchDailyUnits`, `fetchStock`) and `lib/culina-forecast.js` (`dailyPace`, `forecastUnits`, seasonal index). These are the numbers the monthly Culina report and daily stock alerts already use; the split must not recompute them another way.
2. `need` is the units forecast over the next 30 days, minus FBA fulfillable stock, minus units already inbound to FBA. Units sitting in AWD are not counted: they still have to be moved to FBA.

   **Read FBA stock separately from `fetchStock`** (builder check). That function adds AWD inbound into the same `inbound` figure and aggregates by ASIN, which absorbs the `amzn.gr.*` SKUs. The split instead reads FBA inventory by SKU:
   - "inbound to FBA" = working + shipped + receiving on the FBA side only;
   - AWD-to-FBA replenishment transfers count, because they are FBA inbound shipments already on their way.

   *My call.*
3. Cases to FBA = `ceil(max(0, need) / unitsPerCase)`, capped at the cases Travis has. The remaining cases go to AWD.

*My call:* a SKU with no usable pace (no sales history, or out of stock long enough that pace cannot be read) sends **all** its cases to FBA. Without stock in FBA it cannot sell, so it cannot build a pace either.

### 5. Book the FBA part (Fulfillment Inbound v2024-03-20)

Create the plan from Springville, then:

1. Packing: one SKU per case. Enter case dimensions, weight and units per case from the table.
2. Placement and transport are chosen **together, by lowest TOTAL cost**: placement fee net of discounts, plus the cheapest partnered transport for every shipment that placement creates. This follows from Sean's "unless there is a less expensive way". The cheapest placement fee on its own is often the most-split option, and that can cost more in freight. So transport is quoted for every placement option before any confirm. That means more calls, which is acceptable at this volume. Then confirm the winning placement and its transport choices. A cheaper total that means more shipments and more label sets is accepted.
3. Transport modes considered: partnered small parcel and partnered LTL (see "Pallets"). The ready-to-ship date is the day the email arrived, because Travis writes when the cases are ready. *My call.*
4. Fetch the case labels as PDFs.

Every asynchronous operation is polled until it completes, and its final status is checked before the next step.

### 6. Hand off the AWD part

Email **Sean only**: "Create this AWD shipment in Seller Central (Send to Amazon → AWD), partnered carrier." It lists:
- ship-from
- each SKU with its ASIN, cases, units per case, case size and weight
- a one-line reason for the split, e.g. "6-pack: 14 days of FBA cover, so 4 cases to FBA, 6 to AWD"

On later runs the tool watches AWD inbound shipments (`listInboundShipments`). An AWD shipment created after the handoff email, whose SKUs and case counts match the pending AWD share exactly, is claimed. The tool fetches its labels (`getInboundShipmentLabels`) and emails them to Travis in the original thread, CC Sean.

- **Nothing matches within 3 days:** Sean gets one reminder.
- **It matches only partly** (different counts): the tool does not guess. It tells Sean.

### 7. Reply to Travis

The reply goes in the same thread as Travis's message, CC Sean, with:
- every FBA case label as a PDF attachment, one file per shipment
- per shipment: Amazon shipment ID, destination warehouse, which pack and how many cases go in it, the carrier, and pickup or drop-off instructions
- a line naming the cases held back for AWD, saying their labels follow once that shipment is created

No em dashes in the email body (house rule for copy Sean sends).

### 8. When something fails

Any Amazon or mail failure:
- stops at that step;
- leaves the state record at that step so the next run resumes;
- emails Sean **immediately** (`notify({ immediate: true })`), naming the email, the step, the plan ID and Amazon's error.

It waits on Sean rather than the 5 AM digest, because Travis is waiting on labels and money may already be committed. Travis is not emailed about a failure; Sean decides what to tell him.

Every run that does anything writes one deferred digest row. A run that finds nothing new writes none.

### 9. Running it

Dry by default on the CLI, `--apply` on cron.
- **`--dry-run --text "<message>"`** shows the parse, the split and the cheapest options with fees, without confirming anything.
- **Generated options do cost something:** Amazon creates a draft plan to quote. *My call:* the dry run creates the plan, reads the options, then cancels the plan (`cancelInboundPlan`), and says so. A dry run that only parsed would never test the part that can fail.

Off switch: `config/amazon-inbound.json` `enabled: false`. That file also holds the SKU table above, the aliases, the ship-from, the addresses and the 30-day rule.

## Constraints

- Uses `lib/amazon/sp-api-client.js`. The production refresh token on both machines now carries Amazon Fulfillment, including inbound, verified 2026-11-12.
- SP-API inbound endpoints throttle hard (429 seen at about 1 request/second). Pace calls and back off.
- Cron times in UTC; no `TZ=` prefix (it schedules nothing on this host). Add the job to `scripts/setup-cron.sh` and install it live in the same change.
- The agent uses `isDirectRun`. Pure logic (parse, validate, split, choose cheapest, AWD match) goes in a `lib/` module with tests. I/O stays in the agent.
- `data/amazon-inbound/` is gitignored, server-only, and added to `scripts/backup-snapshots-offsite.sh`. This repo is public, and the email bodies stored there carry a person's correspondence.

## Pallets (LTL)

Sean, 2026-11-12: **"Yes, CMS can handle pallets."** Both partnered small parcel and partnered LTL are therefore quoted, and the cheapest total wins (see step 5).

*My calls, all in `config/amazon-inbound.json`:*
- **Pallet build:** standard 48 × 40 in pallets, cases stacked to at most 60 in total height including the pallet, declared non-stackable. Pallet count and weight per shipment are computed from the case table. A pallet's own weight defaults to 40 lb.
- **Pickup contact:** Travis, travis@traviswales.com, with his own phone number (Sean, 2026-11-12). The number is read from `AMAZON_INBOUND_CONTACT_PHONE` in `.env` on both machines and never committed, because this repo is public. If it is missing, LTL is not quoted and small parcel still runs.
- **Travis is told how to build what was declared.** When LTL wins, the reply states how many pallets per shipment and which cases go on each. It attaches pallet labels and the bill of lading as well as the case labels, so what arrives matches what Amazon was told.

## Left to the builder

- Exact v2024-03-20 call order, polling and request shapes, verified against Amazon's current reference rather than recalled.
- Which label endpoint and page type produces correct partnered-carrier case labels.
- Email layout.
- How "cheapest" handles an option whose fee is not quoted. *My call:* an option with an unquoted fee is never chosen as cheapest. If no option is quoted, stop and tell Sean.
