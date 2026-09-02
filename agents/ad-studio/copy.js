// agents/ad-studio/copy.js
//
// Stage 2: exact per-zone ad copy plus the claim metadata the gate in claims.js checks.
// Copy is where revenue is made, so this runs on the flagship model.

// The gate's own serializer. Imported rather than re-implemented so the text shown to the
// writer and the text searched by claims.js cannot drift apart — see sourceText's docstring.
import { sourceText } from './claims.js';
import { GOLDEN_THREAD_RULE } from './golden-thread.js';

/**
 * @param {{format:object, product:object, pdpBody:string, persona?:object, tactics?:string[],
 *          variant?:string, giveaway?:object}} args
 * @returns {string}
 */
// How many reviews the writer is shown, and how much of each.
//
// Bounded because 26 full reviews is a lot of tokens on a call made once per concept.
// Truncating the DISPLAY is safe: the claim gate validates evidence against the FULL
// review text in the source index, so any quote taken from the shown excerpt is still a
// contiguous substring of the source.
const REVIEWS_SHOWN = 12;
const REVIEW_CHARS = 320;

// A variant slug/name that signals "no fragrance" — the operator's instruction was to
// treat that absence as a benefit to lead with, never as a gap to paper over with a
// sibling variant's scent. Matches "pure-unscented", "unscented", "fragrance-free", etc.
const UNSCENTED_VARIANT_RE = /unscented|fragrance[\s-]?free|no[\s-]?scent/i;

// The four sources claims.js has always held. `giveaway` joins them ONLY while an Entry
// Period is open (lib/giveaway-claim-source.js decides), so with no giveaway running this
// list — and therefore the whole prompt — is byte-identical to what it has always been.
const BASE_SOURCE_IDS = ['pdp', 'catalog', 'brandKit', 'reviews'];

/**
 * WHAT THE AD IS FOR — the one thing about an ad that cannot be inferred from its format.
 *
 * These three lived in flexible.js until 2026-08-25 and moved here because BOTH copy calls
 * need them, and flexible.js already imports from this file (the reverse would be a cycle).
 * flexible.js re-exports them, so every existing importer is unchanged.
 *
 * THE BUG THAT MOVED THEM. `--objective` reached the ad-level writer and never the plate
 * writer, so with an Entry Period open a `--flexible --objective sale` run produced ONE
 * manifest whose Meta primary texts sold a product and whose three plates asked the reader
 * to enter a giveaway. Measured on the coconut-bar-soap-12-pack dry run: all three plate
 * concepts led with "ENTER TO WIN 36 BARS ... ENTRIES CLOSE SEPTEMBER 14, 2026" and not one
 * of them mentioned the price, the quantity or the offer the run existed to advertise. Both
 * gates passed every word of it, correctly — an incoherent ad is not an unsourced one, and
 * no claim gate is in a position to notice that an ad is selling two different actions.
 */
export const OBJECTIVES = Object.freeze(['sale', 'entry']);
export const DEFAULT_OBJECTIVE = 'sale';

/**
 * `entry` requires a live giveaway, and says so rather than quietly writing entry copy with
 * nothing to enter. Outside an Entry Period `sourceId: "giveaway"` is not even a valid
 * source, so every deadline and prize detail would fail the claim gate anyway — this just
 * fails it earlier, and legibly.
 */
export function assertObjective(objective, { giveaway = null } = {}) {
  if (!OBJECTIVES.includes(objective)) {
    throw new Error(`ad-studio: unknown --objective "${objective}". Valid: ${OBJECTIVES.join(', ')}.`);
  }
  if (objective === 'entry' && !giveaway) {
    throw new Error(
      'ad-studio: --objective entry needs a live giveaway, and no Entry Period is open. ' +
      'Outside one, "giveaway" is not a citable source, so every prize and deadline in the copy would ' +
      'fail the claim gate. Check config/giveaway.json against the published Official Rules.'
    );
  }
}

/**
 * Does this objective let the writer see, and cite, the Official Rules?
 *
 * ONE PREDICATE, because "show the rules block" and "list giveaway as a citable source" must
 * never disagree. Offering a source the writer is never shown is the documented failure this
 * file's giveaway-block docstring describes at length — the writer invents a plausible
 * deadline and cites it, and three runs die at the gate. Showing the rules while omitting
 * them from the source list is the same defect wearing the other sign.
 */
export function giveawayIsCitable(objective, giveaway) {
  return Boolean(giveaway) && objective === 'entry';
}

/**
 * The objective instruction for a PLATE prompt.
 *
 * Deliberately NOT flexible.js's `objectiveBrief`, and this is not a duplicated rule. That
 * one briefs Meta-rendered primary text and headlines ("the call to action is to ENTER, in
 * both primary texts"); this one briefs zone strings an operator sets in Photoshop, which
 * have no primary texts and no call-to-action field. The shared thing is the VOCABULARY —
 * `OBJECTIVES`, `DEFAULT_OBJECTIVE`, `assertObjective`, `giveawayIsCitable` — and that is
 * defined once, here, and imported. Two prompts for two artifacts is not drift.
 *
 * When a giveaway is live and the objective is `sale`, this block is where the writer is
 * told so explicitly. Saying nothing was the old behaviour and it is what produced the
 * incoherent manifest above: the rules block is long, vivid and full of quotable specifics,
 * and a writer given it with no counterweight will write the ad it describes.
 */
export function buildObjectiveBlock(objective = DEFAULT_OBJECTIVE, { giveaway = null } = {}) {
  if (objective === 'entry') {
    return `\nTHE JOB OF THIS AD: get a GIVEAWAY ENTRY, not a sale. The product is the reason
the prize is worth having, not the thing being sold. Lead with the prize and the deadline,
both quoted from the Official Rules below.\n`;
  }
  const giveawayCaveat = giveaway
    ? `\n\nA GIVEAWAY IS RUNNING, AND THIS AD IS NOT IT. The Official Rules are deliberately
NOT shown to you and "giveaway" is NOT a source you may cite here. Do not mention a prize, a
giveaway, an entry, a sweepstakes, a draw, "no purchase necessary", or any entry deadline.
A reader who finishes this ad wanting to enter something has been sent to the wrong place.`
    : '';
  return `\nTHE JOB OF THIS AD: sell the product. The reader should want to buy it, and the
copy should give them the reason — what it is, what it costs, and why that is worth it.${giveawayCaveat}\n`;
}

/**
 * The giveaway instruction block, or '' when no giveaway is running.
 *
 * Shaped exactly like variantBlock above, and for the same reason: an optional block that
 * contributes NOTHING when absent, so the no-giveaway prompt cannot drift by so much as a
 * newline. It is interpolated immediately after variantBlock, on the same line.
 *
 * Everything factual it puts in front of the writer is a VERBATIM section of the published
 * Official Rules, quoted rather than summarised. That is the whole discipline: the writer is
 * never told "the prize is a three-year supply of soap" in this file's own words, because a
 * sentence written here is a sentence no source contains, and the writer would quite
 * reasonably repeat it into an ad. It is pointed at the prize text and told to quote it.
 *
 * A SHIPPING SCHEDULE IS NOT A SUPPLY DURATION, and this block used to invite the confusion.
 * It asked the writer to quote the prize's "quantity and duration", and the first live
 * giveaway run (coconut-soap, 2026-08-18) duly returned "Win a three-year SUPPLY" — from
 * rules that say only "thirty-six (36) bars ... SHIPPED OVER three (3) years". Both gates
 * passed it, correctly: every word traced to the rules prose. What no gate can catch is the
 * semantic conversion, because "shipped over 3 years" is a fact about fulfilment while "a
 * 3-year supply" is a claim about how fast the winner uses soap — unsubstantiated, and
 * weakest against the whole-family persona the ad was aimed at. Same class as the invented
 * 90-day supply on the bundle lander. So the instruction now names the schedule explicitly
 * and forbids restating it as a duration of use.
 *
 * `prizeFraming` decides WHICH parts of a multi-component prize the ad leads with. It is an
 * A/B knob, not a compliance one: both framings are quoted from the same rules text and both
 * face the same gate. Absent (the default) it contributes nothing and the writer chooses, so
 * the prompt is byte-identical to what it was before this option existed.
 *
 * EXPORTED so the ad-level writer in flexible.js uses THIS block rather than a second,
 * thinner one. Its first version merely told the writer that "giveaway" was citable and
 * never showed it the rules — so every deadline it produced was a plausible invention that
 * the claim gate then rejected, three runs in a row. It also injected a synthesized line
 * ("entries close September 14, 2026") which the model dutifully quoted back as evidence:
 * prompt-manufactured text masquerading as source, which is precisely the failure
 * lib/giveaway-claim-source.js exists to prevent at the other end.
 */
export function buildGiveawayBlock(giveaway) {
  if (!giveaway) return '';
  const framing = {
    soap: `
PRIZE FRAMING FOR THIS AD: lead with the SOAP portion of the prize only. Do not mention the
Sensitive Skin Moisturizing Sets. Understating a prize is permitted; overstating one is not.`,
    full: `
PRIZE FRAMING FOR THIS AD: name BOTH components of the prize — the soap AND the Sensitive
Skin Moisturizing Sets — quoting each one's quantity from the PRIZES text.`,
  }[giveaway.prizeFraming] || '';
  return `
GIVEAWAY RUNNING — THIS IS A LEAD AD, NOT A SALES AD.
The thing this ad asks for is an ENTRY (an email address), NOT a purchase. Do not ask anyone
to buy, do not lead with a price, and never imply that buying helps: NO PURCHASE NECESSARY,
and a purchase does not improve anyone's chances of winning. Entries close ${giveaway.closesOn}.
The SIZE of the prize is the hook — quote its full quantity out of the PRIZES text below
rather than settling for "a free bar".

State the prize as a QUANTITY and, if you give a timeframe, as the SHIPPING SCHEDULE the
rules actually describe. You may say bars are shipped over a period; you may NOT convert that
into how long they will last anyone — "a three-year supply", "lasts three years", "three
years' worth" are all claims about the winner's rate of use that no source supports.${framing}

OFFICIAL RULES (a source you may cite as "giveaway") — verbatim, and the ONLY authority for
what the prize is, who may enter, and when entries close:

  PRIZES: ${giveaway.prizes}

  ENTRY PERIOD: ${giveaway.entryPeriod}

  HOW TO ENTER: ${giveaway.howToEnter}

  ELIGIBILITY: ${giveaway.eligibility}

Every prize detail, quantity, value and date you state must be quoted from the text above
with sourceId "giveaway", under the same contiguous-verbatim-substring rule as every other
source. A prize or a date that is not in that text is rejected before anything renders.
A call to action asserts no fact — "Enter to win", "Enter free", "Free to enter" are
factual: false. So is urgency with no number in it ("Closing soon"). A DATE is a fact.
`;
}

/**
 * A source the writer may cite, rendered with its CONTENT.
 *
 * THE BUG THIS FIXES. `pdp` and `reviews` had their text in the prompt; `brandKit` and
 * `catalog` were named in the "cite one of these" list and their content was never shown.
 * A writer cannot quote a contiguous verbatim substring of a source it has never seen, so
 * those two were nameable but uncitable — and naming them made it worse than omitting them,
 * because the writer confidently attributes a real fact to the wrong source and the gate
 * rejects correct copy. Exactly what happened on 2026-08-18: the EWG ingredient figure was
 * sitting in brand-kit.json, the writer could only see the PDP, so it cited `pdp` and the
 * run died with the evidence present in the index the whole time. Same class as PR #491's
 * `reviews` — an accepted sourceId that nothing populated.
 *
 * It renders the ORIGINAL object, not `sourceIndex[id]`. The index looked like the tempting
 * choice — it is literally what validateClaims searches — but normalizeForMatch lowercases
 * and strips punctuation, so the index holds `{markerbrandkitmarker}`. Showing that would
 * hand the writer mangled text to quote from and teach it to write lowercase, unpunctuated
 * copy. Quoting the real object is safe because the gate normalises the writer's evidence
 * and the source the SAME way before comparing, so a correctly-quoted pretty string still
 * matches. What must agree between prompt and gate is WHICH sources exist, not their casing
 * — and that is handled by deriving sourceIds from the index below.
 */
function sourceBlock(value, id, label) {
  if (!value || (typeof value === 'object' && !Object.keys(value).length)) return '';
  // sourceText, NOT a second JSON.stringify. The writer must be shown byte-for-byte what
  // claims.js will search, or an honest contiguous quote fails the gate — see sourceText's
  // docstring for the run where exactly that rejected two of three correct concepts.
  return `\n${label} (a source you may cite as "${id}"):\n${sourceText(value)}\n`;
}

/**
 * The two-gate rules block, in ONE place because there are now two writers behind the
 * same two gates: the per-format plate copy below, and the ad-level primary text and
 * headlines in flexible.js. A second hand-maintained copy of these paragraphs is how the
 * health-claim rule ends up strict in one prompt and lax in the other — the same shape of
 * failure as personas.json feeding a second path around a gate, which this project has
 * already paid for once.
 *
 * The prose is unchanged from the version that has been running; only `unit` is
 * parameterised, because "in any zone" is the right noun for a plate and the wrong one
 * for a Meta primary text.
 *
 * This is prompt text, not enforcement. assertNoHealthClaims and assertClaimsSourced are
 * what actually stop a run; stating the rules here only saves the retries.
 *
 * @param {{sourceIds: string[], unit?: string}} o
 */
export function buildClaimRules({ sourceIds, unit = 'zone' }) {
  return `- Never claim a manufacturing origin other than "made in the USA".
- NO HEALTH CLAIMS, in any ${unit}, including inside a customer quote. This product is a
  COSMETIC. You may say what it does to the appearance and feel of skin — moisturizes,
  absorbs, softens, soothes, non-greasy, for dry or sensitive skin. You may NOT name a
  disease or condition (eczema, psoriasis, dermatitis, rosacea, acne, infection, rash),
  name a drug or prescription treatment (steroid, cortisone, prescription, antibiotic,
  over-the-counter), or say the product heals, cures, treats, prevents, reverses or
  remedies anything. Do not claim clinical, dermatologist or FDA backing.
  A verbatim customer review is NOT an exception: an advertiser is responsible for the
  claims an endorsement conveys, so a quote naming a disease makes it our claim. If the
  only quote that fits carries such language, pick a different quote.
- Do not invent counts, percentages, volumes, timeframes, awards or third-party endorsements.
- EVERY factual statement must be traceable. For each, set factual: true, name a sourceId
  from: ${sourceIds.join(', ')} — and quote the exact supporting phrase in evidence.
  The evidence must be a CONTIGUOUS, VERBATIM SUBSTRING copied from that ONE named source —
  never assembled, never joined from two places, never reworded, and never spanning two
  separate facts. It is checked before anything renders, by exact substring match, and
  there is no override — a paraphrased or synthesized quote fails the gate and stops the
  run entirely, including every OTHER concept's copy already written.
- KEEP THE SOURCE'S HEDGE. If the source says "as many as 112", "up to 30 days", "about
  half", the qualifier is part of the fact and the ad must carry it. Stating a hedged upper
  bound as a flat figure ("the number of ingredients is 112") overstates what the source
  actually found, and the gate cannot catch it — "112" is a substring either way.
- If an ad line combines two facts (e.g. an ingredient count AND a price), split it into
  TWO claims in the claims array, each with its own sourceId and its own verbatim evidence
  quote — one claim per fact, never one evidence string built by concatenating both. For
  example "6 CLEAN INGREDIENTS — $30" is two claims: the ingredient count sourced against
  catalog with its own quote, and the price sourced against catalog with its own separate
  quote — not one evidence string joining a title fragment and a price with a dash.
- Pure persuasion with no factual assertion is fine: set factual: false and omit sourceId.`;
}

// The golden-thread rule ships in the FIRST prompt, not only in the retry — same policy as
// SEO_COPY_COMPLIANCE_RULE, and for the same reason: most runs should never need the second
// call. See golden-thread.js for why an LLM produces this defect by default.
export function buildCopyPrompt({ format, product, pdpBody, persona, tactics, reviews = [], variant, giveaway, sourceIndex, brandKit, catalogEntry, objective = DEFAULT_OBJECTIVE, retryNote = null }) {
  const zoneList = format.zones
    .map(z => {
      const cap = format.zoneCapacity?.[z];
      return cap ? `  - ${z} (maximum ${cap} items — the layout cannot carry more)` : `  - ${z}`;
    })
    .join('\n');
  const unscented = variant && UNSCENTED_VARIANT_RE.test(variant);
  const variantBlock = variant
    ? `\nVARIANT: ${variant} — this copy is for THIS variant ONLY. The PRODUCT PAGE COPY and ` +
      `catalog text below describe the whole product line, including sibling variants. Describe ` +
      `only what is actually in THIS variant — never claim or imply an ingredient, scent, or ` +
      `attribute that belongs to a different variant of this product, even if the source text ` +
      `mentions it for the line as a whole.` +
      (unscented
        ? ` This variant has NO added fragrance and NO essential oils. That absence is a real ` +
          `BENEFIT — lead with it ("no fragrance", "unscented", "nothing added to irritate ` +
          `sensitive skin"). Do NOT claim, name, or imply any essential oil, scent, or fragrance ` +
          `ingredient for this variant, even where the product line as a whole is built around one.`
        : '') +
      '\n'
    : '';
  // BOTH read the one predicate. A `sale` run sees neither the rules nor "giveaway" in its
  // source list, so the writer is never invited to cite something it was not shown.
  const citable = giveawayIsCitable(objective, giveaway);
  const objectiveBlock = buildObjectiveBlock(objective, { giveaway });
  const giveawayBlock = citable ? buildGiveawayBlock(giveaway) : '';
  const brandKitBlock = sourceBlock(brandKit, 'brandKit', 'BRAND KIT');
  const catalogBlock = sourceBlock(catalogEntry, 'catalog', 'CATALOG ENTRY');
  // OFFER ONLY WHAT IS ACTUALLY THERE. This used to be a fixed list, so the writer was told
  // it could cite `catalog` on every run including the ones with no catalog entry in the
  // index — an invitation to attribute a true statement to a source that does not exist for
  // this product, which the gate then rejects. When a sourceIndex is supplied it is the
  // authority on what may be cited, because it is the authority on what will be accepted.
  // Callers that pass none keep the old fixed list, so nothing that has not been updated
  // changes behaviour.
  // The sourceIndex still HOLDS `giveaway` — the claim gate's index is about what is true,
  // not about what this ad is for — so it is filtered out of the prompt's offer rather than
  // out of the index. A sale ad that somehow cited the rules would still pass the gate; it
  // is simply never told it may.
  const sourceIds = (sourceIndex
    ? Object.keys(sourceIndex)
    : (giveaway ? [...BASE_SOURCE_IDS, 'giveaway'] : BASE_SOURCE_IDS)
  ).filter(id => id !== 'giveaway' || citable);
  return `You are writing the copy for a single static ad for Real Skin Care.

FORMAT: ${format.key} — ${format.name}
AWARENESS LEVEL: ${format.awareness}
LAYOUT: ${format.layoutBrief}
${objectiveBlock}
PRODUCT: ${product.title} (${product.handle}) — ${product.priceLabel}
${variantBlock}${giveawayBlock}
PRODUCT PAGE COPY (a source you may cite as "pdp"):
${pdpBody}

${reviews.length ? `CUSTOMER REVIEWS (a source you may cite as "reviews") — real, verbatim, 4 and 5 star:
${reviews.slice(0, REVIEWS_SHOWN).map((r, i) => `  [${i + 1}] ${String(r).slice(0, REVIEW_CHARS)}`).join('\n')}
` : ''}
${brandKitBlock}${catalogBlock}
${persona ? `BUYER: ${persona.name}\nWHAT THEY ALREADY TRIED: ${(persona.angles || []).join('; ')}` : ''}

${tactics && tactics.length ? `COPY TACTICS AVAILABLE:\n${tactics.map(t => `  - ${t}`).join('\n')}` : ''}

Fill exactly these zones:
${zoneList}

RULES:
- Write the literal strings that will be rendered into the image. No placeholders.
- Headlines are short enough to read at phone size in one second.
${GOLDEN_THREAD_RULE}
${buildClaimRules({ sourceIds })}
${retryNote ? `\n${retryNote}\n` : ''}

Respond with JSON only, no commentary:
{
  "zones": { ${format.zones.map(z => `"${z}": ...`).join(', ')} },
  "claims": [
    { "zone": "...", "text": "...", "factual": true, "sourceId": "pdp", "evidence": "..." }
  ]
}
Zones that hold a list (items, rows) take an array of strings; all others take a string.`;
}

/** Pull a JSON object out of a raw model response that may be fenced or chatty. */
function extractJson(raw) {
  const s = String(raw || '').trim();
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : s;
  try {
    return JSON.parse(candidate);
  } catch {
    const first = candidate.indexOf('{');
    const last = candidate.lastIndexOf('}');
    if (first !== -1 && last > first) {
      try { return JSON.parse(candidate.slice(first, last + 1)); } catch { /* fall through */ }
    }
    return null;
  }
}

/**
 * @param {string} raw
 * @returns {{zones:Record<string,string|string[]>, claims:object[]}}
 */
export function parseCopyResponse(raw, format = null) {
  const obj = extractJson(raw);
  if (!obj) throw new Error('ad-studio: could not parse copy response as JSON');
  if (!obj.zones || typeof obj.zones !== 'object') throw new Error('ad-studio: copy response missing "zones"');
  if (!Array.isArray(obj.claims)) throw new Error('ad-studio: copy response missing "claims"');

  // EMPTY IS NOT VALID COPY. The shape was checked and the content never was, so a
  // response of {"headline": "", "attribution": "", "trustLine": ""} sailed through: the
  // claim gate had zero claims to validate and therefore trivially passed, three plates
  // were rendered and paid for, and the comp pass filled the vacuum by INVENTING ad copy
  // ("Real Skin Care for Real People") that no source had ever supported.
  //
  // That is the worst failure mode available to this pipeline — the claim gate exists
  // precisely to stop unsourced copy, and an empty response walks around it rather than
  // through it. It happened on `testimonial`, whose entire purpose is quoting a real
  // customer (2026-08-16).
  //
  // Throwing here is right and cheap: nothing has been rendered yet at this point, so the
  // cost is one wasted copy call rather than three wasted image calls plus an ad nobody
  // can use. buildConcepts isolates it to the one concept, so the rest of the run stands.
  const zones = obj.zones;
  const declared = Array.isArray(format?.zones) && format.zones.length ? format.zones : Object.keys(zones);
  const empty = declared.filter(z => {
    const v = zones[z];
    if (Array.isArray(v)) return v.filter(x => String(x ?? '').trim()).length === 0;
    return !String(v ?? '').trim();
  });
  if (empty.length) {
    throw new Error(
      `ad-studio: copy response has empty zone(s): ${empty.join(', ')}. An empty zone is not ` +
      `copy — it renders a blank ad and gives the claim gate nothing to check, so the comp ` +
      `pass invents text instead. Refusing before anything is rendered.`
    );
  }

  return { zones, claims: obj.claims };
}

/**
 * Hard cap on array-valued zones, applied AFTER the copy call as a backstop to the
 * capacity hint buildCopyPrompt already puts in front of the model. The prompt is a
 * request; this is the enforcement — a model that ignores the instruction (or asks
 * for more anyway) must not be able to push an over-long list into a paid render.
 *
 * Real incident this fixes: a format asked for 6 listItems and 4 bottomBar items:
 * the layout only had room for 4 and 3 respectively, so the image model rendered a
 * short list and silently rewrote the bottom bar, dropping several factual strings
 * that had already cleared the claim gate. The verification gate correctly rejected
 * every attempt — three paid renders burned per target for copy the layout could
 * never have carried in the first place.
 *
 * String-valued zones and zones with no declared capacity are returned unchanged.
 * Every truncation is logged — a silent one reads as full coverage when it isn't.
 *
 * @param {Record<string,string|string[]>} zones
 * @param {{key:string, zoneCapacity?:Record<string,number>}} format
 * @returns {{zones:Record<string,string|string[]>, dropped:{zone:string, items:string[]}[]}}
 */
export function enforceZoneCapacity(zones, format) {
  const capacities = format?.zoneCapacity;
  if (!capacities) return { zones, dropped: [] };

  const outZones = { ...zones };
  const dropped = [];

  for (const [zone, cap] of Object.entries(capacities)) {
    const value = outZones[zone];
    if (!Array.isArray(value) || value.length <= cap) continue;

    const kept = value.slice(0, cap);
    const removed = value.slice(cap);
    outZones[zone] = kept;
    dropped.push({ zone, items: removed });

    console.warn(
      `ad-studio: truncated zone "${zone}" for format "${format.key}" from ${value.length} ` +
      `to ${cap} item(s) — the layout cannot carry more. Dropped: ${JSON.stringify(removed)}`
    );
  }

  return { zones: outZones, dropped };
}

/**
 * Flatten zone values into the ordered list of strings that should appear in the render.
 * Consumed by the verification gate.
 * @param {Record<string,string|string[]>} zones
 * @returns {string[]}
 */
export function expectedStrings(zones) {
  const out = [];
  for (const value of Object.values(zones || {})) {
    if (Array.isArray(value)) out.push(...value.filter(v => typeof v === 'string' && v.trim()));
    else if (typeof value === 'string' && value.trim()) out.push(value);
  }
  return out;
}

// ── Prize-duration claims ───────────────────────────────────────────────────────────
//
// "Thirty-six (36) bars ... SHIPPED OVER three (3) years" is a fulfilment schedule.
// "A three-year supply", "a year of soap", "lasts three years" are claims about how fast
// the winner uses soap — unsubstantiated, and no source can support them.
//
// NEITHER GATE CAN SEE THIS. Every word of "Win a three-year supply" traces to the rules
// prose, so claims.js passes it; it names no disease, so health-claims.js passes it. The
// conversion is semantic. buildGiveawayBlock has forbidden it in prose since 2026-08-18 —
// and the writer did it again on 2026-08-19 ("Enter to win a year of clean coconut soap"),
// through a prompt that contained the prohibition. Instruction without detection is the
// mirror of the mistake selectQuotableReviews fixed, and it fails the same way.
//
// SCOPED TO GIVEAWAY COPY on purpose. A duration attached to a PRIZE is always a use-rate
// claim, because the prize is a quantity and a shipping schedule. Ordinary product copy can
// legitimately carry durations ("6-month shelf life"), so widening this to every ad would
// trade a real catch for false rejections of correct copy.
const SUPPLY_DURATION_PATTERNS = [
  // "a year of soap", "a month's worth", "one year of", "3 YEAR OF SOAP", "2 years of soap".
  // The bare-numeral form was the gap: this pattern originally required a/an/one, and the
  // "supply|worth" pattern below requires that noun to follow, so "3 YEAR OF SOAP - FREE" —
  // a real headline, on a real finished ad, on 2026-08-19 — slipped between the two. Note
  // the singular "YEAR" as well: the phrasing does not have to be grammatical to be a
  // use-rate claim.
  /\b(?:a|an|one|\d+|two|three|four|five|six|seven|eight|nine|ten)\s*[-–]?\s*(?:year|month|week)s?(?:['’]s)?\s+(?:of|worth|supply)\b/i,
  // "three-year supply", "3 years' worth", "12 month supply", "Three (3) years worth".
  // The parenthetical numeral is how the Official Rules themselves write every quantity, so
  // the writer echoes that style — and without allowing for it this pattern missed exactly
  // the phrasing most likely to be produced.
  /\b(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)(?:\s*\(\d+\))?[\s-]*(?:year|month|week)s?['’]?[\s-]*(?:supply|worth)\b/i,
  // "lasts three years", "will last a year"
  /\blasts?\b[^.!?]{0,20}\b(?:\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten)\s*(?:year|month|week)s?\b/i,
  // "supply of three years"
  /\bsupply\s+of\s+(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s*(?:year|month|week)s?\b/i,
];

/** @returns {string[]} the offending phrases, empty when clean */
export function findSupplyDurationClaims(text) {
  const s = String(text || '');
  const hits = [];
  for (const re of SUPPLY_DURATION_PATTERNS) {
    const m = s.match(re);
    if (m) hits.push(m[0].trim());
  }
  return [...new Set(hits)];
}

/**
 * Throws on any prize-duration claim in a zones/fields object. Called only when a giveaway
 * is live — see the scoping note above.
 */
export function assertNoSupplyDurationClaims(zones) {
  const violations = [];
  for (const [zone, value] of Object.entries(zones || {})) {
    for (const item of Array.isArray(value) ? value : [value]) {
      for (const hit of findSupplyDurationClaims(item)) {
        violations.push(`[${zone}] "${hit}" in: ${String(item).slice(0, 140)}`);
      }
    }
  }
  if (violations.length) {
    throw new Error(
      'ad-studio: prize copy states a SUPPLY DURATION, which no source supports. The rules give a ' +
      'quantity and a shipping schedule ("36 bars shipped over 3 years"); how long that lasts anyone ' +
      'is a claim about their rate of use.\n  ' + violations.join('\n  ')
    );
  }
}
