#!/usr/bin/env node
/**
 * PR Target Finder
 *
 * Turns the weekly AI-citation data into a ranked, actionable PR target list:
 * the specific third-party pages driving competitor LLM citations, tagged
 * `pitch` (with author + publication + a drafted angle) or `engage`
 * (Reddit/community). PR effort goes where it actually moves LLM rankings.
 *
 * Mines existing data only (data/reports/ai-citations/*.json) — no fresh LLM
 * queries. Enriches the top pitch targets by fetching the page for its byline.
 *
 * Usage:
 *   node agents/pr-target-finder/index.js              # full run (weekly)
 *   node agents/pr-target-finder/index.js --weeks 4 --enrich 20
 *   node agents/pr-target-finder/index.js --no-enrich   # skip page fetches (fast)
 *
 * Output:
 *   data/reports/pr-targets/latest.json
 *   data/reports/pr-targets/pr-targets-report.md
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rankTargets } from '../../lib/pr-targets.js';
import { extractByline, pageMentionsBrand, looksLikeStore } from '../../lib/html-byline.js';
import { notify } from '../../lib/notify.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const CITATIONS_DIR = join(ROOT, 'data', 'reports', 'ai-citations');
const OUT_DIR = join(ROOT, 'data', 'reports', 'pr-targets');

const args = process.argv.slice(2);
const argVal = (name, def) => { const i = args.indexOf(name); return i !== -1 ? args[i + 1] : def; };
const WEEKS = parseInt(argVal('--weeks', '4'), 10);
const ENRICH = args.includes('--no-enrich') ? 0 : parseInt(argVal('--enrich', '20'), 10);

const config = JSON.parse(readFileSync(join(ROOT, 'config', 'ai-citation-prompts.json'), 'utf8'));
const { brand, competitors } = config;
// Strict aliases for the "does this page already mention us" check — the spaced
// phrase "real skin care" matches generic copy ("real skincare routine"), so use
// only the domain/handle forms.
const STRICT_BRAND_ALIASES = [...new Set([brand.domain, ...brand.aliases.filter((a) => !/\s/.test(a))])];

function loadSnapshots() {
  if (!existsSync(CITATIONS_DIR)) return [];
  const files = readdirSync(CITATIONS_DIR)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort()
    .slice(-WEEKS);
  return files.map((f) => { try { return JSON.parse(readFileSync(join(CITATIONS_DIR, f), 'utf8')); } catch { return null; } }).filter(Boolean);
}

function categoryFromPrompts(prompts) {
  const text = prompts.join(' ').toLowerCase();
  const cats = [
    ['deodorant', 'deodorant'], ['toothpaste', 'toothpaste'], ['lip balm', 'lip balm'],
    ['body lotion', 'body lotion'], ['lotion', 'lotion'], ['soap', 'soap'],
    ['body cream', 'body cream'], ['coconut oil', 'coconut oil product'],
  ];
  for (const [needle, label] of cats) if (text.includes(needle)) return label;
  return 'clean personal-care product';
}

async function fetchPage(domain, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`https://${domain}/`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; RSC-PR-Research/1.0)' },
      redirect: 'follow', signal: controller.signal,
    });
    if (!res.ok) return null;
    return (await res.text()).slice(0, 400_000);
  } catch { return null; }
  finally { clearTimeout(timer); }
}

function buildAngle(row) {
  const category = categoryFromPrompts(row.prompts);
  const competitor = row.competitors[0] || 'the incumbents';
  const prompt = row.prompts[0];
  const proof = 'backed by hundreds of verified 4–5★ Judge.me reviews';
  return `Pitch to be added to their "${prompt}" coverage alongside ${competitor}. Hook: Real Skin Care's coconut-oil ${category} is a clean, aluminum-free alternative — ${proof}.`;
}

async function enrichPitchTargets(rows) {
  const top = rows.slice(0, ENRICH);
  for (const row of top) {
    const html = await fetchPage(row.domain);
    const { author, publication } = extractByline(html, { domain: row.domain });
    row.author = author;
    row.publication = publication || row.domain;
    // Two DISTINCT signals, kept separate to avoid the false "already lists us":
    //  - llm_names_us_here (from tracker): the LLM already names RSC for some of
    //    these prompts (we partly win them) — useful context, not "on this page".
    //  - homepage_mentions_us (from fetch, strict alias): low-confidence hint the
    //    site references us. Homepage-only (we have domains, not article URLs).
    row.llm_names_us_here = row.brand_mentioned;
    row.homepage_mentions_us = html != null ? pageMentionsBrand(html, STRICT_BRAND_ALIASES) : null;
    delete row.brand_mentioned;
    row.angle = buildAngle(row);
    // A single-brand ecommerce store cited for "best X" prompts is a competitor
    // we don't track, not a pitch target. Flag it so it drops out of the list.
    row.likely_store = looksLikeStore(html);
  }
  // attach a templated angle to the un-enriched remainder too
  for (const row of rows.slice(ENRICH)) {
    row.publication = row.domain;
    row.angle = buildAngle(row);
  }
  return rows;
}

async function main() {
  console.log('\nPR Target Finder\n');
  const snapshots = loadSnapshots();
  if (!snapshots.length) {
    console.error(`  No ai-citation snapshots in ${CITATIONS_DIR}. Run ai-citation-tracker first.`);
    process.exit(1);
  }
  console.log(`  Snapshots: ${snapshots.length} (last ${WEEKS} weeks)`);

  const ranked = rankTargets(snapshots, { brand, competitors });
  const engage = ranked.engage;
  let excluded = ranked.excluded;
  // Relevance floor: a real PR target shows up across MULTIPLE engines or
  // prompts. Single-citation hits are long-tail noise — count them as filtered.
  const pitch = ranked.pitch.filter((t) => t.engines.length >= 2 || t.prompts.length >= 2);
  const noiseCut = ranked.pitch.length - pitch.length;
  excluded += noiseCut;
  console.log(`  Candidate sources → pitch: ${pitch.length} (cut ${noiseCut} single-citation), engage: ${engage.length}, excluded: ${ranked.excluded}`);

  let finalPitch = pitch;
  if (ENRICH > 0 && pitch.length) {
    console.log(`  Enriching top ${Math.min(ENRICH, pitch.length)} pitch targets (author + publication)...`);
    await enrichPitchTargets(pitch);
    const stores = pitch.filter((t) => t.likely_store);
    if (stores.length) console.log(`  Dropped ${stores.length} ecommerce/brand site(s): ${stores.map((s) => s.domain).join(', ')}`);
    finalPitch = pitch.filter((t) => !t.likely_store);
  } else {
    for (const row of pitch) { row.publication = row.domain; row.angle = buildAngle(row); }
  }
  for (const row of engage) {
    row.note = `LLMs lean on this for "${row.prompts[0]}" (lists ${row.competitors.slice(0, 2).join(', ')}). Engage organically — answer the question, mention RSC where genuinely relevant.`;
  }

  mkdirSync(OUT_DIR, { recursive: true });
  const report = {
    generated_at: new Date().toISOString(),
    weeks_covered: snapshots.length,
    summary: { pitch: finalPitch.length, engage: engage.length, excluded },
    pitch_targets: finalPitch,
    community_targets: engage,
  };
  writeFileSync(join(OUT_DIR, 'latest.json'), JSON.stringify(report, null, 2));
  writeFileSync(join(OUT_DIR, 'pr-targets-report.md'), renderMarkdown(report));
  console.log(`  Saved: ${join(OUT_DIR, 'latest.json')}`);

  const top = finalPitch[0];
  await notify({
    subject: `PR Targets: ${pitch.length} pitch + ${engage.length} community`,
    body: top ? `Top target: ${top.publication || top.domain} for "${top.prompts[0]}" (cited by ${top.engines.join(', ')}; lists ${top.competitors.slice(0, 2).join(', ')}).` : 'No addressable targets this run.',
    status: 'info', category: 'seo',
  }).catch(() => {});
}

function renderMarkdown(r) {
  const lines = [`# PR Targets — where to focus`, ``, `_${r.weeks_covered} weeks of AI-citation data · ${r.summary.pitch} pitch · ${r.summary.engage} community · generated ${r.generated_at.slice(0, 10)}_`, ``];
  lines.push(`## Pitch targets (editorial — get added)`, '');
  for (const t of r.pitch_targets.slice(0, 25)) {
    lines.push(`### ${t.publication || t.domain}  ·  score ${t.score}`);
    lines.push(`- **Author:** ${t.author || '_(no byline found — pitch the editor)_'}`);
    lines.push(`- **Why:** cited by ${t.engines.join(', ')} for ${t.prompts.map((p) => `_${p}_`).join(', ')}`);
    lines.push(`- **Competitors it surfaces:** ${t.competitors.join(', ') || '—'}${t.homepage_mentions_us ? ' · note: homepage references RSC — verify' : ''}${t.llm_names_us_here ? ' · (we already win some of these prompts)' : ''}`);
    lines.push(`- **Angle:** ${t.angle}`);
    lines.push('');
  }
  lines.push(`## Community targets (Reddit/forums — engage)`, '');
  for (const t of r.community_targets.slice(0, 15)) {
    lines.push(`- **${t.domain}** — ${t.note}`);
  }
  return lines.join('\n') + '\n';
}

main().catch((err) => {
  notify({ subject: 'PR Target Finder failed', body: err.message || String(err), status: 'error' }).catch(() => {});
  console.error('PR Target Finder failed:', err);
  process.exit(1);
});
