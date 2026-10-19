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
// brand says unprompted, so they are written once, reviewed, and tested. The
// one exception is the thank-you, which a creator can receive many times: it is
// model-written and checked against every earlier one (see "Thank-you notes").
//
// ── Replies ─────────────────────────────────────────────────────────────────────
//
// A model drafts the reply from facts this module assembles (their orders,
// tracking, products, submissions). It may answer shipping, product, brief and
// how-to-submit questions. Anything about money, terms, a damaged or missing
// item, a skin reaction, or legal language is ESCALATED: NOTHING is sent to the
// creator, Sean gets an immediate email, and the agent stays silent with that
// creator until Sean has answered from Hushmail himself (Sean, 2026-10-03: a
// flagged email "should have come straight to my email and let me craft the
// response"). A canned holding reply once told a creator to stop using a
// product she had not received yet. The
// escalation check is deterministic and runs on the creator's words BEFORE the
// model is asked anything, and again on the model's draft, because a model
// promising a refund or a free reship is the failure that costs real money.
// Every outgoing reply also passes the fleet's commercial health-claim gate.

import {
  isTrybeSampleOrder, creatorNameFromOrder, shipmentState, normName,
} from './trybe-samples.js';
import { checkSeoCopyFields, COMMERCIAL_SURFACE } from './seo-copy-health-gate.js';
import { handleFor } from './creator-socials.js';
import { openingKey } from './press-followup.js';

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

/**
 * The handle request. Asks for Instagram by name, because a bare "@handle" in
 * the reply is only trusted as Instagram when we asked for Instagram
 * (lib/creator-socials.js).
 */
export const SOCIALS_ASK = 'We\'d love to tag you when we post your video. What\'s your Instagram handle? Just reply with it (or your profile link). If you\'d rather not be tagged, that\'s completely fine, just let me know.';

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
    case 'thanks':
      // The planner's placeholder. The agent replaces it with a model-written
      // note (composeThanks); this is variant 0, the template every thank-you
      // used until 2026-10-19.
      return renderThanksVariant(0, c, extra);
    case 'socials':
      return {
        subject: 'Can we tag you on Instagram?',
        text: [
          hi, '',
          'We\'re sharing creator videos on our Instagram, @realskincare_com, and yours is in the lineup.',
          '',
          SOCIALS_ASK,
          '', SIGNATURE,
        ].join('\n'),
      };
    default:
      throw new Error(`creator-outreach: unknown template ${kind}`);
  }
}

// ── Thank-you notes ─────────────────────────────────────────────────────────────
//
// A creator gets one thank-you per approval batch, and the busy ones get many:
// on 2026-10-19 Taylor Copp had received FOUR, Kristin Crane and Kaitlynn
// Eliason three each, all with the same subject and the same sentence ("exactly
// the kind of content we were hoping for"). Sean: "If we are approving multiple
// videos for a creator, we need to make sure the conversations sound
// authentic." So the note is written by a model from facts we hold (what was
// approved, what came before, any Reel we really posted), checked in code
// against every earlier thank-you to that person, and a later one replies
// inside the earlier thank-you thread like a person would. If the model cannot
// produce a fresh note, a reviewed variant this creator has not had is used;
// with none left the note is HELD, never repeated.

export const THANKS_SUBJECT = 'Thank you for your video!';

const THANKS_VARIANTS = [
  // 0: the original template, kept so legacy history can be recognised.
  (c, extra, w) => ({
    subject: THANKS_SUBJECT,
    body: `We just approved your ${w.what} ${w.noun}. Thank you, ${w.noun === 'videos' ? 'they are' : 'it\'s'} exactly the kind of content we were hoping for.${w.more}`,
  }),
  (c, extra, w) => ({
    subject: `Your ${w.what} ${w.noun}`,
    body: `Your ${w.what} ${w.noun} ${w.noun === 'videos' ? 'are' : 'is'} approved. I really liked how natural ${w.noun === 'videos' ? 'they feel' : 'it feels'}. Thanks for taking the time.${w.missing ? ` Whenever you feel like filming the ${w.missing}, I'd be glad to see that one too.` : ''}`,
  }),
  (c, extra, w) => ({
    subject: `Approved: ${w.what}`,
    body: `Another one approved, thank you! The ${w.what} ${w.noun} came out great and we're glad to have ${w.noun === 'videos' ? 'them' : 'it'}.${w.missing ? ` No pressure, but a ${w.missing} one would be lovely someday.` : ''}`,
  }),
  (c, extra, w) => ({
    subject: 'Got your latest video',
    body: `Just a quick thank you for the ${w.what} ${w.noun}. ${w.noun === 'videos' ? 'They\'re' : 'It\'s'} approved and ready to go, and it's been a real pleasure working with you.${w.missing ? ` The ${w.missing} is still waiting for its moment if you ever want to try it on camera.` : ''}`,
  }),
];

function thanksWords(c, extra) {
  const what = list((extra.products || []).map(shortProduct)) || 'new';
  const noun = (extra.submissionIds || []).length > 1 ? 'videos' : 'video';
  const missing = list(c.missing.map(shortProduct));
  const more = c.missing.length ? ` If you'd like to make one for the ${missing} too, we'd love that.` : '';
  return { what, noun, more, missing: c.missing.length ? missing : '' };
}

/** The whole email: greeting, body, the Instagram ask (when owed), signature. */
export function assembleThanks(c, body, extra = {}, greeting = `Hi ${c.firstName},`) {
  return [greeting, '', body.trim(), ...(extra.askSocials ? ['', SOCIALS_ASK] : []), '', SIGNATURE].join('\n');
}

export function renderThanksVariant(i, c, extra = {}) {
  const v = THANKS_VARIANTS[i](c, extra, thanksWords(c, extra));
  return { subject: v.subject, body: v.body, text: assembleThanks(c, v.body, extra) };
}

export const THANKS_VARIANT_COUNT = THANKS_VARIANTS.length;

/**
 * Every earlier thank-you to this creator, oldest first. Creators thanked
 * before history was recorded got variant 0 each time, so their count is
 * restored as that many variant-0 notes.
 */
export function thanksHistory(rec = {}) {
  const recorded = rec.thanksHistory || [];
  const legacy = Math.max(0, (rec.sent?.thanks || 0) - recorded.length);
  const stub = { source: 'variant:0', subject: THANKS_SUBJECT, body: 'We just approved your video. Thank you, it\'s exactly the kind of content we were hoping for.' };
  return [...Array.from({ length: legacy }, () => stub), ...recorded];
}

/** Reels we really posted from this creator's videos. ledger null = unknown = none. */
export function reelsForCreator(ledger, c) {
  const ids = new Set((c.submissions || []).map((s) => s.id));
  return (ledger?.posts || []).filter((p) => ids.has(p.submission_id) && p.posted_at)
    .map((p) => ({ product: shortProduct(p.product_key || ''), posted: String(p.posted_at).slice(0, 10) }));
}

// Words every thank-you shares by necessity (the product names are added per
// creator): repeating them is not repeating ourselves.
const STOP = new Set('a an and the to of for on in it its it\'s is are was we you your our i this that so with be just have has me my at as but if they them their really video videos approved thank thanks'.split(' '));
const tokens = (s) => String(s).toLowerCase().replace(/[‘’]/g, '\'').replace(/[^a-z0-9'\s]+/g, ' ').split(/\s+/).filter(Boolean);
const contentWords = (s, ignore) => new Set(tokens(s).filter((w) => !STOP.has(w) && !ignore.has(w)));

/** Every word of these product titles, for wordOverlap's `ignore`. */
export const productWords = (titles = []) => new Set(titles.flatMap((t) => tokens(shortProduct(t))));

/** Share of the smaller note's content words the two notes have in common. */
export function wordOverlap(a, b, ignore = new Set()) {
  const A = contentWords(a, ignore); const B = contentWords(b, ignore);
  if (!A.size || !B.size) return 0;
  let n = 0; for (const w of A) if (B.has(w)) n += 1;
  return n / Math.min(A.size, B.size);
}

export const MAX_THANKS_OVERLAP = 0.5;
const STOCK_LINE = /exactly the kind of content we were hoping for/i;
const INSTAGRAM_POST_CLAIM = /\b(posted|reels?|shared (it|them|your)|on our (instagram|page|feed))\b/i;
const names = (body, product) => String(body).toLowerCase().includes(shortProduct(product).toLowerCase());

/** Reels no earlier note has told the creator about. */
export function unmentionedReels(reels = [], history = []) {
  return reels.filter((r) => !history.some((h) => INSTAGRAM_POST_CLAIM.test(h.body) && names(h.body, r.product)));
}

/** Not-yet-filmed products this note names (an invitation to film them). */
export function invitedIn(body, missing = []) {
  return missing.map(shortProduct).filter((p) => names(body, p));
}

/**
 * Deterministic checks on a thank-you body (no greeting, no signature).
 * Empty array = may be sent.
 */
export function thanksProblems(body, { history = [], reels = [], subject = null, threaded = false, ignore = new Set(), missing = [] } = {}) {
  const problems = replyProblems(body);
  const words = String(body).trim().split(/\s+/).length;
  if (words < 12) problems.push('too short');
  if (words > 90) problems.push('over 90 words');
  if (/https?:\/\/|www\./i.test(body)) problems.push('contains a link');
  if (/instagram (handle|username|profile)/i.test(body)) problems.push('asks for the Instagram handle (the code adds that line)');
  if (STOCK_LINE.test(body)) problems.push('uses the old stock line "exactly the kind of content we were hoping for"');
  if (!reels.length && INSTAGRAM_POST_CLAIM.test(body)) problems.push('mentions posting their video, but we have not posted one');
  if (/^\s*(hi|hey|hello|dear)\b/i.test(body)) problems.push('starts with a greeting (the code adds it)');
  if (/\n\s*(sean|real skin care)\s*$/i.test(body)) problems.push('ends with a sign-off (the code adds it)');
  // A person mentions the same Reel once and asks for the next product every
  // so often; a note that does both every time reads as a template even when
  // no sentence repeats (the first live run did exactly that, three times).
  if (INSTAGRAM_POST_CLAIM.test(body) && reels.length && unmentionedReels(reels, history).length === 0) {
    problems.push('mentions a Reel an earlier note already told them about');
  }
  const last = history[history.length - 1];
  for (const p of invitedIn(body, missing)) {
    if (last && invitedIn(last.body, missing).includes(p)) problems.push(`invites them to film the ${p} again (the last note already asked)`);
  }
  const opening = openingKey(body);
  for (const [i, h] of history.entries()) {
    if (opening && opening === openingKey(h.body)) problems.push(`opens the same way as thank-you #${i + 1} ("${opening}")`);
    const o = wordOverlap(body, h.body, ignore);
    if (o >= MAX_THANKS_OVERLAP) problems.push(`${Math.round(o * 100)}% word overlap with thank-you #${i + 1}`);
  }
  if (subject !== null && !threaded) {
    if (!String(subject).trim() || subject.length > 60) problems.push('subject missing or over 60 characters');
    if (/—/.test(subject)) problems.push('em dash in the subject');
    if (history.some((h) => String(h.subject || '').trim().toLowerCase() === String(subject).trim().toLowerCase())) problems.push('subject repeats an earlier thank-you');
  }
  return [...new Set(problems)];
}

/** The facts the thank-you model may use, and nothing else. */
export function thanksFacts(c, extra, { history = [], reels = [] } = {}) {
  const earlier = (c.submissions || []).filter((s) => s.status === 'approved' && !(extra.submissionIds || []).includes(s.id));
  return {
    creator_first_name: c.firstName,
    just_approved: (extra.products || []).map(shortProduct),
    number_of_videos_just_approved: (extra.submissionIds || []).length,
    approved_before_this: earlier.map((s) => ({ products: s.products.map(shortProduct), submitted: String(s.createdAt || '').slice(0, 10) })),
    thank_you_emails_already_sent_to_them: history.length,
    reels_we_posted_from_their_videos: reels,
    reels_not_yet_mentioned_to_them: unmentionedReels(reels, history),
    products_they_have_not_filmed_yet: c.missing.map(shortProduct),
    last_note_already_invited: history.length ? invitedIn(history[history.length - 1].body, c.missing) : [],
    our_earlier_thank_you_notes: history.map((h) => h.body),
  };
}

export const THANKS_SYSTEM = `You write a short thank-you email from Sean, founder of Real Skin Care (natural coconut-oil skin care), to a UGC creator whose video was just approved in Trybe. Many creators make several videos for us, so this person may already have had thank-you notes from us. Each note must sound like a real person continuing a working relationship, never like a form letter.

Write 2 to 4 short sentences, warm and plain, like a busy founder typing a quick note. Vary your structure: you might lead with the product, with "another one", with something specific from the facts, or with a simple thanks. If they have had earlier notes, acknowledge the ongoing relationship naturally (for example that this is another one, or that we keep loving their work) without counting or sounding scripted.

Use ONLY the FACTS. You may mention a Reel only if reels_not_yet_mentioned_to_them lists one, and only the product and that it went up on our Instagram; never mention a Reel an earlier note already told them about. If products_they_have_not_filmed_yet is not empty you may invite one more video for one of those, lightly, but NOT a product listed in last_note_already_invited. Most notes need neither: a plain, specific thanks is often the most natural. Never invent details about the video's content (you have not been told what is in it), its performance, views or results.

Do NOT: write a greeting or a sign-off (the code adds "Hi <name>," and Sean's signature); ask for their Instagram handle (the code adds that line when needed); use em dashes; include links; mention money, commission, payment, discounts, free product or deadlines; describe any product as treating, healing or curing anything; reuse the opening words or phrasing of our_earlier_thank_you_notes; use the phrase "exactly the kind of content we were hoping for".

Also write a short, natural email subject (under 60 characters, different from earlier ones), used only when the note starts a new thread.

Reply with JSON only: {"subject":"...","body":"..."}`;

export function thanksPrompt(facts, problems = []) {
  const retry = problems.length ? `\n\nYOUR LAST DRAFT WAS REJECTED. Fix every one of these and write a fresh note:\n- ${problems.join('\n- ')}` : '';
  return `FACTS:\n${JSON.stringify(facts, null, 2)}${retry}`;
}

export function parseThanks(raw) {
  const s = String(raw || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const j = JSON.parse(s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1));
  if (!j.body) throw new Error('creator-outreach: thank-you draft has no body');
  return { subject: String(j.subject || '').trim(), body: String(j.body).trim() };
}

/**
 * Write a thank-you that does not repeat anything this creator has had.
 * `write(prompt)` returns the model's raw text. Two model attempts, then the
 * first unused reviewed variant that passes the same checks, else held.
 * @returns {Promise<{subject:string, body:string, text:string, source:string, attempts:string[][]} | {held:string, attempts:string[][]}>}
 */
export async function composeThanks({ c, extra = {}, history = [], reels = [], threaded = false, write }) {
  const facts = thanksFacts(c, extra, { history, reels });
  const ignore = productWords([...(c.products || []), ...(extra.products || []), ...(c.missing || [])]);
  const missing = c.missing || [];
  const attempts = [];
  let problems = [];
  for (let i = 0; i < 2 && write; i += 1) {
    try {
      const d = parseThanks(await write(thanksPrompt(facts, problems)));
      problems = thanksProblems(d.body, { history, reels, subject: d.subject, threaded, ignore, missing });
      if (!problems.length) return { subject: d.subject, body: d.body, text: assembleThanks(c, d.body, extra), source: 'model', attempts };
    } catch (err) {
      problems = [`could not use the draft: ${err.message}`];
    }
    attempts.push(problems);
  }
  const used = new Set(history.map((h) => h.source));
  for (let v = 0; v < THANKS_VARIANT_COUNT; v += 1) {
    if (used.has(`variant:${v}`)) continue;
    const r = renderThanksVariant(v, c, extra);
    if (!thanksProblems(r.body, { history, reels, subject: r.subject, threaded, ignore, missing }).length) return { ...r, source: `variant:${v}`, attempts };
  }
  return { held: 'no fresh thank-you could be written and every reviewed variant has been used for this creator', attempts };
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
    declinedTag: Boolean(s.declinedTag),
    lastInboundAt: s.lastInboundAt || null,
    lastScheduledAt: s.lastScheduledAt || null,
    threadMessageId: s.threadMessageId || null,
  };
}

/**
 * What scheduled email, if any, each creator is due. One per creator, oldest
 * delivery first, capped per run.
 * `suppressed` lists only creators who ARE due an email and a gate is holding
 * it: `{ email, name, kind, reason, until }`, `until` an ISO time or null.
 * @returns {{sends: object[], suppressed: object[], outsideWindow: boolean}}
 */
export function planScheduled(roster, state, { now = Date.now(), config = DEFAULT_CONFIG, socials = null } = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const outsideWindow = !inSendWindow(now, cfg.sendWindowUtc);
  const sends = [];
  const suppressed = [];
  const ordered = [...roster].sort((a, b) => String(a.firstDeliveredAt || '9').localeCompare(String(b.firstDeliveredAt || '9')));

  for (const c of ordered) {
    const st = creatorState(state, c.email);
    // Opted out is permanent and silent: nothing is ever due, so nothing is held.
    if (st.optedOut) continue;

    // Decide what is DUE first, then which gate holds it. A creator with nothing
    // due is not "held"; reporting every recently-emailed creator would bury the
    // ones a gate is actually delaying (2026-10-04: five nudges were due and the
    // run said only "Nothing to do").
    let kind = null;
    let extra = {};
    const newlyApproved = c.submissions.filter((s) => s.status === 'approved' && !st.thanked.includes(s.id)
      && ago(s.createdAt, now) < cfg.thankWithinDays * DAY);
    const sinceDelivery = ago(c.firstDeliveredAt, now);
    const quietSubmission = ago(c.latestSubmissionAt, now) < cfg.quietAfterSubmissionDays * DAY;

    // Ask for the Instagram handle once, from any creator with an approved
    // video we cannot tag yet. `socials` null = the handle list could not be
    // built, so nobody is asked (asking someone who already answered is worse
    // than asking a day late).
    const owesHandle = socials !== null && !st.sent.socials && !st.declinedTag
      && c.submissions.some((s) => s.status === 'approved') && !handleFor(socials, c.name);
    if (!st.sent.welcome && c.shipped && !c.submissions.length) kind = 'welcome';
    else if (newlyApproved.length) {
      kind = 'thanks';
      extra = { submissionIds: newlyApproved.map((s) => s.id), products: [...new Set(newlyApproved.flatMap((s) => s.products))], askSocials: owesHandle };
    } else if (c.missing.length && c.firstDeliveredAt && !quietSubmission) {
      if (!st.sent.nudge1 && sinceDelivery >= cfg.nudge1AfterDays * DAY) kind = 'nudge1';
      else if (st.sent.nudge1 && !st.sent.nudge2 && sinceDelivery >= cfg.nudge2AfterDays * DAY
        && ago(st.sent.nudge1, now) >= 5 * DAY) kind = 'nudge2';
      else if (st.sent.nudge2 && !st.sent.final && sinceDelivery >= cfg.finalAfterDays * DAY
        && ago(st.sent.nudge2, now) >= 7 * DAY) kind = 'final';
    }
    if (!kind && owesHandle) kind = 'socials';
    if (!kind) continue;

    const skip = (reason, until = null) => suppressed.push({ email: c.email, name: c.name, kind, reason, until });
    const after = (iso, ms) => new Date(Date.parse(iso) + ms).toISOString();
    if (st.escalatedOpen) { skip('waiting on Sean'); continue; }
    if (ago(st.lastInboundAt, now) < cfg.quietAfterReplyDays * DAY) {
      skip('replied recently', after(st.lastInboundAt, cfg.quietAfterReplyDays * DAY)); continue;
    }
    if (ago(st.lastScheduledAt, now) < cfg.minGapHours * HOUR) {
      skip(`emailed recently (${cfg.minGapHours}h gap)`, after(st.lastScheduledAt, cfg.minGapHours * HOUR)); continue;
    }
    if (sends.length >= cfg.maxScheduledPerRun) { skip('over the per-run cap, goes next run'); continue; }
    sends.push({ email: c.email, name: c.name, kind, extra, ...renderTemplate(kind, c, extra) });
  }
  return { sends: outsideWindow ? [] : sends, deferredByWindow: outsideWindow ? sends : [], suppressed, outsideWindow };
}

// ── Replies ─────────────────────────────────────────────────────────────────────

/** Topics a creator raises that only Sean can answer. Matched on THEIR words. */
export const ESCALATE_PATTERNS = [
  ['money or terms', /\b(pay|paid|payment|payout|commission|rate|rates|fee|fees|invoice|contract|agreement|usage rights?|exclusiv\w*|whitelist\w*|budget|compensat\w*|cash|venmo|paypal)\b/i],
  // Symptoms and conditions, never bare verbs. `react\w*` matched Gmail's
  // "Sierra reacted via Gmail" (a heart emoji) on 2026-10-03 and sent a creator
  // whose sample had not even arrived a "stop using the product" email; bare
  // `ill` and `burn` match ordinary sentences the same way.
  ['a skin reaction or health concern', /\b(rash\w*|reactions?|react(s|ed|ing)? (to|badly|poorly)|allerg\w*|burn(ing|ed|t|s)|irritat\w*|hives|itch(y|ing|ed|es)?|swell(ing|ed)|swollen|redness|sting(s|ing)|breakouts?|broke out|breaking out|flare-?ups?|eczema|psoriasis|dermatitis|rosacea|(got|feel|feeling|felt|made me) sick|injur\w*|hospital|doctor|dermatologist|pregnan\w*|breastfeed\w*|nursing)\b/i],
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
  if (msg.emojiReaction) return { action: 'ignore', reason: 'emoji reaction' };
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
    instagram_handle_on_file: c.instagram || null,
    instagram_handle_received_in_this_email: c.instagramJustReceived || false,
  };
}

export const REPLY_SYSTEM = `You answer emails from UGC creators on behalf of Sean, founder of Real Skin Care (natural coconut-oil skin care: lotions, moisturizer, soaps, toothpaste, deodorant, lip balm). Creators joined the brand's program on Trybe, received free samples, and make short videos.

Write as Sean: warm, brief, plain. 2 to 6 short sentences. Never use em dashes. Sign off exactly as:
${SIGNATURE}

If instagram_handle_received_in_this_email is true, thank them and say we'll tag them when we post their video on our Instagram (@realskincare_com); do not repeat the handle back. If they say they would rather not be tagged, tell them that is completely fine.

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

/** Longest quoted history we carry, so a long thread cannot grow without bound. */
export const MAX_QUOTED_CHARS = 12000;

/**
 * Our body with the conversation so far quoted underneath, the way a mail
 * client's Reply does, so every email (and the Sent copy Sean reads in
 * Hushmail) shows the whole exchange. `prior` is the last message in the
 * thread: { date, from, text } where text already carries its own quotes.
 */
export function withQuotedThread(body, prior) {
  const text = String(prior?.text || '').trim();
  if (!text) return body;
  const when = new Date(prior.date);
  const stamp = Number.isNaN(when.getTime()) ? String(prior.date || '') : when.toUTCString().replace(' GMT', ' UTC');
  const kept = text.length > MAX_QUOTED_CHARS ? `${text.slice(0, MAX_QUOTED_CHARS).trimEnd()}\n[earlier messages trimmed]` : text;
  const quoted = kept.split(/\r?\n/).map((l) => (l.startsWith('>') ? `>${l}` : `> ${l}`).trimEnd()).join('\n');
  return `${body}\n\nOn ${stamp}, ${prior.from} wrote:\n${quoted}`;
}

/** How a creator appears in an attribution line. */
export function senderLabel(name, email) {
  return name ? `${name} <${email}>` : `<${email}>`;
}

export function replySubject(subject) {
  const s = String(subject || '').trim() || 'Your Real Skin Care samples';
  return /^re:/i.test(s) ? s : `Re: ${s}`;
}
