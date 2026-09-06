#!/usr/bin/env node
/**
 * Build a Merchant Center supplemental feed of `question_and_answer` pairs from
 * real buyer questions.
 *
 *   node scripts/build-merchant-qa-feed.mjs --product coconut-oil-deodorant
 *   node scripts/build-merchant-qa-feed.mjs --product coconut-oil-deodorant --apply
 *   node scripts/build-merchant-qa-feed.mjs --all --apply
 *
 * Dry by default: it prints the questions and the drafted answers and writes
 * nothing. `--apply` writes the feed and a review file to
 * `data/reports/merchant-qa/`. **Nothing here uploads to Merchant Center** — the
 * feed is a file a human reviews and submits, because this is product data going
 * to Google under the brand's name and the tactic is unproven (see
 * lib/merchant-qa.js for why it is worth trying anyway).
 *
 * ONE PRODUCT AT A TIME IS THE DEFAULT, and `--all` is the deliberate opt-in.
 * CLAUDE.md's fourth development rule is to test on one before bulk-applying;
 * here that is not ceremony, because each product costs one LLM call and
 * produces up to 30 answers that would go to Google in the brand's voice.
 *
 * EVERY ANSWER IS GATED. `checkSeoCopyFields` runs over the generated pairs
 * before anything is written — this is a cosmetics brand, the questions come
 * from real searches, and "is coconut oil good for eczema?" is exactly the shape
 * of query that earns impressions and exactly the shape of answer that must
 * never ship. A gated batch gets ONE regeneration naming the offending words
 * (`gateGeneratedCopy`, the same loop meta-optimizer and the collection writers
 * use) and is then skipped rather than published — a gate may decide copy cannot
 * ship, never that the work was worthless.
 *
 * The questions come from `data/snapshots/gsc/`, which is SERVER-WRITTEN and
 * gitignored, so a local checkout has none and this must run on the box.
 */
import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
try {
  for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i > 0 && !process.env[t.slice(0, i).trim()]) process.env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
} catch { /* no .env is a valid state for the pure paths */ }

const { extractQuestions, assignQuestionsToProducts, formatQuestionAnswer, renderSupplementalTsv, MAX_PAIRS_PER_PRODUCT } =
  await import('../lib/merchant-qa.js');
const { assignCluster } = await import('../lib/keyword-index/cluster.js');
const { checkSeoCopyFields, SEO_COPY_COMPLIANCE_RULE, plainText } = await import('../lib/seo-copy-health-gate.js');
const { gateGeneratedCopy } = await import('../lib/seo-copy-gate-loop.js');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const ALL = args.includes('--all');
const productArg = args[args.indexOf('--product') + 1];
const SNAPSHOT_DAYS = 28;

const GSC_DIR = join(ROOT, 'data', 'snapshots', 'gsc');
const OUT_DIR = join(ROOT, 'data', 'reports', 'merchant-qa');

/** Product handles by cluster, derived from the catalogue rather than hardcoded. */
function productClusters(catalog) {
  const map = {};
  for (const [handle, p] of Object.entries(catalog)) {
    // Cluster on the TITLE, not the handle: the taxonomy is built for prose.
    const cluster = assignCluster(p.title ?? handle.replace(/-/g, ' '));
    if (!cluster) continue;
    (map[cluster] ??= []).push(handle);
  }
  return map;
}

function loadGscQuestions() {
  if (!existsSync(GSC_DIR)) {
    throw new Error(`${GSC_DIR} does not exist. GSC snapshots are server-written and gitignored — run this on the box.`);
  }
  const files = readdirSync(GSC_DIR).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().slice(-SNAPSHOT_DAYS);
  if (!files.length) throw new Error(`no GSC snapshots in ${GSC_DIR}`);
  const rows = [];
  for (const f of files) {
    try {
      const snap = JSON.parse(readFileSync(join(GSC_DIR, f), 'utf8'));
      rows.push(...(snap.topQueries ?? []));
    } catch { /* one unreadable day must not sink the run */ }
  }
  return { questions: extractQuestions(rows), days: files.length, rows: rows.length };
}

/**
 * Live PDP facts, indexed by handle.
 *
 * WHY THIS EXISTS: the first live run drafted ten answers that all restated
 * "coconut oil is the base ingredient" in different words, because
 * data/brand/product-catalog.json carries only title, price and url — no
 * ingredients, no description, nothing a buyer question is actually about. The
 * catalogue is a price list, not product knowledge.
 *
 * It DEGRADES rather than failing: no credentials or a dead API means
 * catalogue-only facts, which still produce valid answers. But it says so
 * loudly, because thin answers that look fine are exactly what this run
 * produced before and the difference is invisible in the output.
 */
async function loadPdpFacts() {
  try {
    const { getProducts } = await import('../lib/shopify.js');
    const products = await getProducts();
    const byHandle = {};
    for (const p of products ?? []) {
      if (!p?.handle) continue;
      byHandle[p.handle] = {
        description: plainText(p.body_html ?? '').slice(0, 4000),
        product_type: p.product_type || undefined,
        tags: p.tags || undefined,
        // Variants answer a whole class of question the description never does
        // — size, scent, count. Titles only; no prices, which the catalogue has.
        variants: (p.variants ?? []).map((v) => v.title).filter((t) => t && t !== 'Default Title'),
      };
    }
    return { byHandle, ok: true };
  } catch (e) {
    return { byHandle: {}, ok: false, error: e.message };
  }
}

async function draftAnswers(handle, product, questions, pdp) {
  const { default: Anthropic } = await import('../lib/anthropic.js');
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  // The PDP description is the substance; the catalogue is the price list.
  const facts = JSON.stringify({ handle, ...product, ...(pdp ?? {}) }, null, 1);

  // DERIVED from the work, never flat. A fixed ceiling is the defect that
  // truncated most cannibalization merges: 4,000 tokens looked generous and
  // could not hold 30 pairs, because each one echoes its question VERBATIM
  // (some GSC questions run 20+ words) plus a 1-3 sentence answer plus JSON
  // syntax. Measured against the real 30-question deodorant batch, that is
  // ~150 tokens a pair; 200 leaves room for the long tail.
  const maxTokens = Math.min(16000, 600 + questions.length * 200);
  const generate = async (constraint) => {
    const msg = await client.messages.create({
      model: 'claude-sonnet-5',
      max_tokens: maxTokens,
      messages: [{
        role: 'user',
        content: `You are writing Google Merchant Center Q&A answers for a Real Skin Care product.

PRODUCT FACTS (the only things you may assert):
${facts}

RULES:
- Answer ONLY from the product facts above. If a question cannot be answered from them, return an empty answer string for it and it will be dropped — inventing a spec is worse than skipping the question.
- 1-3 sentences. Plain, specific, no marketing adjectives.
- Write the way you would want an AI assistant to repeat it back to a shopper.
- These are real search queries, so some are about the CATEGORY rather than this product. Answer about this product where you honestly can.

${SEO_COPY_COMPLIANCE_RULE}
${constraint}

Return ONLY a JSON array: [{"question": "<verbatim question>", "answer": "<answer or empty string>"}]

QUESTIONS:
${questions.map((q, i) => `[${i}] ${q.query}`).join('\n')}`,
      }],
    });
    // Throw, never save — truncated JSON cannot be repaired by a retry against
    // the same ceiling, and half a batch of answers is not a partial success.
    if (msg.stop_reason === 'max_tokens') {
      throw new Error(`answer generation truncated at max_tokens (${maxTokens} for ${questions.length} questions)`);
    }
    const text = msg.content.map((c) => c.text ?? '').join('');
    const json = text.slice(text.indexOf('['), text.lastIndexOf(']') + 1);
    return JSON.parse(json).filter((p) => p?.question && p?.answer?.trim());
  };

  // One retry naming the offending words, then skip. Every answer is a named
  // field so the report says WHICH answer tripped, not just that one did.
  return gateGeneratedCopy(generate, {
    extract: (pairs) => Object.fromEntries(pairs.map((p, i) => [`answer ${i + 1} (${p.question.slice(0, 40)})`, p.answer])),
  });
}

async function main() {
  if (!ALL && !productArg) {
    console.error('Specify --product <handle> (preferred) or --all.');
    console.error('One product at a time is the default: each is an LLM call and up to 30 answers going to Google.');
    process.exit(64);
  }

  const catalog = JSON.parse(readFileSync(join(ROOT, 'data', 'brand', 'product-catalog.json'), 'utf8'));
  const products = catalog.products ?? catalog;
  const pdp = APPLY ? await loadPdpFacts() : { byHandle: {}, ok: null };
  if (APPLY && !pdp.ok) {
    console.log(`\n!! LIVE PDP FETCH FAILED (${pdp.error}) — answers will be drafted from the`);
    console.log('   catalogue alone, which holds only title/price/url. Expect thin, repetitive');
    console.log('   answers. Fix the credentials rather than shipping these.\n');
  }
  const { questions, days, rows } = loadGscQuestions();
  const clusters = productClusters(products);
  const { byHandle, unassigned } = assignQuestionsToProducts(questions, clusters);

  console.log(`GSC: ${rows} query rows over ${days} snapshots -> ${questions.length} distinct questions`);
  console.log(`Routed to ${byHandle.size} products; ${unassigned.length} matched no product cluster.`);

  const handles = ALL ? [...byHandle.keys()] : [productArg];
  const feedRows = [];
  const review = [];

  for (const handle of handles) {
    const qs = byHandle.get(handle) ?? [];
    const product = products[handle];
    if (!product) { console.log(`\n${handle}: NOT IN CATALOGUE — skipped`); continue; }
    console.log(`\n${handle} — ${qs.length} question(s), cap ${MAX_PAIRS_PER_PRODUCT}`);
    if (!qs.length) continue;
    for (const q of qs.slice(0, 5)) console.log(`   ${String(q.impressions).padStart(6)} imp  ${q.query}`);
    if (qs.length > 5) console.log(`   … and ${qs.length - 5} more`);

    if (!APPLY) continue;

    const facts = pdp.byHandle[handle];
    if (APPLY && pdp.ok && !facts?.description) {
      console.log('   no live PDP description for this handle — answers will be thin.');
    }
    const gated = await draftAnswers(handle, product, qs, facts);
    if (!gated.ok) {
      // Named, counted, and NOT written. The producing run can be repeated; the
      // work is not discarded.
      console.log(`   GATED after ${gated.attempts} attempt(s) — not written.`);
      // gateGeneratedCopy returns { ok, proposed, rejected, violations, advisory,
      // attempts } — `violations` on the failure path, `proposed` on success.
      for (const v of gated.violations ?? []) console.log(`     ${v.field}: "${v.match}" (${v.category})`);
      review.push({ handle, gated: true, claims: gated.violations ?? [] });
      continue;
    }
    const pairs = gated.proposed ?? [];
    if (!pairs.length) { console.log('   generator returned no usable pairs — skipped.'); continue; }
    const value = formatQuestionAnswer(pairs);
    feedRows.push({ id: handle, questionAndAnswer: value });
    review.push({ handle, pairs });
    console.log(`   ${pairs.length} answer(s) drafted and gated clean.`);
  }

  if (!APPLY) {
    console.log('\nDry run. Re-run with --apply to draft answers (one LLM call per product) and write the feed.');
    return;
  }
  if (!feedRows.length) { console.log('\nNothing to write.'); return; }

  mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10);
  const tsv = join(OUT_DIR, `supplemental-qa-${stamp}.tsv`);
  writeFileSync(tsv, renderSupplementalTsv(feedRows));
  const md = join(OUT_DIR, `review-${stamp}.md`);
  writeFileSync(md, [
    `# Merchant Center Q&A — ${stamp}`, '',
    'Review before submitting. Supplemental feed: `id` + `question_and_answer` ONLY —',
    'it must not restate title, price or availability, or it overwrites the primary feed.', '',
    ...review.flatMap((r) => r.gated
      ? [`## ${r.handle} — GATED, not in the feed`, ...r.claims.map((c) => `- ${c.field}: "${c.match}" (${c.category})`), '']
      : [`## ${r.handle} (${r.pairs.length})`, ...r.pairs.map((p) => `- **${p.question}**\n  ${p.answer}`), '']),
  ].join('\n'));

  console.log(`\nfeed:   ${tsv}`);
  console.log(`review: ${md}`);
  console.log('NOT UPLOADED. Review the answers, then submit the TSV as a supplemental feed in Merchant Center.');
}

main().catch((e) => { console.error('[build-merchant-qa-feed]', e.message); process.exit(1); });
