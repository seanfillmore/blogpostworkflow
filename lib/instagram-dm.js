/**
 * Instagram DMs for @realskincare_com: the pure half of agents/instagram-dm.
 *
 * The bio says "DM 'Natural' for $10 off your first order" (Sean confirmed the
 * offer is real, 2026-11-04). This answers that request automatically with a
 * UNIQUE, single-use code (Sean: "a custom discount that cannot be shared"):
 * each code works once in total, on a first order only (Shopify segment
 * number_of_orders = 0), and one Instagram account always gets the same code
 * back however often it asks. Every other DM is left for Sean and listed in a
 * daily digest of conversations waiting on a reply.
 *
 * The keyword match is STRICT on purpose. The inbox is mostly Sean's creator
 * outreach, where people write things like "Love that you made a natural
 * skincare brand!", so a message triggers only when it is essentially the word
 * itself: "Natural", "natural please", "NATURAL!" (at most 3 words, the keyword
 * among them, no question). Anything longer goes to Sean.
 *
 * Instagram lets a business reply only within 24 hours of the customer's last
 * message, so a request older than that is never auto-answered (it goes in the
 * digest instead), and a request Sean already answered by hand is skipped.
 */

export const OUR_IG_ID = '17841428233225633';
export const KEYWORD = 'natural';
export const REPLY_WINDOW_MS = 24 * 3_600_000;
export const CODE_PREFIX = 'IG10';
export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const POOL_LOW = 25;

/** True when a message is a request for the DM offer and nothing more. */
export function isOfferRequest(text) {
  const t = String(text || '').trim();
  if (!t || t.includes('?') || t.length > 40) return false;
  const words = t.toLowerCase().replace(/[^a-z\s']/g, ' ').split(/\s+/).filter(Boolean);
  return words.length >= 1 && words.length <= 3 && words.includes(KEYWORD);
}

export function genCodes(n, rand = Math.random, taken = new Set()) {
  const out = new Set();
  while (out.size < n) {
    let s = '';
    for (let i = 0; i < 7; i++) s += CODE_ALPHABET[Math.floor(rand() * CODE_ALPHABET.length)];
    const c = `${CODE_PREFIX}-${s}`;
    if (!taken.has(c)) out.add(c);
  }
  return [...out];
}

export function replyText(code) {
  return `Hi! Thanks for following along. Here is your $10 off your first order at realskincare.com: ${code}\n\nIt is just for you and works once, on a first order. Enjoy!`;
}

/**
 * What to send this run. `conversations` = [{ id, messages: [{ id, created_time,
 * from: { id, username }, message }] }] (any order). `state` = { assigned:
 * { [igUserId]: { code, at } }, handled: { [messageId]: true }, pool: [...] }.
 * Returns { sends: [{ conversationId, recipientId, username, messageId, code, reused }], stale: [...] }.
 * Pure: it neither mutates state nor assigns from the pool beyond what it returns.
 */
export function planReplies(conversations = [], state = {}, { now = Date.now(), ourId = OUR_IG_ID } = {}) {
  const sends = [];
  const stale = [];
  const pool = [...(state.pool || [])];
  const assigned = { ...(state.assigned || {}) };
  const handled = state.handled || {};
  for (const c of conversations) {
    const msgs = [...(c.messages || [])].sort((a, b) => String(a.created_time).localeCompare(String(b.created_time)));
    // The newest unhandled request in the thread; earlier ones are covered by one reply.
    let req = null;
    for (const m of msgs) if (m.from?.id !== ourId && !handled[m.id] && isOfferRequest(m.message)) req = m;
    if (!req) continue;
    const answered = msgs.some((m) => m.from?.id === ourId && String(m.created_time) > String(req.created_time));
    if (answered) continue;
    if (now - Date.parse(req.created_time) > REPLY_WINDOW_MS) { stale.push({ conversationId: c.id, username: req.from?.username, messageId: req.id }); continue; }
    const who = req.from.id;
    let code = assigned[who]?.code;
    const reused = !!code;
    if (!code) {
      code = pool.shift();
      if (!code) { stale.push({ conversationId: c.id, username: req.from?.username, messageId: req.id, reason: 'code pool empty' }); continue; }
      assigned[who] = { code, at: new Date(now).toISOString() };
    }
    sends.push({ conversationId: c.id, recipientId: who, username: req.from?.username || null, messageId: req.id, code, reused });
  }
  return { sends, stale };
}

/** Conversations whose newest message is from the customer and was not auto-answered: Sean's to answer. */
export function awaitingReply(conversations = [], state = {}, { now = Date.now(), ourId = OUR_IG_ID } = {}) {
  const out = [];
  for (const c of conversations) {
    const msgs = [...(c.messages || [])].sort((a, b) => String(a.created_time).localeCompare(String(b.created_time)));
    const last = msgs[msgs.length - 1];
    if (!last || last.from?.id === ourId || state.handled?.[last.id]) continue;
    const ageH = (now - Date.parse(last.created_time)) / 3_600_000;
    out.push({ conversationId: c.id, username: last.from?.username || '?', ageHours: Math.round(ageH), canReply: ageH <= 24, preview: String(last.message || '(attachment)').replace(/\s+/g, ' ').slice(0, 120) });
  }
  return out.sort((a, b) => a.ageHours - b.ageHours);
}
