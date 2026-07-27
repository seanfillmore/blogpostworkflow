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
    try { fm = parseFrontmatter(content); } catch { continue; }
    out.push({ name: fm.name || entry.name, description: fm.description, path, content });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Render a fresh SKILL.md. Every claim carries provenance so a tactic that later
 * proves wrong is traceable to its source and that source can be re-weighted.
 */
export function renderSkillMarkdown({ name, description, tactics = [] }) {
  const lines = [
    '---',
    `name: ${name}`,
    `description: ${description}`,
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
  if (newContent.length < oldContent.length * SHRINK_FLOOR && !supersedes) {
    const pct = Math.round((1 - newContent.length / oldContent.length) * 100);
    throw new Error(
      `Refusing to shrink "${newFm.name}" by ${pct}% without an explicit supersedes reason ` +
      `(${oldContent.length} -> ${newContent.length} chars).`
    );
  }
  return true;
}
