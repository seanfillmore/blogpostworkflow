/**
 * Shared code-based email components for all RSC Klaviyo flows.
 * Same design language as the Post-Purchase flow: warm cream canvas, white card,
 * deep natural green accent, Georgia headings. Email-safe (tables, inline styles,
 * <=600px, dark-mode-aware). Merge tags use Klaviyo/Django syntax.
 */

export const SITE = 'https://www.realskincare.com';
const ADDRESS = '6212 FM 933, Blum, TX 76627, United States';
const SUPPORT = 'support@realskincare.com';
export const FREE_SHIP = '$50';

// Verified-live product URLs + cart permalinks (variant ids)
export const P = {
  deodorant:  { url: `${SITE}/products/coconut-oil-deodorant`,      cart: `${SITE}/cart/44179451052202:1`, name: 'Coconut Oil Deodorant',      price: '$15' },
  toothpaste: { url: `${SITE}/products/coconut-oil-toothpaste`,     cart: `${SITE}/cart/44179458162858:1`, name: 'Coconut Oil Toothpaste',     price: '$13' },
  handsoap:   { url: `${SITE}/products/organic-foaming-hand-soap`,  cart: `${SITE}/cart/44179472187562:1`, name: 'Foaming Coconut Hand Soap',  price: '$13' },
  barsoap:    { url: `${SITE}/products/coconut-soap`,               cart: `${SITE}/cart/44179485655210:1`, name: 'Coconut Bar Soap',          price: '$11' },
  lotion:     { url: `${SITE}/products/coconut-lotion`,             cart: `${SITE}/cart/45828179165354:1`, name: 'Non-Toxic Body Lotion',     price: '$30' },
  moisturizer:{ url: `${SITE}/products/coconut-moisturizer`,        cart: `${SITE}/cart/44179428475050:1`, name: 'Coconut Moisturizer',       price: '$28' },
  lipbalm:    { url: `${SITE}/products/coconut-oil-lip-balm`,       cart: `${SITE}/cart/44180191772842:1`, name: 'Coconut Lip Balm (4-pack)', price: '$15' },
  set:        { url: `${SITE}/products/sensitive-skin-starter-set`, cart: `${SITE}/cart/48075580539050:1`, name: 'Sensitive Skin Set',        price: '$46.80' },
  shopAll:    { url: `${SITE}/collections/all` },
  bestSellers:{ url: `${SITE}/collections/best-sellers` },
};

export const H1 = (t) => `<h1 style="margin:0 0 16px;font-family:Georgia,serif;font-size:24px;line-height:30px;color:#2b2b2b;">${t}</h1>`;
export const P_ = (t) => `<p style="margin:0 0 16px;font-family:Helvetica,Arial,sans-serif;font-size:16px;line-height:24px;color:#3d3d3d;">${t}</p>`;
export const SIGN = P_(`Take care,<br/><strong>Sean</strong><br/><span style="color:#6b6b6b;">Co-Founder, Real Skin Care</span>`);
export const FREESHIP_NOTE = `<p style="margin:8px 0 0;font-family:Helvetica,Arial,sans-serif;font-size:13px;color:#6b6b6b;">Free shipping on orders over ${FREE_SHIP}.</p>`;

export function button(href, label) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0;"><tr>
    <td align="center" bgcolor="#2f5e3f" style="border-radius:6px;">
      <a href="${href}" style="display:inline-block;padding:14px 30px;font-family:Helvetica,Arial,sans-serif;font-size:16px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:6px;">${label}</a>
    </td></tr></table>`;
}

export function productCard({ url, name, price, note }) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e6ded1;border-radius:8px;margin:10px 0;"><tr>
    <td style="padding:16px 18px;font-family:Helvetica,Arial,sans-serif;">
      <a href="${url}" style="font-size:16px;font-weight:600;color:#2f5e3f;text-decoration:none;">${name}${price ? ` — ${price}` : ''}</a>
      ${note ? `<div style="font-size:14px;color:#6b6b6b;margin-top:4px;">${note}</div>` : ''}
    </td></tr></table>`;
}

/** Visual product card with image (left) + text/CTA (right). image/name/url may be Klaviyo merge tags. */
export function imageCard({ image, url, name, price, cta = 'Shop now' }) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e6ded1;border-radius:10px;margin:14px 0;"><tr>
    <td width="140" style="padding:12px;"><a href="${url}"><img src="${image}" width="120" alt="${name}" style="width:120px;max-width:120px;height:auto;border-radius:6px;display:block;"/></a></td>
    <td style="padding:12px 16px 12px 0;font-family:Helvetica,Arial,sans-serif;vertical-align:middle;">
      <a href="${url}" style="font-size:16px;font-weight:600;color:#2b2b2b;text-decoration:none;">${name}</a>
      ${price ? `<div style="font-size:15px;color:#2f5e3f;margin:4px 0 8px;font-weight:600;">${price}</div>` : ''}
      <a href="${url}" style="font-size:14px;color:#2f5e3f;font-weight:600;text-decoration:none;">${cta} &rarr;</a>
    </td></tr></table>`;
}

/** Dashed code callout box (free-ship / discount codes). */
export function codeBox(label, code) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:18px 0;"><tr><td align="center">
    <table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="border:2px dashed #2f5e3f;border-radius:10px;padding:14px 34px;text-align:center;">
      <div style="font-family:Helvetica,Arial,sans-serif;font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#6b6b6b;">${label}</div>
      <div style="font-family:Georgia,serif;font-size:24px;letter-spacing:4px;color:#2f5e3f;font-weight:700;margin-top:4px;">${code}</div>
    </td></tr></table>
  </td></tr></table>`;
}

/**
 * Wrap body content in the branded shell.
 * @param {string} preheader inbox preview text (never leave empty)
 * @param {string} body inner HTML
 */
export function shell(preheader, body) {
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
      <tr><td align="center" style="padding:8px 0 20px;">
        <a href="${SITE}" style="font-family:Georgia,'Times New Roman',serif;font-size:22px;letter-spacing:2px;color:#2f5e3f;text-decoration:none;font-weight:700;">REAL SKIN CARE</a>
      </td></tr>
      <tr><td style="background-color:#ffffff;border-radius:12px;padding:36px 32px;">
        ${body}
      </td></tr>
      <tr><td align="center" style="padding:22px 16px;font-family:Helvetica,Arial,sans-serif;font-size:12px;line-height:18px;color:#9a9385;">
        Real Skin Care · ${ADDRESS}<br/>
        Questions? Just reply, or email <a href="mailto:${SUPPORT}" style="color:#9a9385;">${SUPPORT}</a>.<br/>
        <a href="https://x.com/realskincarecom" style="color:#9a9385;">X</a> ·
        <a href="https://www.instagram.com/realskincare_com/" style="color:#9a9385;">Instagram</a> ·
        <a href="https://www.facebook.com/real.skincare1" style="color:#9a9385;">Facebook</a><br/>
        <a href="{% unsubscribe %}" style="color:#9a9385;text-decoration:underline;">Unsubscribe</a>
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;
}
