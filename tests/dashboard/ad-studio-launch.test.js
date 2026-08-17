import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { validateLaunch, buildAgentArgv, MAX_RENDERS_CEILING } from '../../agents/dashboard/routes/ad-studio-launch.js';

const FORMATS = [{ key: 'manifesto' }, { key: 'us-vs-them' }, { key: 'testimonial' }];
const PRODUCTS = [{ handle: 'coconut-lotion' }, { handle: 'coconut-oil-deodorant' }];
const ctx = { formats: FORMATS, manifestProducts: PRODUCTS };

const good = { product: 'coconut-lotion', formats: ['manifesto'], variations: 1, targets: 'meta', maxRenders: 120 };

test('a well-formed request is accepted and normalised', () => {
  const r = validateLaunch(good, ctx);
  assert.equal(r.ok, true);
  assert.equal(r.args.product, 'coconut-lotion');
  assert.deepEqual(r.args.formats, ['manifesto']);
  assert.equal(r.args.variant, null);
  assert.equal(r.args.dryRun, false);
});

test('an unknown product is refused', () => {
  const r = validateLaunch({ ...good, product: 'not-a-product' }, ctx);
  assert.equal(r.ok, false);
  assert.match(r.error, /product/i);
});

// The browser's format list is a convenience. The authority is here — a client that
// posts a format that does not exist must not reach a spawn.
test('an unknown format is refused and named', () => {
  const r = validateLaunch({ ...good, formats: ['manifesto', 'invented-format'] }, ctx);
  assert.equal(r.ok, false);
  assert.match(r.error, /invented-format/);
});

// The single most expensive default in the CLI, deliberately inverted in the UI: the
// cheapest action is the one you get by accident.
test('no formats is refused rather than meaning all of them', () => {
  assert.equal(validateLaunch({ ...good, formats: [] }, ctx).ok, false);
});

test('variations must be a whole number in 1..10', () => {
  assert.equal(validateLaunch({ ...good, variations: 0 }, ctx).ok, false);
  assert.equal(validateLaunch({ ...good, variations: 11 }, ctx).ok, false);
  assert.equal(validateLaunch({ ...good, variations: 2.5 }, ctx).ok, false);
  assert.equal(validateLaunch({ ...good, variations: 10 }, ctx).ok, true);
});

test('targets must be one of the two offered sets', () => {
  assert.equal(validateLaunch({ ...good, targets: 'all' }, ctx).ok, true);
  assert.equal(validateLaunch({ ...good, targets: 'demand-gen=1:1' }, ctx).ok, false);
});

// The ceiling is enforced here regardless of what the form sends. A launch button on
// a publicly reachable URL is categorically different from every other route on it.
test('maxRenders is clamped to the ceiling, never trusted upward', () => {
  assert.equal(validateLaunch({ ...good, maxRenders: 5000 }, ctx).args.maxRenders, MAX_RENDERS_CEILING);
  assert.equal(validateLaunch({ ...good, maxRenders: 6 }, ctx).args.maxRenders, 6);
  assert.equal(validateLaunch({ ...good, maxRenders: 0 }, ctx).ok, false);
});

test('a run whose expected renders exceed its own ceiling is refused before it starts', () => {
  // 3 formats x 10 variations x meta = 30 concepts x 6 = 180 expected, over a ceiling of 20.
  const r = validateLaunch(
    { ...good, formats: ['manifesto', 'us-vs-them', 'testimonial'], variations: 10, maxRenders: 20 },
    ctx,
  );
  assert.equal(r.ok, false);
  assert.match(r.error, /expected/i);
});

test('the plan carries the cost estimate the operator was shown', () => {
  const r = validateLaunch(good, ctx);
  assert.equal(r.args.plan.expected, 6);
  assert.equal(r.args.plan.expectedUsd, 0.78);
  assert.equal(r.args.plan.worstCase, 12);
});

test('a dry run is allowed with no ceiling argument at all', () => {
  const r = validateLaunch({ ...good, dryRun: true, maxRenders: undefined }, ctx);
  assert.equal(r.ok, true);
  assert.equal(r.args.dryRun, true);
});

// ── buildAgentArgv ───────────────────────────────────────────────────────────────────

test('argv is built from validated args only', () => {
  const { args } = validateLaunch({ ...good, variant: 'coconut-breeze' }, ctx);
  assert.deepEqual(buildAgentArgv(args, 'job-1'), [
    '--product', 'coconut-lotion',
    '--variant', 'coconut-breeze',
    '--formats', 'manifesto',
    '--targets', 'meta',
    '--variations', '1',
    '--max-renders', '120',
    '--job-id', 'job-1',
  ]);
});

test('a dry run passes --dry-run and no render ceiling', () => {
  const { args } = validateLaunch({ ...good, dryRun: true }, ctx);
  const argv = buildAgentArgv(args, 'job-2');
  assert.ok(argv.includes('--dry-run'));
  assert.equal(argv.includes('--max-renders'), false);
});

test('a variant is omitted entirely when there is none', () => {
  const { args } = validateLaunch(good, ctx);
  assert.equal(buildAgentArgv(args, 'job-3').includes('--variant'), false);
});
