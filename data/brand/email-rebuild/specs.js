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

import { readFileSync } from 'node:fs';

// Free-shipping threshold. brand-kit.json owns it — it moved from $50 to $45 on
// 2026-07-31 and appears in six of these emails, so it is interpolated, never retyped.
const SHIP = JSON.parse(
  readFileSync(new URL('../brand-kit.json', import.meta.url), 'utf8'),
).free_shipping_threshold;

const KIT_SUB = JSON.parse(
  readFileSync(new URL('../brand-kit.json', import.meta.url), 'utf8'),
).subscription;

// Prices and variant IDs come from the live storefront via
// scripts/build-product-catalog.mjs. A lip balm price of $8 was invented here and reached
// a live email; it is $15. Variant IDs are worse — a wrong one adds the wrong product to
// someone's cart. Never type either from memory.
const CATALOG = JSON.parse(
  readFileSync(new URL('../product-catalog.json', import.meta.url), 'utf8'),
).products;

const price = (handle) => {
  const p = CATALOG[handle];
  if (!p) throw new Error(`no catalog entry for ${handle} — run build-product-catalog.mjs`);
  // priceLabel, not price — the raw number renders "$46.8" for a $46.80 product.
  if (!p.priceLabel) throw new Error(`${handle} has no priceLabel — regenerate the catalog`);
  return p.priceLabel;
};
// Bundle savings, for the multipack placements added 2026-08-30. THROWS rather than
// degrading to no saving: a bundle whose whole argument is "cheaper per unit" and which
// renders without the number is a worse email than one that fails to build. Regenerate
// the catalog if this fires — the storefront is the source, never a typed number.
const savings = (handle) => {
  const p = CATALOG[handle];
  if (!p) throw new Error(`no catalog entry for ${handle} — run build-product-catalog.mjs`);
  if (!p.savingsLabel) throw new Error(`${handle} has no savingsLabel — is it actually discounted?`);
  return p.savingsLabel;
};
const variant = (handle) => {
  const p = CATALOG[handle];
  if (!p) throw new Error(`no catalog entry for ${handle} — run build-product-catalog.mjs`);
  return p.defaultVariantId;
};

const PDP = 'https://www.realskincare.com/products';
const BEST = 'https://www.realskincare.com/collections/best-sellers';
// The Sets & Bundles collection — a SMART collection on tag "bundle", holding all 11
// live bundles. Added here 2026-08-30 with the first bundle placements in any flow.
const BUNDLES = 'https://www.realskincare.com/collections/sets-and-bundles';

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

/**
 * A product row: name, price, one line of why, and a link.
 *
 * Deliberately text-and-link rather than an image card. The only product image URLs we
 * have verified are the deodorant hero and the lotion; inventing CDN paths for the rest
 * would ship broken images, and a missing image in an email cannot be fixed after send.
 * Where a real image is available it comes from the event payload instead.
 */
const productRow = (name, price, why, href) => `<table cellpadding="0" cellspacing="0" role="presentation" width="100%" style="margin:0 0 14px;border-top:1px solid #EDEDED;padding-top:14px;"><tr><td>
<a href="${href}" style="font-family:Outfit,'Helvetica Neue',Helvetica,Arial,sans-serif;font-size:16px;font-weight:600;color:#000000;text-decoration:none;">${name} — ${price}</a>
<div style="font-family:Outfit,'Helvetica Neue',Helvetica,Arial,sans-serif;font-size:14px;line-height:21px;color:#000000;margin-top:2px;">${why}</div>
</td></tr></table>`;

// A plain-text code block. These codes are hardcoded strings in the live templates, not
// {% coupon_code %} tags — promoting them to tags would require the coupons to exist in
// Klaviyo under those names, and they do not.
const codeBlock = (label, code) => `<table cellpadding="0" cellspacing="0" role="presentation" style="margin:0 0 24px;" width="100%"><tr><td align="center">
<table cellpadding="0" cellspacing="0" role="presentation"><tr><td style="border:2px dashed #AEDEAC;border-radius:10px;padding:14px 34px;text-align:center;">
<div style="font-family:Outfit,'Helvetica Neue',Helvetica,Arial,sans-serif;font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#000000;">${label}</div>
<div style="font-family:Cabin,'Trebuchet MS','Segoe UI',Tahoma,sans-serif;font-size:24px;letter-spacing:4px;color:#000000;font-weight:700;margin-top:4px;">${code}</div>
</td></tr></table></td></tr></table>`;

// Opens the per-category conditional used by the Post-Purchase and Replenishment flows.
const ITEMS_OPEN = '{% with items=event.Items|join:", " %}';
const ITEMS_CLOSE = '{% endwith %}';

const ANY_CATEGORY = '"Deodorant" in items or "Toothpaste" in items or "Soap" in items '
  + 'or "Lotion" in items or "Coconut Moisturizer" in items or "Lip" in items';

/**
 * Per-category content with a mandatory fallback.
 *
 * The outer if/else is not decoration. Without it, an order whose items match none of the
 * category strings — a bundle named differently, a gift card, a new SKU — renders the
 * section completely empty, and the customer gets an email with a hole in it. The live
 * templates all had this guard; a first pass at these rebuilds dropped it, and the tag
 * check is what caught it.
 */
const byCategory = (inner, fallback) =>
  `${ITEMS_OPEN}{% if ${ANY_CATEGORY} %}\n${inner}\n{% else %}\n${fallback}\n{% endif %}${ITEMS_CLOSE}`;

// Shopify add-to-cart permalink. The variant IDs are copied verbatim from the live
// template — a wrong ID silently adds the wrong product to someone's cart.
const cartButton = (label, variantId) => `<table cellpadding="0" cellspacing="0" role="presentation" style="margin:0 0 14px;" width="100%"><tr><td align="center" bgcolor="#000000" style="border-radius:6px;">
<a href="https://www.realskincare.com/cart/${variantId}:1" style="display:inline-block;padding:14px 28px;font-family:Outfit,'Helvetica Neue',Helvetica,Arial,sans-serif;font-size:15px;font-weight:600;color:#FFFFFF;text-decoration:none;border-radius:6px;">${label}</a>
</td></tr></table>`;

// Outlined rather than solid black. Six solid buttons would each shout as loudly as the
// primary reorder above them, which is the opposite of the hierarchy this email needs.
const secondaryButton = (label, variantId) => `<table cellpadding="0" cellspacing="0" role="presentation" style="margin:0 0 10px;" width="100%"><tr><td align="center" style="border:1px solid #000000;border-radius:6px;">
<a href="https://www.realskincare.com/cart/${variantId}:1" style="display:block;padding:13px 20px;font-family:Outfit,'Helvetica Neue',Helvetica,Arial,sans-serif;font-size:15px;font-weight:600;color:#000000;text-decoration:none;">${label}</a>
</td></tr></table>`;

const reviewLink = (name, handle) => `<table cellpadding="0" cellspacing="0" role="presentation" style="margin:0 0 20px;" width="100%"><tr><td align="center">
<a href="${'https://www.realskincare.com/products'}/${handle}#reviews" style="font-family:Outfit,'Helvetica Neue',Helvetica,Arial,sans-serif;font-size:15px;font-weight:600;color:#000000;text-decoration:underline;">Review your ${name} →</a>
</td></tr></table>`;

/**
 * Routes the reorder CTA to the product they actually bought.
 *
 * A first pass replaced this whole conditional with one generic "shop best sellers"
 * link. That defeats the email: a replenishment nudge exists to make reordering *their*
 * item a single tap, and a collection page puts the search back on the customer.
 */
/**
 * Shows the two refill cadences side by side.
 *
 * The emails described a discount that varies by frequency but rendered one identical
 * button either way, so the difference the copy promised was invisible. Recurpay has no
 * per-cadence deep link, so the choice is made on the PDP — the email's job is to make
 * the trade-off legible before they get there.
 *
 * Figures come from brand-kit.json and are flagged UNVERIFIED there.
 */
const cadenceTable = () => {
  const [fast, slow] = KIT_SUB.cadence_weeks;
  const cell = (weeks, who) => `<td width="50%" style="padding:14px;border:1px solid #EDEDED;border-radius:8px;text-align:center;font-family:Outfit,'Helvetica Neue',Helvetica,Arial,sans-serif;color:#000000;">
<div style="font-size:22px;font-weight:700;">Every ${weeks} weeks</div>
<div style="font-size:12px;margin-top:6px;">${who}</div>
</td>`;
  return `<table cellpadding="0" cellspacing="0" role="presentation" width="100%" style="margin:0 0 10px;"><tr><td align="center" style="padding:12px;border:2px dashed #AEDEAC;border-radius:10px;font-family:Cabin,'Trebuchet MS','Segoe UI',Tahoma,sans-serif;font-size:20px;font-weight:700;color:#000000;">
${KIT_SUB.discount_pct}% off every refill, either way
</td></tr></table>
<table cellpadding="0" cellspacing="6" role="presentation" width="100%" style="margin:0 0 20px;"><tr>
${cell(fast, 'Most people')}
${cell(slow, 'If it lasts you longer')}
</tr></table>`;
};

const subscribeLinks = () => byCategory(
  ['Deodorant:coconut-oil-deodorant', 'Toothpaste:coconut-oil-toothpaste', 'Soap:coconut-soap',
    'Coconut Moisturizer:coconut-moisturizer', 'Lotion:coconut-lotion', 'Lip:coconut-oil-lip-balm']
    .map((pair) => {
      const [key, handle] = pair.split(':');
      return `{% if "${key}" in items %}<table cellpadding="0" cellspacing="0" role="presentation" style="margin:0 0 14px;" width="100%"><tr><td align="center" bgcolor="#000000" style="border-radius:6px;"><a href="https://www.realskincare.com/products/${handle}" style="display:inline-block;padding:14px 28px;font-family:Outfit,'Helvetica Neue',Helvetica,Arial,sans-serif;font-size:15px;font-weight:600;color:#FFFFFF;text-decoration:none;border-radius:6px;">Reorder or set up a refill</a></td></tr></table>{% endif %}`;
    }).join('\n'),
  `<table cellpadding="0" cellspacing="0" role="presentation" style="margin:0 0 14px;" width="100%"><tr><td align="center" bgcolor="#000000" style="border-radius:6px;"><a href="${BEST}" style="display:inline-block;padding:14px 28px;font-family:Outfit,'Helvetica Neue',Helvetica,Arial,sans-serif;font-size:15px;font-weight:600;color:#FFFFFF;text-decoration:none;border-radius:6px;">Reorder or set up a refill</a></td></tr></table>`,
);

const para = (html) =>
  `<p style="margin:0 0 16px;font-family:Outfit,'Helvetica Neue',Helvetica,Arial,sans-serif;font-size:16px;line-height:24px;color:#000000;">${html}</p>`;

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
      // A lapsed buyer needs a reason to come back that is bigger than the one thing they
      // stopped buying. The Clean Swap is that without being a big ask — the $87
      // Head-to-Toe and $144 90-Day are further than a cold winback should reach.
      {
        type: 'raw',
        html: productRow('The Clean Swap', price('clean-swap'), `Or replace more than one thing this time — save ${savings('clean-swap')} against buying them singly.`, `${PDP}/clean-swap`),
      },
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
        html: `Normally free shipping starts at $${SHIP}, which is a real reason to put something off. This removes it.`,
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
        html: `Orders over $${SHIP} ship free, if you were close to it.`,
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

  // ------------------------------------------------------------------- Welcome Series
  // 01 is plain-text lean and follows the resell-before-reward rule: tease what is
  // coming, hand over the incentive last. Leading with the code spends the attention you
  // needed. 02 and 04 are education — plain and link-light, because education styled as
  // promo lands in the promotions tab. 03 and 05 sell, so they are designed.

  W5ySJc: {
    name: 'Welcome — 01 Welcome + Free Shipping',
    format: 'plain',
    preheader: 'Six ingredients, and a reason for each one. Your shipping is covered.',
    blocks: [
      { type: 'h1', text: 'What you just signed up for' },
      {
        type: 'p',
        html: 'Hi {{ first_name|default:"there" }} — here is the short version. Everything we make starts with cold-pressed virgin coconut oil and a list of ingredients short enough to read on one hand.',
      },
      {
        type: 'p',
        html: 'Cold-pressed virgin coconut oil keeps its lauric acid, which is the part that actually does the work. Refined coconut oil is cheaper, neutral and more shelf-stable — the deodorising process strips the lauric acid out. We buy the expensive one, and that is most of why this costs more than the drugstore version.',
      },
      {
        type: 'p',
        html: 'That is the whole pitch. No fillers to bulk out a tube, no synthetic fragrance, nothing added to make a label look better.',
      },
      { type: 'raw', html: codeBlock('Free shipping on your first order', 'SHIPFREE') },
      { type: 'cta', text: 'Shop best sellers', href: BEST },
      {
        type: 'p',
        html: `Use it at checkout. Orders over $${SHIP} ship free anyway.`,
      },
      { type: 'signoff' },
      { type: 'ps', html: 'Reply to this email if you want a recommendation for your skin — a real person answers, usually me.' },
    ],
  },

  TzuGfG: {
    name: 'Welcome — 02 Brand Story',
    format: 'plain',
    preheader: 'Julie started this over 20 years ago, for a reason that still decides every formula.',
    blocks: [
      { type: 'h1', text: 'Why this exists' },
      {
        type: 'p',
        html: 'Hi {{ first_name|default:"there" }} — I am Sean, co-founder. My sister-in-law Julie started Real Skin Care over 20 years ago, after looking for skincare that was both organic and genuinely simple and finding that it mostly did not exist.',
      },
      {
        type: 'p',
        html: 'Twenty years later the test we apply to every formula is still hers: <em>if a cheaper substitute would do the same job, would we use it?</em> The answer is yes, honestly — if it would. The reason we do not is that the cheap substitutes do not.',
      },
      {
        type: 'p',
        html: 'Baking soda is softer than enamel and neutralises oral acid. Hydrated silica is harder than enamel and simply abrades. Silica is cheaper. We use baking soda. That decision repeats itself across every product we make.',
      },
      { type: 'cta', text: 'See what we make', href: 'https://www.realskincare.com/collections/all' },
      { type: 'signoff' },
      { type: 'ps', html: 'Handmade in the USA, in small enough batches that the texture shifts a little between runs. That is the coconut oil behaving like a real ingredient, not a defect.' },
    ],
  },

  Ra3L8A: {
    name: 'Welcome — 03 Best Sellers',
    format: 'designed',
    preheader: 'The three people start with, and who each one is actually for.',
    blocks: [
      { type: 'h1', text: 'Where most people start' },
      {
        type: 'p',
        html: 'Not sure what to try first? These three cover most people, and they are not interchangeable — each one suits a different problem.',
      },
      {
        type: 'raw',
        html: productRow('Coconut Oil Deodorant', price('coconut-oil-deodorant'), 'Aluminium-free. Expect a 1–2 week adjustment when you switch off antiperspirant — that is the point, not a flaw.', `${PDP}/coconut-oil-deodorant`),
      },
      {
        type: 'raw',
        html: productRow('Coconut Oil Toothpaste', price('coconut-oil-toothpaste'), 'Fluoride-free and SLS-free. It foams less than conventional paste, because the foam was the SLS.', `${PDP}/coconut-oil-toothpaste`),
      },
      {
        type: 'raw',
        html: productRow('Sensitive Skin Set', price('sensitive-skin-starter-set'), 'The gentlest set we make, and cheaper than buying the pieces separately.', `${PDP}/sensitive-skin-starter-set`),
      },
      // For anyone replacing more than one thing at once. Deliberately the $59 Clean Swap
      // and NOT the $144 90-Day version: docs/bundle-marketing-plan.md §4 rules that one
      // out of the welcome series as too steep cold, and it is right — this reader has not
      // bought anything yet.
      {
        type: 'raw',
        html: productRow('The Clean Swap', price('clean-swap'), `Replacing several things at once rather than trying one — save ${savings('clean-swap')} against buying them singly.`, `${PDP}/clean-swap`),
      },
      { type: 'cta', text: 'Shop best sellers', href: BEST },
      { type: 'p', html: `Free shipping over $${SHIP}.` },
    ],
  },

  U7SuwV: {
    name: 'Welcome — 04 Why Clean / USP',
    format: 'plain',
    preheader: 'Tom\'s of Maine sells "natural" toothpaste with SLS in it. That is the problem.',
    blocks: [
      { type: 'h1', text: 'Why we never say "natural"' },
      {
        type: 'p',
        html: 'The word is essentially unregulated in personal-care labelling. Tom\'s of Maine sells "natural" toothpaste containing sodium lauryl sulfate. Crest markets SKUs as natural. Burt\'s Bees uses the word alongside hydrogenated castor oil.',
      },
      {
        type: 'p',
        html: 'So the word tells you nothing, and if you have reacted badly to something labelled natural before, you already know that.',
      },
      {
        type: 'p',
        html: 'What we do instead is name what is absent and why. No SLS — it is a foaming agent linked to canker sores in people prone to them. No fluoride. No glycerin or sorbitol coating. No titanium dioxide. No synthetic sweeteners or fragrance. Each of those is verifiable by reading our ingredient list against any conventional alternative.',
      },
      { type: 'cta', text: 'Read the ingredient lists', href: 'https://www.realskincare.com/collections/all' },
      { type: 'signoff' },
      { type: 'ps', html: 'The trade-off is real: it costs more, tastes milder, and does not foam. Every one of those is a downstream effect of leaving something out.' },
    ],
  },

  XGJfxT: {
    name: 'Welcome — 05 Last Chance Free Shipping',
    format: 'designed',
    preheader: 'SHIPFREE is still good — this is the last time I mention it.',
    blocks: [
      { type: 'h1', text: 'Last time I mention this' },
      {
        type: 'p',
        html: 'Your welcome code is still active. This is the last email in which I bring it up.',
      },
      { type: 'raw', html: codeBlock('Free shipping on your first order', 'SHIPFREE') },
      { type: 'cta', text: 'Use it on a best seller', href: BEST },
      {
        type: 'p',
        html: 'If something is stopping you — you are not sure which product suits your skin, or you have reacted badly to a "clean" brand before — just reply. A real person answers, usually me.',
      },
      { type: 'signoff' },
    ],
  },

  // ------------------------------------------------------- Product Review / Cross-Sell
  // Split format: the ask has to read as a person asking, so it is plain and comes first;
  // the cross-sell is a separate designed block below it. Never gate a review request by
  // rating and never incentivise it — that is review-fraud territory and against the
  // platforms' terms.

  TA5Wi4: {
    name: 'Product Review — 01 Review + Cross-Sell',
    format: 'plain',
    preheader: 'Two weeks in — did it actually work for you?',
    blocks: [
      { type: 'h1', text: 'Did it work?' },
      {
        type: 'p',
        html: 'Hi {{ first_name|default:"there" }} — your order has had a couple of weeks to earn its place. Long enough to know.',
      },
      {
        type: 'p',
        html: 'If it worked, a review helps the next person with the same problem find it. If it did not, I would rather hear that directly — reply to this email and tell me what happened.',
      },
      {
        type: 'raw',
        html: byCategory(
          `{% if "Deodorant" in items %}${reviewLink('Coconut Oil Deodorant', 'coconut-oil-deodorant')}{% endif %}
{% if "Toothpaste" in items %}${reviewLink('Coconut Oil Toothpaste', 'coconut-oil-toothpaste')}{% endif %}
{% if "Soap" in items %}${reviewLink('Foaming Hand Soap', 'organic-foaming-hand-soap')}{% endif %}
{% if "Lotion" in items or "Coconut Moisturizer" in items %}${reviewLink('Body Lotion', 'coconut-lotion')}{% endif %}
{% if "Lip" in items %}${reviewLink('Lip Balm', 'coconut-oil-lip-balm')}{% endif %}`,
          `<table cellpadding="0" cellspacing="0" role="presentation" style="margin:0 0 20px;" width="100%"><tr><td align="center"><a href="${BEST}" style="font-family:Outfit,'Helvetica Neue',Helvetica,Arial,sans-serif;font-size:15px;font-weight:600;color:#000000;text-decoration:underline;">Leave a review →</a></td></tr></table>`,
        ),
      },
      { type: 'signoff' },
      {
        type: 'raw',
        html: productRow('Coconut Oil Lip Balm', price('coconut-oil-lip-balm'), 'The small one people add on and then reorder on its own.', `${PDP}/coconut-oil-lip-balm`),
      },
      // A reader who just left a review is warm and has no single obvious next SKU — this
      // flow fires on any product. The collection is the honest destination: it lets them
      // pick rather than guessing at them. Added 2026-08-30 with the first bundle
      // placements in any flow.
      // A CTA rather than a productRow, and not by preference: `productRow`'s price slot
      // renders a bare "$NN", and lib/email-render.js's stale-threshold guard reads any
      // such figure as a possible out-of-date free-shipping number and refuses the build.
      // It is right to be strict — an $8 lip balm and a $50 threshold both reached live
      // emails — so the collection is linked without a price instead of the guard widened.
      { type: 'cta', text: 'Browse sets & bundles', href: BUNDLES },
      {
        type: 'p',
        html: 'Every multipack and set in one place — all cheaper per unit than reordering one at a time.',
      },
    ],
  },

  // --------------------------------------------------------------------- Post-Purchase
  // 01, 02 and 04 are the churn-prevention surface. Plain and link-light on purpose:
  // primary-tab placement matters more than polish, because the transition-period
  // explanation only prevents churn if it is actually read. 03 and 05 sell, so they are
  // designed but light.

  UrT2dK: {
    name: 'Post-Purchase — 01 Thank You',
    format: 'plain',
    preheader: 'One thing to know before it arrives, especially for the deodorant.',
    blocks: [
      { type: 'h1', text: 'Thank you — and one thing to expect' },
      {
        type: 'p',
        html: 'Hi {{ first_name|default:"there" }} — your order is being prepared and you will get tracking as soon as it ships.',
      },
      // The transition-period warning only belongs in front of someone who bought the
      // deodorant. A first pass sent it to everyone, so a lotion buyer was told about
      // antiperspirant withdrawal they will never experience.
      {
        type: 'raw',
        html: `{% with items=event.Items|join:", " %}{% if "Deodorant" in items %}
${para('One thing worth knowing now rather than in week two: switching off antiperspirant takes about <strong>1–2 weeks</strong>. You may notice more moisture at first — that is your sweat glands doing what they always did, no longer blocked by aluminium. It settles.')}
${para('Most people who give up on natural deodorant quit inside that window, days before it would have worked. Do not judge it before day 14.')}
{% else %}
${para('Everything is handmade in the USA from a short ingredient list, and the results come from using it consistently rather than heavily. Give it a couple of weeks.')}
{% endif %}{% endwith %}`,
      },
      { type: 'p', html: 'I will send a short note on using what you bought, and then leave you alone.' },
      { type: 'signoff' },
      { type: 'ps', html: 'If anything arrives damaged or wrong, reply here and we will fix it. No form to fill in.' },
    ],
  },

  VBhR7B: {
    name: 'Post-Purchase — 02 How To Use It (dynamic)',
    format: 'plain',
    preheader: 'How to use what you bought — and what is normal in week one.',
    blocks: [
      { type: 'h1', text: 'How to use what you bought' },
      { type: 'p', html: 'Hi {{ first_name|default:"there" }} — short and specific to your order.' },
      {
        type: 'raw',
        html: byCategory(
          `{% if "Deodorant" in items %}${para('<strong>Your deodorant.</strong> Two to three swipes on clean, dry skin each morning and after showering. The switch off antiperspirant takes 1–2 weeks and you may notice more moisture at first — that is normal and temporary. Do not judge it before day 14.')}{% endif %}
{% if "Toothpaste" in items %}${para('<strong>Your toothpaste.</strong> A pea-sized amount, twice a day. It foams less than conventional paste — foam is SLS, not cleaning. Squeeze from the bottom; the coconut oil firms up in a cold bathroom and loosens in a warm one.')}{% endif %}
{% if "Soap" in items or "Lotion" in items or "Coconut Moisturizer" in items %}${para('<strong>Your skin routine.</strong> Cleanse first, then moisturise while skin is still damp — that is what locks the water in. On dry skin you are just adding oil to a dry surface.')}{% endif %}
{% if "Lip" in items %}${para('<strong>Your lip balm.</strong> No menthol or camphor, so no cooling tingle. That tingle is mild irritation, and it is why some balms leave you reapplying all day.')}{% endif %}`,
          para('Everything starts with cold-pressed virgin coconut oil and a short ingredient list. The results come from using it consistently — give it a couple of weeks before you judge it.'),
        ),
      },
      { type: 'signoff' },
      { type: 'ps', html: 'Consistency matters more than quantity with all of it. Two weeks of daily use tells you more than a heavy first application.' },
    ],
  },

  UYgNuY: {
    name: 'Post-Purchase — 03 Complete Your Routine (Set)',
    format: 'designed',
    preheader: 'SETSHIP covers shipping on the Sensitive Skin Set.',
    blocks: [
      { type: 'h1', text: 'The set, if you want the rest of it' },
      {
        type: 'p',
        html: 'If what you ordered is working, the Sensitive Skin Moisturizing Set is the gentlest group we make — and it costs less than buying the pieces separately.',
      },
      {
        type: 'raw',
        html: productRow('Sensitive Skin Moisturizing Set', price('sensitive-skin-starter-set'), 'Our gentlest coconut-oil essentials, priced below the individual pieces.', `${PDP}/sensitive-skin-starter-set`),
      },
      { type: 'raw', html: codeBlock('Free shipping on your set', 'SETSHIP') },
      { type: 'cta', text: 'Shop the Set', href: `${PDP}/sensitive-skin-starter-set` },
      { type: 'signoff' },
    ],
  },

  XW7wTj: {
    name: 'Post-Purchase — 04 Review + Referral',
    format: 'plain',
    preheader: 'If it is not right, I would rather fix it than have you quietly stop.',
    blocks: [
      { type: 'h1', text: 'How is it going?' },
      {
        type: 'p',
        html: 'Hi {{ first_name|default:"there" }} — a couple of weeks in, which is long enough to know whether it suits you.',
      },
      {
        type: 'p',
        html: 'If something is not right, reply to this email. We read every message, and most problems have a straightforward answer — the wrong amount, the wrong order of steps, or a transition period that has not finished yet.',
      },
      {
        type: 'p',
        html: 'If it is working and you know someone who has been let down by a "clean" brand before, send them to realskincare.com — <strong>NEWCUSTOMER</strong> gets them free shipping on their first order.',
      },
      { type: 'cta', text: 'Send a friend our way', href: 'https://www.realskincare.com' },
      { type: 'signoff' },
    ],
  },

  RiMM8C: {
    name: 'Post-Purchase — 05 Restock Reorder',
    format: 'designed',
    // The add-to-cart permalinks carry Shopify variant IDs. They are copied exactly from
    // the live template — a wrong variant ID silently adds the wrong product.
    preheader: 'One tap adds your usual straight to the cart.',
    blocks: [
      { type: 'h1', text: 'Running low?' },
      { type: 'p', html: 'Each button drops it straight into your cart — no hunting for it.' },
      // Their own items first, as one-tap reorders.
      {
        type: 'raw',
        html: byCategory(
          `{% if "Deodorant" in items %}${cartButton(`Reorder Coconut Oil Deodorant — ${price('coconut-oil-deodorant')}`, variant('coconut-oil-deodorant'))}{% endif %}
{% if "Toothpaste" in items %}${cartButton(`Reorder Coconut Oil Toothpaste — ${price('coconut-oil-toothpaste')}`, variant('coconut-oil-toothpaste'))}{% endif %}
{% if "Soap" in items %}${cartButton(`Reorder Foaming Hand Soap — ${price('organic-foaming-hand-soap')}`, variant('organic-foaming-hand-soap'))}{% endif %}
{% if "Lotion" in items %}${cartButton(`Reorder Body Lotion — ${price('coconut-lotion')}`, variant('coconut-lotion'))}{% endif %}
{% if "Coconut Moisturizer" in items %}${cartButton(`Reorder Coconut Moisturizer — ${price('coconut-moisturizer')}`, variant('coconut-moisturizer'))}{% endif %}
{% if "Lip" in items %}${cartButton(`Reorder Lip Balm — ${price('coconut-oil-lip-balm')}`, variant('coconut-oil-lip-balm'))}{% endif %}`,
          cartButton(`Reorder Coconut Oil Deodorant — ${price('coconut-oil-deodorant')}`, variant('coconut-oil-deodorant')),
        ),
      },
      // The rest of the range, so the email is useful to someone restocking more than the
      // one thing they last bought. A first pass showed only their own items, which made a
      // reorder email a dead end for anyone wanting to add to the order.
      { type: 'raw', html: ITEMS_OPEN },
      { type: 'p', html: '<strong>Add to the same order</strong>' },
      // Buttons, not text rows — this is a one-tap reorder email and a plain link does not
      // read as tappable next to the primary button above.
      //
      // Each is suppressed when the customer already bought that product, so it does not
      // appear twice: once as their reorder button and again here. Expressed as an empty
      // {% if %} with the row in the {% else %} branch rather than "not in", because
      // if/else is the construct the account already runs in production.
      {
        type: 'raw',
        html: [
          ['coconut-oil-deodorant', 'Coconut Oil Deodorant', 'Deodorant'],
          ['coconut-oil-toothpaste', 'Coconut Oil Toothpaste', 'Toothpaste'],
          ['coconut-oil-lip-balm', 'Coconut Oil Lip Balm', 'Lip'],
          ['coconut-soap', 'Moisturizing Coconut Soap', 'Soap'],
          ['coconut-lotion', 'Non-Toxic Body Lotion', 'Lotion'],
          ['coconut-moisturizer', 'Coconut Moisturizer', 'Coconut Moisturizer'],
        ].map(([handle, label, key]) =>
          `{% if "${key}" in items %}{% else %}${secondaryButton(`Add ${label} — ${price(handle)}`, variant(handle))}{% endif %}`,
        ).join('\n'),
      },
      // `items` is scoped to its {% with %} block, and the one above is already closed —
      // without reopening it here every condition reads as false and the dedupe silently
      // does nothing.
      // Multipacks. Added 2026-08-30, when a read of the live account found 16 flow
      // emails across 5 flows carrying ZERO bundle links — while the multipacks exist
      // for precisely the second order this email already asks for.
      //
      // Shown only for a category the customer actually bought, so this stays a better
      // way to do the thing they came for rather than an unrelated upsell. `items` is
      // reopened because the block above closed it (see the note there); forgetting that
      // makes every condition read false and the section silently vanish.
      { type: 'raw', html: ITEMS_OPEN },
      { type: 'p', html: '<strong>Or stock up and pay less per bar, tube and stick</strong>' },
      {
        type: 'raw',
        html: [
          ['coconut-bar-soap-4-pack', 'Bar Soap 4-Pack', 'Soap'],
          ['coconut-deodorant-4-pack', 'Deodorant 4-Pack', 'Deodorant'],
          ['coconut-toothpaste-3-pack', 'Toothpaste 3-Pack', 'Toothpaste'],
        ].map(([handle, label, key]) =>
          `{% if "${key}" in items %}${secondaryButton(`${label} — ${price(handle)}, save ${savings(handle)}`, variant(handle))}{% endif %}`,
        ).join('\n'),
      },
      { type: 'raw', html: ITEMS_CLOSE },
      { type: 'p', html: `Free shipping over $${SHIP}, if you are stocking up on more than one.` },
    ],
  },

  // ---------------------------------------------------------------- Replenishment
  // Plain and link-light — §6 names reorder nudges explicitly as the plain case. The
  // cadence numbers below are the ones already live; measured reorder gaps differ per
  // SKU, so treat 6/8 weeks as the current default rather than a finding.

  Y8wJn7: {
    name: 'Replenishment — 01 Running Low',
    format: 'plain',
    preheader: 'About five weeks in, which is when most people hit the bottom of it.',
    blocks: [
      { type: 'h1', text: 'About that time' },
      {
        type: 'p',
        html: 'Hi {{ first_name|default:"there" }} — you picked up {{ event.Items|first|default:"your Real Skin Care favorites" }} about five weeks ago, which is roughly when most people start scraping the bottom.',
      },
      {
        type: 'p',
        html: `Subscribe &amp; Save is ${KIT_SUB.discount_pct}% off every refill — the cadence only changes how often it turns up, not the price. Skip, pause, swap scent or cancel any time from your account; it is not a contract and you do not have to call anyone.`,
      },
      { type: 'raw', html: cadenceTable() },
      { type: 'raw', html: subscribeLinks() },
      { type: 'signoff' },
      { type: 'ps', html: 'If six weeks is too fast for how you actually use it, pick eight — same discount either way. Running a subscription you keep skipping is worse than not having one.' },
    ],
  },

  ThCS7T: {
    name: 'Replenishment — 02 Never Run Out',
    format: 'plain',
    preheader: 'Probably empty by now — two ways to handle it.',
    blocks: [
      { type: 'h1', text: 'Probably empty by now' },
      {
        type: 'p',
        html: 'Hi {{ first_name|default:"there" }} — your {{ event.Items|first|default:"Real Skin Care favorite" }} is likely finished.',
      },
      {
        type: 'p',
        html: `Two options. Reorder when you notice, or put it on Subscribe &amp; Save at ${KIT_SUB.discount_pct}% off — pick the interval that matches how fast you actually get through it. Skip, pause, swap or cancel any time from your account.`,
      },
      { type: 'raw', html: cadenceTable() },
      { type: 'raw', html: subscribeLinks() },
      // A third option the email never offered: buy enough that running out stops being an
      // event. This reader has proven their cadence by reaching a second reorder nudge, so
      // the multipack is the honest recommendation — and the saving is the whole argument,
      // which is why it is interpolated rather than described.
      {
        type: 'p',
        html: '<strong>Or stop running out</strong>',
      },
      {
        type: 'raw',
        html: productRow('90-Day Coconut Reset', price('99-coconut-reset-digital'), `Three months of lotion and cream in one order — save ${savings('99-coconut-reset-digital')} against reordering them separately.`, `${PDP}/99-coconut-reset-digital`),
      },
      {
        type: 'raw',
        html: productRow('Bar Soap 12-Pack', price('coconut-bar-soap-12-pack'), `Roughly a year of soap — save ${savings('coconut-bar-soap-12-pack')}.`, `${PDP}/coconut-bar-soap-12-pack`),
      },
      { type: 'signoff' },
    ],
  },

  // ----------------------------------------------------------- Browse Abandonment
  // Designed and light, product imagery carrying it. Data shape here is different from
  // the cart flows: this trigger carries event.ImageURL / Name / Price / URL, NOT
  // $extra.line_items. Copied from the live template rather than assumed.

  UCfgDD: {
    name: 'Browse Abandonment — 01 Still Looking',
    format: 'designed',
    preheader: 'The one you were looking at, and what it is actually for.',
    blocks: [
      { type: 'h1', text: 'Still deciding?' },
      { type: 'p', html: 'Hi {{ first_name|default:"there" }} — here it is again.' },
      {
        type: 'raw',
        // The {% else %} branch is required: not every viewed product carries an image,
        // and without it those recipients get an email that never names what they looked
        // at. The live template had this; a first pass at the rebuild dropped it.
        html: `{% if event.ImageURL %}<table cellpadding="0" cellspacing="0" role="presentation" width="100%" style="margin:0 0 20px;"><tr><td align="center">
<a href="{{ event.URL }}" style="text-decoration:none;"><img alt="{{ event.Name }}" src="{{ event.ImageURL }}" style="display:block;width:100%;max-width:400px;height:auto;border:0;border-radius:8px;"/></a>
<div style="font-family:Outfit,'Helvetica Neue',Helvetica,Arial,sans-serif;font-size:16px;font-weight:600;color:#000000;margin-top:12px;">{{ event.Name }} — \${{ event.Price }}</div>
</td></tr></table>{% else %}<table cellpadding="0" cellspacing="0" role="presentation" width="100%" style="margin:0 0 20px;"><tr><td align="center">
<div style="font-family:Outfit,'Helvetica Neue',Helvetica,Arial,sans-serif;font-size:16px;font-weight:600;color:#000000;">{{ event.Name|default:'the item you were looking at' }}</div>
</td></tr></table>{% endif %}`,
      },
      {
        type: 'p',
        html: 'If you have been let down by something labelled "clean" before, the useful thing to do is read our ingredient list against whatever you are comparing it to. That comparison is the whole argument.',
      },
      { type: 'cta', text: 'Take another look', href: "{{ event.URL|default:'https://www.realskincare.com/collections/all' }}" },
    ],
  },

  Y8tMjd: {
    name: 'Browse Abandonment — 02 Best Sellers',
    format: 'designed',
    preheader: 'Three starting points, and who each one suits.',
    blocks: [
      { type: 'h1', text: 'Still on your mind?' },
      { type: 'p', html: 'No rush. If you are still deciding, these are the three people usually start with.' },
      {
        type: 'raw',
        html: productRow('Coconut Oil Deodorant', price('coconut-oil-deodorant'), 'Aluminium-free. Expect a 1–2 week adjustment off antiperspirant.', `${PDP}/coconut-oil-deodorant`),
      },
      {
        type: 'raw',
        html: productRow('Sensitive Skin Set', price('sensitive-skin-starter-set'), 'The gentlest set, and cheaper than the pieces separately.', `${PDP}/sensitive-skin-starter-set`),
      },
      {
        type: 'raw',
        html: productRow('Coconut Oil Toothpaste', price('coconut-oil-toothpaste'), 'Fluoride-free and SLS-free. Foams less, because foam was the SLS.', `${PDP}/coconut-oil-toothpaste`),
      },
      { type: 'cta', text: 'Shop best sellers', href: BEST },
      { type: 'p', html: `Free shipping over $${SHIP}.` },
    ],
  },

  // ------------------------------------------------- Coconut Reset — Digital Delivery
  // TRANSACTIONAL. This one is treated with the most care on the list: a paying customer
  // not receiving what they bought is the worst failure here. Plain and functional, the
  // download links first and unmissable, no promotional styling that could push it to the
  // promotions tab. The two PDF URLs are copied verbatim from the live template.

  X4c9Rt: {
    name: 'Coconut Reset — Digital Delivery',
    format: 'plain',
    preheader: 'Your two guides are ready to download — links inside.',
    blocks: [
      { type: 'h1', text: 'Your downloads are ready' },
      {
        type: 'p',
        html: 'Hi {{ first_name|default:"there" }} — thank you for starting the 90-Day Coconut Reset. Your box is on its way, and both guides are ready now.',
      },
      {
        type: 'textlink',
        text: '1. Download the 90-Day Calm-Skin Routine &amp; Tracker →',
        href: 'https://cdn.shopify.com/s/files/1/0270/1911/6579/files/90-Day-Calm-Skin-Routine-and-Tracker-v3.pdf?v=1786591629',
      },
      {
        type: 'textlink',
        text: '2. Download the Coconut Skincare Field Guide →',
        href: 'https://cdn.shopify.com/s/files/1/0270/1911/6579/files/Coconut-Skincare-Field-Guide-v3.pdf?v=1786591634',
      },
      {
        type: 'p',
        html: 'The Routine &amp; Tracker is the two-step plan plus a 12-week tracker. The Field Guide covers what helps sensitive skin and what quietly irritates it.',
      },
      {
        type: 'p',
        html: 'Save both to your device now — that way you have them even if this email gets buried.',
      },
      { type: 'signoff' },
      { type: 'ps', html: 'If either link does not open, reply to this email and I will send the files directly. You paid for them; you should have them.' },
    ],
  },
};

export const BEST_SELLERS = BEST;
