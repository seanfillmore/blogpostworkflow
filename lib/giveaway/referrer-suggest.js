/**
 * "Did you mean...?" for the referral-email field, at the moment it is typed.
 *
 * WHY THIS EXISTS AT ENTRY TIME AND NOT AFTERWARDS. Official Rules §5: referral
 * "is identified solely by the referrer's email address entered in that field".
 * §6 awards a second $536.40 prize to the referrer "named at the time of entry".
 * Together those make the typed value the identifier, so a mistyped referrer
 * cannot lawfully be repaired later — lib/giveaway/referral-audit.js reports
 * those and deliberately does not fix them. The only moment a wrong address is
 * still fixable is BEFORE submit, while the entrant is choosing what to type.
 * Everything in this module serves that moment.
 *
 * TWO LAYERS, DIFFERENT EXPOSURE:
 *
 *   1. suggestDomainTypo (here) — pure string work against a fixed list of
 *      consumer mail providers. Consults NOTHING. It cannot leak whether any
 *      address entered the giveaway, so it is safe to run on every keystroke
 *      pause, and it catches the dominant typo class.
 *   2. the /api/giveaway/suggest-referrer endpoint — compares against actual
 *      confirmed entrants. That IS an oracle, so it is rate limited, it returns
 *      a suggestion or nothing, and it NEVER emits a "no such entrant" signal.
 *      A prober learns something only when they already hold a near-copy of a
 *      real entrant's address.
 *
 * Layer 1 is deliberately first: most typos never need layer 2 at all.
 */
import { levenshtein } from './email-similarity.js';

/**
 * Consumer mail domains that are REAL.
 *
 * Consulted before any distance maths, and that order is the whole point:
 * mail.com is a genuine provider one edit from gmail.com, so distance-first
 * would tell every mail.com entrant they meant gmail.com. Membership here means
 * "never second-guess this", not "this is popular".
 */
export const KNOWN_DOMAINS = [
  'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'icloud.com',
  'aol.com', 'live.com', 'msn.com', 'comcast.net', 'me.com', 'mac.com',
  'protonmail.com', 'proton.me', 'gmx.com', 'mail.com', 'ymail.com',
  'verizon.net', 'att.net', 'sbcglobal.net', 'bellsouth.net', 'cox.net',
  'charter.net', 'earthlink.net', 'zoho.com', 'yandex.com',
];

const KNOWN = new Set(KNOWN_DOMAINS);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Correct an obvious misspelling of a well-known mail provider, or return null.
 *
 * Never throws: this runs against half-typed input in a live form.
 *
 * @param {string} raw the address as typed
 * @returns {string|null} the corrected address, or null when nothing is proposed
 */
export function suggestDomainTypo(raw) {
  const email = String(raw ?? '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return null;

  const at = email.lastIndexOf('@');
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (!local || !domain) return null;

  // A real provider, or any domain we have no opinion about (corporate, ccTLD,
  // vanity), is left exactly as typed.
  if (KNOWN.has(domain)) return null;

  // Only correct toward a provider that is CLEARLY the intended one. A tie means
  // two providers are equally plausible, and showing one of them with the same
  // confidence as a correct guess is worse than showing nothing.
  let best = null;
  let bestDistance = Infinity;
  let tied = false;
  for (const candidate of KNOWN_DOMAINS) {
    const d = levenshtein(domain, candidate);
    if (d === 0 || d > 2) continue;
    if (d < bestDistance) { best = candidate; bestDistance = d; tied = false; } else if (d === bestDistance) tied = true;
  }
  if (!best || tied) return null;

  // A one-character domain is not a typo of anything; require the typed domain
  // to be long enough that an edit-distance match means something.
  if (domain.length < 5) return null;

  return `${local}@${best}`;
}
