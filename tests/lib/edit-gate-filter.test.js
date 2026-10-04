import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  partitionByEditGate, renderEditGateLines, editGateSummaryFragment, gateTargetHandle,
} from '../../lib/edit-gate-filter.js';
import { decide, planRun, editKindForItem } from '../../lib/queue-autoapply.js';
import { editGateTargetFor, PostEditGateError } from '../../lib/queue-apply.js';

const HELD = { allowed: false, reason: 'page frozen until 2026-11-01: SLS revert', until: '2026-11-01T00:00:00.000Z' };
const OK = { allowed: true, reason: 'no freeze, no cooldown' };

describe('partitionByEditGate', () => {
  test('a held item is moved out, an allowed one kept, order preserved', () => {
    const gate = (t) => (t === 'b' ? HELD : OK);
    const { kept, held } = partitionByEditGate(['a', 'b', 'c'], { kind: 'rewrite', mayEdit: gate, targetOf: (s) => s });
    assert.deepEqual(kept, ['a', 'c']);
    assert.equal(held.length, 1);
    assert.equal(held[0].target, 'b');
    assert.equal(held[0].kind, 'rewrite');
    assert.equal(held[0].until, HELD.until);
  });

  test('the kind is passed through to the gate', () => {
    const seen = [];
    partitionByEditGate(['a'], { kind: 'serp', mayEdit: (t, k) => { seen.push(k); return OK; }, targetOf: (s) => s });
    assert.deepEqual(seen, ['serp']);
  });

  test('an item with no resolvable page is kept and the gate is not asked', () => {
    let asked = 0;
    const { kept } = partitionByEditGate([{ x: 1 }], { kind: 'enhance', mayEdit: () => { asked++; return HELD; }, targetOf: () => null });
    assert.equal(kept.length, 1);
    assert.equal(asked, 0);
  });

  test('no gate injected means nothing is withheld (callers that only rank)', () => {
    const { kept, held } = partitionByEditGate(['a', 'b'], { kind: 'rewrite', mayEdit: null, targetOf: (s) => s });
    assert.deepEqual(kept, ['a', 'b']);
    assert.equal(held.length, 0);
  });

  test('filtering BEFORE a cap: held pages do not eat the slots', () => {
    const gate = (t) => (t.startsWith('frozen') ? HELD : OK);
    const pool = ['frozen-1', 'frozen-2', 'frozen-3', 'live-1', 'live-2'];
    const { kept } = partitionByEditGate(pool, { kind: 'rewrite', mayEdit: gate, targetOf: (s) => s });
    assert.deepEqual(kept.slice(0, 2), ['live-1', 'live-2']);
  });
});

describe('rendering', () => {
  test('lines name each page once, with kind and reason; empty when nothing held', () => {
    assert.deepEqual(renderEditGateLines([]), []);
    const lines = renderEditGateLines([
      { target: 'https://www.realskincare.com/blogs/news/sls', kind: 'serp', reason: 'r1' },
      { target: 'sls', kind: 'serp', reason: 'r1' },
      { target: 'other', kind: 'rewrite', reason: 'r2' },
    ]);
    assert.equal(lines[0], 'Edit gate held 2 page(s):');
    assert.ok(lines.some((l) => l.includes('sls (serp) — r1')));
    assert.ok(lines.some((l) => l.includes('other (rewrite) — r2')));
  });

  test('summary fragment', () => {
    assert.equal(editGateSummaryFragment([]), '');
    assert.equal(editGateSummaryFragment([{ target: 'a' }, { target: 'a' }, { target: 'b' }]), ' · edit gate held 2');
  });

  test('gateTargetHandle takes the last path segment of a URL', () => {
    assert.equal(gateTargetHandle('https://www.realskincare.com/blogs/news/x-y?z=1'), 'x-y');
    assert.equal(gateTargetHandle('x-y'), 'x-y');
  });
});

describe('queue-autoapply: edit gate as planner DATA', () => {
  const item = (slug, trigger = 'flop-refresh', created_at = '2026-09-01') => ({ slug, trigger, status: 'pending', created_at });

  test('editKindForItem: refreshes are rewrites, low-ctr-meta included (it ships a body)', () => {
    for (const t of ['quick-win', 'flop-refresh', 'legacy-flop', 'low-ctr-meta']) assert.equal(editKindForItem({ trigger: t }), 'rewrite');
    assert.equal(editKindForItem({ trigger: 'page-meta-rewrite' }), null, 'a Shopify PAGE, not an article');
    assert.equal(editKindForItem({ trigger: 'collection-gap' }), null);
    assert.equal(editKindForItem({ trigger: 'seo-opportunity' }, { opportunityAgent: 'refresh-runner' }), 'rewrite');
    assert.equal(editKindForItem({ trigger: 'seo-opportunity' }, { opportunityAgent: 'collection-content-optimizer' }), null);
  });

  test('a held item is a SKIP (left pending), never a dismiss, and carries no human-decision label', () => {
    const d = decide(item('sls'), { editGate: new Map([['sls', { ...HELD, kind: 'rewrite' }]]) });
    assert.equal(d.action, 'skip');
    assert.equal(d.gate, 'edit-gate');
    assert.equal(d.decision, undefined, 'it clears on its own; not a decision for Sean');
    assert.match(d.reason, /frozen/);
  });

  test('an allowed verdict, or no verdict, changes nothing', () => {
    assert.equal(decide(item('a'), { editGate: new Map([['a', OK]]) }).action, 'apply');
    assert.equal(decide(item('a')).action, 'apply');
  });

  test('held items are filtered BEFORE the per-run cap', () => {
    const items = [item('f1', 'flop-refresh', '2026-01-01'), item('f2', 'flop-refresh', '2026-01-02'), item('ok1'), item('ok2')];
    const editGate = new Map([['f1', HELD], ['f2', HELD]]);
    const plan = planRun(items, { editGate }, { cap: 2 });
    assert.deepEqual(plan.apply.map((d) => d.item.slug), ['ok1', 'ok2']);
    assert.equal(plan.skip.filter((s) => s.gate === 'edit-gate').length, 2);
    assert.equal(plan.decisions.length, 0);
  });
});

describe('queue-apply: target and typed refusal', () => {
  test('editGateTargetFor prefers the declared article handle over the dir slug', () => {
    assert.equal(editGateTargetFor({ slug: 'toothpaste-without-sls', shopify_handle: 'toothpaste-without-sls-what-to-know-best-options' }, 'x'),
      'toothpaste-without-sls-what-to-know-best-options');
    assert.equal(editGateTargetFor({ shopify_url: 'https://x.com/blogs/news/h-1' }, 'x'), 'h-1');
    assert.equal(editGateTargetFor(null, 'fallback'), 'fallback');
  });

  test('PostEditGateError is typed and names target, kind and reason', () => {
    const e = new PostEditGateError('sls', 'rewrite', HELD);
    assert.ok(e instanceof Error);
    assert.equal(e.editGateHold, true);
    assert.equal(e.kind, 'rewrite');
    assert.equal(e.until, HELD.until);
    assert.match(e.message, /Left pending/);
  });
});
