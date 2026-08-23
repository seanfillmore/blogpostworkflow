/**
 * Every unattended agent that writes live SEO copy to Shopify imports the
 * health-claim gate, and every one of its LLM prompts carries the compliance
 * rule up front.
 *
 * A SOURCE SCAN rather than a behavioural test, for the reason
 * tests/lib/briefs-dir-readers.test.js gives: importing an agent entry point
 * RUNS the agent — these three call `loadEnv()`, `process.exit(1)` without an
 * API key, and import `lib/shopify.js`, which throws at import time without
 * OAuth credentials. The retry loop and the field extraction are tested for
 * real in tests/lib/seo-copy-gate-loop.test.js and
 * tests/lib/queue-apply-health-gate.test.js; what cannot be reached any other
 * way is whether the agents are wired to them at all.
 *
 * This is the check that would have caught the 2026-08-22 incident: an audit on
 * 2026-08-23 found NO SEO-copy writer in this repo imported the gate. A fourth
 * writer added later without it is a gap, not an exemption — so a new file that
 * calls `client.messages.create` and writes `title_tag` / `description_tag` /
 * `title` to Shopify should be added to WRITERS here, or explicitly justified
 * in the EXEMPT list below.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

/**
 * Source with comments removed. Several of these files DISCUSS `immediate: true`
 * in a comment explaining why they must not use it, so a raw scan for the string
 * finds the documentation rather than the code.
 */
const readCode = (p) => read(p)
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .split('\n').map((l) => l.replace(/(^|\s)\/\/.*$/, '')).join('\n');

/** Unattended, cron-driven, generates SEO copy AND writes it live. */
const WRITERS = [
  'agents/meta-optimizer/index.js',
  'agents/product-optimizer/index.js',
  'agents/collection-content-optimizer/index.js',
];

describe('every unattended SEO-copy writer is wired to the gate', () => {
  for (const file of WRITERS) {
    test(`${file} imports the health-claim gate`, () => {
      assert.match(read(file), /from '\.\.\/\.\.\/lib\/seo-copy-(health-gate|gate-loop)\.js'/);
    });

    test(`${file} regenerates once rather than dropping a candidate silently`, () => {
      const src = read(file);
      assert.ok(
        /gateGeneratedCopy|gateProposedCopy/.test(src),
        'must use the shared retry loop — a bespoke copy of the retry policy is a copy that drifts',
      );
    });

    test(`${file} puts the compliance rule in the FIRST prompt, on every prompt`, () => {
      const src = read(file);
      const prompts = src.match(/client\.messages\.create\(/g) || [];
      const rules = src.match(/SEO_COPY_COMPLIANCE_RULE/g) || [];
      assert.ok(prompts.length > 0, 'expected at least one model call');
      // One import mention plus one per prompt. Detection without prevention
      // burns retries — the rule up front is what keeps most runs at one call.
      assert.ok(
        rules.length >= prompts.length,
        `${prompts.length} prompt(s) but only ${rules.length} mention(s) of SEO_COPY_COMPLIANCE_RULE`,
      );
    });
  }
});

describe('the last line before a live write refuses copy it cannot regenerate', () => {
  test('lib/queue-apply.js gates inside applyItem, not merely alongside it', () => {
    const src = read('lib/queue-apply.js');
    assert.match(src, /export async function applyItem\(item, deps\) \{\s*\n\s*assertItemCopyIsCompliant\(item\);/);
  });

  test('queue-autoapply gates in the PURE planner, before anything that spends', () => {
    const src = read('lib/queue-autoapply.js');
    const gateAt = src.indexOf('seoCopyViolationsForItem(item)');
    const cooldownAt = src.indexOf('cooldown.has(target)');
    assert.ok(gateAt > 0 && cooldownAt > 0);
    assert.ok(gateAt < cooldownAt, 'the health gate must run before the cooldown/attempt checks can mask it');
  });

  test('a gated queue item is never dismissed — refusing a write is not deciding work is worthless', () => {
    const src = read('lib/queue-autoapply.js');
    // Every health-claim return in decide() must be a skip.
    for (const m of src.matchAll(/\{\s*action:\s*'(\w+)',\s*gate:\s*'health-claim'/g)) {
      assert.equal(m[1], 'skip');
    }
    assert.ok(/gate: 'health-claim'/.test(src));
  });

  test('the two --publish-approved drains refuse rather than dismiss', () => {
    for (const file of ['agents/product-optimizer/index.js', 'agents/collection-content-optimizer/index.js']) {
      const src = read(file);
      assert.match(src, /health_gate = \{/, `${file} must stamp the refusal on the item`);
      assert.ok(
        !/health_gate[\s\S]{0,400}status = 'dismissed'/.test(src),
        `${file} must not dismiss an item on a gate hit`,
      );
    }
  });
});

describe('a gate block reaches the 5 AM digest and is not an error', () => {
  for (const file of ['agents/product-optimizer/index.js', 'agents/collection-content-optimizer/index.js', 'agents/queue-autoapply/index.js']) {
    test(`${file} renders gate lines into the notification body`, () => {
      const src = read(file);
      assert.match(src, /renderGateSkipLines|renderGateRefusalLines/);
    });

    test(`${file} never escalates a gate block to an immediate email`, () => {
      // No notify() call in these files may set immediate:true — a gate block is
      // routine and belongs in the 5 AM digest with everything else. Comments are
      // stripped first: two of these files explain in prose why they do not.
      assert.ok(!/immediate:\s*true/.test(readCode(file)), 'a gate block belongs in the deferred digest');
    });
  }
});
