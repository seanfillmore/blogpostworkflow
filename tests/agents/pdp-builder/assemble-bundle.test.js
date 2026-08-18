// tests/agents/pdp-builder/assemble-bundle.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadFoundation } from '../../../agents/pdp-builder/lib/load-foundation.js';
import { buildBundleFacts } from '../../../agents/pdp-builder/lib/bundle-facts.js';
import { assembleBundle, validateBundleContent, MAX_VALIDATION_RETRIES } from '../../../agents/pdp-builder/lib/assemble-bundle.js';
import { buildBundleSystemPrompt } from '../../../agents/pdp-builder/lib/prompt-builder.js';
import { fetchBundleProduct } from '../../../agents/pdp-builder/lib/fetch-bundle.js';
// Imported for its side-effect-freedom as much as its behaviour: index.js must be
// importable without running the agent (main guard).
import { writeBundleCopy } from '../../../agents/pdp-builder/index.js';

const foundation = loadFoundation();

function component(qty, handle, title, price) {
  return {
    quantity: qty,
    productVariant: { id: 'gid://v', title, price: String(price), product: { id: 'gid://p', title: 'X', handle } },
  };
}

const CLEAN_SWAP = {
  handle: 'clean-swap', title: 'The Clean Swap', status: 'ACTIVE', productType: '', tags: ['bundle'],
  variants: {
    nodes: [{
      id: 'gid://v1', title: 'Gentle', price: '59.00',
      productVariantComponents: {
        nodes: [
          component(1, 'coconut-lotion', 'Pure Unscented', 30),
          component(1, 'coconut-oil-deodorant', 'Calming Lavender', 15),
          component(1, 'coconut-oil-toothpaste', 'Fresh Mint', 13),
          component(1, 'coconut-soap', 'Pure Unscented', 11),
        ],
      },
    }],
  },
};
const facts = buildBundleFacts({ product: CLEAN_SWAP, ingredientsByCluster: foundation.ingredientsByCluster });

const body = (extra = '') =>
  `<p>Body lotion, deodorant, toothpaste and bar soap in one box. ${extra}</p><p>` +
  Array(180).fill('word').join(' ') + '</p>';

const VALID = {
  seoTitle: 'The Clean Swap Set | Four Daily Basics | Real Skin Care', // 55 chars
  metaDescription: 'A'.repeat(150),
  bodyHtml: body('$69 of product for $59.'),
};

function fakeResponse(payload) {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

function scriptedClient(payloads) {
  let i = 0;
  const calls = [];
  return {
    calls,
    messages: {
      create: async (req) => {
        calls.push(req);
        return fakeResponse(payloads[Math.min(i++, payloads.length - 1)]);
      },
    },
  };
}

test('assembleBundle: clean output produces a pending queue item', async () => {
  const client = scriptedClient([VALID]);
  const item = await assembleBundle({ foundation, facts, claudeClient: client });
  assert.equal(item.type, 'pdp-bundle');
  assert.equal(item.slug, 'clean-swap');
  assert.equal(item.status, 'pending');
  assert.equal(item.validation.passed, true);
  assert.equal(item.attempts, 1);
  assert.equal(item.facts.variants[0].savings, 10);
});

test('assembleBundle: a health claim is regenerated, and the retry can succeed', async () => {
  const client = scriptedClient([
    { ...VALID, bodyHtml: body('It heals dry skin.') },
    VALID,
  ]);
  const item = await assembleBundle({ foundation, facts, claudeClient: client });
  assert.equal(item.status, 'pending');
  assert.equal(item.attempts, 2);
  // The rejection reason was fed back to the model, not silently swallowed.
  const correction = client.calls.at(-1).messages.at(-1).content;
  assert.match(correction, /That draft was rejected/);
  assert.match(correction, /health claim "heals" \(therapeutic\)/);
});

test('assembleBundle: a health claim that survives every retry ends as needs_rework, never pending', async () => {
  const client = scriptedClient([{ ...VALID, bodyHtml: body('It heals dry skin.') }]);
  const item = await assembleBundle({ foundation, facts, claudeClient: client });
  assert.equal(item.status, 'needs_rework');
  assert.equal(item.validation.passed, false);
  assert.match(item.validation.errors.join('\n'), /health claim "heals"/);
  assert.equal(item.attempts, MAX_VALIDATION_RETRIES + 1);
});

test('assembleBundle: an invented component ends as needs_rework', async () => {
  const client = scriptedClient([{ ...VALID, bodyHtml: body('Plus a lip balm.') }]);
  const item = await assembleBundle({ foundation, facts, claudeClient: client });
  assert.equal(item.status, 'needs_rework');
  assert.match(item.validation.errors.join('\n'), /lip balm/);
});

test('assembleBundle: an invented dollar saving ends as needs_rework', async () => {
  const client = scriptedClient([{ ...VALID, bodyHtml: body('Save $25 today.') }]);
  const item = await assembleBundle({ foundation, facts, claudeClient: client });
  assert.equal(item.status, 'needs_rework');
  assert.match(item.validation.errors.join('\n'), /\$25/);
});

test('assembleBundle: unparseable JSON is reported, not retried forever', async () => {
  const client = {
    messages: { create: async () => ({ content: [{ type: 'text', text: 'not json at all' }] }) },
  };
  const item = await assembleBundle({ foundation, facts, claudeClient: client });
  assert.equal(item.status, 'needs_rework');
  assert.match(item.validation.errors[0], /not valid JSON/);
  assert.equal(item.raw_response, 'not json at all');
});

test('validateBundleContent: returns no errors for the known-good payload', () => {
  const errors = validateBundleContent({
    proposed: VALID, facts, ingredientsByCluster: foundation.ingredientsByCluster,
  });
  assert.deepEqual(errors, []);
});

// ── prompt ────────────────────────────────────────────────────────────────

test('buildBundleSystemPrompt: carries the computed arithmetic and every cluster POV', () => {
  const prompt = buildBundleSystemPrompt({ foundation, facts });
  assert.match(prompt, /Sum of parts \$69/);
  assert.match(prompt, /Saving \$10/);
  assert.match(prompt, /every option saves exactly \$10/);
  for (const heading of ['## lotion', '## deodorant', '## toothpaste', '## bar_soap']) {
    assert.ok(prompt.includes(heading), `expected cluster POV ${heading} in prompt`);
  }
});

test('buildBundleSystemPrompt: tells the writer to say nothing about savings when not claimable', () => {
  const overpriced = structuredClone(CLEAN_SWAP);
  overpriced.variants.nodes[0].price = '75.00';
  const badFacts = buildBundleFacts({ product: overpriced, ingredientsByCluster: foundation.ingredientsByCluster });
  const prompt = buildBundleSystemPrompt({ foundation, facts: badFacts });
  assert.match(prompt, /SAVINGS: NOT CLAIMABLE/);
});

// ── fetch (read-only) ─────────────────────────────────────────────────────

test('fetchBundleProduct: issues a read-only query and returns productByHandle', async () => {
  let seen = null;
  const product = await fetchBundleProduct('clean-swap', {
    graphql: async (q, vars) => { seen = { q, vars }; return { productByHandle: CLEAN_SWAP }; },
  });
  assert.equal(product.handle, 'clean-swap');
  assert.equal(seen.vars.handle, 'clean-swap');
  assert.ok(!/mutation/i.test(seen.q), 'bundle mode must never issue a mutation');
  assert.match(seen.q, /productVariantComponents/);
});

test('fetchBundleProduct: throws on an unknown handle rather than returning null', async () => {
  await assert.rejects(
    () => fetchBundleProduct('nope', { graphql: async () => ({ productByHandle: null }) }),
    /no product with handle "nope"/,
  );
});

// ── write boundary ────────────────────────────────────────────────────────

test('writeBundleCopy: writes html + json for a pending item', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bundle-copy-'));
  try {
    const item = {
      type: 'pdp-bundle', slug: 'clean-swap', status: 'pending',
      generated_at: 'now', foundation_version: 'abc', facts, proposed: VALID,
    };
    const path = writeBundleCopy(item, { dir });
    assert.ok(existsSync(path));
    assert.equal(readFileSync(path, 'utf8').trim(), VALID.bodyHtml);
    const sidecar = JSON.parse(readFileSync(join(dir, 'clean-swap.json'), 'utf8'));
    assert.equal(sidecar.seoTitle, VALID.seoTitle);
    assert.equal(sidecar.savings.minSavings, 10);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeBundleCopy: writes nothing for a needs_rework item', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bundle-copy-'));
  try {
    const path = writeBundleCopy({ type: 'pdp-bundle', slug: 'x', status: 'needs_rework', proposed: VALID, facts }, { dir });
    assert.equal(path, null);
    assert.equal(existsSync(join(dir, 'x.html')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeBundleCopy: throws rather than write a health claim to disk', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bundle-copy-'));
  try {
    const item = {
      type: 'pdp-bundle', slug: 'clean-swap', status: 'pending',
      generated_at: 'now', foundation_version: 'abc', facts,
      proposed: { ...VALID, bodyHtml: '<p>Cures dry skin.</p>' },
    };
    assert.throws(() => writeBundleCopy(item, { dir }), /Health claim gate failed/);
    assert.equal(existsSync(join(dir, 'clean-swap.html')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
