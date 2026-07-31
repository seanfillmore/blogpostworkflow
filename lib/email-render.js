/**
 * Render a Klaviyo email from a spec.
 *
 * The 22 live templates were hand-written, and every one of them shipped with
 * `href="{% unsubscribe %}"` — a tag that expands to a whole <a> element and leaks raw
 * markup into the footer. Twenty-two chances to get compliance markup wrong is twenty-one
 * too many, so the chrome (head, header, footer, postal address, unsubscribe) is rendered
 * once here and the per-email spec only supplies content.
 *
 * Format follows the email's job, per data/brand/email-format-matrix.md:
 *   designed — promotional. Hosted logo, dark-mode swap, hero imagery, webfont.
 *   plain    — education, onboarding, reorder. Link-light, no hero, no webfont, so it
 *              reads as a personal message and stays in the primary tab.
 *
 * Colours are validated against brand-kit.json at render time, so a retired hex like
 * #C1DF6D fails the build rather than reaching the verifier.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const KIT = JSON.parse(readFileSync(join(ROOT, 'data/brand/brand-kit.json'), 'utf8'));

const PALETTE = new Set([...KIT.palette_hexes.map((h) => h.toUpperCase()), '#FFFFFF']);
const LOGO = KIT.logo.cdn_urls;

const SAND = '#EDE5D8';
const INK = '#000000';
const RULE = '#EDEDED';
const ACCENT = '#AEDEAC';

const ADDRESS = 'Real Skin Care · 6212 FM 933, Blum, TX 76627, United States';

const HEAD_FONT = "Cabin,'Trebuchet MS','Segoe UI',Tahoma,sans-serif";
const BODY_FONT = "Outfit,'Helvetica Neue',Helvetica,Arial,sans-serif";

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function assertPalette(html) {
  const off = [...new Set((html.match(/#[0-9a-fA-F]{6}\b/g) ?? []).map((h) => h.toUpperCase()))]
    .filter((h) => !PALETTE.has(h));
  if (off.length) throw new Error(`off-palette colours: ${off.join(', ')} — brand-kit.json is the source of truth`);
}

function renderBlock(b) {
  switch (b.type) {
    case 'h1':
      return `<h1 class="h1" style="margin:0 0 12px;font-family:${HEAD_FONT};font-size:28px;line-height:34px;font-weight:700;color:${INK};">${b.text}</h1>`;

    case 'p':
      return `<p style="margin:0 0 16px;font-family:${BODY_FONT};font-size:16px;line-height:24px;color:${INK};">${b.html}</p>`;

    case 'cta': {
      if (!b.href) throw new Error(`cta "${b.text}" has an empty href — that ships a dead button`);
      const bg = b.bg ?? INK;
      return `<table cellpadding="0" cellspacing="0" role="presentation" style="margin:0 0 28px;" width="100%"><tr>`
        + `<td align="center" bgcolor="${bg}" style="border-radius:6px;">`
        + `<a href="${b.href}" style="display:inline-block;padding:15px 32px;font-family:${BODY_FONT};font-size:16px;font-weight:600;color:#FFFFFF;text-decoration:none;border-radius:6px;">${b.text}</a>`
        + `</td></tr></table>`;
    }

    case 'textlink': {
      if (!b.href) throw new Error(`textlink "${b.text}" has an empty href — that ships a dead link`);
      return `<table cellpadding="0" cellspacing="0" role="presentation" style="margin:0 0 28px;" width="100%"><tr><td align="center">`
        + `<a href="${b.href}" style="font-family:${BODY_FONT};font-size:15px;font-weight:600;color:${INK};text-decoration:underline;">${b.text}</a>`
        + `</td></tr></table>`;
    }

    case 'coupon':
      return `<table cellpadding="0" cellspacing="0" role="presentation" style="margin:0 0 24px;" width="100%"><tr><td align="center">`
        + `<table cellpadding="0" cellspacing="0" role="presentation"><tr><td style="border:2px dashed ${ACCENT};border-radius:10px;padding:14px 34px;text-align:center;">`
        + `<div style="font-family:${BODY_FONT};font-size:11px;letter-spacing:1px;text-transform:uppercase;color:${INK};">${b.label}</div>`
        + `<div style="font-family:${HEAD_FONT};font-size:24px;letter-spacing:4px;color:${INK};font-weight:700;margin-top:4px;">{% coupon_code '${b.code}' %}</div>`
        + `</td></tr></table></td></tr></table>`;

    case 'signoff':
      return `<p style="margin:0 0 6px;font-family:${BODY_FONT};font-size:16px;line-height:24px;color:${INK};">Take care,<br/><strong>Sean</strong><br/><span style="font-size:14px;">Co-Founder, Real Skin Care</span></p>`;

    case 'ps':
      return `<p style="margin:20px 0 0;padding-top:18px;border-top:1px solid ${RULE};font-family:${BODY_FONT};font-size:15px;line-height:23px;color:${INK};"><strong>PS —</strong> ${b.html}</p>`;

    case 'raw':
      return b.html;

    default:
      throw new Error(`unknown block type: ${b.type}`);
  }
}

export function renderEmail(spec) {
  const { preheader, format = 'plain', blocks = [] } = spec;

  // The skill's rule: never ship a defaulted preheader. Left to the client it renders
  // whatever the email opens with, spending the only pre-open signal on filler.
  if (!preheader || !String(preheader).trim()) {
    throw new Error('preheader is required — a defaulted preheader wastes the preview line');
  }

  const designed = format === 'designed';

  const webfont = designed
    ? `@import url('https://fonts.googleapis.com/css2?family=Cabin:wght@400;600;700&family=Outfit:wght@400;500;600&display=swap');`
    : '';

  const darkModeCss = designed
    ? `.logo-dark { display: none; }
  @media (prefers-color-scheme: dark) {
    .logo-light { display: none !important; }
    .logo-dark  { display: inline-block !important; }
  }`
    : '';

  const header = designed
    ? `<tr><td align="center" style="padding:8px 0 20px;">
<a href="https://www.realskincare.com" style="text-decoration:none;">
<img alt="Real Skin Care" class="logo-light" src="${LOGO['rsc-logo-black.png']}" style="display:inline-block;width:180px;max-width:180px;height:auto;border:0;" width="180"/>
<img alt="Real Skin Care" class="logo-dark" src="${LOGO['rsc-logo-white.png']}" style="display:none;width:180px;max-width:180px;height:auto;border:0;" width="180"/>
</a>
</td></tr>`
    : `<tr><td align="center" style="padding:8px 0 20px;font-family:${HEAD_FONT};font-size:15px;letter-spacing:2px;text-transform:uppercase;color:${INK};">
<a href="https://www.realskincare.com" style="color:${INK};text-decoration:none;">Real Skin Care</a>
</td></tr>`;

  const body = blocks.map(renderBlock).join('\n');

  const html = `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8"/>
<meta content="width=device-width, initial-scale=1" name="viewport"/>
<meta content="light dark" name="color-scheme"/>
<meta content="light dark" name="supported-color-schemes"/>
<title>Real Skin Care</title>
<style>
  ${webfont}
  ${darkModeCss}
  @media only screen and (max-width: 480px) {
    .px { padding-left: 20px !important; padding-right: 20px !important; }
    .h1 { font-size: 24px !important; line-height: 30px !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background-color:${SAND};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(preheader)}</div>
<table cellpadding="0" cellspacing="0" role="presentation" style="background-color:${SAND};" width="100%">
<tr><td align="center" style="padding:24px 12px;">
<table cellpadding="0" cellspacing="0" role="presentation" style="max-width:600px;width:100%;" width="600">

${header}

<tr><td style="background-color:#FFFFFF;border-radius:12px;padding:36px 32px;" class="px">
${body}
</td></tr>

<tr><td align="center" style="padding:22px 16px;font-family:${BODY_FONT};font-size:12px;line-height:18px;color:${INK};">
${ADDRESS}<br/>
Questions? Just reply, or email <a href="mailto:support@realskincare.com" style="color:${INK};">support@realskincare.com</a>.<br/>
<a href="https://x.com/realskincarecom" style="color:${INK};">X</a> ·
<a href="https://www.instagram.com/realskincare_com/" style="color:${INK};">Instagram</a> ·
<a href="https://www.facebook.com/real.skincare1" style="color:${INK};">Facebook</a>
</td></tr>

<tr><td align="center" style="padding:0 16px 22px;">
<a href="{% unsubscribe_link %}" style="font-family:${BODY_FONT};font-size:13px;line-height:20px;color:${INK};text-decoration:underline;">Don't want these? Unsubscribe here — no hard feelings.</a>
</td></tr>

</table>
</td></tr>
</table>
</body>
</html>
`;

  assertPalette(html);
  return html;
}
