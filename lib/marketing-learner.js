/**
 * lib/marketing-learner.js
 *
 * Pure, network-free logic for the marketing-learner agent: CLI date parsing,
 * the RSC constraint block, skill inventory scanning, skill rendering, and
 * edit-safety guards.
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { withRetry } from './retry.js';

const STALE_YEARS = 4;

/**
 * Pair --published dates to URLs positionally.
 *
 * A single date with multiple URLs is an ERROR rather than a broadcast:
 * stamping one date across several videos produces confident, wrong,
 * authoritative-looking metadata that skews scoring and that nobody thinks
 * to re-check. No date at all is strictly safer than a wrong one.
 */
export function parsePublishedFlags(urls, publishedFlags = [], { today = null, allowYearOnly = false } = {}) {
  const dates = publishedFlags.filter((d) => d != null && d !== '');

  if (dates.length && dates.length !== urls.length) {
    const dateWord = dates.length === 1 ? 'one' : dates.length;
    throw new Error(
      `Got ${dateWord} --published date${dates.length === 1 ? '' : 's'} for ${urls.length} URL${urls.length === 1 ? '' : 's'}. ` +
      `Supply one date per URL in order, or none at all — a single date is not broadcast across videos.`
    );
  }

  const now = today ? new Date(`${today}T00:00:00Z`) : new Date();
  const staleCutoff = new Date(now);
  staleCutoff.setUTCFullYear(staleCutoff.getUTCFullYear() - STALE_YEARS);

  return urls.map((url, i) => {
    const raw = dates[i] ?? null;
    if (!raw) return { url, publishedAt: null, warning: null };

    // A book has a copyright year, not an upload date. Requiring YYYY-MM-DD
    // would manufacture a false month and day — the same invented precision the
    // one-date-many-URLs rule above already refuses.
    const isYearOnly = allowYearOnly && /^\d{4}$/.test(raw);
    if (!isYearOnly && !/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
      throw new Error(
        `--published "${raw}" must be in YYYY-MM-DD form` +
        (allowYearOnly ? ' (or a bare YYYY for a file source).' : '.'),
      );
    }
    // A bare year is compared at Jan 1: a 2026 copyright is not "in the future"
    // in mid-2026, and staleness is judged from the start of the year.
    const iso = isYearOnly ? `${raw}-01-01` : raw;
    const d = new Date(`${iso}T00:00:00Z`);
    // Round-tripping catches rollovers like 2026-02-30 -> 2026-03-02.
    if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== iso) {
      throw new Error(`--published "${raw}" is not a real calendar date.`);
    }
    if (d > now) {
      throw new Error(`--published "${raw}" is in the future.`);
    }
    const warning = d < staleCutoff
      ? `Video is older than ${STALE_YEARS} years (${raw}) — platform-mechanics tactics from it are probably obsolete.`
      : null;

    return { url, publishedAt: raw, warning };
  });
}

/**
 * The business reality every tactic is scored against. Figures are the settled
 * ones — note the AOV is the trailing-90d $50.46, NOT the all-time $19, which is
 * dragged down by a 2024 order spike and must never be used for decisions.
 */
export function buildConstraintBlock({ sourceType = 'video', sourceKind = 'book' } = {}) {
  // Gated on the KIND, not on the loader. A book is undated and mostly principle,
  // so the nudge is right. A social post or newsletter pasted into a .md file is
  // as platform-era as any video — telling the model to treat it as durable would
  // instruct it to discount the very era cues it is supposed to be scoring.
  const durability = sourceType === 'file' && sourceKind === 'book'
    ? `\n\nThis source is a book, not a platform-era video. Treat its content as durable ` +
      `principle rather than platform mechanics unless a passage names a specific platform, ` +
      `product, or feature — those passages still decay at the fast rate above.`
    : '';
  return `## Real Skin Care — operating reality

Score every tactic against these. They are measured, not aspirational.

- Shopify revenue ~$875/mo. Amazon ~$1,800/mo. Combined ~$2,700/mo.
- AOV $50.46 (trailing 90 days).
- Repeat rate 18-22.5%; repeat customers are ~45-52% of revenue.
  **Retention is the binding constraint, not traffic.**
- 12 SKUs. Natural deodorant, body care, oral care, lip balm.
- Solo operator. No team, no agency, no media buyer, no designer.
- **The traffic gate is OPEN as of 2026-08-17.** A Meta paid campaign is being stood up to
  drive entries to the soap giveaway. Paid social is now a live surface, not a future one.
  Do NOT park or discount a tactic on the reasoning that "there is no ad account", "no
  spend exists", or "paid sits behind Tracking -> CRO -> Offer/AOV". That reasoning is
  now false. It is exactly how six directly-relevant Meta reporting tactics were scored
  4/10 and hidden from the fleet on 2026-08-16, the same week the account was being built.
- **Meta budget: $30/day (~$900/mo)**, hand-run by one person. That is real money against
  ~$2,700/mo combined revenue, and it is the number to judge against. But a tactic assuming
  a $100/day floor, a 20-creative test cell, an agency, a media buyer or a video crew is
  **early, not wrong** — park it behind \`scale\` or \`team\` per the stage rules below.
  These constraints are today's, not permanent: the business is trying to grow out of them.
- Prime directive is revenue, not rankings or traffic.

## Reject a tactic outright when it

- Is motivational framing with no stated mechanism — not actionable, not testable.
- Restates something an existing skill already covers (duplication degrades skill triggering).
- Has no honest translation to an ecommerce catalog **at any size** (B2B service pricing,
  physical-location expansion, "move to a bigger market"). Note "at any size": needing
  staff, budget or volume this business does not have YET is a stage, not a reject — see
  the stage rules below.
- Targets a platform Real Skin Care is not on and has no plan to be on.

## Timing is a stage, never a reject

\`stage\` parks a tactic that is right for this business but blocked by something that has
not arrived yet. A parked tactic is **adopted** — it lands in the skill with a
\`**Stage:**\` marker, stays discoverable, and is hidden from the fleet's live projection
until its gate opens. A rejected tactic goes into a JSON report nothing reads again.

**The four funnel gates (tracking, cro, offer-aov, traffic) are all open as of 2026-08-17.**
Never park behind those, and never discount a tactic because "there is no ad account" or
"paid sits behind CRO" — that reasoning is false now. Two gates remain ahead:

- \`scale\` — order, list and spend volume. Park here anything that needs a **readable
  signal** (statistical significance, top-vs-bottom decile contrasts, per-permutation
  winners, frequency-fatigue thresholds), a **multi-cell test** (a 20-creative test cell,
  several ad sets, a $100/day floor), or a **paid analytics subscription**. Today the
  business is at ~54 orders/month, a sub-1,000 list, $30/day.
- \`team\` — people who are not the solo operator. Park here anything needing **video or UGC
  production, a creator roster, a designer, an editor, a media buyer, sales or support
  staff, or an agency**.

So:

- **Executable now, real mechanism, not a duplicate** → adopt with no stage, score on merit.
- **Sound, but blocked only by volume, budget or people** → **adopt with the stage that
  unblocks it. This is never a reject.** Score it on the merit it will have when that gate
  opens, not on today's inability to run it — the stage already records the timing, so
  discounting the score double-counts it and buries the tactic twice. State the trigger in
  the reasoning: what has to be true before it is worth doing.
- **Has an honest scaled-down version runnable today** → prefer that: adopt unparked, and
  state the scale-down. Parking is for what genuinely cannot be run yet, not a way to avoid
  the work of translating a tactic.

Reject on merit alone — no mechanism, duplication, or no honest translation to a
solo-operator ecommerce catalog **at any size**. "Not yet" is a stage. Only "not ever" is a
reject.

What you must NOT do is discount a tactic because paid traffic is "premature" or an ad
account "does not exist". Both are false now. That reasoning cost six directly-relevant
Meta reporting tactics a 4/10 apiece on 2026-08-16 — in the same week the ad account was
being built for the giveaway.

## Staleness is not uniform

| Tactic class | Decay | Examples |
|---|---|---|
| Platform mechanics | Fast — treat anything older than ~18 months with suspicion | Ad account structure, algorithm behavior, placement names, attribution windows |
| Durable principle | Slow — age is nearly irrelevant | Offer construction, positioning, retention psychology, pricing logic |

A 2022 Meta campaign structure describes a system that no longer exists. A 2019 offer
principle is fine. When age is what drove a score down, \`rscFit.reasoning\` MUST name
which class the tactic falls into.${durability}`;
}

const countWords = (s) => String(s).split(/\s+/).filter(Boolean).length;

/** Last `n` words of a chunk, prepended to the next one as its own paragraph. */
function overlapTail(prevChunk, n) {
  if (n <= 0) return [];
  const w = String(prevChunk).split(/\s+/).filter(Boolean);
  return w.length ? [w.slice(-n).join(' ')] : [];
}

/**
 * Hard-split a paragraph that is on its own larger than the budget.
 *
 * Prose sources have blank lines to pack against; auto-generated video transcripts
 * do not — they arrive as one unbroken blob with almost no punctuation (8 sentence
 * marks in 9,794 words on pLhQOYMGa88), so there is no natural boundary to prefer.
 * Splitting on word count is crude but it is the only boundary such a source offers,
 * and the chunk overlap plus consolidation is what repairs a mid-thought cut.
 */
function splitOversized(paragraph, maxWords) {
  const w = String(paragraph).split(/\s+/).filter(Boolean);
  if (w.length <= maxWords) return [paragraph];
  const pieces = [];
  for (let i = 0; i < w.length; i += maxWords) pieces.push(w.slice(i, i + maxWords).join(' '));
  return pieces;
}

/** Greedily pack blank-line-delimited paragraphs up to `maxWords`. */
function packParagraphs(text, maxWords, overlapWords) {
  const paras = String(text)
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .flatMap((p) => splitOversized(p, maxWords));
  if (!paras.length) return [];

  const chunks = [];
  let cur = [];
  let count = 0;

  for (const p of paras) {
    const n = countWords(p);
    // `count &&` is load-bearing: a lone paragraph over budget must still be
    // emitted rather than flushing an empty chunk ahead of itself. Paragraphs
    // larger than the budget have already been hard-split by splitOversized.
    if (count && count + n > maxWords) {
      const finished = cur.join('\n\n');
      chunks.push(finished);
      cur = overlapTail(finished, overlapWords);
      count = countWords(cur.join('\n\n'));
    }
    cur.push(p);
    count += n;
  }
  if (cur.length) chunks.push(cur.join('\n\n'));
  return chunks;
}

/**
 * Split on a heading regex; each match STARTS a section and becomes its label.
 *
 * Named splitByHeading, not splitSections: a different splitSections lower in
 * this file carves a skill file into markdown sections for the falsified-claims
 * parser. Same word, unrelated job.
 */
function splitByHeading(text, splitOn) {
  const re = new RegExp(splitOn);
  const sections = [];
  let cur = null;
  for (const line of String(text).split('\n')) {
    const trimmed = line.trim();
    if (trimmed && re.test(trimmed)) {
      if (cur) sections.push(cur);
      cur = { label: trimmed, lines: [line] };
    } else if (cur) {
      cur.lines.push(line);
    } else {
      cur = { label: null, lines: [line] };
    }
  }
  if (cur) sections.push(cur);
  return sections
    .map((s) => ({ label: s.label, text: s.lines.join('\n') }))
    .filter((s) => s.text.trim());
}

/**
 * Split long source text into extraction-sized chunks.
 *
 * Word-budget packing over paragraph boundaries is the default, NOT chapter
 * detection. Confirmed against the real $100M Money Models conversion: every
 * chapter repeats "Description" / "Examples" / "Important Notes" / "Summary
 * Points" — 44 headings that are indistinguishable by shape from the ~22 real
 * chapter titles, so a Title-Case heading regex splits that book into ~65
 * chunks. A misfiring regex has no error and no warning; the operator finds out
 * from the bill. `--split-on` stays opt-in for files that genuinely have clean
 * headings.
 *
 * A 200-word overlap means a tactic straddling a boundary appears whole in at
 * least one chunk. It creates duplicates on purpose — consolidateTactics merges
 * them.
 */
export function chunkText(text, { maxWords = 4500, overlapWords = 200, splitOn = null } = {}) {
  const sections = splitOn
    ? splitByHeading(text, splitOn)
    : [{ label: null, text: String(text ?? '') }];

  const flat = [];
  for (const section of sections) {
    const packed = packParagraphs(section.text, maxWords, overlapWords);
    packed.forEach((chunk, i) => {
      const label = section.label
        ? (packed.length > 1 ? `${section.label} (part ${i + 1} of ${packed.length})` : section.label)
        : null;
      flat.push({ label, text: chunk });
    });
  }

  return flat.map((c, i) => ({
    index: i,
    total: flat.length,
    label: c.label ?? `part ${i + 1} of ${flat.length}`,
    text: c.text,
  }));
}

const SHRINK_FLOOR = 0.75; // new content may not drop below 75% of old without a reason

/** Minimal YAML frontmatter reader — only `name` and `description` are needed. */
export function parseFrontmatter(content) {
  const m = String(content).match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) throw new Error('SKILL.md is missing YAML frontmatter (--- delimited block at the top).');
  const [, head, body] = m;
  const field = (key) => {
    const line = head.match(new RegExp(`^${key}:[ \\t]*(.*)$`, 'm'));
    return line ? line[1].trim() : '';
  };
  return { name: field('name'), description: field('description'), body };
}

/** Every marketing-* skill currently in the project, so the model edits instead of duplicating. */
export function scanSkillInventory(skillsDir) {
  if (!existsSync(skillsDir)) return [];
  const out = [];
  for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('marketing-')) continue;
    const path = join(skillsDir, entry.name, 'SKILL.md');
    if (!existsSync(path)) continue;
    const content = readFileSync(path, 'utf8');
    let fm;
    try { fm = parseFrontmatter(content); } catch {
      console.warn(`[marketing-learner] skipping ${path}: malformed frontmatter`);
      continue;
    }
    out.push({ name: fm.name || entry.name, description: fm.description, path, content });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Render a fresh SKILL.md. Every claim carries provenance so a tactic that later
 * proves wrong is traceable to its source and that source can be re-weighted.
 */
/**
 * Frontmatter here is written a line at a time and read back by a line regex, not
 * by a real YAML parser. Descriptions are now freeform model output, so a stray
 * newline would push the rest of the sentence onto its own line — where the reader
 * silently drops it and the skill ships with a truncated trigger description.
 * Collapse any vertical whitespace to a single space.
 */
function toFrontmatterValue(value) {
  return String(value ?? '').replace(/\s*[\r\n]+\s*/g, ' ').trim();
}

export function renderSkillMarkdown({ name, description, tactics = [] }) {
  const lines = [
    '---',
    `name: ${name}`,
    `description: ${toFrontmatterValue(description)}`,
    '---',
    '',
    `# ${name.replace(/^marketing-/, '').replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())}`,
    '',
  ];

  for (const t of tactics) {
    lines.push(`## ${t.claim}`, '');
    // Directly under the heading so a human scanning the file sees the gate before
    // the argument for the tactic, and so extractStagedTactics finds it without
    // having to parse the whole section.
    if (t.stage) {
      lines.push(
        `**Stage:** ${t.stage} — parked until the ${t.stage} phase opens. Recorded now so it is not re-derived later.`,
        '',
      );
    }
    lines.push(`**Why it works:** ${t.mechanism}`, '');
    if (t.evidence) lines.push(`**Evidence offered:** ${t.evidence}`, '');
    if (t.rscFit) lines.push(`**Fit here (${t.rscFit.score}/10):** ${t.rscFit.reasoning}`, '');
    const s = t.source ?? {};
    lines.push(`*Source: ${s.creator ?? 'unknown'} — "${s.title ?? 'untitled'}" (${s.locator ?? 'n/a'})*`, '');
  }

  return lines.join('\n');
}

/**
 * Guard an LLM-authored replacement of an existing skill. The model returns whole
 * files rather than patches (applying model-generated diffs corrupts silently), so
 * the risk is wholesale loss rather than a bad hunk. Throws — never warns and writes.
 */
export function validateSkillEdit(oldContent, newContent, { supersedes = null } = {}) {
  const oldFm = parseFrontmatter(oldContent);
  const newFm = parseFrontmatter(newContent); // throws if frontmatter is damaged

  if (newFm.name !== oldFm.name) {
    throw new Error(`Skill name changed: "${oldFm.name}" -> "${newFm.name}". Names are stable identifiers.`);
  }
  if (!newFm.description) {
    throw new Error(`Skill "${newFm.name}" has an empty description — it would never trigger.`);
  }

  // NOTE: there is deliberately no "## Falsified must be the last section" guard
  // here. extractFalsifiedClaims used to slice from that heading to EOF, which
  // made section order load-bearing — and the merge prompt never states the
  // ordering rule, so an LLM appending a new "## " section at end-of-file (its
  // default) would abort the whole batch after a paid Opus call. The parser now
  // bounds the graveyard at the next "## " heading instead, so a trailing live
  // section is simply a live section. Structure, not policing.

  // The model returns whole files, so it can silently drop the graveyard while
  // still growing the file — which the shrink guard below would never catch.
  // This is the only falsified guard that is code rather than persuasion.
  const oldDead = extractFalsifiedClaims(oldContent);
  if (oldDead.length) {
    const newDead = extractFalsifiedClaims(newContent);
    const lost = oldDead.filter((c) => !newDead.includes(c));
    if (lost.length) {
      throw new Error(
        `Refusing to edit "${newFm.name}": the replacement drops ${lost.length} falsified ` +
        `entr${lost.length === 1 ? 'y' : 'ies'} — ${lost.map((c) => `"${c}"`).join(', ')}. ` +
        `Falsified tactics were tested here and failed; they must stay on the record.`
      );
    }
  }

  // A dropped **Stage:** marker is the same class of silent damage as a dropped
  // graveyard entry, and the shrink guard cannot see it — the model can lose the
  // line while growing the file. The consequence is immediate: an unmarked tactic
  // enters the fleet projection, which is exactly what parking prevents. Changing
  // WHICH gate applies is fine; losing the marker is not, unless it is declared.
  if (!supersedes) {
    const oldStaged = extractStagedTactics(oldContent);
    if (oldStaged.length) {
      const newClaims = new Set(extractStagedTactics(newContent).map((t) => t.claim));
      const unparked = oldStaged.filter((t) => !newClaims.has(t.claim));
      if (unparked.length) {
        throw new Error(
          `Refusing to edit "${newFm.name}": the replacement unparks ${unparked.length} staged ` +
          `tactic${unparked.length === 1 ? '' : 's'} — ${unparked.map((t) => `"${t.claim}" (${t.stage})`).join(', ')}. ` +
          `A parked tactic that loses its stage marker goes straight into the fleet projection. ` +
          `If the gate really has opened, say so in "supersedes".`
        );
      }
    }
  }

  if (newContent.length < oldContent.length * SHRINK_FLOOR && !supersedes) {
    const pct = Math.round((1 - newContent.length / oldContent.length) * 100);
    throw new Error(
      `Refusing to shrink "${newFm.name}" by ${pct}% without an explicit supersedes reason ` +
      `(${oldContent.length} -> ${newContent.length} chars).`
    );
  }
  return true;
}

export const EXTRACTION_MODEL = 'claude-opus-5';
const VERDICTS = new Set(['adopt', 'reject']);

/**
 * The operating sequence, in order. A tactic that is right for this business but
 * blocked by an earlier gate is ADOPTED with the stage that unblocks it, not
 * rejected — rejecting parked it in a per-video JSON report that nothing reads
 * again, so reaching the gate meant re-deriving the tactic from scratch.
 *
 * Order is load-bearing: `isStageActive` compares indices, so these must stay in
 * the sequence CLAUDE.md states (Tracking -> CRO -> Offer/AOV -> Traffic). The
 * values are written into skill files and reports, so they are a compatibility
 * surface — add to the end rather than renaming.
 *
 * `scale` and `team` were appended 2026-08-20. The first four are FUNNEL gates and
 * all of them are open, which left `traffic` last and parking a no-op — so between
 * 2026-08-17 and 2026-08-20 the extractor was told to stop setting `stage`, and a
 * tactic that was sound but premature had nowhere to go but a reject. 41 of them
 * accumulated in reports nothing reads again, which is the exact failure the stage
 * mechanism was built to prevent, wearing a different hat.
 *
 * These two are CAPACITY gates rather than funnel phases:
 *   scale — order, list and spend volume. Unlocks anything needing a readable
 *           signal (significance, decile contrasts, per-permutation reads, fatigue
 *           thresholds), multi-cell tests, budget split across ad sets, and paid
 *           analytics subscriptions. Today: ~54 orders/mo, sub-1,000 list, $30/day.
 *           TRIGGER, set by the operator 2026-08-21: BOTH $100/day sustained ad spend
 *           AND 200+ orders/month, whichever arrives second. Deliberately the
 *           conservative reading — the parked tactics need spend (a $100/day
 *           Advantage+ floor, multi-cell tests) *and* volume (a decile contrast at
 *           54 orders/month is a guess), so either alone unparks work that still
 *           cannot be read.
 *   team  — people who are not the solo operator. Unlocks video and UGC production,
 *           a creator roster, a designer or editor, a media buyer, sales staff.
 *
 * Ordering them scale-then-team asserts that revenue funds people, which is the
 * right default here but is not a law: a freelance creator could plausibly be hired
 * before the volume arrives. The linear compare is what `isStageActive` supports,
 * and getting the order slightly wrong only parks something one gate too late —
 * strictly better than the reject it replaces.
 */
export const STAGES = Object.freeze(['tracking', 'cro', 'offer-aov', 'traffic', 'scale', 'team']);

/**
 * The gate this business has currently reached. Bump it as phases clear.
 *
 * 2026-08-17: bumped 'cro' -> 'traffic'. A Meta paid campaign is being stood up to drive
 * entries to the soap giveaway, so every funnel gate is open and every tactic parked
 * behind one goes live.
 *
 * It stays at 'traffic' after the 2026-08-20 append of 'scale' and 'team': those are the
 * gates AHEAD, and the whole point of appending them was to give a premature tactic
 * somewhere to live. Bump this only when the capacity it names actually exists — 'scale'
 * when a metric can be read rather than squinted at, 'team' when someone other than the
 * operator is producing work. Bumping it early re-hides nothing and un-hides everything.
 */
export const CURRENT_STAGE = 'traffic';

/** A tactic is active once its gate is the current one or an earlier one. Untagged is always active. */
export function isStageActive(stage, current = CURRENT_STAGE) {
  if (!stage) return true;
  const at = STAGES.indexOf(stage);
  const now = STAGES.indexOf(current);
  if (at === -1 || now === -1) return true; // unknown values fail open — never hide a tactic on a typo
  return at <= now;
}

/**
 * Did this rejection turn on TIMING rather than on merit?
 *
 * A merit rejection stays rejected forever: no mechanism, a duplicate of something
 * already recorded, or nothing an ecommerce catalog could ever do. A timing rejection
 * is the one this project keeps getting wrong — the tactic is sound and the only
 * problem is that the business has not got there yet. Those belong behind a stage
 * gate, on the record, not in a JSON file nothing reads again.
 *
 * Deliberately a keyword predicate over the recorded reasoning rather than a model
 * call: it decides only what is worth PAYING a model to re-read, so a false positive
 * costs a few cents and a false negative costs a lost tactic. It is therefore tuned
 * to over-include. Merit signals win ties — a rejection that says "duplicates X" is a
 * duplicate even if it also mentions the budget.
 */
const MERIT_REJECT = new RegExp([
  'duplicat', 'already (owned|covered|captured|exists|recorded|the lead|in )', 'restates',
  'degrade (skill )?triggering', 're-adding', 'no (stated )?mechanism', 'motivational',
  'no procedure', 'framing with no',
].join('|'), 'i');

const TIMING_REJECT = new RegExp([
  // people the operator does not have. Matched bare rather than as "no <role>":
  // the corpus says "requires a media buyer" as often as "no media buyer", and a
  // false positive here costs a few cents while a false negative loses a tactic.
  '\\bteams?\\b', '\\bagenc(y|ies)\\b', 'media buyer', '\\bdesigner\\b', '\\bvideographer\\b',
  '\\beditor\\b', '\\bstaff\\b', '\\bhire\\b', '\\bheadcount\\b', 'creator roster',
  'does not produce video', 'call cent(er|re)',
  // volume the numbers do not have
  'needs volume', 'not enough volume', 'statistical', 'significan', 'too small',
  'sub-1,000', '~?54 orders', 'at this scale', 'decile',
  // budget the account does not have
  'larger budget', '\\$100/day', '20-creative', 'paid (analytics )?subscription',
  'materially above current spend',
  // explicit futurity
  'not yet', 'premature', 'later stage', 'once the business', 'when the business',
].join('|'), 'i');

export function isTimingReject(tactic) {
  if (tactic?.verdict !== 'reject') return false;
  const why = `${tactic.rejectReason ?? ''} ${tactic.rscFit?.reasoning ?? ''}`;
  if (MERIT_REJECT.test(why)) return false;
  return TIMING_REJECT.test(why);
}

/** Written into SKILL.md under a staged tactic's heading, and read back by extractStagedTactics. */
const STAGE_MARKER = /^\*\*Stage:\*\*[ \t]*([a-z0-9-]+)/im;
const ACTIONS = new Set(['create', 'edit']);

export function buildExtractionPrompt({ video, inventory = [], chunk = null }) {
  const dateLine = video.publishedAt
    ? `Published: ${video.publishedAt}`
    : 'Published: the publish date is unknown — infer era from the transcript and report it in recencySignals.';

  const sourceId = video.sourceId ?? video.videoId;
  const chunkLine = chunk
    ? `\nThis is an EXCERPT of a longer work: ${chunk.label} (${chunk.index + 1} of ${chunk.total}). ` +
      `Extract only what THIS excerpt supports. Do not speculate about the rest of the work — ` +
      `a later step reconciles every excerpt.`
    : '';

  const inventoryBlock = inventory.length
    ? inventory.map((s) => `### ${s.name}\n_${s.description}_\n\n${s.content}`).join('\n\n---\n\n')
    : '(no marketing skills exist yet — every adopted tactic will create one)';

  // Deduped, like renderContextMirror's blocklist: the same tactic can be
  // falsified in two skills, and listing it twice reads as two separate
  // findings rather than one.
  const falsified = [...new Set(inventory.flatMap((s) => extractFalsifiedClaims(s.content)))];
  const falsifiedBlock = falsified.length
    ? `## Already tested here and failed\n\nThese tactics have already been tested here and failed. Reject any tactic that restates one, and say so in rejectReason. Be alert to near-variants — a reworded version of a failed tactic is still a failed tactic.\n\n${falsified.map((c) => `- ${c}`).join('\n')}`
    : '';

  return `You are extracting marketing tactics from a video transcript for a specific small business.

${buildConstraintBlock({ sourceType: video.sourceType, sourceKind: video.sourceKind })}

## Skills that already exist

Prefer editing an existing skill over creating a near-duplicate. Duplicate skills degrade
triggering accuracy, because Claude Code selects skills by matching their descriptions.

${inventoryBlock}

${falsifiedBlock}

## The video

Title: ${video.title ?? 'unknown'}
Creator: ${video.creator ?? 'unknown'}
${dateLine}
Duration: ${video.durationSeconds ? Math.round(video.durationSeconds / 60) + ' minutes' : 'unknown'}${chunkLine}

<transcript>
${chunk ? chunk.text : video.text}
</transcript>

## Your task

Identify every distinct, actionable marketing tactic the creator advocates. For each one,
judge honestly whether it applies to THIS business. Most tactics from most videos will not.
Being generous helps nobody: a wrong tactic promoted into a skill silently degrades future work.

Return ONLY a JSON object, no prose around it:

{
  "sourceId": "${sourceId}",
  "creator": "...",
  "title": "...",
  "summary": "one paragraph: what this video is actually about",
  "recencySignals": "era cues found in the transcript (platform features, product names, explicit years), or null",
  "tactics": [
    {
      "claim": "what the creator asserts, in one sentence",
      "mechanism": "the causal story — why it supposedly works",
      "evidence": "what the creator offers as proof, or 'assertion only'",
      "rscFit": { "score": 0, "reasoning": "why this score, referencing a specific constraint above" },
      "verdict": "adopt" | "reject",
      "rejectReason": "required when verdict is reject, otherwise null",
      "targetSkill": { "name": "marketing-<topic-kebab>", "action": "create" | "edit", "description": "..." }
    }
  ]
}

Rules:
- targetSkill is null when verdict is "reject", and required when verdict is "adopt".
- targetSkill.name MUST start with "marketing-" and be kebab-case.
- Use action "edit" when one of the existing skills above is the right home; "create" otherwise.
- score is an integer 0-10.
- When age drove the score down, rscFit.reasoning must name the tactic class from the decay table.
- targetSkill.description is REQUIRED on every adopted tactic, even when action is "edit" (an
  edit target may not exist yet as a real skill — the model routinely proposes editing something
  it just decided to create). Claude Code selects which skill to load by matching this description
  against the task at hand, so it must describe WHEN to reach for the skill, not WHAT it is named:
  - Name the concrete SITUATIONS that should trigger the skill, not the topic. Start with "Use when".
  - Bad: "Use when working on review mining for copy for Real Skin Care." (restates the title, matches nothing)
  - Good: "Use when writing product page copy, Amazon bullet points, ad copy, or email subject
    lines and you need language that converts — covers mining existing customer reviews for
    verbatim phrasing and objection framing."
  - Mention the artifacts and surfaces a person would actually be working on when they need it
    (product pages, Amazon listings, email flows, collection pages, ad creative), because those
    are the words that will appear in a real task.
  - One or two sentences. No trailing "for Real Skin Care" boilerplate.`;
}

export function validateExtraction(obj) {
  if (!obj || typeof obj !== 'object') throw new Error('Extraction result is not an object.');
  if (!Array.isArray(obj.tactics)) throw new Error('Extraction result: tactics must be an array.');

  for (const [i, t] of obj.tactics.entries()) {
    const at = `tactics[${i}]`;
    if (!t.claim) throw new Error(`${at}: claim is required.`);
    if (!t.mechanism) throw new Error(`${at}: mechanism is required — a tactic with no stated causal mechanism is motivational framing, not actionable.`);
    if (!VERDICTS.has(t.verdict)) throw new Error(`${at}: verdict must be "adopt" or "reject", got "${t.verdict}".`);

    const score = t.rscFit?.score;
    if (!Number.isInteger(score) || score < 0 || score > 10) {
      throw new Error(`${at}: rscFit.score must be an integer 0-10, got ${JSON.stringify(score)}.`);
    }
    if (!t.rscFit?.reasoning) throw new Error(`${at}: rscFit.reasoning is required.`);

    if (t.verdict === 'reject') {
      if (!t.rejectReason) throw new Error(`${at}: rejectReason is required when verdict is "reject".`);
      // A rejected tactic is dead, not parked. Allowing a stage here would recreate
      // the invisible parking lot this field exists to remove: a gate tag with no
      // skill entry behind it, discoverable only by re-reading per-video JSON.
      if (t.stage) {
        throw new Error(
          `${at}: stage is not allowed when verdict is "reject" — a stage-blocked tactic should be ` +
          `adopted with that stage so it lands in the skill, not rejected.`
        );
      }
    } else {
      if (t.stage != null && !STAGES.includes(t.stage)) {
        throw new Error(`${at}: stage must be one of ${STAGES.join(', ')} (or omitted), got "${t.stage}".`);
      }
      if (!t.targetSkill) throw new Error(`${at}: targetSkill is required when verdict is "adopt".`);
      if (!/^marketing-[a-z0-9]+(-[a-z0-9]+)*$/.test(String(t.targetSkill.name))) {
        throw new Error(`${at}: targetSkill.name must start with "marketing-" and be kebab-case, got "${t.targetSkill.name}".`);
      }
      if (!ACTIONS.has(t.targetSkill.action)) {
        throw new Error(`${at}: targetSkill.action must be "create" or "edit", got "${t.targetSkill.action}".`);
      }
      // Required unconditionally, not just when action === "create": the model
      // routinely proposes "edit" for skills that do not exist on disk yet, so
      // gating on action would leave the create path with no description exactly
      // when it needs one. A skill description that just restates its own title
      // gives Claude Code's skill matcher nothing to match on — it silently never
      // triggers, which is worse than not having the skill at all.
      if (typeof t.targetSkill.description !== 'string' || !t.targetSkill.description.trim()) {
        throw new Error(`${at}: targetSkill.description is required (non-empty string) for adopted tactics.`);
      }
    }
  }
  return obj;
}

/**
 * Strip commas that sit immediately before a `}` or `]`. This is by far the most
 * common way an otherwise well-formed extraction comes back unparseable — the Dara
 * Denney statics video failed twice in a row on it, 17 offenders in one chunk and 4
 * in another, each failure throwing away a paid call.
 *
 * A regex alone would corrupt any string value containing `, }` or `, ]`, and the
 * tactic prose here is exactly the kind of text that does, so walk the input and
 * track whether we are inside a string (honouring backslash escapes) instead.
 */
function stripTrailingCommas(json) {
  let out = '';
  let inString = false;
  let escaped = false;

  for (let i = 0; i < json.length; i += 1) {
    const ch = json[i];

    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }

    if (ch === ',') {
      // Look ahead past whitespace: a `}` or `]` means this comma is trailing.
      let j = i + 1;
      while (j < json.length && /\s/.test(json[j])) j += 1;
      if (json[j] === '}' || json[j] === ']') continue; // drop the comma, keep the whitespace
    }

    out += ch;
  }

  return out;
}

/**
 * Extract a JSON object from a model text response. Models wrap JSON in a fenced
 * ```json block, return it raw, or (occasionally) surround it with stray prose —
 * try each in turn before giving up. `errorLabel` names what failed in the thrown
 * error, e.g. "the extraction response for abc12345678".
 */
function parseJsonBlock(text, errorLabel) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced ? fenced[1] : text).trim();

  // A parse failure is as expensive to lose as a schema failure — the call is
  // already paid for, and without the raw text there is nothing left to diagnose.
  // The caller persists err.offendingPayload; an empty text is itself the finding
  // (a refusal or a thinking-only response returns no text block at all).
  const fail = () => {
    const err = new Error(
      `Could not parse JSON from ${errorLabel}${candidate ? '' : ' — the response contained no text'}.`,
    );
    err.rawText = text;
    throw err;
  };

  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start === -1 || end <= start) fail();
    const sliced = candidate.slice(start, end + 1);
    try {
      return JSON.parse(sliced);
    } catch {
      try {
        return JSON.parse(stripTrailingCommas(sliced));
      } catch {
        fail();
      }
    }
  }
}

/**
 * Budgeted at 32k, and streaming, for the same reason consolidation is.
 *
 * 16k was sized against video transcripts, where 4,500 words of speech carry a
 * handful of tactics. A book is far denser: part 3 of 11 of $100M Money Models
 * overflowed 16k and tripped the truncation guard, killing the run. The budget is
 * shared with adaptive thinking — max_tokens caps thinking AND the JSON together —
 * so it has to clear both, and max_tokens is a ceiling rather than a charge: a
 * sparse chunk bills the same as it did before. The larger budget forces streaming
 * (the SDK refuses a non-streaming request whose max_tokens implies a >10-minute
 * operation); lib/anthropic.js meters stream() as well as create(), so extraction
 * stays in the cost report.
 */
export async function extractTactics({ video, inventory = [], client, chunk = null, maxTokens = 32000, retryOptions = {} }) {
  // `chunk` must be forwarded, not just accepted: buildExtractionPrompt falls back to
  // the full `video.text` when it is absent, so dropping it here turns chunking into a
  // silent no-op — N chunks become N identical full-transcript calls that still overflow.
  const prompt = buildExtractionPrompt({ video, inventory, chunk });

  // videoId is null on the file path, so naming it produced "Extraction for null"
  // on every book failure — useless for telling which of 11 chunks broke.
  const where = video.sourceId ?? video.videoId ?? 'unknown source';
  const label = chunk?.label ? `${where} (${chunk.label})` : where;

  // Retry wraps the API call ONLY, never the guards below. A book is 11+ sequential
  // calls, so one transient 529 anywhere in the run used to discard every chunk after
  // it; three consecutive runs of $100M Money Models died that way.
  const callOnce = () => withRetry(
    () => client.messages
      .stream({
        model: EXTRACTION_MODEL,
        max_tokens: maxTokens,
        thinking: { type: 'adaptive' },
        messages: [{ role: 'user', content: prompt }],
      })
      .finalMessage(),
    { label: chunk?.label ?? video.sourceId ?? video.videoId ?? 'extraction', ...retryOptions }
  );

  // ONE re-sample for a body that came back malformed or schema-invalid, and only
  // for that. This used to be lumped in with truncation as "deterministic, don't
  // retry", and that read is wrong for a body the model simply got wrong: on
  // 2026-08-22 The Entrepreneurial Emergency died on chunk 4 of 6 because the model
  // wrote a `rejectReason` for the last tactic and omitted its `verdict` — one
  // dropped key out of seven objects. The JSON parsed; only the schema failed. A
  // re-run of the identical prompt produced valid output, so the failure was
  // sampling variance, not a property of the prompt, and refusing to re-sample
  // discarded five good chunks and a consolidation pass with it.
  //
  // Exactly one extra attempt, because the honest uncertainty is "did this sample
  // slip" — repeated failure means the prompt or the ceiling is the problem, and
  // paying four calls and three minutes of backoff to confirm that is the waste the
  // original no-retry rule was written to prevent.
  //
  // Truncation is still NOT re-sampled: `stop_reason: 'max_tokens'` says the output
  // did not fit the ceiling, and a second attempt against that same ceiling cannot
  // fix it. Same reasoning as the demand-miner classifier.
  const SCHEMA_ATTEMPTS = 2;
  let lastErr = null;

  for (let attempt = 1; attempt <= SCHEMA_ATTEMPTS; attempt++) {
    const res = await callOnce();

    // Repo rule: truncated structured output is corrupt, not partial.
    if (res.stop_reason === 'max_tokens') {
      throw new Error(`Extraction for ${label} hit max_tokens — output is truncated. Refusing to save.`);
    }

    // A refusal is not sampling variance either: the safety classifiers declined this
    // prompt, and re-sending it unchanged reaches the same decision. Grouped with
    // truncation rather than with a malformed body — in both cases the model told you
    // why it stopped, and the answer is not "try again".
    if (res.stop_reason === 'refusal') {
      lastErr = Object.assign(
        new Error(`Extraction for ${label} was refused (stop_reason: refusal). Refusing to save.`),
        { offendingPayload: { stop_reason: 'refusal', rawText: '' } },
      );
      throw lastErr;
    }

    const text = (res.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('');

    // Two failure shapes, two payload contracts, both kept as they were — the caller
    // persists whichever it gets, and a schema failure's parsed object is the thing
    // worth reading (it is how the missing `verdict` key above was diagnosed).
    let parsed;
    try {
      parsed = parseJsonBlock(text, `the extraction response for ${label}`);
    } catch (err) {
      // On a parse failure the payload carries stop_reason: when the text is empty,
      // why the model stopped IS the diagnosis.
      err.offendingPayload = { stop_reason: res.stop_reason ?? null, rawText: err.rawText ?? text };
      lastErr = err;
      if (attempt < SCHEMA_ATTEMPTS) console.warn(`  ⚠ ${label}: ${err.message} — re-sampling once.`);
      continue;
    }

    try {
      return validateExtraction(parsed);
    } catch (err) {
      // Schema-invalid model output is expensive to lose — the operator has already
      // paid for the call. Carry the raw payload on the error so the caller (which
      // knows the corpus path; this module deliberately doesn't) can persist it for
      // inspection before the error propagates.
      err.offendingPayload = parsed;
      lastErr = err;
      if (attempt < SCHEMA_ATTEMPTS) console.warn(`  ⚠ ${label}: ${err.message} — re-sampling once.`);
    }
  }

  throw lastErr;
}

/**
 * Re-try a batch of previously-REJECTED tactics under the current stage rules.
 *
 * The rejects are a permanent record, so a rule change that would have adopted one
 * is retroactively recoverable — but only if something goes back and looks. Nothing
 * did, which is how 41 sound-but-early tactics ended up discarded while the stage
 * mechanism that exists to hold them sat switched off.
 *
 * Only two outcomes are allowed here, and neither is "adopt, unparked": a tactic
 * rejected on merit stays rejected, and a tactic rejected on timing becomes an adopt
 * WITH a stage. Anything genuinely runnable today would not have been rejected on
 * timing in the first place, and letting this pass promote straight into the live
 * projection would let a second-guess overrule a first-hand read of the source.
 */
export async function readjudicateRejects({
  tactics, inventory = [], client, maxTokens = 32000, retryOptions = {},
}) {
  const open = STAGES.slice(0, STAGES.indexOf(CURRENT_STAGE) + 1);
  const ahead = STAGES.slice(STAGES.indexOf(CURRENT_STAGE) + 1);
  if (!ahead.length) {
    throw new Error(
      'No gate sits ahead of CURRENT_STAGE, so every recovered tactic would go straight '
      + 'into the live projection. Append a gate to STAGES before re-adjudicating.',
    );
  }

  // The inventory is what stops this pass inventing a skill per tactic. Names and
  // descriptions only, not full bodies: routing needs to know what exists and what
  // each one is FOR, and 22 whole skills would crowd out the tactics being judged.
  const inventoryBlock = inventory.length
    ? inventory.map((s) => `- \`${s.name}\` — ${s.description}`).join('\n')
    : '(no skills exist yet)';

  const prompt = `${buildConstraintBlock()}

## Skills that already exist

${inventoryBlock}

## Your task

Each tactic below was extracted from a marketing source and REJECTED. The rejection
rules have since changed: needing volume, budget, or people this business does not have
YET is now a **stage**, not a rejection. Some of these were discarded under the old rule
and should have been parked.

Re-judge each one. Two outcomes only:

- \`"recover"\` — the tactic is sound and the ONLY thing wrong with it is that the
  business has not reached the scale or capacity it needs. Assign the gate that unblocks
  it: ${ahead.map((s) => `\`${s}\``).join(' or ')}. Score it on the merit it will have
  when that gate opens.
- \`"uphold"\` — the rejection was right on merit. No mechanism, a duplicate of something
  already in the skills listed above, or no honest translation to an ecommerce catalog at
  ANY size. Also uphold anything that is simply runnable today — those were not timing
  rejections and this pass must not second-guess the original read.

Gates already open (never park behind these): ${open.join(', ')}.

Be strict. Recovering junk is worse than leaving it rejected, because a parked tactic
resurfaces the day its gate opens and will be trusted then.

<rejected-tactics>
${tactics.map((t, i) => `[${i}] ${t.sourceId ?? 'unknown'}
claim: ${t.claim}
mechanism: ${t.mechanism ?? 'n/a'}
original score: ${t.rscFit?.score ?? '?'}/10
rejected because: ${t.rejectReason ?? t.rscFit?.reasoning ?? 'n/a'}`).join('\n\n')}
</rejected-tactics>

Return ONLY a JSON object:

{ "verdicts": [ { "index": 0, "outcome": "recover" | "uphold",
                  "stage": "<gate>" | null,
                  "score": 0,
                  "reasoning": "why, naming the specific capacity that is missing and what has to be true before it is worth doing",
                  "targetSkill": { "name": "marketing-<topic-kebab>", "action": "create" | "edit", "description": "Use when ..." } | null } ] }

Rules:
- One entry per tactic, every index present exactly once.
- stage and targetSkill are REQUIRED when outcome is "recover", and null when "uphold".
- stage must be one of ${ahead.map((s) => `"${s}"`).join(' or ')}.
- **Route into an EXISTING skill from the list above wherever one plausibly fits**
  (action "edit", using its exact name). Every tactic you recover here is parked, so a
  new skill created for one would contain nothing usable today — it would sit in the
  skill list diluting the descriptions Claude Code matches against, which is the same
  harm duplication causes. Use action "create" only when no existing skill is a
  defensible home, and never create one skill per tactic: recovered tactics about the
  same subject share a target.
- targetSkill.description must say WHEN to reach for the skill, starting with "Use when".`;

  const res = await withRetry(
    () => client.messages
      .stream({
        model: EXTRACTION_MODEL,
        max_tokens: maxTokens,
        thinking: { type: 'adaptive' },
        messages: [{ role: 'user', content: prompt }],
      })
      .finalMessage(),
    { label: `readjudicate ${tactics.length}`, ...retryOptions },
  );

  if (res.stop_reason === 'max_tokens') {
    throw new Error('Re-adjudication hit max_tokens — output is truncated. Refusing to save.');
  }
  const text = (res.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  const parsed = parseJsonBlock(text, 're-adjudication response');

  const verdicts = parsed?.verdicts;
  if (!Array.isArray(verdicts) || verdicts.length !== tactics.length) {
    const err = new Error(`Expected ${tactics.length} verdicts, got ${verdicts?.length ?? 'none'}.`);
    err.offendingPayload = parsed;
    throw err;
  }
  const seen = new Set();
  for (const v of verdicts) {
    const at = `verdict for index ${v?.index}`;
    if (!Number.isInteger(v?.index) || v.index < 0 || v.index >= tactics.length) {
      throw Object.assign(new Error(`${at}: index out of range.`), { offendingPayload: parsed });
    }
    if (seen.has(v.index)) {
      throw Object.assign(new Error(`${at}: duplicated.`), { offendingPayload: parsed });
    }
    seen.add(v.index);
    if (v.outcome !== 'recover' && v.outcome !== 'uphold') {
      throw Object.assign(new Error(`${at}: outcome must be "recover" or "uphold".`), { offendingPayload: parsed });
    }
    if (v.outcome === 'uphold') continue;
    // A recovered tactic with no gate would land unparked in the live projection —
    // the precise failure this pass exists to undo.
    if (!ahead.includes(v.stage)) {
      throw Object.assign(
        new Error(`${at}: recovered tactics need a stage ahead of ${CURRENT_STAGE} (${ahead.join(', ')}), got ${JSON.stringify(v.stage)}.`),
        { offendingPayload: parsed },
      );
    }
    if (!v.targetSkill?.name?.startsWith('marketing-')) {
      throw Object.assign(new Error(`${at}: recovered tactics need a marketing-* targetSkill.`), { offendingPayload: parsed });
    }
    if (!Number.isInteger(v.score) || v.score < 0 || v.score > 10) {
      throw Object.assign(new Error(`${at}: score must be an integer 0-10.`), { offendingPayload: parsed });
    }
  }

  return verdicts.map((v) => ({
    ...tactics[v.index],
    verdict: v.outcome === 'recover' ? 'adopt' : 'reject',
    outcome: v.outcome,
    stage: v.outcome === 'recover' ? v.stage : undefined,
    rscFit: { score: v.score ?? tactics[v.index].rscFit?.score ?? 0, reasoning: v.reasoning },
    targetSkill: v.outcome === 'recover' ? v.targetSkill : null,
  }));
}

/**
 * The rejects are a first-class output, not a debug artifact: "what is NOT
 * beneficial" is half of why this tool exists, and it is invisible in a skill diff.
 */
export function renderReport({ extraction, video, skillsTouched = [] }) {
  const adopted = extraction.tactics.filter((t) => t.verdict === 'adopt').sort((a, b) => b.rscFit.score - a.rscFit.score);
  const rejected = extraction.tactics.filter((t) => t.verdict === 'reject').sort((a, b) => b.rscFit.score - a.rscFit.score);

  const L = [];
  L.push(`# ${extraction.title ?? video.title ?? video.sourceId ?? video.videoId}`, '');
  L.push(`**Creator:** ${extraction.creator ?? video.creator ?? 'unknown'}  `);
  L.push(video.sourceType === 'file'
    ? `**Source:** ${video.sourceKind ?? 'book'} — \`${video.sourceId}\`  `
    : `**Video:** https://www.youtube.com/watch?v=${video.videoId}  `);
  L.push(`**Published:** ${video.publishedAt ?? 'unknown (not supplied via --published)'}  `);
  if (extraction.recencySignals) L.push(`**Inferred era cues:** ${extraction.recencySignals}  `);
  L.push('', extraction.summary ?? '', '');
  const parked = adopted.filter((t) => t.stage);
  L.push(
    `Found ${extraction.tactics.length} tactic${extraction.tactics.length === 1 ? '' : 's'}: ` +
    `${adopted.length} adopted, ${rejected.length} rejected` +
    (parked.length ? ` (${parked.length} of the adopted parked behind a stage gate).` : '.'),
    '',
  );

  L.push('## Adopted', '');
  if (!adopted.length) {
    L.push('_No tactics adopted from this video._', '');
  } else {
    for (const t of adopted) {
      L.push(`### ${t.claim} — ${t.rscFit.score}/10${t.stage ? ` · parked until \`${t.stage}\`` : ''}`, '');
      L.push(`**Why it works:** ${t.mechanism}`, '');
      L.push(`**Evidence:** ${t.evidence ?? 'assertion only'}`, '');
      L.push(`**Fit:** ${t.rscFit.reasoning}`, '');
      L.push(`**Target skill:** \`${t.targetSkill.name}\` (${t.targetSkill.action})`, '');
      // Surfaces an implausible merge without re-reading the book.
      if (t.mergedFrom?.length) {
        L.push(`**Merged from:** ${t.mergedFrom.map((m) => m.label).join('; ')}`, '');
      }
    }
  }

  L.push('## Rejected', '');
  if (!rejected.length) {
    L.push('_Nothing rejected._', '');
  } else {
    for (const t of rejected) {
      L.push(`### ${t.claim} — ${t.rscFit.score}/10`, '');
      L.push(`**Rejected because:** ${t.rejectReason}`, '');
      L.push(`**Fit reasoning:** ${t.rscFit.reasoning}`, '');
    }
  }

  L.push('## Skills touched', '');
  L.push(skillsTouched.length
    ? skillsTouched.map((s) => `- \`${s.name}\` (${s.action})`).join('\n')
    : '_None._');
  L.push('');

  return L.join('\n');
}

export function buildConsolidationPrompt({ candidates, source }) {
  const block = candidates.map((t, i) => (
    `[${i}] (${t.chunk?.label ?? 'unknown excerpt'})\n` +
    `  Claim: ${t.claim}\n  Mechanism: ${t.mechanism}\n  Evidence: ${t.evidence ?? 'assertion only'}\n` +
    `  Verdict: ${t.verdict} — ${t.rscFit.score}/10: ${t.rscFit.reasoning}` +
    (t.targetSkill ? `\n  Target skill: ${t.targetSkill.name} (${t.targetSkill.action})` : '')
  )).join('\n\n');

  return `You are consolidating marketing tactics extracted from separate excerpts of ONE work.

Source: ${source.creator ?? 'unknown'} — "${source.title ?? 'untitled'}"

Because the work was processed in excerpts, the SAME tactic frequently appears more than
once: chapters restate their own points in summary blocks, closing chapters restate the
whole work, and consecutive excerpts overlap on purpose. Your job is to collapse those
restatements into one canonical tactic each.

## Candidates

${block}

## Rules

- Merge candidates that are the same tactic, INCLUDING near-variants worded differently.
  "Bill weekly" and "use four-week billing cycles" are one tactic, not two.
- Do NOT merge tactics that merely share a topic. Two distinct plays about pricing are two tactics.
- For each canonical tactic, keep the BEST-stated claim, mechanism, and evidence across the
  candidates it came from — usually the fullest statement, not the first.
- Keep the highest rscFit score among the merged candidates and write reasoning that holds
  for the merged whole.
- **Every candidate index must appear in exactly one canonical tactic's mergedFrom. Not zero,
  not two.** A candidate you think is worthless is still a candidate: keep it as its own
  tactic with verdict "reject" and a rejectReason. Dropping one is a hard error.
- Preserve verdict semantics: targetSkill is required when verdict is "adopt" and null when
  "reject"; rejectReason is required when "reject".

Return ONLY a JSON object, no prose around it:

{
  "tactics": [
    {
      "claim": "...",
      "mechanism": "...",
      "evidence": "...",
      "rscFit": { "score": 0, "reasoning": "..." },
      "verdict": "adopt" | "reject",
      "rejectReason": "required when reject, otherwise null",
      "targetSkill": { "name": "marketing-<topic-kebab>", "action": "create" | "edit", "description": "..." },
      "mergedFrom": [{ "candidateIndex": 0, "label": "the excerpt label from above" }]
    }
  ]
}`;
}

/**
 * Every candidate must land in exactly one merge group.
 *
 * This is code rather than persuasion for the same reason the falsified-claims
 * guard is: an LLM asked to merge a 60-item list can silently omit items and
 * still return well-formed, plausible output. No other guard would catch it —
 * validateSkillEdit's shrink floor only sees the final skill file, by which
 * point the dropped tactic never existed.
 */
export function validateConsolidation(candidates, consolidated) {
  if (!consolidated || !Array.isArray(consolidated.tactics)) {
    throw new Error('Consolidation result: tactics must be an array.');
  }

  const claimedBy = new Map(); // candidateIndex -> [groupIndex, …]
  consolidated.tactics.forEach((t, gi) => {
    if (!Array.isArray(t.mergedFrom) || !t.mergedFrom.length) {
      throw new Error(`Consolidated tactic ${gi} ("${t.claim}") has no mergedFrom — every canonical tactic must name the candidates it came from.`);
    }
    for (const m of t.mergedFrom) {
      const idx = m?.candidateIndex;
      if (!Number.isInteger(idx) || idx < 0 || idx >= candidates.length) {
        throw new Error(`Consolidated tactic ${gi} ("${t.claim}") references candidateIndex ${JSON.stringify(idx)}, which is not a candidate (valid: 0-${candidates.length - 1}).`);
      }
      if (!claimedBy.has(idx)) claimedBy.set(idx, []);
      claimedBy.get(idx).push(gi);
    }
  });

  const dropped = candidates.map((_, i) => i).filter((i) => !claimedBy.has(i));
  if (dropped.length) {
    throw new Error(
      `Consolidation dropped ${dropped.length} candidate tactic${dropped.length === 1 ? '' : 's'}: ` +
      dropped.map((i) => `[${i}] "${candidates[i].claim}"`).join(', ') +
      '. Every candidate must land in exactly one merge group.',
    );
  }

  const doubled = [...claimedBy.entries()].filter(([, gs]) => gs.length > 1);
  if (doubled.length) {
    throw new Error(
      `Consolidation double-claimed ${doubled.length} candidate${doubled.length === 1 ? '' : 's'}: ` +
      doubled.map(([i, gs]) => `[${i}] "${candidates[i].claim}" appears in groups ${gs.join(' and ')}`).join('; ') + '.',
    );
  }

  validateExtraction(consolidated); // same tactic shape as a single-source extraction
  return consolidated;
}

/**
 * One Opus call over the whole run's candidates, before anything touches a skill.
 *
 * Budgeted higher than a single extraction because its input is every candidate from
 * every chunk, and the no-drop guard means output scales with that count: every
 * candidate must land in a group, and every group carries a full tactic object. The
 * budget has now been wrong twice — 37 candidates from a 3-chunk transcript did not
 * fit in 16k, and 172 from the 11 chunks of $100M Money Models did not fit in 32k.
 * 128k is claude-opus-5's output ceiling, so this is the last raise available: a book
 * that overflows it needs consolidation batched, not enlarged. max_tokens is a
 * ceiling rather than a charge — a short run bills what it always did.
 */
export async function consolidateTactics({ candidates, source, client, maxTokens = 128000, retryOptions = {} }) {
  const prompt = buildConsolidationPrompt({ candidates, source });
  // stream(), not create(): the SDK rejects a non-streaming request outright once
  // max_tokens implies a possible >10-minute operation. finalMessage() gives back the
  // same shape create() returned, so everything below is unchanged.
  //
  // Retry covers the transport only, never the guards below — same reasoning as
  // extractTactics. This one call stands between N cached chunk extractions and a
  // saved report, so losing it to a transient 529 costs a whole manual re-run.
  const res = await withRetry(
    () => client.messages
      .stream({
        model: EXTRACTION_MODEL,
        max_tokens: maxTokens,
        thinking: { type: 'adaptive' },
        messages: [{ role: 'user', content: prompt }],
      })
      .finalMessage(),
    { label: `consolidate ${source?.title ?? 'untitled'}`, ...retryOptions }
  );

  if (res.stop_reason === 'max_tokens') {
    throw new Error(`Consolidation for "${source.title ?? 'untitled'}" hit max_tokens — output is truncated. Refusing to save.`);
  }

  const text = (res.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  const parsed = parseJsonBlock(text, `the consolidation response for "${source.title ?? 'untitled'}"`);
  try {
    return validateConsolidation(candidates, parsed);
  } catch (err) {
    // Same contract as extractTactics: the operator has already paid for this
    // call, so carry the raw payload out for the caller to persist.
    err.offendingPayload = parsed;
    throw err;
  }
}

/**
 * Merge new tactics into an existing skill by asking the model for a COMPLETE
 * replacement file, then guarding the result.
 *
 * Whole-file replacement rather than patch application: applying model-generated
 * diffs corrupts silently and is very hard to notice after the fact. The failure
 * mode here is wholesale loss instead, which validateSkillEdit catches.
 *
 * Budgeted at 64k, and streaming, for the same reason extraction is — but the
 * pressure here comes from the SKILL, not the source. Whole-file replacement means
 * the model re-emits every word the skill already holds before it adds a line, so
 * the budget has to clear the largest file in .claude/skills/ plus the new sections
 * plus adaptive thinking (max_tokens caps thinking and the JSON together). 16k was
 * sized when these skills were young; the since-split marketing-paid-acquisition-scaling
 * reached 4,339 words and overflowed it, killing a run after the transcript and extraction
 * were already paid for. That cost scales with how well the fleet is doing its job:
 * every successful merge makes the next merge of that skill more expensive, so this
 * would have failed on whichever skill grew fastest. Raising the budget only buys time —
 * that same file reached 34% of the RAISED budget by 2026-08-20 and was split into
 * marketing-paid-{campaign-structure,creative-testing,media-measurement} rather than
 * chasing it with another raise. Splitting is the actual remedy; skillSizeWarning below
 * is what tells you it is due.
 *
 * Raised 16k -> 32k -> 64k. The 2026-08-22 raise was deliberately the second-best fix:
 * marketing-conversion-copy-angles hit 45% of the 32k budget mid-ingest with four
 * copywriting sources still queued, and the split it was owed was NOT mechanical — 25 of
 * its sections cross-referenced each other positionally ("the rule directly below"), so
 * cutting the file would have turned those into dangling pointers silently. The raise
 * bought room to do that rewrite deliberately instead of mid-run.
 *
 * That split has since happened (marketing-copy-{hooks-and-formats,credibility-and-proof}
 * plus the original name), and no skill now exceeds 30% of this budget — so 64k is
 * currently slack, not a ceiling anyone is pressed against. It is kept because the
 * pressure is a ratchet: every successful merge makes the next merge of that skill
 * bigger, so the headroom is what buys time to notice and split again rather than
 * discovering it when a run dies. Opus 5 caps at 128k output, so one further raise
 * exists and then there is none — treat a third raise as the signal that something
 * needs splitting, not as the fix. max_tokens is a ceiling rather
 * than a charge — merging into a small skill bills what it always did. The larger
 * budget forces streaming (the SDK refuses a non-streaming request whose max_tokens
 * implies a >10-minute operation); lib/anthropic.js meters stream() as well as
 * create(), so the merge stays in the cost report.
 */
/**
 * Warn while there is still runway, because the merge budget fails LATE and expensively:
 * the transcript credit and every extraction call are already spent by the time the merge
 * refuses a truncated skill.
 *
 * The estimate is chars/4 — the usual English rough cut. It is a proxy and does not need
 * to be better than one, because the threshold is anchored empirically rather than
 * derived: the 2026-08-19 failure had a 4,339-word file (~29,000 chars, ~7.2k estimated
 * tokens) against a 16k budget. So the FILE alone was under half the budget and adaptive
 * thinking plus JSON escaping consumed the rest. Warning when the file passes 30% of
 * budget puts the alarm before that ratio, with room to act.
 *
 * Returns a string to print, or null. Deliberately not a throw: a skill that is merely
 * large still merges correctly, and refusing to run would be a worse failure than the one
 * being prevented.
 *
 * @returns {string|null}
 */
export function skillSizeWarning({ content, maxTokens = 64000, name = 'this skill' }) {
  const estimated = Math.round(String(content || '').length / 4);
  const share = estimated / maxTokens;
  if (share < 0.30) return null;
  return (
    `${name} is ~${estimated.toLocaleString()} tokens, ${Math.round(share * 100)}% of the ${maxTokens.toLocaleString()}-token merge budget. ` +
    `The merge re-emits the WHOLE file before adding anything, and shares that budget with thinking — ` +
    `past roughly half, runs on this skill start failing outright. Split it, or raise maxTokens in mergeSkillContent.`
  );
}

export async function mergeSkillContent({
  existingContent, tactics, client, maxTokens = 64000, currentStage = CURRENT_STAGE,
}) {
  const fm = parseFrontmatter(existingContent);

  // Before the call, not after: the point is to warn while the operator can still act,
  // and a warning printed after a successful merge is one nobody reads until it fails.
  const sizeWarning = skillSizeWarning({ content: existingContent, maxTokens, name: fm.name });
  if (sizeWarning) console.warn(`  ⚠️  ${sizeWarning}`);

  const dead = extractFalsifiedClaims(existingContent);
  const deadRule = dead.length
    ? `\n- The "## Falsified" section lists tactics already tested here that failed. Keep that section and every entry in it EXACTLY as-is. Never move an entry back into the live body, and never add a new tactic that restates one — if this transcript advocates one of them, leave it falsified.\n`
    : '\n';
  const tacticBlock = tactics.map((t) => (
    `- Claim: ${t.claim}\n  Mechanism: ${t.mechanism}\n  Evidence: ${t.evidence ?? 'assertion only'}\n` +
    `  Fit ${t.rscFit.score}/10: ${t.rscFit.reasoning}\n` +
    (t.stage ? `  Stage: ${t.stage} (parked — emit the **Stage:** line for this one)\n` : '') +
    `  Source: ${t.source.creator} — "${t.source.title}" (${t.source.locator})`
  )).join('\n');

  // The model rewrites the whole file, so any marker it is not told about is one it
  // will quietly normalize away. validateSkillEdit catches that and aborts the batch
  // after a paid call — cheaper to state the rule than to fail on it.
  // A Stage marker is not the same as being parked. stripParkedSections keeps any
  // section whose gate isStageActive, so a marker on an OPEN gate is live content that
  // the fleet's projection does contain. Listing those under "currently parked" told the
  // model the opposite, and it did as it was told: a 2026-08-19 merge dropped breakeven
  // CAC, campaign-objective choice, the edit freeze and breakthrough-ad dissection from
  // the frontmatter description — four live sections, on the reasoning that a reader
  // would not find them. The description is the trigger text, so that quietly narrowed
  // what the skill fires on, and every gate that opens makes the mistake bigger.
  const staged = extractStagedTactics(existingContent);
  // currentStage is injectable ONLY so both branches stay testable. CURRENT_STAGE is the
  // last gate in STAGES today, so nothing is parked and the closed-gate branch is dormant
  // — exactly the state in which it would rot unnoticed before the next gate is appended.
  const parked = staged.filter((t) => !isStageActive(t.stage, currentStage));
  const openGate = staged.filter((t) => isStageActive(t.stage, currentStage));
  const stageRule =
    `\n- A "**Stage:** <gate>" line directly under a heading records which phase of the business\n` +
    `  a tactic waits for. Keep every such line EXACTLY where it is and worded as it is —\n` +
    `  removing one silently promotes a tactic this business cannot execute yet.` +
    (parked.length
      ? ` Currently PARKED (gate still closed): ${parked.map((t) => `"${t.claim}" (${t.stage})`).join(', ')}.\n`
      : ' Nothing here is currently parked.\n') +
    (openGate.length
      ? `- These carry a Stage marker but their gate is already OPEN, so they are LIVE: ` +
        `${openGate.map((t) => `"${t.claim}" (${t.stage})`).join(', ')}. Keep their marker lines, and treat\n` +
        `  them as ordinary live tactics in every other respect — they belong in the description and\n` +
        `  may be cross-referenced freely. Do not strip them for carrying a Stage line.\n`
      : '') +
    `- Any new tactic above that carries a "Stage:" gets the same "**Stage:** <gate> — parked until\n` +
    `  the <gate> phase opens." line directly under its heading. Tactics with no Stage get no such line.\n` +
    `- A parked section — one whose gate is still CLOSED, per the list above — is REMOVED from the\n` +
    `  projection the agent fleet reads. So: do not mention a\n` +
    `  parked tactic in the frontmatter "description" (that description is what makes the skill\n` +
    `  trigger, and it must only promise what a reader will actually find), and do not cross-\n` +
    `  reference a parked section from a live one ("see the parked X below") — that reference\n` +
    `  dangles once X is stripped. Parked sections may reference live ones; not the reverse.\n`;

  const prompt = `You maintain a Claude Code skill file. Integrate new tactics into it.

Current file:

<skill>
${existingContent}
</skill>

New tactics to integrate:

${tacticBlock}

Rules:
- Return the COMPLETE new file, not a diff.
- Keep the YAML frontmatter. The "name" MUST stay exactly "${fm.name}". You may sharpen "description".
- Where a new tactic refines, contradicts, or duplicates an existing claim, REVISE that
  section rather than appending a second copy. Avoiding duplication is the point of this step.
- Every claim keeps inline provenance in the form: *Source: Creator — "Title" (locator)*
  where the locator is whatever the tactic above carries — a YouTube id for a video, or
  something like \`book, part 7 of 11\` or \`social post\` for a written source. Copy it
  verbatim; never invent or reshape it, and never rename the kind of source it is.
${deadRule}${stageRule}
- Do not delete existing material unless it is genuinely superseded. If you do remove
  anything, say what and why in "supersedes".

Return ONLY JSON:
{ "content": "<the complete new SKILL.md>", "supersedes": "<what you removed and why, or null>" }`;

  // stream(), not create(): the SDK rejects a non-streaming request outright once
  // max_tokens implies a possible >10-minute operation. finalMessage() gives back the
  // same shape create() returned, so everything below is unchanged.
  const res = await client.messages
    .stream({
      model: EXTRACTION_MODEL,
      max_tokens: maxTokens,
      thinking: { type: 'adaptive' },
      messages: [{ role: 'user', content: prompt }],
    })
    .finalMessage();
  if (res.stop_reason === 'max_tokens') {
    throw new Error(`Skill merge for "${fm.name}" hit max_tokens — refusing to write a truncated skill.`);
  }

  const text = (res.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  const parsed = parseJsonBlock(text, `the skill merge for "${fm.name}"`);
  if (!parsed.content) throw new Error(`Skill merge for "${fm.name}" returned no content.`);

  const supersedes = parsed.supersedes ?? null;
  validateSkillEdit(existingContent, parsed.content, { supersedes }); // throws on damage
  return { content: parsed.content, supersedes };
}

const FALSIFIED_HEADING = '## Falsified';
const FALSIFIED_INTRO = 'Tried here and did not work. Do not reintroduce these.';

/**
 * ``` or ~~~ opens a fenced block; per CommonMark it is closed only by a line
 * with the SAME marker character, at least as long as the opening run. A
 * ~~~ line inside a ``` fence (or vice versa) is ordinary content, not a
 * close — and the info string (e.g. "markdown" in ```markdown) is only valid
 * on the opening line, never the closing one. A heading inside a fence is a
 * markdown EXAMPLE, never document structure.
 *
 * Returns a per-document tracker function rather than a stateless predicate:
 * whether a line toggles fence state depends on which marker (if any) is
 * currently open, so the caller's own `inFence` boolean is not enough
 * information on its own.
 *
 * Single definition on purpose: section splitting, graveyard extraction and
 * heading demotion used to each carry their own notion of a fence (one knew
 * only ```, one knew both, one knew none), so a literal "## Falsified" inside a
 * fence could be a section boundary to one reader and invisible to the next.
 */
function createFenceTracker() {
  let openMarker = null; // '`' or '~' while inside a fence, else null
  let openLen = 0;
  return function isFenceToggle(line) {
    if (openMarker) {
      const close = line.match(/^(`{3,}|~{3,})[ \t]*\r?$/); // no info string on a closing fence; \r tolerated for CRLF files
      if (close && close[1][0] === openMarker && close[1].length >= openLen) {
        openMarker = null;
        openLen = 0;
        return true;
      }
      return false;
    }
    const open = line.match(/^(`{3,}|~{3,})/);
    if (!open) return false;
    openMarker = open[1][0];
    openLen = open[1].length;
    return true;
  };
}

/**
 * Split a skill file into its leading matter (frontmatter + title) and its
 * `## ` sections, fence-aware.
 *
 * Line-based rather than regex-based so CRLF files behave: "## Falsified\r"
 * still starts with "## ", and .trim() drops the \r from the heading text. A
 * multiline `$` would NOT match before the \r, which historically made the
 * whole graveyard invisible on a CRLF file — and an invisible graveyard
 * silently disables the only non-prompt falsified guard in validateSkillEdit.
 */
function splitSections(content) {
  const head = [];
  const sections = [];
  let cur = null;
  let inFence = false;
  const isFenceToggle = createFenceTracker();
  for (const line of String(content ?? '').split('\n')) {
    if (isFenceToggle(line)) inFence = !inFence;
    if (line.startsWith('## ') && !inFence) {
      if (cur) sections.push(cur);
      cur = { heading: line.slice(3).trim(), lines: [line] };
    } else if (cur) {
      cur.lines.push(line);
    } else {
      head.push(line);
    }
  }
  if (cur) sections.push(cur);
  return { head: head.join('\n'), sections };
}

/** The `## Falsified` section, or null. Exact heading match — "## Falsified Campaigns" is a live tactic. */
function findGraveyard(sections) {
  return sections.find((s) => s.heading === 'Falsified') ?? null;
}

/**
 * The claims that were tried here and failed. These are the entries the merge
 * must never resurrect — read by the merge prompt, the extraction prompt, and
 * validateSkillEdit.
 *
 * Bounded by the graveyard SECTION, not by end-of-file. Reading to EOF made
 * document order load-bearing: any `## ` tactic that happened to sit below the
 * graveyard had its `### ` subheadings harvested as falsified claims, which
 * blocklists a live tactic with no error anywhere. Bounding it here removes the
 * failure mode structurally, so no write site has to police section ordering.
 */
/**
 * The tactics parked behind a gate, as `{ claim, stage }`. This is what answers
 * "what does reaching the Traffic phase unlock?" — deterministically, with no LLM
 * call, from the skills themselves rather than from per-video reports.
 *
 * The graveyard is excluded: a falsified tactic is dead regardless of any stage
 * marker that survived into it.
 */
export function extractStagedTactics(content) {
  const { sections } = splitSections(content);
  const grave = findGraveyard(sections);
  const out = [];
  for (const s of sections) {
    if (s === grave) continue;
    const m = s.lines.slice(1).join('\n').match(STAGE_MARKER);
    if (m) out.push({ claim: s.heading, stage: m[1].toLowerCase() });
  }
  return out;
}

/**
 * Drop every tactic section whose gate has not opened yet, preserving the head
 * matter and the graveyard. Returns '' when the skill HAD tactics and every one of
 * them is parked — the caller's signal to omit the skill entirely.
 *
 * A skill with no `## ` sections at all is passed through untouched rather than
 * suppressed: prose-only bodies exist, and "nothing survived the filter" and
 * "there was nothing to filter" are different states.
 */
function stripParkedSections(body, stage) {
  const { head, sections } = splitSections(body);
  const grave = findGraveyard(sections);
  const tactics = sections.filter((s) => s !== grave);
  if (!tactics.length) return body;

  const kept = sections.filter((s) => {
    if (s === grave) return true;
    const m = s.lines.slice(1).join('\n').match(STAGE_MARKER);
    return !m || isStageActive(m[1].toLowerCase(), stage);
  });
  if (!kept.some((s) => s !== grave)) return '';
  return [head, ...kept.map((s) => s.lines.join('\n'))].join('\n');
}

export function extractFalsifiedClaims(content) {
  const grave = findGraveyard(splitSections(content).sections);
  if (!grave) return [];
  const claims = [];
  let inFence = false;
  const isFenceToggle = createFenceTracker();
  for (const line of grave.lines.slice(1)) {
    if (isFenceToggle(line)) { inFence = !inFence; continue; }
    if (!inFence && line.startsWith('### ')) claims.push(line.slice(4).trim());
  }
  return claims.filter(Boolean);
}

/**
 * Move one tactic out of the live body and into `## Falsified`, stamped with the
 * date and the reason it failed.
 *
 * Pure text surgery — no LLM call, so this is free and deterministic. The section
 * body is preserved rather than discarded: the record needs to say WHAT was tested,
 * not merely that something failed.
 *
 * Ambiguity throws. A wrong-but-confident write into a curated skill is worse than
 * a refusal, so zero matches and multiple matches both error with the candidates.
 */
export function falsifyTactic(content, { claim, reason, today } = {}) {
  if (!String(claim ?? '').trim()) throw new Error('falsifyTactic: claim is required.');
  if (!String(reason ?? '').trim()) {
    throw new Error('falsifyTactic: reason is required — an unexplained falsification is not a record.');
  }
  parseFrontmatter(content); // throws if the file is not a well-formed skill

  const needle = claim.trim().toLowerCase();
  const { head, sections } = splitSections(content);
  const grave = findGraveyard(sections);
  const dead = grave ? grave.lines.join('\n') : '';
  // Everything that is not the graveyard is live — including any section that
  // happens to sit BELOW it. Such a section is re-emitted above the graveyard,
  // which is also how a file that drifted into that order gets normalized.
  const live = sections.filter((s) => s !== grave);
  const matches = live.filter((s) => s.heading.toLowerCase().includes(needle));

  if (matches.length === 0) {
    // No live match — check if it's already in the falsified graveyard
    const already = extractFalsifiedClaims(content).find((c) => c.toLowerCase().includes(needle));
    if (already) {
      // Name the date it was falsified, not just that it was — an operator
      // re-running --falsify months later needs to know when, not just that
      // someone already tried this. The date lives on the line right after
      // the entry's own "### <heading>" line: "**Falsified <date>:** ...".
      const headingLine = `### ${already}`;
      const hIdx = dead.indexOf(headingLine);
      const dateMatch = hIdx === -1 ? null : dead.slice(hIdx + headingLine.length).match(/\*\*Falsified ([^:]+):\*\*/);
      const date = dateMatch ? dateMatch[1].trim() : 'an earlier run';
      throw new Error(`"${already}" is already falsified on ${date}.`);
    }
    // Otherwise list the available live claims
    const available = live.map((s) => `  - ${s.heading}`).join('\n');
    throw new Error(
      `No live tactic matching "${claim}" in this skill. Available:\n${available || '  (none)'}`
    );
  }
  if (matches.length > 1) {
    const listed = matches.map((s) => `  - ${s.heading}`).join('\n');
    throw new Error(`"${claim}" matches ${matches.length} live tactics — be more specific:\n${listed}`);
  }

  const target = matches[0];
  // Floor 4: inside the graveyard the moved body sits under "### <claim>", where
  // a "### " line reads as its own falsified claim and a "## " line ends the
  // graveyard outright. Every heading in the body must therefore land at ####
  // or deeper — including a rogue H1, which a one-level demotion would leave at
  // ## and a mirror-style two-level demotion would leave at ###. Either way a
  // phantom claim enters the blocklist and becomes a permanent merge tripwire.
  const body = demoteHeadings(target.lines.slice(1).join('\n').trim(), { floor: 4 });
  const entry = [`### ${target.heading}`, `**Falsified ${today}:** ${reason.trim()}`, '', body, ''].join('\n');

  const remaining = live.filter((s) => s !== target).map((s) => s.lines.join('\n').trim());
  const deadBody = dead
    ? `${dead.trimEnd()}\n\n${entry}`
    : [FALSIFIED_HEADING, '', FALSIFIED_INTRO, '', entry].join('\n');

  return [head.trim(), '', ...remaining.flatMap((s) => [s, '']), deadBody.trim(), ''].join('\n');
}

const HEADING = /^(#+)[ \t]/;

/**
 * Demote every markdown heading in a block by a uniform shift, chosen so the
 * SHALLOWEST heading lands at `floor` (never shifting by less than one level).
 * Relative hierarchy inside the block is preserved. Headings inside fenced
 * blocks are examples, not structure, and are left exactly as written.
 *
 * The floor is a parameter because the two callers have opposite requirements
 * and one shared rule cannot serve both:
 *
 * - renderContextMirror wraps each skill in its own `## <skill-name>`, so no
 *   skill-authored heading may land at ## or shallower → floor 3.
 * - falsifyTactic moves a tactic body under `### <claim>` inside `## Falsified`,
 *   where a `### ` line reads as a separate falsified claim → floor 4.
 *
 * A single uniform "H1 demotes by two, everything else by one" rule satisfied
 * the mirror and quietly broke the graveyard: a body containing "# Rogue H1"
 * landed at "### Rogue H1", which extractFalsifiedClaims then reported as a
 * second falsified claim.
 */
function demoteHeadings(text, { floor = 2 } = {}) {
  const lines = String(text).split('\n');

  let inFence = false;
  let shallowest = Infinity;
  let isFenceToggle = createFenceTracker();
  for (const line of lines) {
    if (isFenceToggle(line)) { inFence = !inFence; continue; }
    const m = !inFence && line.match(HEADING);
    if (m) shallowest = Math.min(shallowest, m[1].length);
  }
  const by = Number.isFinite(shallowest) ? Math.max(1, floor - shallowest) : 1;

  inFence = false;
  isFenceToggle = createFenceTracker();
  return lines.map((line) => {
    if (isFenceToggle(line)) { inFence = !inFence; return line; }
    const m = !inFence && line.match(HEADING);
    if (!m) return line;
    return '#'.repeat(Math.min(6, m[1].length + by)) + line.slice(m[1].length);
  }).join('\n');
}

/**
 * Drop a skill body's leading H1 title. The mirror already titles each section
 * with `## <skill-name>`, so keeping the H1 (at any level) puts an empty
 * heading among the real tactic headings — a model scanning the mirror reads
 * one phantom tactic per skill.
 */
function stripLeadingH1(body) {
  const lines = String(body).split('\n');
  let i = 0;
  while (i < lines.length && lines[i].trim() === '') i++;
  if (i >= lines.length || !/^#[ \t]/.test(lines[i])) return body;
  i++;
  while (i < lines.length && lines[i].trim() === '') i++;
  return lines.slice(i).join('\n');
}

/**
 * Project the skills into one file the agent fleet can read.
 *
 * No agent reads .claude/skills/ — that is a Claude Code harness feature. Eight
 * agents read data/context/. This is the bridge.
 *
 * Skill bodies are emitted verbatim except for heading-level demotion to fix
 * hierarchy collision and the removal of parked tactics, so the mirror cannot
 * disagree with its source about content it does emit. The blocklist is hoisted
 * to the top because a single scannable "do not propose" list is easier for a
 * model to honor than the same claims scattered through per-topic subsections.
 *
 * Parked tactics are dropped rather than annotated. creative-packager injects this
 * projection under the instruction "Draw an angle from the live tactics above", so
 * a parked tactic that merely carried a caveat would still become ad copy for an
 * offer this business does not run. `stage` defaults to the current phase rather
 * than to "everything", so a caller that has not been updated cannot leak them.
 */
export function renderContextMirror(inventory = [], { stage = CURRENT_STAGE } = {}) {
  // Collect all falsified claims, then dedupe to avoid duplication
  const deadSet = new Set();
  for (const s of inventory) {
    for (const claim of extractFalsifiedClaims(s.content)) {
      deadSet.add(claim);
    }
  }
  const dead = Array.from(deadSet);

  const L = [
    '# Marketing Tactics',
    '',
    '_Generated from `.claude/skills/marketing-*/SKILL.md` by `agents/marketing-learner`._',
    '_Do not edit by hand — this file is overwritten on every run._',
    '',
    '## Do not propose',
    '',
    'These were tested at Real Skin Care and failed. Do not suggest them or reworded variants of them.',
    '',
    dead.length ? dead.map((c) => `- ${c}`).join('\n') : '_Nothing falsified yet._',
    '',
  ];

  for (const s of inventory) {
    let fm;
    try { fm = parseFrontmatter(s.content); } catch { continue; }
    const live = stripParkedSections(fm.body, stage);
    // A skill whose every tactic is parked projects as a bare heading plus a
    // description promising tactics that are not there — an invitation for the
    // model to invent them. Omit it until something in it is live.
    if (!live.trim()) continue;
    // Drop the skill's own H1 title (the `## <skill-name>` wrapper below already
    // names it), then demote what is left so it nests under that wrapper.
    const demoted = demoteHeadings(stripLeadingH1(live.trim()).trim(), { floor: 3 });
    // Fallback to parsed frontmatter fields if inventory fields are undefined
    const name = s.name ?? fm.name ?? '';
    const desc = s.description ?? fm.description ?? '';
    L.push(`## ${name}`, '', `_${desc}_`, '', demoted, '');
  }

  return L.join('\n');
}
