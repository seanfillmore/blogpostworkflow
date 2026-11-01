#!/usr/bin/env node
/**
 * Put each Merchant Center Q&A answer next to what Google's AI Overview actually
 * says for the same question.
 *
 *   node scripts/compare-qa-to-overviews.mjs              # the overlap, side by side
 *   node scripts/compare-qa-to-overviews.mjs --summary    # counts and flags only
 *   node scripts/compare-qa-to-overviews.mjs --date 2026-09-07
 *
 * READ-ONLY and FREE. It joins two reports that already exist —
 * `data/reports/merchant-qa/review-<date>.md` and
 * `data/reports/ai-overview-citations/<date>.json` — and makes no API call of any
 * kind. Nothing is written.
 *
 * WHY THIS EXISTS. The feed prompt targets the four beats an AI Overview runs
 * (direct answer / ingredient-level mechanism / the distinction that resolves the
 * confusion / the practical caveat), and those beats were derived by reading
 * overviews once, by hand, in a prior session. Nothing ever checked the ANSWERS
 * against them. That is a verification gap on copy going to Google under the
 * brand's name, and it is free to close because the citation measurement already
 * captures `overview_text` for every question it pulls.
 *
 * WHAT IT CAN AND CANNOT TELL YOU. It is a READING AID, not a grader. It joins on
 * the question, shows both texts, and flags two mechanical signals — whether our
 * answer carries any caveat language at all, and whether it is conspicuously
 * shorter than the overview. **A flag is a prompt to go read the pair, never a
 * verdict**, and the absence of flags is not a pass: only a human can see that an
 * answer is factually consistent but frames a trade-off the opposite way round,
 * which is the actual finding this produced on its first run (see the runbook).
 *
 * THE OVERLAP IS SMALL BY CONSTRUCTION and that is not a defect. The citation
 * measurement samples the top ~30 questions site-wide; the feed answers up to 30
 * per product across 16 products. Only questions in both are checkable, which was
 * 15 on 2026-09-07. Raising `--limit` on the measurement widens it, at $0.002 a
 * pull per run.
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const QA_DIR = join(ROOT, 'data', 'reports', 'merchant-qa');
const AIO_DIR = join(ROOT, 'data', 'reports', 'ai-overview-citations');

const args = process.argv.slice(2);
const SUMMARY = args.includes('--summary');
const dateArg = args[args.indexOf('--date') + 1];
const DATE = args.includes('--date') && /^\d{4}-\d{2}-\d{2}$/.test(dateArg ?? '') ? dateArg : null;

/** Same normalization the feed's own dedupe uses, so the join matches what it matched. */
const norm = (s) => String(s ?? '')
  .toLowerCase().replace(/[‘’]/g, "'").replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim();

function latest(dir, re) {
  if (!existsSync(dir)) return null;
  const f = readdirSync(dir).map((n) => re.exec(n)).filter(Boolean).map((m) => m[1]).sort();
  return f.length ? f[f.length - 1] : null;
}

/**
 * Parse the review markdown into { question -> {product, answer} }.
 * Duplicate questions across sibling products collapse onto the first, which is
 * fine: sibling answers differ only in which product they name.
 */
function loadAnswers(path) {
  const out = new Map();
  let product = null;
  let pending = null;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const h = /^## ([a-z0-9-]+)/.exec(line);
    if (h) { product = h[1]; pending = null; continue; }
    const q = /^- \*\*(.+)\*\*$/.exec(line);
    if (q) { pending = { question: q[1], product, answer: '' }; continue; }
    if (pending && line.startsWith('  ') && line.trim()) {
      pending.answer = line.trim();
      if (!out.has(norm(pending.question))) out.set(norm(pending.question), pending);
      pending = null;
    }
  }
  return out;
}

/** Google's overview per question — the LONGEST resolved run, i.e. the fullest sample we hold. */
function loadOverviews(path) {
  const out = new Map();
  const report = JSON.parse(readFileSync(path, 'utf8'));
  for (const q of report.queries ?? []) {
    const texts = (q.runs ?? []).filter((r) => r?.resolved && r?.overview_text).map((r) => r.overview_text);
    if (!texts.length) continue;
    texts.sort((a, b) => b.length - a.length);
    out.set(norm(q.query), { question: q.query, impressions: q.impressions, text: texts[0] });
  }
  return out;
}

/**
 * Caveat vocabulary, kept deliberately WIDE and generic. It answers "does this
 * answer acknowledge a limit at all", not "is the caveat the right one" — a
 * narrow list would report a clean sweep by failing to recognise real hedging.
 */
const CAVEAT_RE = /\b(but|however|though|although|not a|does not|doesn't|won't|can't|cannot|avoid|caution|careful|patch test|varies|depends|some people|may cause|can cause|keep in mind|note that|isn't|is not|rather than|instead of|less|trade-?off)\b/i;

function main() {
  const date = DATE ?? latest(QA_DIR, /^review-(\d{4}-\d{2}-\d{2})\.md$/);
  if (!date) { console.error(`No review file in ${QA_DIR}. Run the feed builder first.`); process.exit(1); }
  const qaPath = join(QA_DIR, `review-${date}.md`);
  const aioPath = join(AIO_DIR, `${date}.json`);
  for (const [label, p] of [['review', qaPath], ['citation report', aioPath]]) {
    if (!existsSync(p)) {
      console.error(`Missing ${label}: ${p}`);
      console.error('Both are server-written. scp them down, or run this on the box.');
      process.exit(1);
    }
  }

  const answers = loadAnswers(qaPath);
  const overviews = loadOverviews(aioPath);
  const overlap = [...overviews.keys()].filter((k) => answers.has(k))
    .sort((a, b) => (overviews.get(b).impressions ?? 0) - (overviews.get(a).impressions ?? 0));

  const flagged = [];
  for (const k of overlap) {
    const g = overviews.get(k), o = answers.get(k);
    const noCaveat = !CAVEAT_RE.test(o.answer);
    // The overview is a multi-section block and our answer is 2-4 sentences, so
    // "shorter" is normal. A quarter of its length is where an answer stops
    // being a condensed version and starts being a different, thinner claim.
    const veryShort = o.answer.length < g.text.length * 0.25;
    if (noCaveat || veryShort) flagged.push({ k, noCaveat, veryShort });
    if (SUMMARY) continue;
    console.log('='.repeat(96));
    console.log(`Q (${g.impressions} imp) [${o.product}]${noCaveat ? '  ⚑ no caveat language' : ''}${veryShort ? '  ⚑ very short vs overview' : ''}`);
    console.log(g.question);
    console.log('\n── GOOGLE ──\n' + g.text.slice(0, 1200));
    console.log('\n── OURS ──\n' + o.answer + '\n');
  }

  console.log('='.repeat(96));
  console.log(`${date}: ${answers.size} distinct answered questions · ${overviews.size} questions with a captured overview · OVERLAP ${overlap.length}`);
  console.log(`${flagged.length} flagged for a read (${flagged.filter((f) => f.noCaveat).length} with no caveat language, ${flagged.filter((f) => f.veryShort).length} very short).`);
  console.log('A flag is a prompt to go read the pair, not a verdict — and no flags is not a pass.');
}

main();
