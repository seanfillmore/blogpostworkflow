/**
 * The "follow us on Instagram" block used in Post-Purchase 01 and 02 (added live
 * 2026-11-04, Sean-approved copy). Shared by data/brand/email-rebuild/specs.js and
 * scripts/klaviyo-add-instagram-block.mjs so the live edit and a future rebuild carry
 * the same markup.
 */
export const IG = 'https://www.instagram.com/realskincare_com/';

export const BLOCK_COPY = {
  heading: 'Come say hi on Instagram',
  body: 'We post quick how-tos (like switching to an aluminum-free deodorant, or what is actually in your toothpaste), real reviews from customers, and a new creator video every day. Come follow along.',
  button: 'Follow @realskincare_com',
};

const BODY_FONT = "Outfit,'Helvetica Neue',Helvetica,Arial,sans-serif";
const HEAD_FONT = "Cabin,'Trebuchet MS','Segoe UI',Tahoma,sans-serif";
export const INSTAGRAM_FOLLOW_BLOCK = `<table cellpadding="0" cellspacing="0" role="presentation" width="100%" style="margin:8px 0 20px;border-top:1px solid #EDEDED;" data-rsc-block="instagram-follow">
<tr><td style="padding-top:18px;">
<p style="margin:0 0 6px;font-family:${HEAD_FONT};font-size:18px;line-height:24px;font-weight:700;color:#000000;">${BLOCK_COPY.heading}</p>
<p style="margin:0 0 14px;font-family:${BODY_FONT};font-size:16px;line-height:24px;color:#000000;">${BLOCK_COPY.body}</p>
<a href="${IG}" style="display:inline-block;padding:12px 22px;background-color:#000000;color:#FFFFFF;border-radius:8px;font-family:${BODY_FONT};font-size:15px;font-weight:700;text-decoration:none;">${BLOCK_COPY.button}</a>
</td></tr>
</table>
`;

