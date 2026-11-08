// lib/email-campaign.js
//
// Designed, image-led PROMO campaign layout (Sean, 2026-11-08: "Lets design these emails
// instead of sending out the text heavy versions"). Per the email-design skill, promotions
// get the designed treatment and education/onboarding stays plain; this module is for the
// first kind only.
//
// It renders section blocks into the shared chrome of lib/email-render.js (logo header,
// footer, unsubscribe line, palette / origin-claim / shipping-threshold guards), using
// that module's cardPadding: '0' so the hero can run edge to edge, and extraCss so columns
// stack on a phone. Nothing here may introduce a colour outside brand-kit.json; the shared
// renderer throws if it does.
//
// Palette (brand-kit.json): black, grey #EDEDED, white (the sand #EDE5D8 is the page behind the card); green #AEDEAC is the
// ONE accent per email, spent on the step-number circles.

import { renderEmail } from './email-render.js';

const HEAD = "Cabin,'Trebuchet MS','Segoe UI',Tahoma,sans-serif";
const BODY = "Outfit,'Helvetica Neue',Helvetica,Arial,sans-serif";
const INK = '#000000';
const RULE = '#EDEDED';
const GREEN = '#AEDEAC';
const WHITE = '#FFFFFF';

export const CAMPAIGN_CSS = '@media only screen and (max-width: 480px) { '
  + '.col { display:block !important; width:100% !important; max-width:100% !important; box-sizing:border-box; } '
  + '.col-gap { padding:0 0 14px 0 !important; } '
  + '.band-h { font-size:28px !important; line-height:34px !important; } '
  + '.pad { padding-left:20px !important; padding-right:20px !important; } }';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
const table = (inner, style = '') => `<table cellpadding="0" cellspacing="0" role="presentation" width="100%" style="${style}">${inner}</table>`;

function button(text, href, { dark = true } = {}) {
  if (!href) throw new Error(`button "${text}" has an empty href`);
  const bg = dark ? INK : WHITE;
  const fg = dark ? WHITE : INK;
  return `<table cellpadding="0" cellspacing="0" role="presentation" align="center" style="margin:0 auto;"><tr>`
    + `<td align="center" bgcolor="${bg}" style="border-radius:6px;">`
    + `<a href="${href}" style="display:inline-block;padding:16px 38px;font-family:${BODY};font-size:16px;font-weight:600;letter-spacing:.3px;color:${fg};text-decoration:none;border-radius:6px;">${text}</a>`
    + `</td></tr></table>`;
}

const SECTIONS = {
  hero: (b) => `<tr><td style="padding:0;line-height:0;font-size:0;">`
    + `<a href="${b.href}" style="text-decoration:none;"><img src="${b.src}" alt="${esc(b.alt)}" width="600" `
    + `style="display:block;width:100%;max-width:600px;height:auto;border:0;"/></a></td></tr>`,

  band: (b) => {
    const dark = b.tone === 'dark';
    // Light bands are WHITE, not sand: the page behind the card is sand, so a sand band reads
    // as falling outside the card (seen in the first render, 2026-11-08).
    const bg = dark ? INK : WHITE;
    const fg = dark ? WHITE : INK;
    return `<tr><td class="pad" align="center" style="background-color:${bg};padding:34px 36px 32px;">`
      + (b.kicker ? `<p style="margin:0 0 10px;font-family:${BODY};font-size:12px;letter-spacing:2.5px;text-transform:uppercase;font-weight:600;color:${fg};">${b.kicker}</p>` : '')
      + `<h1 class="band-h" style="margin:0 0 14px;font-family:${HEAD};font-size:34px;line-height:40px;font-weight:700;color:${fg};">${b.heading}</h1>`
      + (b.text ? `<p style="margin:0 0 24px;font-family:${BODY};font-size:17px;line-height:26px;color:${fg};">${b.text}</p>` : '')
      + (b.cta ? button(b.cta.text, b.cta.href, { dark: !dark }) : '')
      + (b.fine ? `<p style="margin:16px 0 0;font-family:${BODY};font-size:13px;line-height:19px;color:${fg};">${b.fine}</p>` : '')
      + `</td></tr>`;
  },

  steps: (b) => {
    const col = (s, i) => `<td class="col col-gap" width="33%" valign="top" align="center" style="padding:0 8px;">`
      + table(`<tr><td align="center" style="padding:0 0 10px;">`
        + `<table cellpadding="0" cellspacing="0" role="presentation"><tr><td width="44" height="44" align="center" valign="middle" bgcolor="${GREEN}" `
        + `style="width:44px;height:44px;border-radius:22px;font-family:${HEAD};font-size:20px;font-weight:700;color:${INK};">${i + 1}</td></tr></table></td></tr>`
        + `<tr><td align="center" style="font-family:${HEAD};font-size:16px;line-height:22px;font-weight:700;color:${INK};padding:0 0 4px;">${s.title}</td></tr>`
        + `<tr><td align="center" style="font-family:${BODY};font-size:14px;line-height:20px;color:${INK};">${s.text}</td></tr>`)
      + `</td>`;
    return `<tr><td class="pad" style="padding:30px 28px 10px;">`
      + (b.heading ? `<p style="margin:0 0 20px;text-align:center;font-family:${HEAD};font-size:20px;font-weight:700;color:${INK};">${b.heading}</p>` : '')
      + table(`<tr>${b.items.map(col).join('')}</tr>`)
      + `</td></tr>`;
  },

  products: (b) => {
    const card = (p) => `<td class="col col-gap" width="50%" valign="top" style="padding:0 7px 14px;">`
      + table(`<tr><td style="padding:0;line-height:0;font-size:0;"><a href="${p.href}"><img src="${p.img}" alt="${esc(p.name)}" width="250" `
        + `style="display:block;width:100%;height:auto;border:0;border-radius:10px 10px 0 0;"/></a></td></tr>`
        + `<tr><td style="padding:14px 14px 16px;">`
        + `<p style="margin:0 0 4px;font-family:${HEAD};font-size:16px;line-height:21px;font-weight:700;color:${INK};">${p.name}</p>`
        + (p.note ? `<p style="margin:0 0 8px;font-family:${BODY};font-size:13px;line-height:18px;color:${INK};">${p.note}</p>` : '')
        + `<p style="margin:0 0 10px;font-family:${BODY};font-size:16px;font-weight:600;color:${INK};">${p.price}</p>`
        + `<a href="${p.href}" style="font-family:${BODY};font-size:14px;font-weight:600;color:${INK};text-decoration:underline;">${p.link ?? 'Shop now'}</a>`
        + `</td></tr>`, `border:1px solid ${RULE};border-radius:10px;`)
      + `</td>`;
    const rows = [];
    for (let i = 0; i < b.items.length; i += 2) rows.push(`<tr>${b.items.slice(i, i + 2).map(card).join('')}</tr>`);
    return `<tr><td class="pad" style="padding:26px 21px 6px;">`
      + (b.heading ? `<p style="margin:0 0 18px;text-align:center;font-family:${HEAD};font-size:20px;font-weight:700;color:${INK};">${b.heading}</p>` : '')
      + table(rows.join(''))
      + `</td></tr>`;
  },

  link: (b) => {
    if (!b.href) throw new Error(`link "${b.text}" has an empty href`);
    return `<tr><td class="pad" align="center" style="padding:8px 32px 22px;">`
      + `<a href="${b.href}" style="font-family:${BODY};font-size:16px;font-weight:600;color:${INK};text-decoration:underline;">${b.text}</a></td></tr>`;
  },

  text: (b) => `<tr><td class="pad" align="center" style="padding:6px 36px 22px;">`
    + `<p style="margin:0;font-family:${BODY};font-size:16px;line-height:24px;color:${INK};">${b.html}</p></td></tr>`,

  signoff: (b) => `<tr><td class="pad" style="padding:10px 36px 32px;">`
    + `<p style="margin:0 0 6px;font-family:${BODY};font-size:16px;line-height:24px;color:${INK};">Take care,<br/><strong>Sean</strong><br/><span style="font-size:14px;">Co-Founder, Real Skin Care</span></p>`
    + (b.ps ? `<p style="margin:20px 0 0;padding-top:18px;border-top:1px solid ${RULE};font-family:${BODY};font-size:15px;line-height:23px;color:${INK};"><strong>PS:</strong> ${b.ps}</p>` : '')
    + `</td></tr>`,
};

/** Render a designed promo campaign. Returns full email HTML (footer em dash removed). */
export function renderCampaign({ preheader, sections }) {
  const body = table(sections.map((s) => {
    const fn = SECTIONS[s.type];
    if (!fn) throw new Error(`unknown campaign section: ${s.type}`);
    return fn(s);
  }).join('\n'));
  const html = renderEmail({ preheader, format: 'designed', cardPadding: '0', extraCss: CAMPAIGN_CSS, blocks: [{ type: 'raw', html: body }] });
  const before = 'Unsubscribe here — no hard feelings.';
  if (!html.includes(before)) throw new Error('renderer footer changed; re-check the unsubscribe line');
  return html.replace(before, 'Unsubscribe here, no hard feelings.');
}

/** Every customer-visible string in a campaign, for the claim gate. */
export function campaignCopy({ subject, preheader, sections }) {
  const out = { subject, preheader };
  sections.forEach((s, i) => {
    for (const k of ['kicker', 'heading', 'text', 'fine', 'html', 'ps', 'alt']) if (s[k]) out[`${s.type}${i}.${k}`] = s[k];
    if (s.cta) out[`${s.type}${i}.cta`] = s.cta.text;
    for (const [j, it] of (s.items ?? []).entries()) {
      for (const k of ['title', 'text', 'name', 'note', 'price', 'link']) if (it[k]) out[`${s.type}${i}.${j}.${k}`] = it[k];
    }
  });
  return out;
}
