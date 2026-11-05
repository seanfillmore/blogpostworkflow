/**
 * Instagram DMs for @realskincare_com: the pure half of agents/instagram-dm.
 *
 * Two DM offers, each answered automatically with a UNIQUE, single-use Shopify
 * code (Sean, 2026-11-04: "a custom discount that cannot be shared"); one
 * Instagram account always gets the same code back for the same offer:
 *
 *   natural  the bio's "DM 'Natural' for $10 off your first order". $10 off, first
 *            order only (segment number_of_orders = 0).
 *   thanks   the packing-insert card's "Follow us and DM us THANKS for $10 off your
 *            next order of $55 or more, plus free shipping". $10 off with a $55
 *            minimum: free shipping is a shipping RATE at $45 measured AFTER
 *            discounts, so $55 minus $10 keeps every such order free to ship
 *            (Sean chose this over changing free shipping store-wide).
 *
 * Every other DM is left for Sean and listed in the daily digest.
 *
 * The keyword match is STRICT: the whole message must be essentially the keyword
 * (at most 3 words, the keyword among them, no question mark). And a thread where
 * we have written anything ourselves, other than this agent's own replies, is
 * never auto-answered: the inbox is mostly Sean's creator outreach, where "Thanks!"
 * is an ordinary reply and "natural" turns up in sentences. A customer DMing from
 * the bio or the card starts a fresh thread, so they are always answered.
 *
 * Instagram lets a business reply only within 24 hours of the customer's last
 * message, so an older request goes in the digest instead.
 */

export const OUR_IG_ID = '17841428233225633';
export const REPLY_WINDOW_MS = 24 * 3_600_000;
export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const POOL_LOW = 25;
export const NEVER_PURCHASED_SEGMENT = 'gid://shopify/Segment/365228064938'; // number_of_orders = 0

export const OFFERS = Object.freeze({
  natural: Object.freeze({
    keyword: 'natural',
    prefix: 'IG10',
    title: 'Instagram DM $10 off first order (unique, single use)',
    reply: (code) => `Hi! Thanks for following along. Here is your $10 off your first order at realskincare.com: ${code}\n\nIt is just for you and works once, on a first order. Enjoy!`,
    discount: {
      usageLimit: 1,
      appliesOncePerCustomer: true,
      customerSelection: { customerSegments: { add: [NEVER_PURCHASED_SEGMENT] } },
      customerGets: { value: { discountAmount: { amount: '10.00', appliesOnEachItem: false } }, items: { all: true } },
      combinesWith: { shippingDiscounts: true, orderDiscounts: false, productDiscounts: false },
    },
  }),
  thanks: Object.freeze({
    keyword: 'thanks',
    prefix: 'TY10',
    title: 'Instagram card THANKS $10 off $55+ (unique, single use)',
    reply: (code) => `Thank you for your order, and for following along! Here is $10 off your next order of $55 or more at realskincare.com, and shipping is still free: ${code}\n\nIt is just for you and works once. Enjoy!`,
    discount: {
      usageLimit: 1,
      appliesOncePerCustomer: true,
      customerSelection: { all: true },
      minimumRequirement: { subtotal: { greaterThanOrEqualToSubtotal: '55.00' } },
      customerGets: { value: { discountAmount: { amount: '10.00', appliesOnEachItem: false } }, items: { all: true } },
      combinesWith: { shippingDiscounts: true, orderDiscounts: false, productDiscounts: false },
    },
  }),
});

/** The offer a message asks for ('natural' | 'thanks'), or null. */
export function offerRequested(text) {
  const t = String(text || '').trim();
  if (!t || t.includes('?') || t.length > 40) return null;
  const words = t.toLowerCase().replace(/[^a-z\s']/g, ' ').split(/\s+/).filter(Boolean);
  if (words.length < 1 || words.length > 3) return null;
  for (const [key, o] of Object.entries(OFFERS)) if (words.includes(o.keyword)) return key;
  return null;
}

/** Back-compatible: true when the message asks for any offer. */
export const isOfferRequest = (text) => offerRequested(text) !== null;

/** One of this agent's own replies (so it does not count as Sean having written in the thread). */
export function isAgentReply(text) {
  const t = String(text || '');
  return Object.values(OFFERS).some((o) => {
    const probe = o.reply('XXXX').split('XXXX')[0].slice(0, 30);
    return probe && t.startsWith(probe);
  });
}

export function genCodes(n, rand = Math.random, taken = new Set(), prefix = OFFERS.natural.prefix) {
  const out = new Set();
  while (out.size < n) {
    let s = '';
    for (let i = 0; i < 7; i++) s += CODE_ALPHABET[Math.floor(rand() * CODE_ALPHABET.length)];
    const c = `${prefix}-${s}`;
    if (!taken.has(c)) out.add(c);
  }
  return [...out];
}

/** Back-compatible: the natural reply. */
export const replyText = (code) => OFFERS.natural.reply(code);

/**
 * State shape: { offers: { [key]: { discount_id, pool, assigned: { [igUserId]: {code, at, username} } } },
 * handled: { [messageId]: true }, sent: [...] }. A pre-2026-11-05 state (top-level
 * discount_id/pool/assigned, natural only) is read as offers.natural.
 */
export function normalizeState(s = {}) {
  const offers = { ...(s.offers || {}) };
  if (!offers.natural && (s.discount_id || s.pool || s.assigned)) {
    offers.natural = { discount_id: s.discount_id || null, pool: s.pool || [], assigned: s.assigned || {} };
  }
  for (const k of Object.keys(OFFERS)) offers[k] = { discount_id: null, pool: [], assigned: {}, ...(offers[k] || {}) };
  return { offers, handled: s.handled || {}, sent: s.sent || [] };
}

/**
 * What to send this run. `conversations` = [{ id, messages: [{ id, created_time,
 * from: { id, username }, message }] }]. Pure: returns
 * { sends: [{ conversationId, recipientId, username, messageId, offer, code, reused }], stale: [...] }.
 */
export function planReplies(conversations = [], state = {}, { now = Date.now(), ourId = OUR_IG_ID } = {}) {
  const st = normalizeState(state);
  const sends = [];
  const stale = [];
  const pools = Object.fromEntries(Object.entries(st.offers).map(([k, o]) => [k, [...o.pool]]));
  const assigned = Object.fromEntries(Object.entries(st.offers).map(([k, o]) => [k, { ...o.assigned }]));
  for (const c of conversations) {
    const msgs = [...(c.messages || [])].sort((a, b) => String(a.created_time).localeCompare(String(b.created_time)));
    let req = null;
    for (const m of msgs) if (m.from?.id !== ourId && !st.handled[m.id] && offerRequested(m.message)) req = m;
    if (!req) continue;
    // Sean's own threads (creator outreach) are never auto-answered.
    const seanWrote = msgs.some((m) => m.from?.id === ourId && String(m.message || '').trim() && !isAgentReply(m.message));
    if (seanWrote) { stale.push({ conversationId: c.id, username: req.from?.username, messageId: req.id, reason: 'a thread you wrote in; left for you' }); continue; }
    const answered = msgs.some((m) => m.from?.id === ourId && String(m.created_time) > String(req.created_time));
    if (answered) continue;
    if (now - Date.parse(req.created_time) > REPLY_WINDOW_MS) { stale.push({ conversationId: c.id, username: req.from?.username, messageId: req.id }); continue; }
    const offer = offerRequested(req.message);
    const who = req.from.id;
    let code = assigned[offer][who]?.code;
    const reused = !!code;
    if (!code) {
      code = pools[offer].shift();
      if (!code) { stale.push({ conversationId: c.id, username: req.from?.username, messageId: req.id, reason: `${offer} code pool empty` }); continue; }
      assigned[offer][who] = { code };
    }
    sends.push({ conversationId: c.id, recipientId: who, username: req.from?.username || null, messageId: req.id, offer, code, reused });
  }
  return { sends, stale };
}

/** Conversations whose newest message is from the customer and was not auto-answered: Sean's to answer. */
export function awaitingReply(conversations = [], state = {}, { now = Date.now(), ourId = OUR_IG_ID } = {}) {
  const handled = state.handled || {};
  const out = [];
  for (const c of conversations) {
    const msgs = [...(c.messages || [])].sort((a, b) => String(a.created_time).localeCompare(String(b.created_time)));
    const last = msgs[msgs.length - 1];
    if (!last || last.from?.id === ourId || handled[last.id]) continue;
    const ageH = (now - Date.parse(last.created_time)) / 3_600_000;
    out.push({ conversationId: c.id, username: last.from?.username || '?', ageHours: Math.round(ageH), canReply: ageH <= 24, preview: String(last.message || '(attachment)').replace(/\s+/g, ' ').slice(0, 120) });
  }
  return out.sort((a, b) => a.ageHours - b.ageHours);
}
