// lib/creator-outreach.js
//
// The pure half of agents/creator-outreach: who gets which email and when,
// what the scheduled emails say, and the rules an automatic REPLY to a creator
// must pass before it is sent. No I/O, so every decision is something a test
// constructs.
//
// ── What this is for ────────────────────────────────────────────────────────────
//
// Trybe ships free samples to UGC creators (Shopify $0 orders, see
// lib/trybe-samples.js). Most creators go quiet after the box arrives: on
// 2026-10-02, 22 samples had shipped and 3 creators had posted. Priming them
// while the product is fresh, with a brief that says what good content looks
// like, is the lever. Trybe's API cannot message a creator, so this emails them
// from sean@realskincare.com (lib/hushmail.js) on a fixed cadence, and answers
// their replies quickly instead of waiting for Sean.
//
// ── The cadence (scheduled emails) ──────────────────────────────────────────────
//
//   welcome   once, when a sample has SHIPPED: thanks + the content brief
//   nudge1    sample delivered 5+ days, products still without content
//   nudge2    delivered 12+ days, 5+ days after nudge1
//   final     delivered 21+ days, 7+ days after nudge2; then the ladder STOPS
//   thanks    once per newly APPROVED submission
//
// Guards, all of which only ever SUPPRESS a send: an opted-out creator gets
// nothing ever; a creator who emailed us in the last 3 days, or whose thread is
// waiting on Sean, gets no scheduled mail (the conversation is live); no two
// scheduled emails to one person within 48h; no nudge within 5 days of their
// latest submission; one scheduled email per creator per run; a per-run cap;
// scheduled mail only goes out in a US business-hours window.
//
// Scheduled emails are FIXED TEMPLATES, not model output: they are what the
// brand says unprompted, so they are written once, reviewed, and tested.
//
// ── Replies ─────────────────────────────────────────────────────────────────────
//
// A model drafts the reply from facts this module assembles (their orders,
// tracking, products, submissions). It may answer shipping, product, brief and
// how-to-submit questions. Anything about money, terms, a damaged or missing
// item, a skin reaction, or legal language is ESCALATED: the creator gets a
// short holding reply and Sean gets an immediate email with the thread. The
// escalation check is deterministic and runs on the creator's words BEFORE the
// model is asked anything, and again on the model's draft, because a model
// promising a refund or a free reship is the failure that costs real money.
// Every outgoing reply also passes the fleet's commercial health-claim gate.

import {
  isTrybeSampleOrder, creatorNameFromOrder, shipmentState, normName,
} from './trybe-samples.js';
import { checkSeoCopyFields, COMMERCIAL_SURFACE } from './seo-copy-health-gate.js';

const DAY = 86_400_000;
const HOUR = 3_600_000;

export const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  // 'resend' on the server: DigitalOcean blocks outbound SMTP. See lib/hushmail.js.
  sendVia: 'resend',
  nudge1AfterDays: 5,
  nudge2AfterDays: 12,
  finalAfterDays: 21,
  minGapHours: 48,
  quietAfterReplyDays: 3,
  quietAfterSubmissionDays: 5,
  maxScheduledPerRun: 15,
  maxRepliesPerCreatorPerDay: 3,
  // A thank-you for a video submitted weeks ago reads as a form letter.
  thankWithinDays: 14,
  // 16:00-24:00 UTC = 9am-5pm PDT / 8am-4pm PST.
  sendWindowUtc: [16, 24],
});

export const SIGNATURE = 'Sean\nReal Skin Care\nrealskincare.com';

// ── Roster ──────────────────────────────────────────────────────────────────────

export function firstName(name) {
  const first = String(name || '').trim().split(/\s+/)[0] || '';
  if (!first || /[#@\d]/.test(first)) return 'there';
  return first.charAt(0).toUpperCase() + first.slice(1);
}

/**
 * One row per creator EMAIL, built from Shopify sample orders and Trybe
 * submissions. A creator with no email on any order cannot be contacted and is
 * left out.
 */
export function buildRoster({ orders = [], submissions = [] }) {
  const byEmail = new Map();
  for (const order of orders.filter(isTrybeSampleOrder)) {
    const email = String(order.email || '').trim().toLowerCase();
    if (!email) continue;
    const ship = shipmentState(order);
    if (ship.state === 'cancelled') continue;
    const name = creatorNameFromOrder(order);
    if (!byEmail.has(email)) byEmail.set(email, { email, name, firstName: firstName(name), orders: [] });
    const f = (order.fulfillments || [])[0] || {};
    const t = (f.trackingInfo || [])[0] || {};
    byEmail.get(email).orders.push({
      name: order.name,
      createdAt: order.createdAt,
      products: (order.lineItems?.nodes || order.lineItems || []).map((l) => l.title).filter(Boolean),
      state: ship.state,
      carrierStatus: ship.carrierStatus,
      deliveredAt: ship.deliveredAt,
      eta: ship.eta,
      carrier: t.company || null,
      trackingNumber: t.number || null,
      trackingUrl: t.url || null,
    });
  }

  for (const c of byEmail.values()) {
    const key = normName(c.name);
    const mine = (submissions || []).filter((s) => normName(s?.creator?.name) === key);
    const covered = new Set(mine.flatMap((s) => (s.products || []).map((p) => normName(p.name))));
    c.products = [...new Set(c.orders.flatMap((o) => o.products))];
    c.submissions = mine.map((s) => ({
      id: s.id, status: s.status, createdAt: s.created_at, products: (s.products || []).map((p) => p.name),
    }));
    // Only DELIVERED products are owed content; an in-transit box is not.
    const delivered = c.orders.filter((o) => o.state === 'delivered');
    c.missing = [...new Set(delivered.flatMap((o) => o.products))].filter((p) => !covered.has(normName(p)));
    c.shipped = c.orders.some((o) => o.state !== 'unshipped');
    const dates = delivered.map((o) => o.deliveredAt).filter(Boolean).sort();
    // An order Shopify calls delivered with no date is treated as delivered at
    // creation, which makes it due sooner rather than never.
    if (delivered.some((o) => !o.deliveredAt)) dates.unshift(delivered.find((o) => !o.deliveredAt).createdAt);
    c.firstDeliveredAt = dates[0] || null;
    c.latestSubmissionAt = c.submissions.map((s) => s.createdAt).filter(Boolean).sort().pop() || null;
  }
  return [...byEmail.values()];
}

// ── Templates ───────────────────────────────────────────────────────────────────
// No em dashes anywhere in these: Sean's rule for any copy sent in his name.

const list = (items) => {
  const xs = [...items];
  if (xs.length <= 1) return xs.join('');
  return `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;
};

/** "Coconut Moisturizer | 4oz" -> "Coconut Moisturizer", for readable prose. */
export function shortProduct(title) {
  return String(title).split(/\s+[|—-]\s+/)[0].split(/\s+(?:made with|with only)\b/i)[0].trim();
}

const BRIEF = [
  'What works best for us:',
  '1. Open with a question or a strong line in the first 2 seconds, like "Have you ever read the ingredients in your lotion?"',
  '2. Say one specific fact from the product page, like how many ingredients it has or what it leaves out.',
  '3. Show it in use and tell us honestly how it feels, smells and fits your routine.',
  '4. End with "tap the link to check it out."',
  '',
  'Filming: vertical on your phone, under 25 seconds, phone propped or braced, auto-zoom off, natural light. No filter or color grade needed, real looks best.',
  '',
  'One rule we have to be strict about: our products are cosmetics, so please talk about how they look, feel and smell and how they fit your routine, and don\'t describe them as fixing any medical, skin or dental condition. "Great for my dry skin" is perfect. Anything that sounds like a medical result is something we can\'t use.',
  '',
  'When it\'s ready, upload it in Trybe and we\'ll review it within a day or two.',
].join('\n');

export function renderTemplate(kind, c, extra = {}) {
  const hi = `Hi ${c.firstName},`;
  const products = list(c.products.map(shortProduct));
  const missing = list((c.missing.length ? c.missing : c.products).map(shortProduct));
  switch (kind) {
    case 'welcome': {
      const arrived = c.orders.some((o) => o.state === 'delivered');
      return {
        subject: 'Your Real Skin Care samples + what works best',
        text: [
          hi, '',
          `Thank you so much for joining our creator program! Your ${products} ${arrived ? 'should be with you now' : 'are on the way'}, and I wanted to share what makes a great video for us so your content gets approved and used.`,
          '', BRIEF, '',
          'If you have any questions at all, just reply to this email.', '', SIGNATURE,
        ].join('\n'),
      };
    }
    case 'nudge1':
      return {
        subject: 'Re: Your Real Skin Care samples + what works best',
        text: [
          hi, '',
          `Just checking in! Your ${missing} should have arrived about a week ago. How are you liking ${c.missing.length > 1 ? 'them' : 'it'} so far?`,
          '',
          'Whenever you\'re ready to film, the quick version of the brief: a strong first line, one specific fact about the product, show it in use, and keep it under 25 seconds. If anything is unclear or something arrived damaged, just reply and let me know.',
          '', SIGNATURE,
        ].join('\n'),
      };
    case 'nudge2':
      return {
        subject: 'Re: Your Real Skin Care samples + what works best',
        text: [
          hi, '',
          `Hope you've had a chance to try the ${missing}! We'd love to see your video when it's ready.`,
          '',
          'A format that has worked really well for other creators: start with a question ("Have you ever looked at everything in your body lotion?"), name one ingredient fact, show it on your skin, then "tap the link to check it out." Simple and real beats polished.',
          '',
          'Is there anything I can help with, or anything holding you back?',
          '', SIGNATURE,
        ].join('\n'),
      };
    case 'final':
      return {
        subject: 'Re: Your Real Skin Care samples + what works best',
        text: [
          hi, '',
          `One last friendly note about the ${missing}. If you still plan to make a video, upload it in Trybe whenever it suits you. If it ended up not being a fit, no problem at all, and thank you for giving it a try.`,
          '',
          'I won\'t keep reminding you. Reply any time if you have questions.',
          '', SIGNATURE,
        ].join('\n'),
      };
    case 'thanks': {
      const what = list((extra.products || []).map(shortProduct)) || 'new';
      const noun = (extra.submissionIds || []).length > 1 ? 'videos' : 'video';
      const more = c.missing.length ? ` If you'd like to make one for the ${missing} too, we'd love that.` : '';
      return {
        subject: 'Thank you for your video!',
        text: [
          hi, '',
          `We just approved your ${what} ${noun}. Thank you, ${noun === 'videos' ? 'they are' : 'it\'s'} exactly the kind of content we were hoping for.${more}`,
          '', SIGNATURE,
        ].join('\n'),
      };
    }
    default:
      throw new Error(`creator-outreach: unknown template ${kind}`);
  }
}

// ── Scheduled plan ──────────────────────────────────────────────────────────────

const ago = (iso, now) => (iso ? (now - Date.parse(iso)) : Infinity);

export function inSendWindow(now, [from, to] = DEFAULT_CONFIG.sendWindowUtc) {
  const h = new Date(now).getUTCHours();
  return h >= from && h < to;
}

/** The creator's record in the state file, with defaults. */
export function creatorState(state, email) {
  const s = state?.creators?.[email] || {};
  return {
    sent: s.sent || {},
    thanked: s.thanked || [],
    optedOut: Boolean(s.optedOut),
    escalatedOpen: Boolean(s.escalatedOpen),
    lastInboundAt: s.lastInboundAt || null,
    lastScheduledAt: s.lastScheduledAt || null,
    threadMessageId: s.threadMessageId || null,
  };
}

/**
 * What scheduled email, if any, each creator is due. One per creator, oldest
 * delivery first, capped per run.
 * @returns {{sends: object[], suppressed: object[], outsideWindow: boolean}}
 */
export function planScheduled(roster, state, { now = Date.now(), config = DEFAULT_CONFIG } = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const outsideWindow = !inSendWindow(now, cfg.sendWindowUtc);
  const sends = [];
  const suppressed = [];
  const ordered = [...roster].sort((a, b) => String(a.firstDeliveredAt || '9').localeCompare(String(b.firstDeliveredAt || '9')));

  for (const c of ordered) {
    const st = creatorState(state, c.email);
    const skip = (reason) => suppressed.push({ email: c.email, name: c.name, reason });
    if (st.optedOut) { skip('opted out'); continue; }
    if (st.escalatedOpen) { skip('waiting on Sean'); continue; }
    if (ago(st.lastInboundAt, now) < cfg.quietAfterReplyDays * DAY) { skip('replied recently'); continue; }
    if (ago(st.lastScheduledAt, now) < cfg.minGapHours * HOUR) { skip('emailed recently'); continue; }

    let kind = null;
    let extra = {};
    const newlyApproved = c.submissions.filter((s) => s.status === 'approved' && !st.thanked.includes(s.id)
      && ago(s.createdAt, now) < cfg.thankWithinDays * DAY);
    const sinceDelivery = ago(c.firstDeliveredAt, now);
    const quietSubmission = ago(c.latestSubmissionAt, now) < cfg.quietAfterSubmissionDays * DAY;

    if (!st.sent.welcome && c.shipped && !c.submissions.length) kind = 'welcome';
    else if (newlyApproved.length) {
      kind = 'thanks';
      extra = { submissionIds: newlyApproved.map((s) => s.id), products: [...new Set(newlyApproved.flatMap((s) => s.products))] };
    } else if (c.missing.length && c.firstDeliveredAt && !quietSubmission) {
      if (!st.sent.nudge1 && sinceDelivery >= cfg.nudge1AfterDays * DAY) kind = 'nudge1';
      else if (st.sent.nudge1 && !st.sent.nudge2 && sinceDelivery >= cfg.nudge2AfterDays * DAY
        && ago(st.sent.nudge1, now) >= 5 * DAY) kind = 'nudge2';
      else if (st.sent.nudge2 && !st.sent.final && sinceDelivery >= cfg.finalAfterDays * DAY
        && ago(st.sent.nudge2, now) >= 7 * DAY) kind = 'final';
    }
    if (!kind) continue;
    if (sends.length >= cfg.maxScheduledPerRun) { skip(`over the per-run cap (${kind} next run)`); continue; }
    sends.push({ email: c.email, name: c.name, kind, extra, ...renderTemplate(kind, c, extra) });
  }
  return { sends: outsideWindow ? [] : sends, deferredByWindow: outsideWindow ? sends : [], suppressed, outsideWindow };
}

// ── Replies ─────────────────────────────────────────────────────────────────────

/** Topics a creator raises that only Sean can answer. Matched on THEIR words. */
export const ESCALATE_PATTERNS = [
  ['money or terms', /\b(pay|paid|payment|payout|commission|rate|rates|fee|fees|invoice|contract|agreement|usage rights?|exclusiv\w*|whitelist\w*|budget|compensat\w*|cash|venmo|paypal)\b/i],
  ['a skin reaction or health concern', /\b(rash\w*|react\w*|allerg\w*|burn\w*|irritat\w*|hives|itch\w*|swell\w*|breakout|broke out|sick|ill|injur\w*|hospital|doctor|pregnan\w*)\b/i],
  ['a damaged, wrong or missing item', /\b(damaged|broken|leak\w*|spill\w*|crushed|missing|wrong (item|product|scent)|never (arrived|received|got)|didn'?t (arrive|receive|get)|empty)\b/i],
  ['legal language', /\b(lawyer|attorney|legal|sue|lawsuit|ftc|report you)\b/i],
  ['a complaint', /\b(complain\w*|unacceptable|disappointed|scam|refund|angry|upset)\b/i],
];

export const OPT_OUT_PATTERN = /\b(unsubscribe|stop (emailing|messaging|contacting)|remove me|take me off|no longer interested|not interested|leave me alone|opt(ing)? out)\b/i;

const AUTO_REPLY_SUBJECT = /\b(out of (the )?office|automatic reply|auto(matic)?[- ]?reply|away from (my )?(email|desk)|vacation)\b/i;

/** What a REPLY of ours may never say; a hit escalates instead of sending. */
export const REPLY_FORBIDDEN = [
  ['a price, percentage or payment', /\$\s?\d|\d+\s?%|\b(commission|paid|payment|pay you|compensat\w*)\b/i],
  ['a promise of more product or money', /\b(send (you )?(another|a new|more|a replacement|extra)|resend|re-?ship|replacement|refund|discount|coupon|promo code|free (product|gift|bottle|box))\b/i],
  ['a deadline or obligation', /\b(must post|required to|you have to post|deadline|contract)\b/i],
];

export function classifyInbound(msg) {
  const text = `${msg.subject || ''}\n${msg.text || ''}`;
  if (msg.autoSubmitted || AUTO_REPLY_SUBJECT.test(msg.subject || '')) return { action: 'ignore', reason: 'auto-reply' };
  if (!String(msg.text || '').trim()) return { action: 'ignore', reason: 'empty after removing the quoted thread' };
  if (OPT_OUT_PATTERN.test(text)) return { action: 'opt-out' };
  const hits = ESCALATE_PATTERNS.filter(([, re]) => re.test(text)).map(([label]) => label);
  if (hits.length) return { action: 'escalate', reasons: hits };
  return { action: 'draft' };
}

/** Deterministic checks on a drafted reply. Empty array = may be sent. */
export function replyProblems(text) {
  const problems = REPLY_FORBIDDEN.filter(([, re]) => re.test(text)).map(([label]) => label);
  const { blocking } = checkSeoCopyFields({ reply: text }, { surface: COMMERCIAL_SURFACE });
  if (blocking.length) problems.push(`health claim: ${[...new Set(blocking.map((b) => b.match))].join(', ')}`);
  if (/—/.test(text)) problems.push('em dash');
  if (text.length > 1500) problems.push('too long');
  return problems;
}

export function holdingReply(c, reasons = []) {
  const reaction = reasons.includes('a skin reaction or health concern');
  return [
    `Hi ${c.firstName},`, '',
    'Thanks for getting in touch. I want to make sure you get the right answer on this, so I\'m looking into it personally and will get back to you within one business day.',
    ...(reaction ? ['', 'If you\'re having any kind of reaction, please stop using the product in the meantime.'] : []),
    '', SIGNATURE,
  ].join('\n');
}

export function optOutReply(c) {
  return [`Hi ${c.firstName},`, '', 'No problem at all, I won\'t send any more reminders. Thank you for giving us a try.', '', SIGNATURE].join('\n');
}

/** The facts the reply model may use, and nothing else. */
export function replyFacts(c) {
  return {
    creator_first_name: c.firstName,
    samples: c.orders.map((o) => ({
      order: o.name,
      products: o.products,
      status: o.state === 'unshipped' ? 'not shipped yet' : o.state === 'delivered' ? `delivered ${o.deliveredAt ? o.deliveredAt.slice(0, 10) : ''}`.trim() : `in transit (${o.carrierStatus || 'shipped'})`,
      estimated_delivery: o.eta ? o.eta.slice(0, 10) : null,
      carrier: o.carrier,
      tracking_number: o.trackingNumber,
      tracking_url: o.trackingUrl,
    })),
    submissions: c.submissions.map((s) => ({ status: s.status, products: s.products, submitted: String(s.createdAt || '').slice(0, 10) })),
    products_still_without_content: c.missing,
  };
}

export const REPLY_SYSTEM = `You answer emails from UGC creators on behalf of Sean, founder of Real Skin Care (natural coconut-oil skin care: lotions, moisturizer, soaps, toothpaste, deodorant, lip balm). Creators joined the brand's program on Trybe, received free samples, and make short videos.

Write as Sean: warm, brief, plain. 2 to 6 short sentences. Never use em dashes. Sign off exactly as:
${SIGNATURE}

You may ONLY use the FACTS provided. You may help with: shipping status and tracking, which products they received, how to film (vertical, under 25 seconds, strong first line, one specific product fact, show it in use, natural light), how to upload in Trybe, and general encouragement.

You must NOT: mention money, commission, rates or payment terms; promise any product, replacement, refund, discount or deadline; describe any product as treating, healing, curing or preventing any condition; call the deodorant an antiperspirant; invent ingredients or product claims (send them to the product page instead); make commitments on Sean's behalf.

If the email needs anything outside what you may do, or you are unsure, set "action" to "escalate".

Reply with JSON only: {"action":"reply"|"escalate","reply":"<email body, or empty if escalating>","escalate_reason":"<short reason, or empty>"}`;

export function replyPrompt(c, msg) {
  return `FACTS:\n${JSON.stringify(replyFacts(c), null, 2)}\n\nTHE CREATOR WROTE (subject: ${msg.subject || '(none)'}):\n${msg.text}`;
}

/** Parse the model's JSON, tolerating a fenced block. Throws on garbage. */
export function parseDraft(raw) {
  const s = String(raw || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const j = JSON.parse(s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1));
  if (!['reply', 'escalate'].includes(j.action)) throw new Error(`creator-outreach: bad draft action ${j.action}`);
  return { action: j.action, reply: String(j.reply || '').trim(), reason: String(j.escalate_reason || '').trim() };
}

export function replySubject(subject) {
  const s = String(subject || '').trim() || 'Your Real Skin Care samples';
  return /^re:/i.test(s) ? s : `Re: ${s}`;
}
