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
export function parsePublishedFlags(urls, publishedFlags = [], { today = null } = {}) {
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

    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
      throw new Error(`--published "${raw}" must be in YYYY-MM-DD form.`);
    }
    const d = new Date(`${raw}T00:00:00Z`);
    // Round-tripping catches rollovers like 2026-02-30 -> 2026-03-02.
    if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== raw) {
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
export function buildConstraintBlock() {
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
which class the tactic falls into.`;
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
    lines.push(`*Source: ${s.creator ?? 'unknown'} — "${s.title ?? 'untitled'}" (${s.videoId ?? 'n/a'})*`, '');
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

export function buildExtractionPrompt({ video, inventory = [] }) {
  const dateLine = video.publishedAt
    ? `Published: ${video.publishedAt}`
    : 'Published: the publish date is unknown — infer era from the transcript and report it in recencySignals.';

  const inventoryBlock = inventory.length
    ? inventory.map((s) => `### ${s.name}\n_${s.description}_\n\n${s.content}`).join('\n\n---\n\n')
    : '(no marketing skills exist yet — every adopted tactic will create one)';

  const falsified = inventory.flatMap((s) => extractFalsifiedClaims(s.content));
  const falsifiedBlock = falsified.length
    ? `## Already tested here and failed\n\nThese tactics have already been tested here and failed. Reject any tactic that restates one, and say so in rejectReason. Be alert to near-variants — a reworded version of a failed tactic is still a failed tactic.\n\n${falsified.map((c) => `- ${c}`).join('\n')}`
    : '';

  return `You are extracting marketing tactics from a video transcript for a specific small business.

${buildConstraintBlock()}

## Skills that already exist

Prefer editing an existing skill over creating a near-duplicate. Duplicate skills degrade
triggering accuracy, because Claude Code selects skills by matching their descriptions.

${inventoryBlock}

${falsifiedBlock}

## The video

Title: ${video.title ?? 'unknown'}
Creator: ${video.creator ?? 'unknown'}
${dateLine}
Duration: ${video.durationSeconds ? Math.round(video.durationSeconds / 60) + ' minutes' : 'unknown'}

<transcript>
${video.text}
</transcript>

## Your task

Identify every distinct, actionable marketing tactic the creator advocates. For each one,
judge honestly whether it applies to THIS business. Most tactics from most videos will not.
Being generous helps nobody: a wrong tactic promoted into a skill silently degrades future work.

Return ONLY a JSON object, no prose around it:

{
  "videoId": "${video.videoId}",
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
    `  Source: ${t.source.creator} — "${t.source.title}" (${t.source.videoId})`
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
- Every claim keeps inline provenance in the form: *Source: Creator — "Title" (videoId)*
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

/** Index of the Falsified heading, or -1. Requires exact line match (not a prefix). */
function falsifiedIndex(content) {
  const c = String(content ?? '');
  const match = c.match(/^## Falsified[ \t]*$/m);
  if (!match) return -1;
  if (c.startsWith(match[0])) return 0;
  const idx = c.indexOf(`\n${match[0]}`);
  return idx === -1 ? -1 : idx + 1;
}

/**
 * The claims that were tried here and failed. These are the entries the merge
 * must never resurrect — read by the merge prompt, the extraction prompt, and
 * validateSkillEdit.
 */
export function extractFalsifiedClaims(content) {
  const i = falsifiedIndex(String(content ?? ''));
  if (i === -1) return [];
  return String(content)
    .slice(i)
    .split('\n')
    .filter((l) => l.startsWith('### '))
    .map((l) => l.slice(4).trim())
    .filter(Boolean);
}

/** Split the live half of a skill into its leading matter and its `## ` tactic sections. */
function splitLiveSections(live) {
  const head = [];
  const sections = [];
  let cur = null;
  let inFence = false;
  for (const line of live.split('\n')) {
    // Track fence state: ``` toggles in/out of a code block
    if (line.startsWith('```')) {
      inFence = !inFence;
    }
    // Only treat ## as a section boundary if we're NOT inside a fence
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
  const cut = falsifiedIndex(content);
  const live = cut === -1 ? content : content.slice(0, cut);
  const dead = cut === -1 ? '' : content.slice(cut);

  const { head, sections } = splitLiveSections(live);
  const matches = sections.filter((s) => s.heading.toLowerCase().includes(needle));

  if (matches.length === 0) {
    // No live match — check if it's already in the falsified graveyard
    const already = extractFalsifiedClaims(content).find((c) => c.toLowerCase().includes(needle));
    if (already) throw new Error(`"${already}" is already falsified in this skill.`);
    // Otherwise list the available live claims
    const available = sections.map((s) => `  - ${s.heading}`).join('\n');
    throw new Error(
      `No live tactic matching "${claim}" in this skill. Available:\n${available || '  (none)'}`
    );
  }
  if (matches.length > 1) {
    const listed = matches.map((s) => `  - ${s.heading}`).join('\n');
    throw new Error(`"${claim}" matches ${matches.length} live tactics — be more specific:\n${listed}`);
  }

  const target = matches[0];
  const body = target.lines.slice(1).join('\n').trim();
  const entry = [`### ${target.heading}`, `**Falsified ${today}:** ${reason.trim()}`, '', body, ''].join('\n');

  const remaining = sections.filter((s) => s !== target).map((s) => s.lines.join('\n').trim());
  const deadBody = dead
    ? `${dead.trimEnd()}\n\n${entry}`
    : [FALSIFIED_HEADING, '', FALSIFIED_INTRO, '', entry].join('\n');

  return [head.trim(), '', ...remaining.flatMap((s) => [s, '']), deadBody.trim(), ''].join('\n');
}

/**
 * Project the skills into one file the agent fleet can read.
 *
 * No agent reads .claude/skills/ — that is a Claude Code harness feature. Eight
 * agents read data/context/. This is the bridge.
 *
 * Skill bodies are emitted verbatim rather than re-parsed per tactic, so the
 * mirror cannot disagree with its source. The blocklist is hoisted to the top
 * because a single scannable "do not propose" list is easier for a model to
 * honor than the same claims scattered through per-topic subsections.
 */
export function renderContextMirror(inventory = []) {
  const dead = inventory.flatMap((s) => extractFalsifiedClaims(s.content));

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
    let body = '';
    try { body = parseFrontmatter(s.content).body.trim(); } catch { continue; }
    L.push(`## ${s.name}`, '', `_${s.description}_`, '', body, '');
  }

  return L.join('\n');
}
