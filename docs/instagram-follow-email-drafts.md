# Instagram follow: email block + one-off campaign (DRAFTS, nothing live)

Goal: turn customers and engaged subscribers into followers of
[@realskincare_com](https://www.instagram.com/realskincare_com/).

Status: **draft copy for Sean's review. Nothing in Klaviyo or Shopify was changed, sent or scheduled.**
Everything below was gathered with read-only API calls on 2026-11-04.

## 1. What exists today (read-only findings)

### Post-purchase flow emails (Klaviyo)

Flow **`V4U4Qn` "Post-Purchase Flow (RSC v2)"**, live, triggered by Placed Order.

| action id | message id | email | subject |
|---|---|---|---|
| 112411003 | SDt8Hg | 01 Thank You | Thank you, {{ first_name }} |
| 112411005 | TNRXB8 | 02 How To Use It (dynamic) | Getting the most from your order |
| 112411007 | TbQUYv | 03 Complete Your Routine (Set) | Complete your routine (and ship free) |
| 112411010 | UmfKSm | 04 Review + Referral | How's it going, {{ first_name }}? |
| 112411013 | Xj6ugG | 05 Restock Reorder | Running low? Restock in one click |

Every one of these already carries a small text link to Instagram in the footer
(`X · Instagram · Facebook`), rendered by `lib/email-render.js`. Nobody notices a
footer link, so the proposal is a visible block in the body, not a second link.

**Recommended: add the block to `01 Thank You` (SDt8Hg) and `02 How To Use It` (TNRXB8).**
01 arrives an hour after purchase and is the most-opened email a customer gets; 02 is
the "how to use it" email, which is exactly what the how-to carousels are. Leave 03 to 05
alone so each of those keeps one job (cross-sell, review, reorder).

Other post-purchase-adjacent live flows, not proposed for this change:
`Ud6YUF` Product Review / Cross-Sell (Fulfilled Order + 14 days), `UxEXm9` Replenishment,
`XFdcu6` Coconut Reset digital delivery.

How to ship it later (when approved): edit the spec in `data/brand/email-rebuild/specs.js`,
`node scripts/build-emails.mjs`, then `scripts/klaviyo-push-flow-template.mjs` (dry by
default; creates a library template and repoints the flow action through
`PATCH /api/flow-actions/{id}` on revision 2026-07-15).

### Shipping confirmation: sent by SHOPIFY, not Klaviyo

No Klaviyo flow triggers on `Confirmed Shipment`, `Fulfilled Order` (except the review
flow, 14 days later), `Marked Out for Delivery` or `Delivered Shipment`. Those metrics
exist in Klaviyo only because the Shopify integration syncs them. The email a customer
gets with tracking is Shopify's native **Shipping confirmation** notification
(Admin: Settings > Notifications > Customer notifications > Shipping confirmation).
Shopify's Admin API does not expose notification templates, so this edit is a paste in
the admin UI. It is a transactional email, so the block must stay short and below the
tracking information.

### Audiences for the one-off campaign

| id | name | members | can receive email now |
|---|---|--:|--:|
| `S6hKFq` | Email List (list) | 717 | 531 |
| `UAPGjf` | Purchasers - Klaviyo List (segment) | 506 | 471 |
| **union of the two** | | | **671 distinct** |
| `RAwmtt` | Giveaway 2026-09 Engaged (segment) | 2,466 | **1** |

`RAwmtt` is no longer usable: 2,063 of its members are user-suppressed (the post-giveaway
prune) and 401 unsubscribed. It must not be un-suppressed (the one-time exception is
already used). The disqualified bot cohort sits on `UigAyc` and is suppressed as well.

**Recommended audience: `S6hKFq` Email List + `UAPGjf` Purchasers, Smart Sending on,
about 671 people who opted in to email.** Exclude `UigAyc` as belt and braces.
This mix includes subscribers who have never ordered, which is why the $10 line below is
written as "have not ordered yet?".

## 2. Drafts

All strings passed `checkSeoCopyFields` from `lib/seo-copy-health-gate.js` on the default
commercial surface: **19 strings, 0 blocking, 0 advisory.** No em or en dashes, no
"antiperspirant", no whitening, no condition names. (Control check: the gate does block
"Our lotion heals eczema", so it was armed.)

### 2a. Instagram block for post-purchase emails 01 and 02

Plain text:

> **Come say hi on Instagram**
> We post quick how-tos (like switching to an aluminum-free deodorant, or what is actually in your toothpaste), real reviews from customers, and a new creator video every day. Come follow along.
> [Follow @realskincare_com](https://www.instagram.com/realskincare_com/)

HTML (matches the live template: Cabin headings, Outfit body, black on white card,
`#EDEDED` divider). Goes inside the white card, just above the sign-off:

```html
<table cellpadding="0" cellspacing="0" role="presentation" width="100%" style="margin:8px 0 20px;border-top:1px solid #EDEDED;">
<tr><td style="padding-top:18px;">
<p style="margin:0 0 6px;font-family:Cabin,'Trebuchet MS','Segoe UI',Tahoma,sans-serif;font-size:18px;line-height:24px;font-weight:700;color:#000000;">Come say hi on Instagram</p>
<p style="margin:0 0 14px;font-family:Outfit,'Helvetica Neue',Helvetica,Arial,sans-serif;font-size:16px;line-height:24px;color:#000000;">We post quick how-tos (like switching to an aluminum-free deodorant, or what is actually in your toothpaste), real reviews from customers, and a new creator video every day. Come follow along.</p>
<a href="https://www.instagram.com/realskincare_com/" style="display:inline-block;padding:12px 22px;background-color:#000000;color:#FFFFFF;border-radius:8px;font-family:Outfit,'Helvetica Neue',Helvetica,Arial,sans-serif;font-size:15px;font-weight:700;text-decoration:none;">Follow @realskincare_com</a>
</td></tr>
</table>
```

### 2b. Shopify Shipping confirmation block

Plain text:

> While your order is on its way: we post quick how-tos, real customer reviews and a new creator video every day on Instagram. Follow along at @realskincare_com.
> [Follow us on Instagram](https://www.instagram.com/realskincare_com/)

HTML (paste below the tracking button / line items in the Shopify notification template;
inline styles only, so it inherits nothing from the Shopify template):

```html
<p style="margin:24px 0 8px;font-size:15px;line-height:22px;color:#000000;">While your order is on its way: we post quick how-tos, real customer reviews and a new creator video every day on Instagram. Follow along at @realskincare_com.</p>
<p style="margin:0 0 24px;"><a href="https://www.instagram.com/realskincare_com/" style="color:#000000;font-weight:700;text-decoration:underline;">Follow us on Instagram</a></p>
```

### 2c. One-off campaign

**Subject options**
1. Our Instagram is worth a follow now
2. What is actually in your toothpaste?
3. A one-minute guide to switching deodorants

**Preview text:** Quick how-tos, real reviews and a new creator video every day.

**Body (plain text)**

> **Come follow along on Instagram**
>
> Hi {{ first_name|default:"there" }}, quick one from me. We have been putting real work into our Instagram lately, and I think it is genuinely worth a follow. Here is what you will find there:
>
> - Short how-tos you can read in a minute: how to switch to an aluminum-free deodorant without quitting in week one, what is actually in your toothpaste, and why we leave SLS out of ours.
> - Real reviews from customers, in their own words.
> - A new video every day from one of our creators, showing how they use our products in real life.
> - And the occasional post that is just about everyday life.
>
> [Follow @realskincare_com](https://www.instagram.com/realskincare_com/)
>
> Have not ordered from us yet? Send us a DM on Instagram with the word "Natural" and we will send you $10 off your first order.
>
> Take care,
> **Sean**
> Co-Founder, Real Skin Care
>
> PS: If you have a question about anything we make, you can ask it there too. I read the messages.

The $10 line is the real offer on the Instagram bio (Sean confirmed it is live and
answered). It is included only because the audience contains subscribers who have not
ordered. Drop it if the send is narrowed to purchasers only.

**Body (HTML, for the white card of the standard template; footer and
`{% unsubscribe_link %}` come from `lib/email-render.js` as usual)**

```html
<h1 class="h1" style="margin:0 0 12px;font-family:Cabin,'Trebuchet MS','Segoe UI',Tahoma,sans-serif;font-size:28px;line-height:34px;font-weight:700;color:#000000;">Come follow along on Instagram</h1>
<p style="margin:0 0 16px;font-family:Outfit,'Helvetica Neue',Helvetica,Arial,sans-serif;font-size:16px;line-height:24px;color:#000000;">Hi {{ first_name|default:'there' }}, quick one from me. We have been putting real work into our Instagram lately, and I think it is genuinely worth a follow. Here is what you will find there:</p>
<ul style="margin:0 0 20px;padding-left:20px;font-family:Outfit,'Helvetica Neue',Helvetica,Arial,sans-serif;font-size:16px;line-height:24px;color:#000000;">
<li style="margin:0 0 8px;">Short how-tos you can read in a minute: how to switch to an aluminum-free deodorant without quitting in week one, what is actually in your toothpaste, and why we leave SLS out of ours.</li>
<li style="margin:0 0 8px;">Real reviews from customers, in their own words.</li>
<li style="margin:0 0 8px;">A new video every day from one of our creators, showing how they use our products in real life.</li>
<li style="margin:0;">And the occasional post that is just about everyday life.</li>
</ul>
<p style="margin:0 0 24px;text-align:center;"><a href="https://www.instagram.com/realskincare_com/" style="display:inline-block;padding:14px 26px;background-color:#000000;color:#FFFFFF;border-radius:8px;font-family:Outfit,'Helvetica Neue',Helvetica,Arial,sans-serif;font-size:16px;font-weight:700;text-decoration:none;">Follow @realskincare_com</a></p>
<p style="margin:0 0 16px;font-family:Outfit,'Helvetica Neue',Helvetica,Arial,sans-serif;font-size:16px;line-height:24px;color:#000000;">Have not ordered from us yet? Send us a DM on Instagram with the word "Natural" and we will send you $10 off your first order.</p>
<p style="margin:0 0 6px;font-family:Outfit,'Helvetica Neue',Helvetica,Arial,sans-serif;font-size:16px;line-height:24px;color:#000000;">Take care,<br/><strong>Sean</strong><br/><span style="font-size:14px;">Co-Founder, Real Skin Care</span></p>
<p style="margin:20px 0 0;padding-top:18px;border-top:1px solid #EDEDED;font-family:Outfit,'Helvetica Neue',Helvetica,Arial,sans-serif;font-size:15px;line-height:23px;color:#000000;"><strong>PS:</strong> If you have a question about anything we make, you can ask it there too. I read the messages.</p>
```

## 3. Side finding, not acted on

The live `01 Thank You` email (template `UrT2dK`) already contains em dashes in its
heading, greeting and unsubscribe line ("Thank you — and one thing to expect"). If the
block is added to that email, the rebuild is a natural moment to remove them too.

## 4. Decisions for Sean

1. Approve the block copy, and which emails get it (recommended: Post-Purchase 01 and 02).
2. Approve the Shopify Shipping confirmation line (pasted in Shopify admin).
3. Pick a subject line, and approve sending to Email List + Purchasers (~671).
4. Keep or drop the $10 "Natural" DM line in the campaign.
