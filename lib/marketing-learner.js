/**
 * lib/marketing-learner.js
 *
 * Pure, network-free logic for the marketing-learner agent: CLI date parsing,
 * the RSC constraint block, skill inventory scanning, skill rendering, and
 * edit-safety guards.
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

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
export function buildConstraintBlock({ sourceType = 'video' } = {}) {
  const durability = sourceType === 'file'
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
- Paid spend is gated behind a hard sequence: Tracking -> CRO -> Offer/AOV -> Traffic.
  A tactic that assumes working attribution or meaningful ad budget is premature.
- Prime directive is revenue, not rankings or traffic.

## Reject a tactic outright when it

- Requires staff, an agency, or a media buyer.
- Requires ad budget materially above current spend.
- Targets a platform Real Skin Care is not on.
- Is motivational framing with no stated mechanism — not actionable, not testable.
- Restates something an existing skill already covers (duplication degrades skill triggering).
- Depends on scale that does not exist here: a large list, high traffic, thousands of reviews.

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

/** Greedily pack blank-line-delimited paragraphs up to `maxWords`. */
function packParagraphs(text, maxWords, overlapWords) {
  const paras = String(text).split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  if (!paras.length) return [];

  const chunks = [];
  let cur = [];
  let count = 0;

  for (const p of paras) {
    const n = countWords(p);
    // `count &&` is load-bearing: a lone paragraph over budget must still be
    // emitted rather than flushing an empty chunk ahead of itself. Paragraphs
    // are never split, so an oversized one becomes its own oversized chunk.
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

${buildConstraintBlock({ sourceType: video.sourceType })}

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
    } else {
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
 * Extract a JSON object from a model text response. Models wrap JSON in a fenced
 * ```json block, return it raw, or (occasionally) surround it with stray prose —
 * try each in turn before giving up. `errorLabel` names what failed in the thrown
 * error, e.g. "the extraction response for abc12345678".
 */
function parseJsonBlock(text, errorLabel) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced ? fenced[1] : text).trim();

  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start === -1 || end <= start) {
      throw new Error(`Could not parse JSON from ${errorLabel}.`);
    }
    try {
      return JSON.parse(candidate.slice(start, end + 1));
    } catch {
      throw new Error(`Could not parse JSON from ${errorLabel}.`);
    }
  }
}

export async function extractTactics({ video, inventory = [], client, maxTokens = 16000 }) {
  const prompt = buildExtractionPrompt({ video, inventory });
  const res = await client.messages.create({
    model: EXTRACTION_MODEL,
    max_tokens: maxTokens,
    thinking: { type: 'adaptive' },
    messages: [{ role: 'user', content: prompt }],
  });

  // Repo rule: truncated structured output is corrupt, not partial.
  if (res.stop_reason === 'max_tokens') {
    throw new Error(`Extraction for ${video.videoId} hit max_tokens — output is truncated. Refusing to save.`);
  }

  const text = (res.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  const parsed = parseJsonBlock(text, `the extraction response for ${video.videoId}`);
  try {
    return validateExtraction(parsed);
  } catch (err) {
    // Schema-invalid model output is expensive to lose — the operator has already
    // paid for the call. Carry the raw payload on the error so the caller (which
    // knows the corpus path; this module deliberately doesn't) can persist it for
    // inspection before the error propagates.
    err.offendingPayload = parsed;
    throw err;
  }
}

/**
 * The rejects are a first-class output, not a debug artifact: "what is NOT
 * beneficial" is half of why this tool exists, and it is invisible in a skill diff.
 */
export function renderReport({ extraction, video, skillsTouched = [] }) {
  const adopted = extraction.tactics.filter((t) => t.verdict === 'adopt').sort((a, b) => b.rscFit.score - a.rscFit.score);
  const rejected = extraction.tactics.filter((t) => t.verdict === 'reject').sort((a, b) => b.rscFit.score - a.rscFit.score);

  const L = [];
  L.push(`# ${extraction.title ?? video.title ?? video.videoId}`, '');
  L.push(`**Creator:** ${extraction.creator ?? video.creator ?? 'unknown'}  `);
  L.push(`**Video:** https://www.youtube.com/watch?v=${video.videoId}  `);
  L.push(`**Published:** ${video.publishedAt ?? 'unknown (not supplied via --published)'}  `);
  if (extraction.recencySignals) L.push(`**Inferred era cues:** ${extraction.recencySignals}  `);
  L.push('', extraction.summary ?? '', '');
  L.push(`Found ${extraction.tactics.length} tactic${extraction.tactics.length === 1 ? '' : 's'}: ${adopted.length} adopted, ${rejected.length} rejected.`, '');

  L.push('## Adopted', '');
  if (!adopted.length) {
    L.push('_No tactics adopted from this video._', '');
  } else {
    for (const t of adopted) {
      L.push(`### ${t.claim} — ${t.rscFit.score}/10`, '');
      L.push(`**Why it works:** ${t.mechanism}`, '');
      L.push(`**Evidence:** ${t.evidence ?? 'assertion only'}`, '');
      L.push(`**Fit:** ${t.rscFit.reasoning}`, '');
      L.push(`**Target skill:** \`${t.targetSkill.name}\` (${t.targetSkill.action})`, '');
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

/** One Opus call over the whole run's candidates, before anything touches a skill. */
export async function consolidateTactics({ candidates, source, client, maxTokens = 16000 }) {
  const prompt = buildConsolidationPrompt({ candidates, source });
  const res = await client.messages.create({
    model: EXTRACTION_MODEL,
    max_tokens: maxTokens,
    thinking: { type: 'adaptive' },
    messages: [{ role: 'user', content: prompt }],
  });

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
 */
export async function mergeSkillContent({ existingContent, tactics, client, maxTokens = 16000 }) {
  const fm = parseFrontmatter(existingContent);
  const dead = extractFalsifiedClaims(existingContent);
  const deadRule = dead.length
    ? `\n- The "## Falsified" section lists tactics already tested here that failed. Keep that section and every entry in it EXACTLY as-is. Never move an entry back into the live body, and never add a new tactic that restates one — if this transcript advocates one of them, leave it falsified.\n`
    : '\n';
  const tacticBlock = tactics.map((t) => (
    `- Claim: ${t.claim}\n  Mechanism: ${t.mechanism}\n  Evidence: ${t.evidence ?? 'assertion only'}\n` +
    `  Fit ${t.rscFit.score}/10: ${t.rscFit.reasoning}\n` +
    `  Source: ${t.source.creator} — "${t.source.title}" (${t.source.locator})`
  )).join('\n');

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
  something like \`book, part 7 of 11\` for a book. Copy it verbatim; never invent or reshape it.
${deadRule}
- Do not delete existing material unless it is genuinely superseded. If you do remove
  anything, say what and why in "supersedes".

Return ONLY JSON:
{ "content": "<the complete new SKILL.md>", "supersedes": "<what you removed and why, or null>" }`;

  const res = await client.messages.create({
    model: EXTRACTION_MODEL,
    max_tokens: maxTokens,
    thinking: { type: 'adaptive' },
    messages: [{ role: 'user', content: prompt }],
  });
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
 * hierarchy collision, so the mirror cannot disagree with its source about
 * content. The blocklist is hoisted to the top because a single scannable
 * "do not propose" list is easier for a model to honor than the same claims
 * scattered through per-topic subsections.
 */
export function renderContextMirror(inventory = []) {
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
    // Drop the skill's own H1 title (the `## <skill-name>` wrapper below already
    // names it), then demote what is left so it nests under that wrapper.
    const demoted = demoteHeadings(stripLeadingH1(fm.body.trim()).trim(), { floor: 3 });
    // Fallback to parsed frontmatter fields if inventory fields are undefined
    const name = s.name ?? fm.name ?? '';
    const desc = s.description ?? fm.description ?? '';
    L.push(`## ${name}`, '', `_${desc}_`, '', demoted, '');
  }

  return L.join('\n');
}
