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
 * ---------------------------------------------------------------------------
 * PICK THE BASE INBOX CAREFULLY. IT GETS BURNED. (learned the hard way, 2026-08-12)
 * ---------------------------------------------------------------------------
 * Seeding five plus-aliases of ONE inbox against the production list tripped
 * Klaviyo's anti-abuse handling. It reads as list-bombing, because that is what
 * list-bombing looks like. The consequences were permanent for that inbox:
 *
 *   - every NEW alias of that root is now stamped USER_SUPPRESSED the instant it
 *     subscribes — verified with a fresh alias sent ALONE after 90s of quiet,
 *     while a different domain in the same run was untouched
 *   - a suppressed address will never be sent a confirmation again
 *   - a profile already sitting in the pending state is not sent a second
 *     confirmation either, so re-subscribing cannot rescue a botched run
 *
 * So: the run is not retryable on the same inbox, and --run <newid> does NOT
 * help, because the suppression follows the ROOT address, not the alias.
 *
 * PACING DOES NOT PREVENT IT. The 2026-08-12 r3 run seeded 150s apart and C, D
 * and E were suppressed anyway while A and B stayed clean — the trigger is the
 * COUNT of plus-aliases per root, roughly the third onward, not the rate.
 *
 * What makes the run survivable is the ORDER below: A and B are seeded FIRST and
 * are the only two that ever need to receive mail. By the time the detector
 * trips it is hitting C, D and E, which must never confirm anyway — suppressed
 * is exactly the state they are supposed to end in. DO NOT REORDER.
 *
 * Klaviyo account sending was NOT harmed — real customer flows kept delivering
 * throughout. The damage is scoped to the base inbox you choose here.
 *
 * Use an inbox you are willing to lose, never the operator's main address, and
 * never one a real customer or the support desk relies on.
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
import { execFileSync } from 'node:child_process';
import { buildIdentities, isTestProfile, TEST_MARKER } from '../../lib/giveaway/test-identity.js';
import {
  getProfileByEmail, listProfilesWithConsent, updateProfileProperties,
} from '../../lib/klaviyo-profiles.js';
import { klaviyoRequest } from '../../lib/klaviyo.js';
import { summarizeEntrants } from '../../lib/giveaway/summarize.js';

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

/**
 * Seed the five identities, PACED.
 *
 * The first version fired all five subscribes inside one second. Klaviyo's
 * anti-abuse handling suppressed the last three outright (`USER_SUPPRESSED`,
 * stamped the same second the profile was created) and silently dropped the
 * opt-in emails for the first two. Verified against the account's suppression
 * list on 2026-08-12: livecheck subscribed alone at 5:47 got its email; A-E
 * subscribed together at 5:48 got nothing and C/D/E were suppressed.
 *
 * A suppressed alias is BURNED — Klaviyo will not send it a confirmation again,
 * and a profile already sitting in the pending state will not be sent a second
 * one either, so a re-subscribe cannot rescue a botched run. Use a new --run id.
 *
 * --delay controls the gap. Do not set it to 0 outside a dry run.
 */
async function seed() {
  const delayMs = Number(arg('delay', '150')) * 1000;
  const list = Object.values(ids);
  for (const [i, id] of list.entries()) {
    if (i > 0) {
      console.log(`  …waiting ${delayMs / 1000}s before ${id.key.toUpperCase()} (Klaviyo suppresses bursts)`);
      await sleep(delayMs);
    }
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

async function reconcile() {
  // The reconciler is the ONLY writer of the confirm and referral rungs, and it
  // reads Klaviyo's confirmed set. It deliberately does NOT skip gv_test
  // profiles — excluding them there would make this phase unable to verify the
  // two rungs it exists to verify.
  console.log('running the reconciler…');
  const out = execFileSync('node', [join(ROOT, 'scripts', 'giveaway', 'reconcile-referrals.mjs'), '--apply'], { encoding: 'utf8' });
  console.log(out.trim());

  for (const id of Object.values(ids)) {
    const { entries, breakdown } = await entriesOf(id.email);
    assert(entries === id.expected, `${id.key.toUpperCase()} totals ${id.expected}`, `got ${entries}`);
    assert(
      breakdown?.confirmed === id.confirms,
      `${id.key.toUpperCase()} confirmed === ${id.confirms}`,
      `got ${breakdown?.confirmed}`,
    );
  }

  const a = await entriesOf(ids.a.email);
  assert(a.breakdown?.referrals === 1, 'A was credited for exactly ONE referral — B confirmed, C did not', `got ${a.breakdown?.referrals}`);
  const d = await entriesOf(ids.d.email);
  assert((d.breakdown?.referrals ?? 0) === 0, 'D earned nothing from naming itself');
  const e = await entriesOf(ids.e.email);
  assert((e.breakdown?.referrals ?? 0) === 0, 'E earned nothing from naming a non-entrant');
}

async function limits() {
  // MUST run last, and MUST run on a FRESH limiter — restart PM2 immediately
  // before this phase as well as after. The budgets are per-IP and this harness
  // is one IP, so `seed` (5 /enter) and `positive`+`negative` (10 mutations)
  // have already spent part of both budgets; without a restart the boundary
  // assertions below measure the leftovers, not the limits.
  const burn = (n, path, bodyFor) => (async () => {
    const seen = [];
    for (let i = 0; i < n; i += 1) seen.push((await post(path, bodyFor(i))).status);
    return seen;
  })();

  const limEmail = (i) => ids.a.email.replace('@', `+lim${i}@`);
  const enterStatuses = await burn(7, '/enter', (i) => ({ email: limEmail(i), firstName: 'Lim' }));
  assert(enterStatuses.slice(0, 5).every((s) => s === 201), '/enter accepts the first 5 from one IP',
    `${enterStatuses.join(',')}${enterStatuses[0] === 429 ? ` — the limiter was NOT fresh; restart and re-run: ${RESTART}` : ''}`);
  assert(enterStatuses[5] === 429, '/enter 429s on the 6th', `got ${enterStatuses[5]}`);

  // Those first five calls created five REAL profiles on the production list.
  // They carry gv_entrant and nothing else, so without a marker they are
  // indistinguishable from genuine entrants: cleanup would not find them, Gate A
  // would not flag them, and they would sit in the draw pool holding a live
  // chance at a $536.40 prize. Mark them before asserting anything else.
  let marked = 0;
  for (let i = 0; i < 5; i += 1) {
    if (enterStatuses[i] !== 201) continue;
    try {
      await markTestProfile(limEmail(i), { [TEST_MARKER]: true, gv_test_run: runId });
      marked += 1;
    } catch (err) {
      console.error(`  COULD NOT MARK ${limEmail(i)}: ${err.message}`);
    }
  }
  const created = enterStatuses.slice(0, 5).filter((s) => s === 201).length;
  assert(marked === created, 'every profile this phase created is marked gv_test and so is cleanable',
    `marked ${marked} of ${created} — an unmarked profile is a live entrant in the draw pool; mark or delete it by hand before launch`);

  const mutateStatuses = await burn(32, '/answers', () => ({ email: ids.a.email, survey: true }));
  const firstRefusal = mutateStatuses.indexOf(429);
  assert(firstRefusal === 30, 'the mutation budget 429s on the 31st', `first 429 at index ${firstRefusal}`);

  console.log('\nNOW RESET THE LIMITER before any further phase:');
  console.log(`  ${RESTART}`);
}

async function exclusion() {
  const members = await listProfilesWithConsent(config.listId);
  const testCount = members.filter((p) => isTestProfile(p.properties)).length;
  assert(testCount > 0, 'there are test profiles on the list to exclude', `found ${testCount}`);
  const s = summarizeEntrants(members);
  assert(s.excludedTestProfiles === testCount, 'the report excludes every test profile', `excluded ${s.excludedTestProfiles} of ${testCount}`);
  assert(s.total === members.length - testCount, 'and its total counts only real entrants', `${s.total} of ${members.length}`);
}

async function cleanup() {
  // Deletion is asynchronous in Klaviyo. This asserts the request was accepted,
  // then re-enumerates so a silent failure cannot pass as success.
  const members = await listProfilesWithConsent(config.listId);
  const testProfiles = members.filter((p) => isTestProfile(p.properties));
  console.log(`${testProfiles.length} test profile(s) to delete`);
  for (const p of testProfiles) {
    await klaviyoRequest('POST', '/data-privacy-deletion-jobs/', {
      data: { type: 'data-privacy-deletion-job', attributes: { profile: { data: { type: 'profile', attributes: { email: p.email } } } } },
    });
    console.log(`  deletion requested: ${p.email}`);
  }
  console.log('\nDeletion is asynchronous. Re-run `status` in a few minutes, and confirm Gate A');
  console.log('reports `no gv_test profiles remain` before launching.');
}

async function status() {
  const members = await listProfilesWithConsent(config.listId);
  const testProfiles = members.filter((p) => isTestProfile(p.properties));
  console.log(`list members: ${members.length}   test profiles: ${testProfiles.length}`);
  for (const p of testProfiles) {
    console.log(`  ${String(p.properties?.gv_entries ?? '?').padStart(3)}  ${p.email}  run=${p.properties?.gv_test_run ?? '?'}`);
  }
  assert(true, 'status read completed');
}

const PHASES = { preflight, seed, positive, negative, reconcile, limits, exclusion, cleanup, status };

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
