//
// Policy for agents/press-outreach: when mail may go out, how much, what the
// fixed messages say, and what every outgoing message must pass. Pure; the
// agent supplies time, state and config.
//
// The daily cap is a DOMAIN-REPUTATION limit, not a volume target. Cold mail
// from realskincare.com shares a sender reputation with Klaviyo and order
// email, so volume ramps only after two clean weeks, and any complaint stops
// everything until a human resumes it.

import { checkSeoCopyFields } from './seo-copy-health-gate.js';

export const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  sendVia: 'resend',
  queueTarget: 25,
  // One drafting run makes at most this many drafts, so the queue fills over a few days.
  draftRunMax: 10,
  dailySendCap: 10,
  dailySendCapRamped: 25,
  rampAfterDays: 14,
  editorialShare: 0.7,
  monthlySampleKits: 10,
  draftExpiryDays: 14,
  hunterUsageStop: 0.8,
  minGapMinutes: 10,
});

export const OPT_OUT_LINE = 'If this isn\'t a fit, just reply "no thanks" and I won\'t follow up.';
const SUBJECT_MAX = 70;
const PITCH_MAX_WORDS = 150;

export function inSendWindow(nowMs) {
  const d = new Date(nowMs);
  const day = d.getUTCDay();
  return day >= 1 && day <= 5 && d.getUTCHours() >= 16;
}

export function dailyCap(config, state, nowMs) {
  if (state?.paused) return 0;
  // The ramp needs a CLEAN stretch: any pause inside rampAfterDays resets it.
  const window = config.rampAfterDays * 86_400_000;
  if ((state?.pause_history || []).some((t) => nowMs - Date.parse(t) < window)) return config.dailySendCap;
  const first = state?.first_sent_at ? Date.parse(state.first_sent_at) : null;
  if (first && nowMs - first >= config.rampAfterDays * 86_400_000) return config.dailySendCapRamped;
  return config.dailySendCap;
}

/** The pitch sign-off. The postal address is NOT here: postalLine puts it under the opt-out sentence. */
export function signature() {
  return ['Sean', 'Real Skin Care', 'realskincare.com'].join('\n');
}

/** The CAN-SPAM postal line, on one line directly under OPT_OUT_LINE. */
export function postalLine(postalAddress) {
  return `Real Skin Care, ${postalAddress}`;
}

export function stripDashes(s) {
  return String(s).replace(/\s*[—–]\s*/g, ', ');
}

export function firstName(contact) {
  if (contact?.kind === 'outlet') return 'there';
  const f = String(contact?.name || '').trim().split(/\s+/)[0];
  return f || 'there';
}

export function askAddressText({ firstName: n }) {
  return `Hi ${n},\n\nWonderful, thank you! What's the best mailing address to send them to? I'll get them out right away and send tracking once they ship.\n\nSean`;
}

/** Everything an outgoing message must pass. Fixed templates are checked once in tests. */
export function checkOutgoingCopy({ subject, text, kind, postalAddress }) {
  const problems = [];
  if (/[—–]/.test(subject) || /[—–]/.test(text)) problems.push('contains an em or en dash');
  if (String(subject).length > SUBJECT_MAX) problems.push(`subject over ${SUBJECT_MAX} characters`);
  if (kind === 'pitch') {
    if (!text.includes(OPT_OUT_LINE)) problems.push('missing the opt-out line');
    const afterOptOut = text.split(OPT_OUT_LINE)[1] || '';
    if (postalAddress) {
      if (!afterOptOut.includes(postalAddress)) problems.push('missing the postal address after the opt-out line');
    } else {
      if (!/\b\d{5}\b/.test(afterOptOut)) problems.push('missing the postal address after the opt-out line');
    }
    const body = text.split(OPT_OUT_LINE)[0];
    if (body.trim().split(/\s+/).length > PITCH_MAX_WORDS) problems.push(`body over ${PITCH_MAX_WORDS} words`);
  }
  const gate = checkSeoCopyFields({ subject, body: text });
  for (const b of gate.blocking) problems.push(`${b.category}: "${b.match}" (${b.why})`);
  return { ok: problems.length === 0, problems };
}

export function shouldPause(sends) {
  const recent = (sends || []).slice(-50);
  if (recent.some((s) => s.last_event === 'complained')) return { pause: true, reason: 'a recipient marked our email as spam' };
  if (recent.length < 20) return { pause: false, reason: null };
  const bounced = recent.filter((s) => s.last_event === 'bounced').length;
  const rate = bounced / recent.length;
  return rate > 0.03
    ? { pause: true, reason: `${bounced} of the last ${recent.length} sends bounced (${(rate * 100).toFixed(1)}%)` }
    : { pause: false, reason: null };
}
