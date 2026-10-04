// lib/press-replies.js
//
// What a writer's reply means, decided by rules a person can read. The one
// rule that matters most: when in doubt, ESCALATE. An escalated reply reaches
// Sean in minutes and nothing goes back to the writer, which costs a little
// speed. A wrong automatic answer to a journalist costs the relationship.
//
// Escalation triggers are checked BEFORE yes/no: "Happy to! What's your rate?"
// is a money conversation, not a sample request.

export const REPLY_KINDS = Object.freeze(['ignore', 'opt-out', 'decline', 'sample-yes', 'address-given', 'escalate']);

const ESCALATE = [
  [/\b(rate|rates|fee|fees|pricing|price|cost|paid|pay|sponsor\w*|budget|invoice|commission|affiliate|media kit|rate card)\b/i, 'money or terms'],
  [/\b(contract|agreement|exclusiv\w*|usage rights|license|whitelist\w*)\b/i, 'terms'],
  [/\b(sweat\w*|antiperspirant|eczema|psoriasis|acne|rash|allerg\w*|safe (for|during)|pregnan\w*|cure|heal\w*|treat\w*|fda|cavit\w*|enamel)\b/i, 'health or claim question'],
  [/\b(spam\w*|stop emailing|harass\w*|annoy\w*|unprofessional|report you)\b/i, 'complaint'],
  [/\b(published|went live|featured you|included you|link to your|piece is up|article is up)\b/i, 'feature confirmed'],
  [/\?/, 'a question needs a real answer'],
];
const OPT_OUT = /^\s*(no,? thanks?|no thank you)[.!]?\s*$|(unsubscribe|remove me|take me off|do not (contact|email)|don'?t (contact|email)|stop (sending|emailing|contacting)|never (contact|email|send)|do not send|don'?t send)(?:\s+(me|us|any more))?/i;
const CONDITIONAL = /\b(but|however|unless|until|after|only|can'?t|cannot|unable|not right now|later|first)\b/i;
const DECLINE = /\b(pass(ing)? (on|at) this|i'?ll pass|going to pass|not a (good )?fit|not interested|no longer (covering|writing)|at (max|full) capacity|not taking (on )?(new )?(brands|pitches|products))\b/i;
const YES = /(^|\W)(i'?d love to|love to (try|test|sample)|happy to (try|test|sample|take)|would love (some|to)|absolutely)\b/i;
const YES_PUNCT = /(^|\W)(sure|yes)[,!.]/i;
const ADDRESS_CUE = /\b(address|ship|shipping|mail (it|them) to|send (it|them) to)\b/i;

const STREET = /^\s*\d{1,6}\s+[A-Za-z0-9.' -]+(,\s*(apt|apartment|unit|suite|ste|#)\.?\s*[\w-]+)?\s*$/i;
const CITY_ZIP = /^\s*[A-Za-z .'-]+,\s*[A-Z]{2}\s+(\d{5})(-\d{4})?\s*$/;

/** A single US street + city/state/ZIP pair, or null when absent or ambiguous. */
export function extractUsAddress(text) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const hits = [];
  for (let i = 1; i < lines.length; i++) {
    const z = lines[i].match(CITY_ZIP);
    if (z && STREET.test(lines[i - 1])) hits.push({ lines: [lines[i - 1], lines[i]], zip: z[1] });
  }
  return hits.length === 1 ? hits[0] : null;
}

export function classifyReply(msg, { awaitingAddress = false } = {}) {
  if (msg.autoSubmitted) return { kind: 'ignore', reason: 'auto-reply' };
  if (msg.emojiReaction) return { kind: 'ignore', reason: 'emoji reaction' };
  const text = String(msg.text || '');
  const address = extractUsAddress(text);
  // An address line is not a question; strip it before the "?" rule looks.
  const scan = address ? text.replace(address.lines[0], '').replace(address.lines[1], '') : text;
  for (const [re, reason] of ESCALATE) if (re.test(scan)) return { kind: 'escalate', reason };
  if (OPT_OUT.test(text)) return { kind: 'opt-out', reason: 'asked not to be contacted' };
  if (DECLINE.test(text)) return { kind: 'decline', reason: 'declined' };
  // Conditional or deferred yes escalates before the yes branch
  if ((YES.test(text) || YES_PUNCT.test(text)) && CONDITIONAL.test(text)) return { kind: 'escalate', reason: 'conditional or deferred yes' };
  if (YES.test(text) || YES_PUNCT.test(text)) {
    // Promote to address-given only if address is present AND a cue is present, or awaitingAddress is true
    if (address && (ADDRESS_CUE.test(text) || awaitingAddress)) {
      return { kind: 'address-given', reason: 'accepted with address', address };
    }
    return { kind: 'sample-yes', reason: 'accepted' };
  }
  if (address && awaitingAddress) return { kind: 'address-given', reason: 'sent the address we asked for', address };
  return { kind: 'escalate', reason: 'could not classify with confidence' };
}
