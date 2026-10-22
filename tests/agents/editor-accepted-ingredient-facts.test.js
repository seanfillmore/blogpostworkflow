// The editor's INGREDIENT ACCURACY rule must not block owner-confirmed facts.
// On 2026-10-18 it filed "cold-pressed coconut oil" as a BLOCKER because the spec
// says "organic virgin coconut oil"; blocked-post-resolver would then have
// "fixed" a true claim off live pages. Sean, 2026-10-07: cold-pressed is true,
// and "all organic" is accurate. A source scan: importing the agent runs it.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('../../agents/editor/index.js', import.meta.url), 'utf8');
const start = SRC.indexOf('3. INGREDIENT ACCURACY');
const rule = SRC.slice(start, SRC.indexOf('4. YEAR ACCURACY', start));

test('ingredient accuracy accepts cold-pressed coconut oil', () => {
  assert.match(rule, /cold-pressed/i);
});

test('ingredient accuracy accepts "all organic"', () => {
  assert.match(rule, /all organic/i);
});
