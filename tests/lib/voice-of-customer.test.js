import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SKIN_CLUSTER_HANDLES,
  normalizeJudgemeReview,
  normalizeTavilyResult,
  normalizeSerpItem,
  dedupeRecords,
  filterSkinCluster,
  AWARENESS_LEVELS,
  validateAnalysis,
  findUnsourcedQuotes,
  sanitizeVocMarkdown,
  vocForCopy,
  sanitizeVocMarkdownWithReport,
  rankPersonas,
  renderPersonasMarkdown,
  renderVoiceOfCustomerMarkdown,
  sliceVocSections,
  BLOG_VOC_HEADINGS,
} from '../../lib/voice-of-customer.js';

const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// ── cluster definition ──────────────────────────────────────────────────────
test('SKIN_CLUSTER_HANDLES is the exact five-handle list', () => {
  assert.deepEqual([...SKIN_CLUSTER_HANDLES].sort(), [
    'body-lotion-1',
    'coconut-lotion',
    'coconut-moisturizer',
    'coconut-soap',
    'organic-foaming-hand-soap',
  ]);
});

// ── normalization ───────────────────────────────────────────────────────────
test('normalizeJudgemeReview maps a Judge.me review onto the record shape', () => {
  const rec = normalizeJudgemeReview({
    id: 991,
    product_handle: 'coconut-lotion',
    rating: 5,
    body: '  Cleared up my eczema in a week.  ',
  });
  assert.equal(rec.source, 'judgeme');
  assert.equal(rec.id, 'judgeme:991');
  assert.equal(rec.handle, 'coconut-lotion');
  assert.equal(rec.rating, 5);
  assert.equal(rec.text, 'Cleared up my eczema in a week.');
  assert.equal(rec.url, null);
});

test('normalizeTavilyResult keys on the URL and joins title + content', () => {
  const rec = normalizeTavilyResult({
    url: 'https://reddit.com/r/SkincareAddiction/comments/abc/',
    title: 'Does coconut oil clog pores?',
    content: 'It broke me out badly.',
  });
  assert.equal(rec.source, 'reddit');
  assert.equal(rec.url, 'https://reddit.com/r/SkincareAddiction/comments/abc/');
  assert.match(rec.text, /Does coconut oil clog pores\?/);
  assert.match(rec.text, /broke me out badly/);
  assert.equal(rec.handle, null);
  assert.equal(rec.rating, null);
});

test('normalizeTavilyResult labels a non-reddit URL "web", not "reddit"', () => {
  // Regression: the agent used to reach Reddit by prefixing "reddit" to the
  // query text and hardcode source:'reddit'. That labelled the Reddit Wikipedia
  // article, the Reddit App Store listing and YouTube videos as forum friction.
  const rec = normalizeTavilyResult({
    url: 'https://en.wikipedia.org/wiki/Reddit',
    title: 'Reddit',
    content: 'Reddit is an American social news aggregation website.',
  });
  assert.equal(rec.source, 'web');
  assert.ok(rec.id.startsWith('web:'), `id should carry the derived source, got ${rec.id}`);
});

test('normalizeTavilyResult labels reddit subdomains and www as "reddit"', () => {
  for (const url of [
    'https://www.reddit.com/r/SkincareAddiction/comments/abc/',
    'https://old.reddit.com/r/eczema/comments/def/',
    'https://reddit.com/r/x/1',
  ]) {
    assert.equal(normalizeTavilyResult({ url, title: 't', content: 'c' }).source, 'reddit', url);
  }
});

test('normalizeTavilyResult falls back to "web" when there is no usable URL', () => {
  assert.equal(normalizeTavilyResult({ url: null, title: 't', content: 'c' }).source, 'web');
});

test('normalizeSerpItem maps a DataForSEO organic item', () => {
  const rec = normalizeSerpItem({
    url: 'https://example.com/coconut-oil-review',
    title: 'Coconut Oil Lotion Review',
    description: 'Greasy and slow to absorb.',
  });
  assert.equal(rec.source, 'serp');
  assert.equal(rec.url, 'https://example.com/coconut-oil-review');
  assert.match(rec.text, /Greasy and slow to absorb/);
});

// ── dedup ───────────────────────────────────────────────────────────────────
test('dedupeRecords collapses the same URL arriving via Tavily and SERP', () => {
  const shared = 'https://reddit.com/r/SkincareAddiction/comments/abc/';
  const out = dedupeRecords([
    normalizeTavilyResult({ url: shared, title: 'T', content: 'body' }),
    normalizeSerpItem({ url: shared, title: 'T', description: 'body' }),
  ]);
  assert.equal(out.length, 1);
});

test('dedupeRecords ignores a trailing slash and querystring when comparing URLs', () => {
  const out = dedupeRecords([
    normalizeTavilyResult({ url: 'https://reddit.com/r/x/abc/', title: 'T', content: 'b' }),
    normalizeSerpItem({ url: 'https://reddit.com/r/x/abc?utm_source=g', title: 'T', description: 'b' }),
  ]);
  assert.equal(out.length, 1);
});

test('dedupeRecords keeps distinct Judge.me reviews that have no URL', () => {
  const out = dedupeRecords([
    normalizeJudgemeReview({ id: 1, product_handle: 'coconut-lotion', rating: 5, body: 'a' }),
    normalizeJudgemeReview({ id: 2, product_handle: 'coconut-lotion', rating: 4, body: 'b' }),
  ]);
  assert.equal(out.length, 2);
});

test('dedupeRecords keeps distinct Tavily results with no URL and different text', () => {
  const out = dedupeRecords([
    normalizeTavilyResult({ url: null, title: 'First discussion', content: 'Great product' }),
    normalizeTavilyResult({ url: null, title: 'Second discussion', content: 'Terrible experience' }),
  ]);
  assert.equal(out.length, 2);
});

test('dedupeRecords collapses Tavily results with no URL but identical text', () => {
  const result = { url: null, title: 'Same discussion', content: 'Same feedback' };
  const out = dedupeRecords([
    normalizeTavilyResult(result),
    normalizeTavilyResult(result),
  ]);
  assert.equal(out.length, 1);
});

test('dedupeRecords keeps distinct SERP items with no URL and different text', () => {
  const out = dedupeRecords([
    normalizeSerpItem({ url: null, title: 'Article A', description: 'Content A' }),
    normalizeSerpItem({ url: null, title: 'Article B', description: 'Content B' }),
  ]);
  assert.equal(out.length, 2);
});

// ── cluster filter ──────────────────────────────────────────────────────────
test('filterSkinCluster keeps skin handles and drops other clusters', () => {
  const out = filterSkinCluster([
    normalizeJudgemeReview({ id: 1, product_handle: 'coconut-lotion', rating: 5, body: 'a' }),
    normalizeJudgemeReview({ id: 2, product_handle: 'coconut-oil-toothpaste', rating: 4, body: 'b' }),
    normalizeJudgemeReview({ id: 3, product_handle: 'coconut-breeze', rating: 5, body: 'c' }),
  ]);
  assert.deepEqual(out.map((r) => r.handle), ['coconut-lotion']);
});

test('filterSkinCluster keeps handle-less external records', () => {
  const out = filterSkinCluster([
    normalizeTavilyResult({ url: 'https://reddit.com/r/x/1', title: 'T', content: 'b' }),
  ]);
  assert.equal(out.length, 1);
});

function validAngle(overrides = {}) {
  return {
    id: 'steroid-cream-off-ramp',
    label: 'The steroid-cream off-ramp',
    awareness: 'problem-aware',
    objection_addressed: 'Will a natural lotion actually do anything?',
    proof: '97 reviews at 4.91 stars',
    hook_examples: ['Off the steroid cream in three weeks'],
    source_quotes: ['I finally stopped using hydrocortisone.'],
    ...overrides,
  };
}

function validPersona(overrides = {}) {
  return {
    id: 'eczema-flare-parent',
    name: 'The eczema flare parent',
    summary: 'Buys for a child whose skin reacts to everything.',
    evidence_count: 23,
    emotional_intensity: 8.4,
    angles: [validAngle()],
    ...overrides,
  };
}

function validAnalysis(overrides = {}) {
  return {
    personas: [validPersona()],
    objections: [{ text: 'Worried it will feel greasy', evidence_count: 12, quote: 'Too greasy for me.' }],
    golden_nugget_phrases: [{ text: 'like butter for your skin', evidence_count: 3, quote: 'It is like butter for your skin.' }],
    trigger_points: [{ text: 'A winter flare-up', evidence_count: 7, quote: 'My hands cracked in January.' }],
    not_for: [{ text: 'People who want a fragrance-free gel', evidence_count: 4, quote: 'I wanted a gel, not a balm.' }],
    ...overrides,
  };
}

// ── validation ──────────────────────────────────────────────────────────────
test('validateAnalysis accepts a well-formed analysis', () => {
  const res = validateAnalysis(validAnalysis());
  assert.equal(res.ok, true, res.errors.join('; '));
  assert.deepEqual(res.errors, []);
});

test('validateAnalysis rejects a persona with zero angles', () => {
  const res = validateAnalysis(validAnalysis({ personas: [validPersona({ angles: [] })] }));
  assert.equal(res.ok, false);
  assert.match(res.errors.join(' '), /at least one angle/i);
});

test('validateAnalysis rejects an angle with no source_quotes', () => {
  const persona = validPersona({ angles: [validAngle({ source_quotes: [] })] });
  const res = validateAnalysis(validAnalysis({ personas: [persona] }));
  assert.equal(res.ok, false);
  assert.match(res.errors.join(' '), /source_quotes/);
});

test('validateAnalysis rejects an awareness value outside the allowed set', () => {
  const persona = validPersona({ angles: [validAngle({ awareness: 'vaguely-curious' })] });
  const res = validateAnalysis(validAnalysis({ personas: [persona] }));
  assert.equal(res.ok, false);
  assert.match(res.errors.join(' '), /awareness/);
  assert.ok(AWARENESS_LEVELS.includes('problem-aware'));
});

test('validateAnalysis rejects an analysis with no personas', () => {
  const res = validateAnalysis(validAnalysis({ personas: [] }));
  assert.equal(res.ok, false);
});

test('validateAnalysis rejects a voice-of-customer entry with no quote', () => {
  const res = validateAnalysis(validAnalysis({
    objections: [{ text: 'Too greasy', evidence_count: 2, quote: '' }],
  }));
  assert.equal(res.ok, false);
  assert.match(res.errors.join(' '), /quote/);
});

// ── ranking ─────────────────────────────────────────────────────────────────
test('rankPersonas orders qualified personas by emotional intensity, highest first', () => {
  const loud = validPersona({ id: 'loud', evidence_count: 40, emotional_intensity: 2 });
  const intense = validPersona({ id: 'intense', evidence_count: 12, emotional_intensity: 9 });
  assert.deepEqual(rankPersonas([loud, intense]).map((p) => p.id), ['intense', 'loud']);
});

test('rankPersonas: volume does not outrank intensity once both clear the floor', () => {
  // The first live run's actual shape: the most intense persona had fewer
  // mentions and the old evidence x intensity score buried it.
  const labelReader = validPersona({ id: 'label', evidence_count: 25, emotional_intensity: 7.5 });
  const eczema = validPersona({ id: 'eczema', evidence_count: 18, emotional_intensity: 9.2 });
  assert.deepEqual(rankPersonas([labelReader, eczema]).map((p) => p.id), ['eczema', 'label']);
});

test('rankPersonas sinks an under-evidenced persona below qualified ones, without dropping it', () => {
  const thin = validPersona({ id: 'thin', evidence_count: 2, emotional_intensity: 10 });
  const solid = validPersona({ id: 'solid', evidence_count: 20, emotional_intensity: 5 });
  const out = rankPersonas([thin, solid]);
  assert.deepEqual(out.map((p) => p.id), ['solid', 'thin'], 'a 2-mention persona must not drive the default angle');
  assert.equal(out.length, 2, 'nothing is dropped — it is a floor, not a filter');
});

test('rankPersonas breaks intensity ties on evidence_count so the order is deterministic', () => {
  const fewer = validPersona({ id: 'fewer', evidence_count: 10, emotional_intensity: 7 });
  const more = validPersona({ id: 'more', evidence_count: 30, emotional_intensity: 7 });
  assert.deepEqual(rankPersonas([fewer, more]).map((p) => p.id), ['more', 'fewer']);
});

test('rankPersonas does not mutate its input', () => {
  const input = [
    validPersona({ id: 'a', evidence_count: 1, emotional_intensity: 1 }),
    validPersona({ id: 'b', evidence_count: 10, emotional_intensity: 10 }),
  ];
  rankPersonas(input);
  assert.deepEqual(input.map((p) => p.id), ['a', 'b']);
});

// ── rendering ───────────────────────────────────────────────────────────────
test('renderVoiceOfCustomerMarkdown emits the five stable headings', () => {
  const md = renderVoiceOfCustomerMarkdown(validAnalysis(), { partial: false });
  for (const heading of [
    '## Objections',
    '## Golden-nugget phrases',
    '## Trigger points',
    "## Who we're not for",
    '## Source notes',
  ]) {
    assert.ok(md.includes(heading), `missing ${heading}`);
  }
});

test('renderVoiceOfCustomerMarkdown flags a partial corpus in Source notes', () => {
  const md = renderVoiceOfCustomerMarkdown(validAnalysis(), { partial: true });
  assert.match(md, /generated without external friction data/);
});

test('renderVoiceOfCustomerMarkdown puts evidence count and quote on every entry', () => {
  const md = renderVoiceOfCustomerMarkdown(validAnalysis(), { partial: false });
  assert.match(md, /Worried it will feel greasy/);
  assert.match(md, /12 mentions/);
  assert.match(md, /Too greasy for me\./);
});

test('renderVoiceOfCustomerMarkdown says "1 mention", not "1 mentions"', () => {
  const md = renderVoiceOfCustomerMarkdown(validAnalysis({
    objections: [{ text: 'Only said once', evidence_count: 1, quote: 'Just me then.' }],
  }), { partial: false });
  assert.match(md, /1 mention\./);
  assert.ok(!/1 mentions/.test(md), 'must not print "1 mentions"');
});

test('renderPersonasMarkdown says "1 mention", not "1 mentions"', () => {
  const md = renderPersonasMarkdown(validAnalysis({
    personas: [validPersona({ evidence_count: 1 })],
  }));
  assert.match(md, /1 mention,/);
  assert.ok(!/1 mentions/.test(md), 'must not print "1 mentions"');
});

test('renderPersonasMarkdown lists personas in rank order with their angles', () => {
  const analysis = validAnalysis({
    personas: [
      validPersona({ id: 'low', name: 'Low persona', evidence_count: 1, emotional_intensity: 1 }),
      validPersona({ id: 'high', name: 'High persona', evidence_count: 50, emotional_intensity: 9 }),
    ],
  });
  const md = renderPersonasMarkdown(analysis);
  assert.ok(md.indexOf('High persona') < md.indexOf('Low persona'));
  assert.match(md, /problem-aware/);
  assert.match(md, /steroid-cream-off-ramp/);
});

// ── section slicing (what each consumer is allowed to see) ──────────────────
test('BLOG_VOC_HEADINGS excludes the disqualifier and the provenance sections', () => {
  assert.deepEqual(BLOG_VOC_HEADINGS, [
    '## Objections',
    '## Golden-nugget phrases',
    '## Trigger points',
  ]);
  assert.ok(!BLOG_VOC_HEADINGS.includes("## Who we're not for"));
  assert.ok(!BLOG_VOC_HEADINGS.includes('## Source notes'));
});

test('sliceVocSections returns only the requested sections, in document order', () => {
  const md = renderVoiceOfCustomerMarkdown(validAnalysis(), { partial: false });
  const sliced = sliceVocSections(md, BLOG_VOC_HEADINGS);

  assert.ok(sliced.includes('## Objections'));
  assert.ok(sliced.includes('## Golden-nugget phrases'));
  assert.ok(sliced.includes('## Trigger points'));
  assert.ok(sliced.indexOf('## Objections') < sliced.indexOf('## Trigger points'));

  assert.ok(!sliced.includes("## Who we're not for"), 'disqualifier must not reach the blog writer');
  assert.ok(!sliced.includes('## Source notes'));
  assert.ok(!sliced.includes('I wanted a gel, not a balm.'), 'not_for entries must be dropped too');
  assert.ok(!sliced.includes('# Voice of Customer'), 'the h1 preamble is not a requested section');
});

test('sliceVocSections keeps the body of a requested section verbatim', () => {
  const md = [
    '# Title', '', '## Objections', '', '- **Greasy** — 3 mentions. > "Too greasy."', '',
    "## Who we're not for", '', '- **Nope** — 1 mention. > "Not for me."', '',
  ].join('\n');
  const sliced = sliceVocSections(md, ['## Objections']);
  assert.equal(sliced, '## Objections\n\n- **Greasy** — 3 mentions. > "Too greasy."');
});

test('sliceVocSections returns an empty string for missing input or unknown headings', () => {
  assert.equal(sliceVocSections('', BLOG_VOC_HEADINGS), '');
  assert.equal(sliceVocSections(undefined, BLOG_VOC_HEADINGS), '');
  assert.equal(sliceVocSections('## Objections\n\nbody', []), '');
  assert.equal(sliceVocSections('## Objections\n\nbody', ['## Nonexistent']), '');
});

test('sliceVocSections does not treat a ### subheading as a section boundary', () => {
  const md = '## Objections\n\n### Price\n\n- **Steep** — 2 mentions.\n\n## Source notes\n\n- x';
  const sliced = sliceVocSections(md, ['## Objections']);
  assert.ok(sliced.includes('### Price'));
  assert.ok(sliced.includes('Steep'));
  assert.ok(!sliced.includes('Source notes'));
});

// ── quote provenance ────────────────────────────────────────────────────────
const PROVENANCE_CORPUS = {
  records: [
    { source: 'judgeme', text: 'It just glides onto the skin like butter! It doesnt leave a greasy residue.' },
    { source: 'reddit', text: 'for me its too heavy and pore clogging, if you want a natural oil try jojoba' },
  ],
};

function analysisWithQuote(quote) {
  return validAnalysis({
    personas: [validPersona({ angles: [validAngle({ source_quotes: [quote] })] })],
    objections: [{ text: 't', evidence_count: 1, quote }],
    golden_nugget_phrases: [{ text: 't', evidence_count: 1, quote }],
    trigger_points: [{ text: 't', evidence_count: 1, quote }],
    not_for: [{ text: 't', evidence_count: 1, quote }],
  });
}

test('findUnsourcedQuotes returns [] when every quote is in the corpus', () => {
  const out = findUnsourcedQuotes(
    analysisWithQuote('It just glides onto the skin like butter!'),
    PROVENANCE_CORPUS,
  );
  assert.deepEqual(out, []);
});

test('findUnsourcedQuotes flags an invented quote, and says where it came from', () => {
  const out = findUnsourcedQuotes(analysisWithQuote('This lotion cured my psoriasis overnight.'), PROVENANCE_CORPUS);
  assert.equal(out.length, 5, 'one per section plus the angle source_quote');
  assert.ok(out.every((u) => u.quote === 'This lotion cured my psoriasis overnight.'));
  assert.match(out.map((u) => u.location).join(' '), /personas\[0\]/);
  assert.match(out.map((u) => u.location).join(' '), /objections\[0\]/);
});

test('findUnsourcedQuotes normalizes curly vs straight apostrophes', () => {
  const corpus = { records: [{ text: 'I’ve only used it for a week and it’s about one third its size.' }] };
  assert.deepEqual(findUnsourcedQuotes(analysisWithQuote("I've only used it for a week and it's about one third its size."), corpus), []);
  const flipped = { records: [{ text: "I've only used it for a week and it's about one third its size." }] };
  assert.deepEqual(findUnsourcedQuotes(analysisWithQuote('I’ve only used it for a week and it’s about one third its size.'), flipped), []);
});

test('findUnsourcedQuotes tolerates whitespace and case differences', () => {
  const corpus = { records: [{ text: 'Zero   crap\nadded to this one.' }] };
  assert.deepEqual(findUnsourcedQuotes(analysisWithQuote('zero crap added to this one.'), corpus), []);
});

test('findUnsourcedQuotes accepts a quote whose trailing clause was trimmed', () => {
  const corpus = {
    records: [{
      text: 'My feet are no longer cracked and painful to walk on and my husband agrees this is the first product that helps.',
    }],
  };
  const out = findUnsourcedQuotes(
    analysisWithQuote('My feet are no longer cracked and painful to walk on'),
    corpus,
  );
  assert.deepEqual(out, []);
});

test('findUnsourcedQuotes rejects a quote whose opening was invented even if it ends real', () => {
  const corpus = { records: [{ text: 'for me its too heavy and pore clogging on my face and back' }] };
  const out = findUnsourcedQuotes(
    analysisWithQuote('Every dermatologist agrees that for me its too heavy and pore clogging on my face'),
    corpus,
  );
  assert.ok(out.length > 0, 'a fabricated opening must not be laundered by a real tail');
});

test('findUnsourcedQuotes accepts a bare records array as the corpus', () => {
  assert.deepEqual(
    findUnsourcedQuotes(analysisWithQuote('It just glides onto the skin like butter!'), PROVENANCE_CORPUS.records),
    [],
  );
});

test('findUnsourcedQuotes leaves empty quotes to validateAnalysis', () => {
  const analysis = analysisWithQuote('It just glides onto the skin like butter!');
  analysis.objections = [{ text: 't', evidence_count: 1, quote: '' }];
  const out = findUnsourcedQuotes(analysis, PROVENANCE_CORPUS);
  assert.deepEqual(out, [], 'an empty quote is not an unsourced quote');
  assert.equal(validateAnalysis(analysis).ok, false, 'validateAnalysis is what rejects it');
});

// ── the VOC markdown reaches live storefront copy, so it needs the same gate ───
// Found 2026-08-17: data/context/voice-of-customer.md carried the exact quote
// from the 2026-08-16 incident ("prescription strength lotions, steroids...")
// under "## Golden-nugget phrases" — a section defined as language worth using
// in an ad VERBATIM. BLOG_VOC_HEADINGS is every section but `not_for`, so it
// reached agents/blog-post-writer, and agents/pdp-builder is handed the whole
// file. Both write live storefront copy for a COSMETIC; neither has a gate.
// A verbatim review can be correctly sourced and still be an illegal claim.

test('sanitizeVocMarkdown drops a bullet carrying a health claim', () => {
  const md = [
    '## Golden-nugget phrases',
    '',
    "- **'I have tried prescription strength lotions, steroids, you name it... to no avail.'** — 1 mention. > \"...Until Real Skin Care!!!!\"",
    "- **'Zero crap added.'** — 2 mentions. > \"minimal, natural ingredients\"",
    '',
  ].join('\n');
  const out = sanitizeVocMarkdown(md);
  assert.ok(!out.includes('prescription'), 'claim survived');
  assert.ok(!out.includes('steroids'), 'claim survived');
  assert.ok(out.includes('Zero crap added.'), 'clean bullet was destroyed');
  assert.ok(out.includes('## Golden-nugget phrases'), 'heading must survive');
});

test('sanitizeVocMarkdown keeps headings even when every bullet drops', () => {
  const md = '## Objections\n\n- **eczema flare** — 3 mentions.\n';
  const out = sanitizeVocMarkdown(md);
  assert.ok(out.includes('## Objections'));
  assert.ok(!out.includes('eczema'));
});

test('sanitizeVocMarkdown reports what it dropped', () => {
  const md = '## Objections\n\n- **cures my eczema** — 1 mention.\n- **smells nice** — 4 mentions.\n';
  const { markdown, dropped } = sanitizeVocMarkdownWithReport(md);
  assert.equal(dropped.length, 1);
  assert.match(dropped[0].reason, /disease|drug|therapeutic/);
  assert.ok(markdown.includes('smells nice'));
});

test('sanitizeVocMarkdown leaves clean documents byte-identical', () => {
  const md = '## Objections\n\n- **too greasy** — 5 mentions.\n\n## Trigger points\n\n- **winter** — 2 mentions.\n';
  assert.equal(sanitizeVocMarkdown(md), md);
});

test('REGRESSION: the committed Golden-nugget section carries no health claim', () => {
  // Scoped to Golden-nugget deliberately. The other VOC sections are RESEARCH —
  // "CeraVe is the default recommendation for eczema" is competitive intel, and
  // destroying it would throw away analysis the generator paid for. Those are
  // handled at the consumer boundary instead (see the vocForCopy tests below).
  //
  // Golden-nugget is different in kind: its stated contract is "striking customer
  // language worth putting in an ad VERBATIM". A claim sitting there is not
  // context a writer might misuse — it is an instruction to publish it.
  const p = join(ROOT_DIR, 'data', 'context', 'voice-of-customer.md');
  if (!existsSync(p)) return; // not generated on a fresh checkout
  const golden = sliceVocSections(readFileSync(p, 'utf8'), ['## Golden-nugget phrases']);
  const { dropped } = sanitizeVocMarkdownWithReport(golden);
  assert.deepEqual(
    dropped.map((d) => d.text.slice(0, 70)), [],
    'Golden-nugget phrases carries a health claim and that section is used verbatim in ads',
  );
});

test('vocForCopy gates every section, not just Golden-nugget', () => {
  // The consumer boundary. blog-post-writer takes BLOG_VOC_HEADINGS (every
  // section but not_for) and pdp-builder takes the file WHOLE, so research
  // sections reach a copy model too and must be gated on the way out.
  const md = [
    '## Objections', '',
    '- **CeraVe is the default recommendation for eczema** — 9 mentions.',
    '- **too greasy** — 5 mentions.', '',
  ].join('\n');
  const out = vocForCopy(md);
  assert.ok(!out.includes('eczema'), 'research claim reached the copy writer');
  assert.ok(out.includes('too greasy'));
  assert.ok(out.includes('## Objections'));
});

test('vocForCopy on the real committed file is claim-free', () => {
  const p = join(ROOT_DIR, 'data', 'context', 'voice-of-customer.md');
  if (!existsSync(p)) return;
  const { dropped } = sanitizeVocMarkdownWithReport(vocForCopy(readFileSync(p, 'utf8')));
  assert.deepEqual(dropped.map((d) => d.text.slice(0, 70)), []);
});
