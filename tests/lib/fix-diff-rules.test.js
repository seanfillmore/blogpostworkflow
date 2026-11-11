import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkFixDiff, FORBIDDEN_PATHS, GATE_FILES } from '../../lib/fix-diff-rules.js';

const good = { numstat: '30\t10\tagents/x/index.js\n20\t0\ttests/agents/x.test.js', patch: 'diff --git a/agents/x/index.js b/agents/x/index.js\n+const a = 1;\n' };
const probs = (d) => checkFixDiff(d).problems;
const withFile = (line) => ({ ...good, numstat: good.numstat + '\n' + line });

test('good diff passes', () => assert.deepEqual(checkFixDiff(good), { ok: true, problems: [] }));
test('exports lists', () => { assert.ok(FORBIDDEN_PATHS.length >= 4); assert.equal(GATE_FILES.length, 7); });

test('forbidden paths', () => {
  for (const p of ['data/x.json', '.env', '.env.local', 'theme/a.liquid', 'config/site.json', 'scripts/setup-cron.sh']) {
    assert.ok(probs(withFile(`1\t0\t${p}`)).some((x) => x.includes(p)), p);
  }
});
test('gate files', () => {
  for (const p of GATE_FILES) assert.ok(probs(withFile(`1\t0\t${p}`)).some((x) => x.includes(p)), p);
});
test('over 300 lines', () => {
  assert.ok(probs({ ...good, numstat: '200\t101\tagents/x/index.js\n1\t0\ttests/a.test.js' }).some((x) => /300/.test(x)));
  assert.equal(checkFixDiff({ ...good, numstat: '199\t100\tagents/x/index.js\n1\t0\ttests/a.test.js' }).ok, true);
});
test('no test file', () => {
  assert.ok(probs({ ...good, numstat: '5\t0\tagents/x/index.js' }).some((x) => /test/.test(x)));
});
test('deleted test file', () => {
  const patch = good.patch + 'diff --git a/tests/lib/a.test.js b/tests/lib/a.test.js\ndeleted file mode 100644\n';
  assert.ok(probs({ ...good, patch }).some((x) => /deleted test/.test(x)));
});
test('removed assert in tests', () => {
  const patch = good.patch + 'diff --git a/tests/lib/a.test.js b/tests/lib/a.test.js\n--- a/tests/lib/a.test.js\n+++ b/tests/lib/a.test.js\n-  assert.equal(a, 1);\n';
  assert.ok(probs({ ...good, patch }).some((x) => /assert/.test(x)));
});
test('removed assert outside tests is fine', () => {
  const patch = good.patch + 'diff --git a/lib/a.js b/lib/a.js\n--- a/lib/a.js\n+++ b/lib/a.js\n-  assert(x);\n';
  assert.equal(checkFixDiff({ ...good, patch }).ok, true);
});
test('skips and todos', () => {
  for (const l of ['+test.skip("x")', '+it.todo("x")', '+test.todo("x")', '+test("x", { skip: true }, f)', '+describe.skip(']) {
    assert.ok(probs({ ...good, patch: good.patch + l + '\n' }).some((x) => /skip|todo/.test(x)), l);
  }
});
test('notify status change', () => {
  assert.ok(probs({ ...good, patch: good.patch + "-  status: 'error',\n+  status: 'info',\n" }).some((x) => /status/.test(x)));
});
test('empty diff', () => {
  assert.deepEqual(checkFixDiff({ numstat: '', patch: '' }), { ok: false, problems: ['no change'] });
});
test('binary numstat counts as zero lines', () => {
  assert.equal(checkFixDiff(withFile('-\t-\tagents/x/img.png')).ok, true);
});
