/**
 * Added to Cart (net-new, 2026-10-05) — trigger: Added to Cart (VieVPL).
 *
 * The existing "Abandoned Cart (RSC v2)" fires on Checkout Started, so it only
 * reaches shoppers who got as far as checkout: 16 recipients in 90 days, while
 * earlier work found ~70% of carts never start checkout. This flow covers the
 * carts in between. Sean approved it 2026-10-05 after confirming an
 * abandoned-checkout flow already exists (it does; this does not replace it).
 *
 * Exits on Checkout Started (Wfyj88) or Placed Order (V69ueg) after flow start,
 * so nobody gets this AND the checkout flow for the same cart. Klaviyo ANDs
 * condition_groups, so the two exits are two groups.
 *
 * The button is a Shopify cart permalink (/cart/<variant>:<qty>), which rebuilds
 * the cart on any device. The event's own URL is the myshopify host and, for a
 * pack, a bare noindexed tier page, so it is never linked. Pack tiers carry no
 * image, so the image renders only when the event has one.
 */
import { shell, H1, P_, SIGN, button, FREESHIP_NOTE } from '../components.js';

const NAME = "{{ event|lookup:'Product Name'|default:'your pick' }}";
const LINK = "https://www.realskincare.com/cart/{{ event.VariantID }}:{{ event.Quantity|default:1 }}";
const IMAGE =
  `{% if event.ImageURL %}<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e6ded1;border-radius:10px;margin:14px 0;"><tr>` +
  `<td width="140" style="padding:12px;"><a href="${LINK}"><img src="{{ event.ImageURL }}" width="120" alt="${NAME}" style="width:120px;max-width:120px;height:auto;border-radius:6px;display:block;"/></a></td>` +
  `<td style="padding:12px 16px 12px 0;font-family:Helvetica,Arial,sans-serif;vertical-align:middle;font-size:16px;font-weight:600;color:#2b2b2b;">${NAME}</td>` +
  `</tr></table>{% endif %}`;
const GUARANTEE = P_('Every order comes with our 30-day refund. If it is not for you, email us and we will refund you. You do not have to send it back.');

export default {
  name: 'Added to Cart (RSC v2)',
  oldFlowId: null,
  triggers: [{ type: 'metric', id: 'VieVPL', trigger_filter: null }],
  profileFilter: {
    condition_groups: [
      { conditions: [{
        type: 'profile-metric', metric_id: 'Wfyj88', measurement: 'count',
        measurement_filter: { type: 'numeric', operator: 'equals', value: 0 },
        timeframe_filter: { type: 'date', operator: 'flow-start' }, metric_filters: null,
      }] },
      { conditions: [{
        type: 'profile-metric', metric_id: 'V69ueg', measurement: 'count',
        measurement_filter: { type: 'numeric', operator: 'equals', value: 0 },
        timeframe_filter: { type: 'date', operator: 'flow-start' }, metric_filters: null,
      }] },
    ],
  },
  entry: 'd1',
  emails: {
    atc_1: {
      name: 'Added to Cart — 01 Still Deciding',
      subject: `Still deciding on ${NAME}?`,
      preview: 'Your pick is one click away.',
      html: shell(
        'Your pick is one click away.',
        H1('Still deciding?') +
        P_(`Hi {{ first_name|default:"there" }}, you added ${NAME} to your cart and did not check out. No pressure. If you have a question about it, just reply. A real person answers, usually me.`) +
        IMAGE +
        button(LINK, 'Finish my order') +
        GUARANTEE +
        SIGN,
      ),
    },
    atc_2: {
      name: 'Added to Cart — 02 One More Thing',
      subject: 'A quick note on your cart',
      preview: 'Orders over $45 ship free.',
      html: shell(
        'Orders over $45 ship free.',
        H1('One more thing') +
        P_(`If cost is what stopped you: orders over $45 ship free, and most of our products come in packs that cost less per item.`) +
        IMAGE +
        button(LINK, 'Finish my order') +
        FREESHIP_NOTE +
        SIGN,
      ),
    },
  },
  actions(msg, { send, delay }, sendStatus) {
    return [
      delay('d1', 3, 'hours', 'e1'),
      send('e1', msg('atc_1'), 'd2', sendStatus),
      delay('d2', 1, 'days', 'e2'),
      send('e2', msg('atc_2'), null, sendStatus),
    ];
  },
};
