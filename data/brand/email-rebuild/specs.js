/**
 * Per-email specs. The chrome comes from lib/email-render.js; this file is content only.
 *
 * Format for each flow is decided in data/brand/email-format-matrix.md, not here — the
 * `format` field below is that decision applied, and changing it should mean changing the
 * matrix first.
 *
 * Two standing constraints, both learned the hard way:
 *
 *   1. Never invent a coupon code. `{% coupon_code 'X' %}` requires X to exist in Klaviyo;
 *      a code that doesn't renders a broken offer. Only WINBACK25 (Winback 03) and the
 *      plain-text WELCOMEBACK (Winback 02) exist today.
 *   2. Dynamic product content is only available where the flow's trigger carries it.
 *      Winback and Post-Purchase trigger on Placed Order, so $extra.line_items is
 *      populated — verified against a live payload. Abandoned Cart triggers on Checkout
 *      Started, which carries the same shape. Browse Abandonment carries event.ImageURL
 *      instead, a different structure entirely.
 */

const PDP = 'https://www.realskincare.com/products';
const BEST = 'https://www.realskincare.com/collections/best-sellers';

// The product they actually bought, with a fallback — these emails fire long after the
// order and a discontinued product would otherwise render a broken image.
const boughtHero = `{% with li=event.extra.line_items|first %}
<a href="${PDP}/{{ li.product.handle|default:'coconut-oil-deodorant' }}" style="text-decoration:none;">
{% if li.product.images.0.src %}<img alt="{{ li.product.title }}" src="{{ li.product.images.0.src }}" style="display:block;width:100%;max-width:536px;height:auto;border:0;border-radius:8px;margin:0 0 24px;"/>{% endif %}
</a>
{% endwith %}`;

const boughtLink = (text) => `{% with li=event.extra.line_items|first %}
<table cellpadding="0" cellspacing="0" role="presentation" style="margin:0 0 28px;" width="100%"><tr><td align="center">
<a href="${PDP}/{{ li.product.handle|default:'coconut-oil-deodorant' }}" style="font-family:Outfit,'Helvetica Neue',Helvetica,Arial,sans-serif;font-size:15px;font-weight:600;color:#000000;text-decoration:underline;">${text}</a>
</td></tr></table>
{% endwith %}`;

// The cart, as the three cart templates already render it.
const cartItems = `{% for item in event.extra.line_items %}
<table cellpadding="0" cellspacing="0" role="presentation" width="100%" style="margin:0 0 14px;"><tr>
<td width="72" style="padding-right:14px;">{% if item.product.images.0.src %}<img alt="{{ item.product.title }}" src="{{ item.product.images.0.src }}" width="72" style="display:block;width:72px;height:auto;border:0;border-radius:6px;"/>{% endif %}</td>
<td style="font-family:Outfit,'Helvetica Neue',Helvetica,Arial,sans-serif;font-size:15px;line-height:22px;color:#000000;"><strong>{{ item.product.title }}</strong><br/><span style="font-size:13px;">Qty {{ item.quantity }}</span></td>
</tr></table>
{% endfor %}`;

export const specs = {
  // ---------------------------------------------------------------- Customer Winback
  // Designed and image-led. The matrix argues this explicitly: a winback's two acceptable
  // outcomes are reactivation or a clean unsubscribe, and holding dormant subscribers is
  // itself what damages the domain reputation the reorder emails depend on. So it should
  // look like what it is rather than hide as plain text.

  SHb8Df: {
    name: 'Winback — 01 We Miss You',
    format: 'designed',
    preheader: 'Same ingredients, same formula — and your last order is one tap away.',
    blocks: [
      { type: 'h1', text: "Nothing's changed, which is the point" },
      {
        type: 'p',
        html: 'Hi {{ first_name|default:"there" }} — everything is still handmade in the USA from the same short ingredient list you bought before. No reformulation, no new "improved" version that quietly swapped the coconut oil for something cheaper to ship.',
      },
      { type: 'raw', html: boughtHero },
      {
        type: 'p',
        html: 'That matters more than it sounds. Cold-pressed virgin coconut oil keeps its lauric acid — the part that actually does the work. Refined coconut oil is cheaper, more shelf-stable, and has that stripped out. We still buy the expensive one.',
      },
      { type: 'raw', html: boughtLink('Reorder what you bought last time →') },
      { type: 'signoff' },
      {
        type: 'ps',
        html: 'If you moved on because something did not work for you, reply and tell me — I read these, and it is more useful to me than any survey.',
      },
    ],
  },

  Rt93pZ: {
    name: 'Winback — 02 Free Shipping',
    format: 'designed',
    // WELCOMEBACK is plain text in the live template, not a {% coupon_code %} tag. Kept
    // that way deliberately — promoting it to a tag would require the coupon to exist in
    // Klaviyo, and it does not.
    preheader: 'WELCOMEBACK covers the shipping. No minimum, no expiry games.',
    blocks: [
      { type: 'h1', text: 'Free shipping, no minimum' },
      {
        type: 'p',
        html: 'Use <strong>WELCOMEBACK</strong> at checkout and shipping is on us — on one lip balm or on a full restock, it does not matter which.',
      },
      { type: 'raw', html: boughtHero },
      {
        type: 'p',
        html: 'Normally free shipping starts at $50, which is a real reason to put something off. This removes it.',
      },
      { type: 'raw', html: boughtLink('Use WELCOMEBACK on your last order →') },
      { type: 'signoff' },
      {
        type: 'ps',
        html: 'No minimum and no expiry countdown. If this lands at a bad week, it will still work later.',
      },
    ],
  },

  // ------------------------------------------------------------------ Abandoned Cart
  // Designed but light. The matrix rule: lead with a reminder, never a discount, and hold
  // any discount for the last message. None of the three carries one today and none gains
  // one here — inventing a code would ship a broken offer.

  S5yPYg: {
    name: 'Abandoned Cart — 01 You Left Something',
    format: 'designed',
    preheader: 'Your cart is saved. Nothing expires, nothing is reserved.',
    blocks: [
      { type: 'h1', text: 'Your cart is still here' },
      { type: 'p', html: 'No countdown, no pressure — just a link back to it.' },
      { type: 'raw', html: cartItems },
      { type: 'cta', text: 'Return to my cart', href: '{{ event.extra.checkout_url }}' },
      {
        type: 'p',
        html: 'Orders over $50 ship free, if you were close to it.',
      },
    ],
  },

  RsxMmD: {
    name: 'Abandoned Cart — 02 Still Saved',
    format: 'designed',
    preheader: 'Six ingredients, and a reason for each one.',
    blocks: [
      { type: 'h1', text: 'Still saved, if you want it' },
      {
        type: 'p',
        html: 'The reason this costs more than the drugstore version: baking soda is softer than enamel and neutralises acid, while hydrated silica is harder than enamel and simply abrades it. Silica is cheaper. We use baking soda.',
      },
      { type: 'raw', html: cartItems },
      { type: 'cta', text: 'Complete my order', href: '{{ event.extra.checkout_url }}' },
      {
        type: 'p',
        html: 'Every ingredient is in there because it does something. Nothing is in there to make the label look better or the tube cheaper to fill.',
      },
    ],
  },

  QPwJK2: {
    name: 'Abandoned Cart — 03 Last Call',
    format: 'designed',
    preheader: 'Last reminder on this cart — then we stop.',
    blocks: [
      { type: 'h1', text: 'Last reminder on this one' },
      {
        type: 'p',
        html: 'This is the final email about this cart. We are not going to keep nudging you about it.',
      },
      { type: 'raw', html: cartItems },
      { type: 'cta', text: 'Check out now', href: '{{ event.extra.checkout_url }}' },
      {
        type: 'p',
        html: 'Everything is made in small batches, so the occasional item does go out of stock for a week or two. That is the only real deadline here.',
      },
      { type: 'signoff' },
    ],
  },
};

export const BEST_SELLERS = BEST;
