// tests/agents/blog-post-writer-voc.test.js
//
// agents/blog-post-writer/index.js calls main() at module scope, so it cannot be
// imported into a test process without kicking off a real writing run. The
// behaviour under test — which voice-of-customer sections reach an
// auto-publishing writer, and how they are framed — is therefore asserted two
// ways: the slicing contract is unit-tested against the real lib functions, and
// the agent's wiring to those functions is asserted against its source.
//
// What this guards: blog-post-writer output flows calendar-runner → editor →
// publisher with no human in the loop, and the editor gate checks structure and
// claim sourcing, not "do not reproduce a 1-star review on the storefront".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sliceVocSections, BLOG_VOC_HEADINGS } from '../../lib/voice-of-customer.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = readFileSync(join(ROOT, 'agents', 'blog-post-writer', 'index.js'), 'utf8');

// A doc shaped like the real artifact, including the material that must not
// reach the writer.
const FULL_DOC = [
  '# Voice of Customer — skin cluster',
  '',
  '## Objections',
  '',
  '- **Price feels steep** — 11 mentions. > "for $11 a bar, the price seems excessive. Will not be purchasing again."',
  '',
  '## Golden-nugget phrases',
  '',
  '- **Zero crap added** — 2 mentions. > "Zero crap added."',
  '',
  '## Trigger points',
  '',
  '- **First cold snap** — 6 mentions. > "My hands get very dry in the winter."',
  '',
  "## Who we're not for",
  '',
  '- **Bargain shoppers** — 8 mentions. > "The bar seemed small for the price point."',
  '',
  '## Source notes',
  '',
  '- Judge.me reviews for the skin cluster, Reddit via Tavily.',
  '',
].join('\n');

test('the writer slice drops the disqualifier and provenance sections', () => {
  const sliced = sliceVocSections(FULL_DOC, BLOG_VOC_HEADINGS);
  assert.ok(sliced.includes('## Objections'));
  assert.ok(sliced.includes('## Golden-nugget phrases'));
  assert.ok(sliced.includes('## Trigger points'));
  assert.ok(!sliced.includes("## Who we're not for"), 'a disqualifier is for the ad and PDP consumers, not a blog post');
  assert.ok(!sliced.includes('Bargain shoppers'));
  assert.ok(!sliced.includes('## Source notes'));
});

test('blog-post-writer slices the doc rather than injecting the whole file', () => {
  assert.match(SRC, /import \{ sliceVocSections, BLOG_VOC_HEADINGS, vocForCopy \} from '\.\.\/\.\.\/lib\/voice-of-customer\.js'/);
  assert.match(SRC, /sliceVocSections\(raw, BLOG_VOC_HEADINGS\)/);
});

test('blog-post-writer gates the VOC text through the health-claims filter', () => {
  // The research sections legitimately name conditions — "CeraVe is the default
  // recommendation for eczema" is competitive intel that stays on disk. This
  // agent writes live storefront copy for a COSMETIC and auto-publishes via
  // calendar-runner → editor → publisher with no human in the loop, so nothing
  // ungated may reach the prompt.
  assert.match(SRC, /vocForCopy\(sliceVocSections\(raw, BLOG_VOC_HEADINGS\)\)/);
});

test('blog-post-writer frames the block as internal research, not copy to reuse', () => {
  assert.match(SRC, /VOICE OF CUSTOMER \(internal research — NOT source material to quote\)/);
  assert.match(SRC, /Never quote, paraphrase closely, or reproduce any line below/);
  assert.match(SRC, /Never restate a complaint about our own products as fact/);
  // The instruction that made verbatim reuse the goal must be gone.
  assert.ok(
    !/prefer this customer language over invented phrasing/.test(SRC),
    'the old "prefer this customer language" instruction invited verbatim reuse',
  );
});

test('the block carries a skin-cluster scope caveat, since the writer also writes toothpaste', () => {
  // sliceVocSections strips the doc's "# Voice of Customer — skin cluster" H1
  // along with every other non-"## " line, so the injected text carries no scope
  // of its own. Without the caveat a toothpaste post can open by answering a
  // bar-soap price objection — and that pipeline auto-publishes.
  const block = SRC.slice(SRC.indexOf('const vocBlock'), SRC.indexOf('const ingredientList'));
  assert.match(block, /SCOPE — this research covers the skin cluster ONLY/);
  assert.match(block, /coconut lotion, body lotion, coconut moisturizer, coconut bar soap, and foaming hand soap/);
  assert.match(block, /toothpaste, deodorant, lip balm, hair/);
  assert.match(block, /ignore this whole block/);
  // and it must live inside the non-empty guard, not outside it
  assert.match(block, /const vocBlock = voc \? `/);
  assert.match(block, /` : '';/);
});

test('the voice-of-customer block uses the same divider styling as its neighbours', () => {
  const block = SRC.slice(SRC.indexOf('const vocBlock'), SRC.indexOf('const ingredientList'));
  const dividers = block.match(/═══════════════════════════════════/g) || [];
  assert.equal(dividers.length, 2, 'heading should be fenced above and below like FORMAT OVERRIDE');
});
