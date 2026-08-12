#!/usr/bin/env node
/**
 * End-to-end verification of every entry-earning method.
 *
 *   node scripts/giveaway/e2e-verify.mjs <phase> --run <id> --email you@gmail.com
 *
 * Phases, in this order:
 *   preflight  endpoint reachable, DNS resolves from HERE, config sane
 *   seed       create A-E via the real POST /enter
 *   positive   A: survey -> 4, instagram -> 7, upload -> 17
 *   negative   the twelve must-not-credit cases
 *   ---- human clicks the confirmation emails for A and B only ----
 *   reconcile  run the reconciler, assert A=24 B=3 C=D=E=1
 *   limits     rate-limit boundaries            RUN LAST
 *   exclusion  the report must not count test profiles
 *   cleanup    delete every gv_test profile and verify they are gone
 *   status     show current totals without changing anything
 *
 * This creates REAL profiles on the PRODUCTION list. Cleanup is not optional;
 * Gate A refuses launch while any gv_test profile remains.
 *
 * RATE LIMITER: POST /enter allows 5 per IP per hour and `seed` spends exactly
 * all five, so `negative` (which re-enters A) and `limits` (which needs a fresh
 * budget) each REQUIRE a PM2 restart first — the limiter is an in-memory map
 * that resets on restart. The runbook spells out where. Every phase that
 * depends on this says so when it sees a 429.
 *
 * Never weaken an assertion to make this pass. Its only value is failing.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lookup } from 'node:dns/promises';
import { buildIdentities, isTestProfile } from '../../lib/giveaway/test-identity.js';
import { getProfileByEmail, updateProfileProperties } from '../../lib/klaviyo-profiles.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const config = JSON.parse(readFileSync(join(ROOT, 'config', 'giveaway.json'), 'utf8'));
const HOST = 'https://entries.realskincare.com';
const API = `${HOST}/api/giveaway`;
const RESTART = "ssh root@137.184.119.230 'pm2 restart seo-dashboard'";

const argv = process.argv.slice(2);
const phase = argv[0];
const arg = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};
const runId = arg('run');
const baseEmail = arg('email');

if (!phase) { console.error('usage: e2e-verify.mjs <phase> --run <id> --email you@gmail.com'); process.exit(2); }
if (!runId) { console.error('--run <id> is required so identities and cleanup are scoped to one run'); process.exit(2); }
if (phase !== 'cleanup' && phase !== 'status' && !baseEmail) {
  console.error('--email you@gmail.com is required (aliases are built from it)'); process.exit(2);
}

const ids = baseEmail ? buildIdentities(runId, baseEmail) : null;
const results = [];
let failed = 0;
function assert(ok, label, detail = '') {
  if (!ok) failed += 1;
  results.push({ ok: !!ok, label, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
}
const post = async (path, body) => {
  const res = await fetch(`${API}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON body */ }
  return { status: res.status, json };
};
const entriesOf = async (email) => {
  const p = await getProfileByEmail(email);
  return { entries: p?.properties?.gv_entries ?? null, breakdown: p?.properties?.gv_breakdown ?? null, props: p?.properties ?? null };
};
// A 1x1 PNG, the smallest valid image the upload path will accept.
const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Klaviyo's profile-search index lags a subscribe by a second or two, so a
 * marker write immediately after POST /enter can 404 on a profile that plainly
 * exists. Retry rather than let a timing artefact read as a real failure.
 */
async function withRetry(fn, { attempts = 5, waitMs = 1500 } = {}) {
  let last;
  for (let i = 0; i < attempts; i += 1) {
    try { return await fn(); } catch (e) { last = e; await sleep(waitMs); }
  }
  throw last;
}

/**
 * Mark a profile as a test identity.
 *
 * Written STRAIGHT TO KLAVIYO, never through POST /answers, for two reasons the
 * endpoint makes unavoidable:
 *   1. /answers passes its body through answerProperties(), which whitelists the
 *      survey enums and silently drops everything else — gv_test would never be
 *      stored, and the marker is the whole basis of the prize-safety argument.
 *   2. /answers hardcodes `survey: true`, so using it to mark a profile would
 *      credit the +3 survey rung to all five identities and put C, D and E at 4
 *      entries instead of the 1 they must hold for the negative cases to mean
 *      anything.
 * That the endpoint refuses a client-supplied gv_test is correct: a request that
 * could mark itself could also un-mark a real entrant out of the draw.
 */
const markTestProfile = (email, properties) =>
  withRetry(() => updateProfileProperties(email, properties));

async function preflight() {
  try {
    const { address } = await lookup('entries.realskincare.com');
    assert(true, 'entries.realskincare.com resolves from this machine', address);
  } catch (e) {
    assert(false, 'entries.realskincare.com resolves from this machine',
      `${e.code} — a resolver holding the NXDOMAIN cached before the record existed will report this. Test from the server or wait for the cache to expire; it is NOT a broken endpoint.`);
  }
  const res = await fetch(`${API}/entries?email=not-an-email`).catch((e) => ({ status: 0, err: e.message }));
  assert(res.status === 400, 'the endpoint answers without auth', `got ${res.status}${res.status === 401 ? ' — the dashboard has not been deployed with routes/giveaway.js yet' : ''}`);
  assert(!!config.listId, 'config.listId is set', config.listId || '');
  assert(!!config.metaPixelId, 'config.metaPixelId is set', config.metaPixelId || '');
}

async function seed() {
  for (const id of Object.values(ids)) {
    const body = { email: id.email, firstName: id.firstName };
    if (id.referredBy) body.referredBy = id.referredBy;
    const { status, json } = await post('/enter', body);
    assert(status === 201, `${id.key.toUpperCase()} entered`,
      `status ${status}${status === 429 ? ` — /enter allows 5 per IP per hour and this run has spent them. Restart to clear: ${RESTART}` : ''}`);
    assert(json?.entries === 1, `${id.key.toUpperCase()} starts at exactly 1 entry`, `got ${json?.entries}`);
    // The marker is what keeps this profile out of the report and the draw.
    try {
      await markTestProfile(id.email, id.properties);
    } catch (e) {
      assert(false, `${id.key.toUpperCase()} could be marked`, e.message);
    }
    const { props } = await entriesOf(id.email);
    assert(isTestProfile(props), `${id.key.toUpperCase()} carries the gv_test marker`);
    assert(props?.gv_entries === 1, `${id.key.toUpperCase()} is still at 1 after marking — marking must not credit a rung`, `got ${props?.gv_entries}`);
  }
  console.log(`\nNOW RESET THE LIMITER before the negative phase — seed spent all 5 /enter slots:\n  ${RESTART}`);
}

async function positive() {
  const a = ids.a;
  let cur = await entriesOf(a.email);
  assert(cur.entries === 1, 'A begins the positive phase at 1', `got ${cur.entries}`);

  await post('/answers', { email: a.email, household: 'solo', frustration: 'fragrance', currentBrand: 'cerave' });
  cur = await entriesOf(a.email);
  assert(cur.entries === 4, 'survey credits +3', `got ${cur.entries}`);
  assert(cur.props?.gv_frustration === 'fragrance', 'the survey answer is stored as a TOP-LEVEL property the flow can filter on');

  await post('/answers', { email: a.email, instagram: true, igHandle: '@gvtest' });
  cur = await entriesOf(a.email);
  assert(cur.entries === 7, 'Instagram credits +3', `got ${cur.entries}`);

  const up = await post('/upload', { email: a.email, filename: 'a.png', dataBase64: TINY_PNG, rightsGranted: true });
  assert(up.status === 200, 'upload accepted with rights granted', `status ${up.status}`);
  cur = await entriesOf(a.email);
  assert(cur.entries === 17, 'upload credits +10', `got ${cur.entries}`);
  assert(typeof cur.props?.gv_upload_url === 'string', 'the uploaded asset URL is recorded');
}

async function negative() {
  const a = ids.a;
  const before = await entriesOf(a.email);

  // 1. Self-referral: the ENTRY must still succeed. Losing a paid entry over a
  //    bad optional field would be the more expensive failure.
  const d = await entriesOf(ids.d.email);
  assert(d.entries === 1, 'D (self-referral) still holds its base entry', `got ${d.entries}`);
  assert(!d.props?.gv_referred_by, 'D has no referrer stored — self-referral was dropped, not honoured');

  // 2. An unknown referrer is STORED by the endpoint but must earn nobody
  //    anything — refusing it is the reconciler's job, asserted in `reconcile`.
  //
  //    The other endpoint-level guard, "an Instagram claim with no handle
  //    credits nothing", is deliberately NOT retested here: it can only be
  //    probed against A, whose instagram rung is already true after `positive`,
  //    so the assertion could not fail and would be theatre. It is covered
  //    where it can actually fail — tests/dashboard/giveaway-routes.test.js.
  const e = await entriesOf(ids.e.email);
  assert(e.props?.gv_referred_by?.includes('never-entered'), 'E stored a referrer that never entered — the reconciler, not the endpoint, must refuse it');

  // 4-6. A client may declare WHICH action it performed, never what it is worth.
  await post('/answers', { email: a.email, gv_entries: 9999 });
  assert((await entriesOf(a.email)).entries === before.entries, 'a client-supplied gv_entries is ignored');
  await post('/answers', { email: a.email, confirmed: true });
  assert((await entriesOf(a.email)).breakdown?.confirmed === false, 'a request cannot set breakdown.confirmed');
  await post('/answers', { email: a.email, referrals: 50 });
  assert((await entriesOf(a.email)).breakdown?.referrals === 0, 'a request cannot set referral credits');

  // 7. Unknown enum values are dropped, not stored.
  await post('/answers', { email: a.email, household: 'martian' });
  assert((await entriesOf(a.email)).props?.gv_household === 'solo', 'an unknown enum value is dropped and the real one survives');

  // 8-10. Upload guards.
  const noRights = await post('/upload', { email: a.email, filename: 'x.png', dataBase64: TINY_PNG, rightsGranted: false });
  assert(noRights.status === 400, 'upload without granted rights is rejected', `status ${noRights.status}`);
  const badExt = await post('/upload', { email: a.email, filename: 'x.svg', dataBase64: TINY_PNG, rightsGranted: true });
  assert(badExt.status === 400, 'a non-image extension is rejected', `status ${badExt.status}`);
  const huge = await post('/upload', { email: a.email, filename: 'big.png', dataBase64: 'A'.repeat(9 * 1024 * 1024), rightsGranted: true });
  assert(huge.status === 400 || huge.status === 413, 'an oversized upload is rejected', `status ${huge.status}`);

  // 11. A repeat entry must not reset earned progress.
  const reEnter = await post('/enter', { email: a.email, firstName: 'Test A' });
  assert(reEnter.status === 201, 'a repeat entry is accepted',
    `status ${reEnter.status}${reEnter.status === 429 ? ` — seed spent all 5 /enter slots for this IP. This case did NOT run. Restart and re-run this phase: ${RESTART}` : ''}`);
  const after = await entriesOf(a.email);
  assert(after.entries === before.entries, 'a repeat entry does NOT reset progress', `${before.entries} -> ${after.entries}`);
  assert(after.breakdown?.survey === true, 'the survey rung survives a repeat entry');
  assert(after.breakdown?.upload === true, 'the upload rung survives a repeat entry');

  // 12. Purchases can never earn entries — assert the absence structurally.
  //
  // Comments are stripped BEFORE the search. Against the raw file this assertion
  // is a guaranteed false failure: routes/giveaway.js carries the prose "the
  // ORDER of the two side effects", which /order/i matches. The `[^:]` guard on
  // the line-comment rule keeps `https://` intact so stripping cannot instead
  // swallow real code and turn this into a false PASS.
  const routes = readFileSync(join(ROOT, 'agents', 'dashboard', 'routes', 'giveaway.js'), 'utf8');
  const code = routes.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');
  assert(code.includes('/api/giveaway/enter'), 'the comment-stripped source still contains the real routes (the strip did not eat the file)');
  assert(!/order|checkout|purchase|webhook/i.test(code), 'no purchase, order or webhook path exists in the giveaway routes');
}

const PHASES = { preflight, seed, positive, negative };

const fn = PHASES[phase];
if (!fn) {
  console.error(`unknown phase '${phase}'. one of: ${Object.keys(PHASES).join(', ')}`);
  process.exit(2);
}
console.log(`\n=== phase: ${phase}  run: ${runId} ===\n`);
await fn();

const OUT = join(ROOT, 'data', 'reports', 'giveaway');
mkdirSync(OUT, { recursive: true });
const artifactPath = join(OUT, `e2e-${runId}.json`);
let artifact = { runId, phases: {} };
try { artifact = JSON.parse(readFileSync(artifactPath, 'utf8')); } catch { /* first phase */ }
artifact.phases[phase] = { failed, results };
writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`);

console.log(`\n${results.length - failed}/${results.length} assertions passed`);
if (failed) { console.error(`${failed} FAILED — do not launch.`); process.exit(1); }
