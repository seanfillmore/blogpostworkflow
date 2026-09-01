// lib/giveaway/frustration-campaigns.js
/**
 * The four pre-draw, full-price sends, one per answer to the survey's "biggest
 * frustration" question.
 *
 * WHY THIS EXISTS: the giveaway defers every offer to day 30 by design, which also
 * defers every revenue signal past the point the budget is spent. Spec §7.1 named the
 * mitigation — "One full-price send at day 12-15 to the reactive/fragrance segment
 * featuring the Set" — and it was never built. This is that send, widened from one
 * segment to all four because `gv_frustration` already partitions the list for free.
 *
 * ── ONE PRODUCT, FOUR ANGLES ────────────────────────────────────────────────────────
 *
 * Every segment points at the SAME product (the Sensitive Skin Set). That is deliberate
 * and it is the whole experimental design: with the SKU held constant, a difference in
 * orders between segments is attributable to the ANGLE and to nothing else. Give each
 * segment its own product and you have changed two variables at once on a list of 1,844
 * people, which is not enough volume to separate them again afterwards.
 *
 * The Set genuinely answers all four answers, which is what makes holding it constant
 * honest rather than lazy: it carries the Body Cream for `dry` ("more than a lotion"),
 * short tolerable ingredient lists for `reactive`, eight ingredients across two products
 * for `ingredients`, and no fragrance or masking fragrance for `fragrance`.
 *
 * `secondary` varies where a cheaper entry point is the natural next line. It is never
 * the measured CTA.
 *
 * ── TWO GATES RUN AT RENDER TIME, NOT IN A SEPARATE LINTER ──────────────────────────
 *
 * `assertNoHealthClaims` is IMPORTED from agents/ad-studio/health-claims.js and never
 * redefined here. A second copy of those patterns would drift from the first, and the
 * copy that drifts is the one guarding the email that actually sends. Same reasoning as
 * AWARENESS_LEVELS being imported rather than restated in lib/demand-questions.js.
 *
 * The sweepstakes gate is local because it is specific to sending into an OPEN contest:
 * every one of these emails sells to someone whose entry is still live, so each must
 * carry the no-purchase-necessary line. An offer email that implies buying improves the
 * odds is the one thing a sweepstakes genuinely cannot do, and the failure mode is a
 * regulator rather than a bad open rate. Both gates throw at render, so an email that
 * violates either cannot reach a template, let alone a send.
 */

import { assertNoHealthClaims } from '../../agents/ad-studio/health-claims.js';

/** Sponsor + contest chrome. Mirrors data/giveaway/nurture/*.html — same audience, same rules. */
const BG = '#f5f1ea';
const GREEN = '#2f5e3f';
const INK = '#2b2b2b';
const BODY_INK = '#3d3d3d';
const MUTED = '#9a9385';
const RULE = '#e6e0d5';

const SITE = 'https://www.realskincare.com';

/**
 * Required verbatim in every send. Read the whole thing before shortening it: the three
 * sentences do three different jobs (no purchase necessary / no improved odds / purchases
 * earn nothing), and dropping any one of them leaves a gap a plaintiff can stand in.
 */
export const NO_PURCHASE_LINE =
  'No purchase necessary. A purchase will not improve your chances of winning. Purchases do not earn entries.';

/** The four values agents/dashboard/routes/giveaway.js accepts for gv_frustration. */
export const FRUSTRATION_KEYS = ['dry', 'reactive', 'ingredients', 'fragrance'];

const SET = {
  handle: 'sensitive-skin-starter-set',
  name: 'Sensitive Skin Moisturizing Set',
  price: '$46.80',
};

/**
 * The EWG figure, with its hedge and its date welded on.
 *
 * The retired angle p2a2 quoted EWG's 2004 figure of 126, which EWG's own 2023 re-run
 * revised DOWN to 112 — so the old angle was both stale and backwards on the trend. This
 * is the current figure, and it is stated as an INGREDIENT COUNT and explicitly disclaimed
 * as not a safety verdict. Framed as toxicity it would be both unsupported by the source
 * and a health claim; framed as a count it is neither.
 */
const EWG_PARA =
  'A 2023 survey of 2,200 U.S. adults by EWG and Morning Consult found people use around ' +
  '12 personal care products a day, which can put them in contact with as many as 112 ' +
  'unique chemical ingredients. That is an ingredient count, not a safety verdict — we are ' +
  'not making a claim about any one of them. It is only the reason a label short enough to ' +
  'read is worth something.';

/**
 * One spec per segment. Copy lives here rather than in HTML files so both gates can run
 * over the strings themselves — a gate that only ever sees rendered markup is a gate that
 * can be defeated by an edit to the markup.
 */
export const SEGMENTS = [
  {
    key: 'dry',
    label: 'Dry skin',
    subject: 'You said dry skin. This is the one we would hand you.',
    preheader: 'Eight ingredients across two products, and one of them is a cream.',
    headline: 'You told us dry skin was the problem.',
    paras: [
      'When we asked what frustrates you most, you picked dry skin. So did more people than picked anything else — it was the most common answer by a wide margin.',
      'The Sensitive Skin Moisturizing Set is a lotion and a cream rather than one bottle, because they do different jobs. The Body Lotion is six ingredients on a cold-pressed virgin coconut oil base. The Body Cream is for skin that needs more than a lotion — it drops the jojoba and adds organic beeswax, which holds moisture in without sealing the skin the way petrolatum does.',
      'Both are handmade in small batches in the USA.',
    ],
    ctaLabel: 'See the Set',
    secondary: null,
  },
  {
    key: 'reactive',
    label: 'Reactive / itchy',
    subject: 'You said your skin reacts. Start with a shorter list.',
    preheader: 'Eight ingredients across two products. No added fragrance in either.',
    headline: 'You told us your skin reacts to things.',
    paras: [
      'That was your answer when we asked about your biggest frustration, and it is the one we hear most from people who have already worked through a shelf of bottles.',
      'The Sensitive Skin Moisturizing Set is the shortest full routine we make: eight ingredients across two products, no added fragrance, no synthetic preservative. Organic jojoba is in the lotion because it is close enough to skin\'s own sebum to absorb without leaving a film.',
      'We are not going to promise you what it will do. What we can do is tell you exactly what is in it, which takes about five seconds to read.',
    ],
    ctaLabel: 'See what is in it',
    secondary: null,
  },
  {
    key: 'ingredients',
    label: 'Ingredients',
    subject: 'Eight ingredients. You can read the whole label.',
    preheader: 'You said ingredients were the frustration. So here is the count.',
    headline: 'You said it was the ingredients.',
    paras: [
      EWG_PARA,
      'The Sensitive Skin Moisturizing Set is eight ingredients across two products. The Body Lotion is six of them: purified spring water, organic virgin coconut oil, organic jojoba, organic plant-based emulsifying wax, organic red palm oil and organic grapefruit seed extract. The Body Cream shares five, swaps the jojoba for organic beeswax, and adds organic palm stearic.',
      'That is the entire list. There is no line on it we would have to explain to you.',
    ],
    ctaLabel: 'Read the full list',
    secondary: null,
  },
  {
    key: 'fragrance',
    label: 'Fragrance',
    subject: 'Most "unscented" soap isn\'t. Ours is.',
    preheader: 'You said fragrance. Here is the formulation shortcut behind that word.',
    headline: 'Most "unscented" soap isn\'t. Ours is.',
    paras: [
      'You told us fragrance was your biggest frustration, so here is a category fact worth having: plenty of products labelled "unscented" still carry a masking fragrance on the panel. Fragrance goes in to cover the smell of the base, a neutralising compound goes on top of that, and the label still reads "unscented" because no scent is the intended result — even though fragrance is in there.',
      'Nothing we make is built that way. The Sensitive Skin Moisturizing Set has no fragrance and no masking fragrance in either product, because nothing in it needs covering up.',
      'If you would rather start smaller, the Pure Unscented bar is the same idea for $11 — it is also the bar at the centre of this giveaway.',
    ],
    ctaLabel: 'See the Set',
    secondary: { label: 'Or just the $11 bar', handle: 'coconut-soap' },
  },
];

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const P = (t) =>
  `<p style="margin:0 0 16px;font-family:Helvetica,Arial,sans-serif;font-size:16px;line-height:24px;color:${BODY_INK};">${t}</p>`;

const BUTTON = (href, label) =>
  `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0;"><tr>` +
  `<td align="center" bgcolor="${GREEN}" style="border-radius:6px;">` +
  `<a href="${href}" style="display:inline-block;padding:14px 30px;font-family:Helvetica,Arial,sans-serif;` +
  `font-size:16px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:6px;">${esc(label)}</a>` +
  `</td></tr></table>`;

/**
 * Render one segment's email.
 *
 * Throws rather than warns on a gate failure. These are outbound to ~1,844 people in an
 * open contest; a warning in a build log is not a control.
 */
export function renderFrustrationEmail(spec) {
  if (!spec || !FRUSTRATION_KEYS.includes(spec.key)) {
    throw new Error(`unknown frustration segment: ${spec && spec.key}`);
  }

  // Gate 1 — cosmetic, not drug. Runs over the SOURCE strings, so markup cannot hide a claim.
  assertNoHealthClaims({
    [`${spec.key}:subject`]: spec.subject,
    [`${spec.key}:preheader`]: spec.preheader,
    [`${spec.key}:headline`]: spec.headline,
    [`${spec.key}:body`]: spec.paras,
    [`${spec.key}:cta`]: spec.ctaLabel,
    [`${spec.key}:secondary`]: spec.secondary ? spec.secondary.label : '',
  });

  // Gate 2 — this is a full-price send. A discount code here would spend the consolation
  // offer three weeks early, which is the one thing §7.1 traded the entry-moment for.
  const all = [spec.subject, spec.preheader, spec.headline, ...spec.paras, spec.ctaLabel].join(' ');
  const code = all.match(/\bSOAP4MO|SOAP6MO|FIRST20|NEWCUSTOMER\b/i);
  if (code) throw new Error(`${spec.key}: contains discount code "${code[0]}" — this send is full price`);

  const setUrl = `${SITE}/products/${SET.handle}`;
  const body = spec.paras.map((t) => P(esc(t))).join('');
  const secondary = spec.secondary
    ? `<p style="margin:0 0 16px;font-family:Helvetica,Arial,sans-serif;font-size:14px;line-height:22px;color:${MUTED};">` +
      `<a href="${SITE}/products/${spec.secondary.handle}" style="color:${GREEN};">${esc(spec.secondary.label)}</a></p>`
    : '';

  const html = `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<meta name="color-scheme" content="light dark"/>
<meta name="supported-color-schemes" content="light dark"/>
<title>Real Skin Care</title>
</head>
<body style="margin:0;padding:0;background-color:${BG};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(spec.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:${BG};">
  <tr><td align="center" style="padding:24px 12px;">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">
      <tr><td align="center" style="padding:8px 0 20px;">
        <a href="${SITE}" style="font-family:Georgia,'Times New Roman',serif;font-size:22px;letter-spacing:2px;color:${GREEN};text-decoration:none;font-weight:700;">REAL SKIN CARE</a>
      </td></tr>
      <tr><td style="background-color:#ffffff;border-radius:12px;padding:36px 32px;">
        <h1 style="margin:0 0 16px;font-family:Georgia,serif;font-size:24px;line-height:30px;color:${INK};">${esc(spec.headline)}</h1>
        ${body}
        ${BUTTON(setUrl, spec.ctaLabel)}
        ${secondary}
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:28px 0 0;border-top:1px solid ${RULE};"><tr><td style="padding:20px 0 0;">
          <p style="margin:0;font-family:Helvetica,Arial,sans-serif;font-size:14px;line-height:22px;color:${BODY_INK};">Your entries are not affected by any of this. You are already in for the drawing on September 16, whether you buy something or not.</p>
        </td></tr></table>
        <p style="margin:16px 0 0;font-family:Helvetica,Arial,sans-serif;font-size:12px;line-height:18px;color:${MUTED};">${NO_PURCHASE_LINE}</p>
      </td></tr>
      <tr><td align="center" style="padding:22px 16px;font-family:Helvetica,Arial,sans-serif;font-size:12px;line-height:18px;color:${MUTED};">
        This is a promotional email about the "Win 36 Free Bars" giveaway, sponsored by Real Skin Care, 1623 Central Ave STE 201, Cheyenne, WY 82001, United States. The address above is Sponsor's mailing address for correspondence only — RSC products are made in the USA.<br/>
        Questions? Just reply, or email <a href="mailto:support@realskincare.com" style="color:${MUTED};">support@realskincare.com</a>. <a href="${SITE}/pages/giveaway-official-rules" style="color:${MUTED};">Official rules</a>.<br/>
        <a href="https://www.instagram.com/realskincare_com/" style="color:${MUTED};">Instagram</a><br/>
        <a href="{% unsubscribe_link %}" style="color:${MUTED};text-decoration:underline;">Unsubscribe</a> — unsubscribing does not forfeit your entry. Your entry stays valid for the drawing either way.
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;

  // Gate 3 — the contest chrome survived rendering. Cheap to assert, and the failure it
  // catches (a refactor that drops the footer) is silent everywhere else.
  for (const [what, needle] of [
    ['no-purchase line', NO_PURCHASE_LINE],
    // `_link` is the URL-only spelling and is the one that belongs inside an href.
    // Asserting the exact string rather than either spelling is deliberate: the bare
    // `{% unsubscribe %}` here would render href="<a class=" and leak the footer markup
    // as visible text, so this needle is what keeps the correct one in place.
    ['unsubscribe tag', '{% unsubscribe_link %}'],
    ['official rules link', '/pages/giveaway-official-rules'],
  ]) {
    if (!html.includes(needle)) throw new Error(`${spec.key}: rendered email is missing the ${what}`);
  }

  return html;
}

/** Klaviyo segment definition for one frustration answer. */
export function segmentDefinition(key) {
  if (!FRUSTRATION_KEYS.includes(key)) throw new Error(`unknown frustration segment: ${key}`);
  return {
    condition_groups: [
      {
        conditions: [
          {
            type: 'profile-property',
            property: 'properties[\'gv_frustration\']',
            filter: { type: 'string', operator: 'equals', value: key },
          },
        ],
      },
    ],
  };
}

/** Render all four. Any gate failure takes the whole run down — none of them ship alone. */
export function renderAll() {
  return SEGMENTS.map((spec) => ({ ...spec, html: renderFrustrationEmail(spec) }));
}
