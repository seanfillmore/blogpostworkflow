/**
 * Abandoned Cart (rebuild) — trigger: Checkout Started (Wfyj88).
 * Dynamic cart line-items WITH product images + the Shopify recovery checkout URL
 * ({{ event.extra.checkout_url }}); free-ship framing (no discount, per strategy);
 * a 3rd touch added; preserves the old profile filter (excludes recent purchasers
 * + not-in-flow-7-days).
 */
import { shell, H1, P_, SIGN, button, FREE_SHIP } from '../components.js';

const CHECKOUT = '{{ event.extra.checkout_url }}';

// Dynamic cart items with images (Checkout Started line_items shape).
const cartItems =
  `{% for item in event.extra.line_items %}` +
  `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e6ded1;border-radius:8px;margin:8px 0;"><tr>` +
    `<td width="92" style="padding:10px;"><a href="${CHECKOUT}"><img src="{{ item.product.images.0.src }}" width="72" alt="{{ item.product.title }}" style="width:72px;height:auto;border-radius:6px;display:block;"/></a></td>` +
    `<td style="padding:10px 14px 10px 0;font-family:Helvetica,Arial,sans-serif;vertical-align:middle;">` +
      `<a href="${CHECKOUT}" style="font-size:15px;font-weight:600;color:#2b2b2b;text-decoration:none;">{{ item.product.title }}</a>` +
      `<div style="font-size:13px;color:#6b6b6b;margin-top:3px;">Qty: {{ item.quantity }}</div>` +
    `</td></tr></table>` +
  `{% endfor %}`;

const freeShipLine = P_(`Orders over ${FREE_SHIP} ship free — add one more favorite and it's on us.`);

export default {
  name: 'Abandoned Cart (RSC v2)',
  oldFlowId: 'SVn26v',
  entry: 'd1',
  emails: {
    cart_1: {
      name: 'Abandoned Cart — 01 You Left Something',
      subject: 'You left something behind, {{ first_name|default:"there" }} 🌿',
      preview: 'We saved your cart — pick up right where you left off.',
      html: shell(
        'We saved your cart — pick up right where you left off.',
        H1('You left something behind') +
        P_('No worries — we saved your cart. Whenever you\'re ready, you\'re one click from finishing up.') +
        cartItems +
        button(CHECKOUT, 'Return to my cart') +
        freeShipLine,
      ),
    },
    cart_2: {
      name: 'Abandoned Cart — 02 Still Saved',
      subject: 'Still saved for you',
      preview: 'Your clean skincare is waiting — free shipping over $50.',
      html: shell(
        'Your clean skincare is waiting — free shipping over $50.',
        H1('Still thinking it over?') +
        P_('Your cart is still here. Everything we make is handmade in the USA from a short list of clean, coconut-oil ingredients — no fillers, no junk. Worth finishing up.') +
        cartItems +
        button(CHECKOUT, 'Complete my order') +
        freeShipLine,
      ),
    },
    cart_3: {
      name: 'Abandoned Cart — 03 Last Call',
      subject: 'Last call — your cart is about to expire',
      preview: 'Grab your items before they\'re gone.',
      html: shell(
        'Grab your items before they\'re gone.',
        H1('Last call on your cart') +
        P_('This is the final reminder — carts don\'t stay saved forever, and popular items sell out. If you still want these, now\'s the moment.') +
        cartItems +
        button(CHECKOUT, 'Check out now') +
        freeShipLine +
        SIGN,
      ),
    },
  },
  actions(msg, { send, delay }, sendStatus) {
    return [
      delay('d1', 4, 'hours', 'e1'),
      send('e1', msg('cart_1'), 'd2', sendStatus),
      delay('d2', 1, 'days', 'e2'),
      send('e2', msg('cart_2'), 'd3', sendStatus),
      delay('d3', 2, 'days', 'e3'),
      send('e3', msg('cart_3'), null, sendStatus),
    ];
  },
};
