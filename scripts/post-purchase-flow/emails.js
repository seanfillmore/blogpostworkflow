/**
 * Post-Purchase Flow — email HTML templates (RSC brand voice, founder Sean).
 *
 * Email-safe HTML: table layout, inline styles, <=600px, dark-mode-aware.
 * Merge tags use Klaviyo/Django syntax. Unsubscribe + mailing address in footer
 * (CAN-SPAM). All product/CTA URLs are verified-live (see build.js STORE map).
 *
 * Design language: warm cream canvas, white card, deep natural green accent —
 * clean and unfussy, matching a coconut-oil, few-ingredients brand.
 */

const SITE = 'https://www.realskincare.com';
const ADDRESS = '6212 FM 933, Blum, TX 76627, United States';
const SUPPORT = 'support@realskincare.com';

// Verified-live product URLs + cart permalinks (variant ids) — see build.js
export const P = {
  deodorant:  { url: `${SITE}/products/coconut-oil-deodorant`,        cart: `${SITE}/cart/44179451052202:1`, name: 'Coconut Oil Deodorant',      price: '$15' },
  toothpaste: { url: `${SITE}/products/coconut-oil-toothpaste`,       cart: `${SITE}/cart/44179458162858:1`, name: 'Coconut Oil Toothpaste',     price: '$13' },
  handsoap:   { url: `${SITE}/products/organic-foaming-hand-soap`,    cart: `${SITE}/cart/44179472187562:1`, name: 'Foaming Coconut Hand Soap',  price: '$13' },
  barsoap:    { url: `${SITE}/products/coconut-soap`,                 cart: `${SITE}/cart/44179485655210:1`, name: 'Coconut Bar Soap',          price: '$11' },
  lotion:     { url: `${SITE}/products/coconut-lotion`,               cart: `${SITE}/cart/45828179165354:1`, name: 'Non-Toxic Body Lotion',     price: '$30' },
  moisturizer:{ url: `${SITE}/products/coconut-moisturizer`,          cart: `${SITE}/cart/44179428475050:1`, name: 'Coconut Moisturizer',       price: '$28' },
  lipbalm:    { url: `${SITE}/products/coconut-oil-lip-balm`,         cart: `${SITE}/cart/44180191772842:1`, name: 'Coconut Lip Balm (4-pack)', price: '$15' },
  set:        { url: `${SITE}/products/sensitive-skin-starter-set`,   cart: `${SITE}/cart/48075580539050:1`, name: 'Sensitive Skin Moisturizing Set', price: '$46.80' },
  shopAll:    { url: `${SITE}/collections/all` },
};

const FREE_SHIP = '$50';

// ---------- shared shell ----------

function button(href, label) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0;">
    <tr><td align="center" bgcolor="#2f5e3f" style="border-radius:6px;">
      <a href="${href}" style="display:inline-block;padding:14px 30px;font-family:Helvetica,Arial,sans-serif;font-size:16px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:6px;">${label}</a>
    </td></tr></table>`;
}

function productCard({ url, name, price, note }) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e6ded1;border-radius:8px;margin:10px 0;">
    <tr><td style="padding:16px 18px;font-family:Helvetica,Arial,sans-serif;">
      <a href="${url}" style="font-size:16px;font-weight:600;color:#2f5e3f;text-decoration:none;">${name} — ${price}</a>
      ${note ? `<div style="font-size:14px;color:#6b6b6b;margin-top:4px;">${note}</div>` : ''}
    </td></tr></table>`;
}

/**
 * Wrap body content in the branded email shell.
 * @param {string} preheader hidden inbox preview text
 * @param {string} body inner HTML (already table/inline-styled)
 */
function shell(preheader, body) {
  return `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<meta name="color-scheme" content="light dark"/>
<meta name="supported-color-schemes" content="light dark"/>
<title>Real Skin Care</title>
</head>
<body style="margin:0;padding:0;background-color:#f5f1ea;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${preheader}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f5f1ea;">
  <tr><td align="center" style="padding:24px 12px;">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">
      <!-- header -->
      <tr><td align="center" style="padding:8px 0 20px;">
        <a href="${SITE}" style="font-family:Georgia,'Times New Roman',serif;font-size:22px;letter-spacing:2px;color:#2f5e3f;text-decoration:none;font-weight:700;">REAL SKIN CARE</a>
      </td></tr>
      <!-- card -->
      <tr><td style="background-color:#ffffff;border-radius:12px;padding:36px 32px;">
        ${body}
      </td></tr>
      <!-- footer -->
      <tr><td align="center" style="padding:22px 16px;font-family:Helvetica,Arial,sans-serif;font-size:12px;line-height:18px;color:#9a9385;">
        Real Skin Care · ${ADDRESS}<br/>
        Questions? Just reply, or email <a href="mailto:${SUPPORT}" style="color:#9a9385;">${SUPPORT}</a>.<br/>
        <a href="{% unsubscribe %}" style="color:#9a9385;text-decoration:underline;">Unsubscribe</a>
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;
}

const H1 = (t) => `<h1 style="margin:0 0 16px;font-family:Georgia,serif;font-size:24px;line-height:30px;color:#2b2b2b;">${t}</h1>`;
const P_ = (t) => `<p style="margin:0 0 16px;font-family:Helvetica,Arial,sans-serif;font-size:16px;line-height:24px;color:#3d3d3d;">${t}</p>`;
const SIGN = P_(`Take care,<br/><strong>Sean</strong><br/><span style="color:#6b6b6b;">Co-Founder, Real Skin Care</span>`);
const FREESHIP_NOTE = `<p style="margin:8px 0 0;font-family:Helvetica,Arial,sans-serif;font-size:13px;color:#6b6b6b;">Free shipping on orders over ${FREE_SHIP}.</p>`;

// ---------- the 8 templates ----------

export const EMAILS = {
  e1_thankyou: {
    key: 'e1',
    name: 'Post-Purchase — 01 Thank You',
    subject: 'Thank you, {{ first_name|default:"friend" }} 🌿',
    preview: "Your order's on the way — here's how to get the most from it.",
    html: shell(
      "Your order's on the way — here's how to get the most from it.",
      H1('Thank you for your order.') +
      P_('Hi {{ first_name|default:"there" }}, thank you for choosing Real Skin Care. Your order is being prepared and will be on its way shortly — you\'ll get tracking as soon as it ships.') +
      P_('We make everything with a short list of clean, coconut-oil-based ingredients — no fillers, no junk. It\'s made to keep skin comfortable and nourished as part of your everyday routine.') +
      P_('Over the next couple of weeks I\'ll send a few short notes on getting the most out of what you ordered. If you ever have a question, just reply to any email — it comes straight to us.') +
      SIGN +
      button(P.shopAll.url, 'Explore the full collection') +
      FREESHIP_NOTE,
    ),
  },

  // Single Email 2 with conditional content keyed off the order's items.
  // Klaviyo flow emails expose the triggering event as `event`; we join
  // event.Items to a string and substring-match (verified renders correctly).
  // Keeps the flow a single linear trunk (Klaviyo flows are trees, not DAGs —
  // branch paths do not re-converge, so per-product graph branches would
  // orphan the downstream emails).
  e2_howto: {
    key: 'e2',
    name: 'Post-Purchase — 02 How To Use It (dynamic)',
    subject: 'Getting the most from your order',
    preview: 'A few quick tips for what you just bought.',
    html: shell(
      'A few quick tips for what you just bought.',
      H1('How to get the most from your order') +
      P_('Hi {{ first_name|default:"there" }}, a few quick, honest tips to help your new products work their best.') +
      `{% with items=event.Items|join:", " %}` +
      `{% if "Deodorant" in items or "Toothpaste" in items or "Soap" in items or "Lotion" in items or "Moisturiz" in items %}` +
        // Deodorant guidance (highest refund-deflection value)
        `{% if "Deodorant" in items %}` +
          P_('<strong>Your natural deodorant.</strong> Switching from antiperspirant comes with a short 1–2 week adjustment — you may notice more moisture at first. That\'s normal and temporary. Apply 2–3 swipes to clean, dry skin each morning and after showering.') +
          productCard({ ...P.handsoap, note: 'A quick coconut-soap wash keeps things fresh through the transition.' }) +
        `{% endif %}` +
        // Toothpaste guidance
        `{% if "Toothpaste" in items %}` +
          P_('<strong>Your fluoride-free toothpaste.</strong> Use a pea-sized amount twice a day. It foams less than conventional paste — that\'s the absent SLS, not absent clean.') +
        `{% endif %}` +
        // Soap / lotion / moisturizer / set routine
        `{% if "Soap" in items or "Lotion" in items or "Moisturiz" in items %}` +
          P_('<strong>Your skin routine.</strong> Cleanse with our coconut soaps (they clean without stripping), then moisturize while skin is still damp to lock in hydration.') +
          productCard({ ...P.moisturizer, note: 'Rich 4oz coconut moisturizer for face & body.' }) +
        `{% endif %}` +
      `{% else %}` +
        // Fallback (e.g. lip balm, or any product without a specific guide)
        P_('Everything we make starts with coconut oil and a short list of clean ingredients — no fillers, no synthetic fragrance. The best results come from using it consistently, so give your skin a couple of weeks to show the difference.') +
      `{% endif %}` +
      `{% endwith %}` +
      SIGN +
      button(P.shopAll.url, 'Explore the collection') +
      FREESHIP_NOTE,
    ),
  },

  e3_set: {
    key: 'e3',
    name: 'Post-Purchase — 03 Complete Your Routine (Set)',
    subject: 'Complete your routine (and ship free)',
    preview: 'The Sensitive Skin Set — everything you need, less than buying separately.',
    html: shell(
      'The Sensitive Skin Set — everything you need, less than buying separately.',
      H1('Ready to complete your routine?') +
      P_('If you\'re loving what you ordered, the easiest next step is our <strong>Sensitive Skin Moisturizing Set</strong> — a curated bundle of our gentlest coconut-oil essentials, priced below buying each piece on its own.') +
      productCard({ ...P.set, note: 'Everything you need for soft, comfortable skin — for less than buying each piece separately.' }) +
      P_('And this one\'s on us to ship. Use the code below at checkout and <strong>your set ships free</strong> — our thank-you for coming back.') +
      // Free-shipping code callout
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:18px 0;">
        <tr><td align="center">
          <table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="border:2px dashed #2f5e3f;border-radius:10px;padding:14px 34px;text-align:center;">
            <div style="font-family:Helvetica,Arial,sans-serif;font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#6b6b6b;">Free shipping on your set</div>
            <div style="font-family:Georgia,serif;font-size:24px;letter-spacing:4px;color:#2f5e3f;font-weight:700;margin-top:4px;">SETSHIP</div>
          </td></tr></table>
        </td></tr>
      </table>` +
      SIGN +
      button(P.set.url, 'Shop the Set'),
    ),
  },

  e4_review: {
    key: 'e4',
    name: 'Post-Purchase — 04 Review + Referral',
    subject: 'How\'s it going, {{ first_name|default:"there" }}?',
    preview: 'We\'d love your honest take — and your friends get free shipping.',
    html: shell(
      'We\'d love your honest take — and your friends get free shipping.',
      H1('How are you liking it?') +
      P_('You\'ve had your order for a couple of weeks now — long enough to know how it\'s working for you. If you have a minute, we\'d be truly grateful for an honest review. It helps us improve, and it helps other people find clean products they can trust.') +
      button(P.shopAll.url, 'Leave a review') +
      P_('<strong>Love it? Share it.</strong> Send a friend to realskincare.com and they\'ll get <strong>free shipping</strong> on their first order with code <strong>NEWCUSTOMER</strong>.') +
      SIGN,
    ),
  },

  e5_restock: {
    key: 'e5',
    name: 'Post-Purchase — 05 Restock Reorder',
    subject: 'Running low? Restock in one click 🔁',
    preview: 'Stock up on your essentials — and cross $50 for free shipping.',
    html: shell(
      'Stock up on your essentials — and cross $50 for free shipping.',
      H1('Time for a refill?') +
      P_('If you\'re getting low on your everyday essentials, here\'s the one-click way to restock. Each button adds it straight to your cart.') +
      // Show the reorder card for what they actually bought; fall back to the trio.
      `{% with items=event.Items|join:", " %}` +
      `{% if "Deodorant" in items or "Toothpaste" in items or "Soap" in items %}` +
        `{% if "Deodorant" in items %}` + productCard({ url: P.deodorant.cart, name: `Reorder ${P.deodorant.name}`, price: P.deodorant.price, note: 'Add to cart in one click' }) + `{% endif %}` +
        `{% if "Toothpaste" in items %}` + productCard({ url: P.toothpaste.cart, name: `Reorder ${P.toothpaste.name}`, price: P.toothpaste.price, note: 'Add to cart in one click' }) + `{% endif %}` +
        `{% if "Soap" in items %}` + productCard({ url: P.handsoap.cart, name: `Reorder ${P.handsoap.name}`, price: P.handsoap.price, note: 'Add to cart in one click' }) + `{% endif %}` +
      `{% else %}` +
        productCard({ url: P.deodorant.cart, name: `Reorder ${P.deodorant.name}`, price: P.deodorant.price, note: 'Add to cart in one click' }) +
        productCard({ url: P.toothpaste.cart, name: `Reorder ${P.toothpaste.name}`, price: P.toothpaste.price, note: 'Add to cart in one click' }) +
        productCard({ url: P.handsoap.cart, name: `Reorder ${P.handsoap.name}`, price: P.handsoap.price, note: 'Add to cart in one click' }) +
      `{% endif %}` +
      `{% endwith %}` +
      P_(`<strong>Tip:</strong> stock up on two or three and you\'ll pass ${FREE_SHIP} — so <strong>shipping\'s free.</strong>`) +
      SIGN +
      button(P.shopAll.url, 'Shop everything'),
    ),
  },
};

export const ORDER = ['e1_thankyou','e2_howto','e3_set','e4_review','e5_restock'];
