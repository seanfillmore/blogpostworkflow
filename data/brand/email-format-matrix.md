# Email format matrix

Which format each flow's emails take, and why. Derived from the skills — this file is
the applied answer for Real Skin Care's eight live flows, not new doctrine.

The governing rule is `marketing-email-design-production` §6: **format follows the
email's job.** Designed and image-led for promotional campaigns; plain-text and
link-light for education, onboarding and reorder nudges; mobile-first always; one ask
per objective, at most two destinations.

Why it matters mechanically: inbox providers classify heavily designed, link-dense,
promotion-worded mail as promotional. Styling an education email like a sale pushes it
out of the primary tab — which is exactly where a transition-period explanation has to
land to prevent the churn it exists to prevent.

## The matrix

| Flow | Job | Format | Skeleton | Non-obvious constraint |
|---|---|---|---|---|
| **Customer Winback** | Reactivate or cleanly lose a 6+ month lapsed buyer | **Designed, image-led** | Full: preheader, headline, hero, primary CTA, body, secondary CTA, footer CTA | Unsubscribe **prominent, not buried**. The spike is the point — see below. |
| **Abandoned Cart** | Resume a purchase that already stalled | **Designed, light** | Preheader, headline, cart items, one CTA, body, footer | Lead with a reminder, **not** a discount. Hold any discount for the last message. |
| **Browse Abandonment** | Re-surface a product they looked at | **Designed, light** | As above, product imagery carrying it | Same discount discipline as cart. |
| **Welcome — 01 (incentive)** | Hand over FIRST20 without losing them | **Plain-text lean** | Preheader, headline, body, reward near the end, footer | **Resell before reward** — tease what's coming, deliver the incentive last. Leading with it spends the attention you needed. |
| **Welcome — 02, 04 (story/USP)** | Educate, build belief | **Plain-text, link-light** | Preheader, headline, body, one CTA, footer | Education styled as promo lands in the promotions tab. |
| **Welcome — 03, 05 (best sellers / last chance)** | Sell | **Designed, image-led** | Full skeleton | Product imagery from the PDP URL, not hand-exported. |
| **Post-Purchase — 01, 02, 04** | Onboard, get to first visible result | **Plain-text, link-light** | Preheader, headline, body, one CTA, footer | This is the churn-prevention surface. Primary-tab placement matters more than polish. |
| **Post-Purchase — 03, 05 (routine / restock)** | Cross-sell, reorder | **Designed, light** | Preheader, headline, product, one CTA, footer | Reorder nudge — closer to plain than a campaign. |
| **Replenishment** | Reorder before they run out | **Plain-text, link-light** | Preheader, headline, body, one CTA, footer | §6 names reorder nudges explicitly as the plain case. |
| **Product Review / Cross-Sell** | Request a review, then cross-sell | **Plain for the ask, designed for the cross-sell** | Split: personal ask first, product block second | Review request must read as a person asking. See the review-request rules — never gate by rating, never incentivise. |
| **Coconut Reset — Digital Delivery** | Deliver a purchased asset | **Plain, functional** | Minimal: headline, link, body, footer | **Transactional.** Promo styling risks the promotions tab, and a paying customer not receiving what they bought is the worst failure on this list. |

## Winback: why designed, despite the audience being cold

The intuitive call is to style a winback plainly so it reaches the primary inbox of
people who have ignored you for six months. That is wrong here, for a reason worth
writing down:

`marketing-email-list-health` records that an abnormally high unsubscribe rate on the
first send after a long silence is **pulled-forward churn, not a signal to stop** —
subscribers who would have drifted off over months all churn at once. And holding
dormant, disengaged subscribers is *itself* what damages domain reputation, which
decides whether the reorder and transition-period emails reach the primary inbox at all.

So a winback has two acceptable outcomes: reactivation, or a clean unsubscribe. Both
improve the list. That removes the reason to design defensively — it should look like
what it is, a promotional offer.

The one real risk is **spam complaints**, not unsubscribes, because a handful on a
sub-1,000-subscriber list measurably hurts placement. The mitigation is making the
unsubscribe easy to find rather than burying it, which is why it is called out as a
constraint above.

## What this file is not

It does not say what the emails should *say*. Copy angle comes from
`marketing-conversion-copy-angles`, `marketing-copy-hooks-and-formats`,
`marketing-copy-credibility-and-proof` and `marketing-awareness-level-messaging`; the offer
itself from `marketing-retention-offers` and `marketing-offer-construction`; proof
selection from `marketing-review-mining`. This is the format layer only.
