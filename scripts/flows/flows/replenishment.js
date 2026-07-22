/**
 * Replenishment (net-new) — trigger: Placed Order (V69ueg).
 * Fills the gap between Review (day 14) and Winback (day 75). Nudges one-time
 * buyers to re-purchase, preferentially via Subscribe & Save.
 *   E1 (35d)  no coupon — subscribe-first + one-time reorder
 *   E2 (+15d) subscribe hero + RESTOCK10 (10% one-time) fallback
 * Profile filter exits anyone who reorders after flow start (same shape as Winback).
 */
import { shell, H1, P_, SIGN, button, codeBox, P } from '../components.js';

const FLEX = P_('Skip, pause, swap scent, or cancel anytime from your account.');
const PROD = '{{ event.Items|first|default:"your Real Skin Care favorites" }}';

// CTA that links to the PDP of whatever the customer actually bought (falls back to
// best-sellers). Klaviyo's template engine has no confirmed `{% elif %}` support anywhere
// else in this codebase (see product-review.js), so mutual exclusivity is emulated with
// nested {% if %}/{% else %}/{% endif %} rather than {% elif %}.
const pdpButton = (label) =>
  `{% with items=event.Items|join:", " %}` +
  `{% if "Deodorant" in items %}` + button(P.deodorant.url, label) +
  `{% else %}{% if "Toothpaste" in items %}` + button(P.toothpaste.url, label) +
  `{% else %}{% if "Moisturiz" in items %}` + button(P.moisturizer.url, label) +
  `{% else %}{% if "Lotion" in items %}` + button(P.lotion.url, label) +
  `{% else %}{% if "Soap" in items %}` + button(P.barsoap.url, label) +
  `{% else %}{% if "Lip" in items %}` + button(P.lipbalm.url, label) +
  `{% else %}` + button(P.bestSellers.url, label) +
  `{% endif %}{% endif %}{% endif %}{% endif %}{% endif %}{% endif %}` +
  `{% endwith %}`;

export default {
  name: 'Replenishment (RSC v2)',
  oldFlowId: null,
  triggers: [{ type: 'metric', id: 'V69ueg', trigger_filter: null }],
  profileFilter: {
    condition_groups: [{
      conditions: [{
        type: 'profile-metric', metric_id: 'V69ueg', measurement: 'count',
        measurement_filter: { type: 'numeric', operator: 'equals', value: 0 },
        timeframe_filter: { type: 'date', operator: 'flow-start' }, metric_filters: null,
      }],
    }],
  },
  entry: 'd1',
  emails: {
    replenish_1: {
      name: 'Replenishment — 01 Running Low',
      subject: `Running low on ${PROD}?`,
      preview: 'Most folks are getting low around now — the easy way to restock.',
      html: shell(
        'Most folks are getting low around now — the easy way to restock.',
        H1('Running low?') +
        P_(`Hi {{ first_name|default:"there" }}, you picked up ${PROD} about five weeks ago — right around when most folks start running low.`) +
        P_('The easiest way to never run out? <strong>Subscribe &amp; Save — 15% off every order</strong>, delivered every 6&ndash;8 weeks to match how fast you actually use it.') +
        FLEX +
        pdpButton('Subscribe & Save 15%') +
        P_('Prefer to grab it just once?') +
        pdpButton('Reorder just once') +
        SIGN,
      ),
    },
    replenish_2: {
      name: 'Replenishment — 02 Never Run Out',
      subject: `Never run out of ${PROD} 🥥`,
      preview: 'Your favorite is probably empty by now — here are two easy ways to restock.',
      html: shell(
        'Your favorite is probably empty by now — here are two easy ways to restock.',
        H1('Never run out again') +
        P_(`Hi {{ first_name|default:"there" }}, your ${PROD} is probably running empty about now.`) +
        P_('Subscribe &amp; Save is the no-brainer: <strong>15% off every order</strong>, delivered every 6&ndash;8 weeks.') +
        FLEX +
        pdpButton('Subscribe & Save 15%') +
        P_('Not ready to subscribe? Here&rsquo;s <strong>10% off a one-time restock</strong>:') +
        codeBox('10% off your restock', 'RESTOCK10') +
        pdpButton('Reorder once') +
        SIGN,
      ),
    },
  },
  actions(msg, { send, delay }, sendStatus) {
    return [
      delay('d1', 35, 'days', 'e1'),
      send('e1', msg('replenish_1'), 'd2', sendStatus),
      delay('d2', 15, 'days', 'e2'),
      send('e2', msg('replenish_2'), null, sendStatus),
    ];
  },
};
