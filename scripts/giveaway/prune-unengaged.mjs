#!/usr/bin/env node
/**
 * Suppress the unengaged remainder of the giveaway entrant list.
 *
 *   node scripts/giveaway/prune-unengaged.mjs                   # report
 *   node scripts/giveaway/prune-unengaged.mjs --limit 1 --apply  # canary ONE
 *   node scripts/giveaway/prune-unengaged.mjs --apply            # all of them
 *
 * WHY. Klaviyo bills on ACTIVE profiles and suppressed ones do not count. Measured
 * on this list: 7,135 entrants produced exactly ONE order, ever — verified twice,
 * once through Klaviyo's Placed Order event stream and once independently against
 * Shopify's own orders. The draw-day offer send returned 0.31% CTR and a 4.32%
 * unsubscribe rate. The unengaged half of this list costs money and returns none.
 *
 * THESE ARE REAL PEOPLE, unlike the §5 bot cohort — they entered legitimately and
 * simply never opened anything. So the plan is computed by the pure `planPrune`,
 * which protects purchasers, the winner and alternates, and the engaged, and which
 * REFUSES outright if the engaged set looks collapsed or the prune would take an
 * implausible share. Suppression is invisible in practice, so the guards are
 * arithmetic rather than care at the keyboard.
 *
 * Reversible: suppression can be undone per profile, and the run record lists
 * every address so the set is reconstructable.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { klaviyoRequest } from '../../lib/klaviyo.js';
import { planPrune } from '../../lib/giveaway/audience-prune.js';
import { verificationSample, submitSuppressionJobs } from '../../lib/giveaway/suppression.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const config = JSON.parse(readFileSync(join(ROOT, 'config', 'giveaway.json'), 'utf8'));
const APPLY = process.argv.includes('--apply');
const limitArg = process.argv.indexOf('--limit');
const LIMIT = limitArg === -1 ? null : Number(process.argv[limitArg + 1]);
const ENGAGED_FLOOR = 1000;
const PLACED_ORDER_METRIC = 'V69ueg';
const OUT = join(ROOT, 'data', 'reports', 'giveaway-prune');

const pageAll = async (start, onItem) => {
  let url = start;
  for (let g = 0; url && g < 600; g += 1) {
    const d = await klaviyoRequest('GET', url);
    for (const item of d.data || []) onItem(item);
    const nx = d.links?.next;
    url = nx ? nx.replace(/^https:\/\/[^/]+\/api/, '') : null;
  }
};

// ---- the list, with suppression state read in the same pass ----
const listEmails = []; const suppressedEmails = [];
await pageAll(
  `/lists/${config.listId}/profiles/?additional-fields%5Bprofile%5D=subscriptions&page%5Bsize%5D=100`,
  (p) => {
    const email = String(p.attributes?.email || '').toLowerCase();
    if (!email) return;
    listEmails.push(email);
    const s = p.attributes?.subscriptions?.email?.marketing?.suppression ?? [];
    if (Array.isArray(s) ? s.length : Boolean(s)) suppressedEmails.push(email);
  },
);
console.log(`list ${config.listId}: ${listEmails.length} profiles · ${suppressedEmails.length} already suppressed`);

// ---- the engaged segment ----
const engagedEmails = [];
await pageAll(
  `/segments/${config.offerEngagedSegmentId}/profiles/?fields%5Bprofile%5D=email&page%5Bsize%5D=100`,
  (p) => { const e = String(p.attributes?.email || '').toLowerCase(); if (e) engagedEmails.push(e); },
);
console.log(`engaged segment ${config.offerEngagedSegmentId}: ${engagedEmails.length}`);

// ---- anyone who has ever placed an order (profile ids → emails) ----
const buyerIds = new Set();
await pageAll(
  `/events/?filter=${encodeURIComponent(`equals(metric_id,"${PLACED_ORDER_METRIC}")`)}&fields%5Bevent%5D=datetime&page%5Bsize%5D=500`,
  (ev) => { const id = ev.relationships?.profile?.data?.id; if (id) buyerIds.add(id); },
);
const purchaserEmails = [];
const ids = [...buyerIds];
for (let i = 0; i < ids.length; i += 100) {
  const chunk = ids.slice(i, i + 100);
  const f = encodeURIComponent(`any(id,["${chunk.join('","')}"])`);
  const d = await klaviyoRequest('GET', `/profiles/?filter=${f}&fields%5Bprofile%5D=email&page%5Bsize%5D=100`);
  for (const p of d.data || []) {
    const e = String(p.attributes?.email || '').toLowerCase();
    if (e) purchaserEmails.push(e);
  }
}
console.log(`ever placed an order: ${buyerIds.size} event profiles → ${purchaserEmails.length} resolved emails`);

// ---- the winner and every alternate ----
const result = JSON.parse(readFileSync(join(ROOT, 'data', 'giveaway', 'draw-result.json'), 'utf8'));
const protectedEmails = [result.winner, ...(result.ordering || []).slice(0, 25)]
  .filter(Boolean).map((e) => String(e).toLowerCase());
console.log(`protected (winner + alternates): ${new Set(protectedEmails).size}`);

const plan = planPrune({
  listEmails, engagedEmails, purchaserEmails, protectedEmails, suppressedEmails,
  engagedFloor: ENGAGED_FLOOR,
});

console.log('\n=== plan ===');
console.log(`  list ${plan.listSize} · engaged ${plan.engagedSize}`);
console.log(`  kept: engaged ${plan.kept.engaged} · purchasers ${plan.kept.purchasers} · winner/alternates ${plan.kept.protected}`);
console.log(`  already suppressed: ${plan.alreadySuppressed}`);
console.log(`  TO SUPPRESS: ${plan.toSuppress.length} (${(plan.share * 100).toFixed(1)}% of the list)`);

const emails = LIMIT ? plan.toSuppress.slice(0, LIMIT) : plan.toSuppress;
if (LIMIT) console.log(`  --limit ${LIMIT} → acting on ${emails.length}`);

if (!emails.length) { console.log('\n✓ nothing to do'); process.exit(0); }
if (!APPLY) { console.log('\nDry run — pass --apply to suppress.'); process.exit(0); }

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
mkdirSync(OUT, { recursive: true });
const recordPath = join(OUT, `prune-${stamp}.json`);
writeFileSync(recordPath, `${JSON.stringify({
  ranAt: new Date().toISOString(), engagedSegmentId: config.offerEngagedSegmentId,
  engagedFloor: ENGAGED_FLOOR, plan: { ...plan, toSuppress: emails },
}, null, 2)}\n`);
console.log(`\nrun record (the set is reconstructable from this): ${recordPath}`);

// Submit AND poll. Firing the job and walking away hides partial failure: the
// first real run of this accepted 1,402 addresses and ~8% silently never took.
const jobs = await submitSuppressionJobs({
  emails,
  deps: { request: klaviyoRequest, sleep: (ms) => new Promise((r) => setTimeout(r, ms)), log: (m) => console.log(m) },
});
console.log(`\nsubmitted ${jobs.submitted} in ${jobs.batches} batch(es) · completed ${jobs.completed} · SKIPPED ${jobs.skipped}`);
if (jobs.skipped) console.error(`!! Klaviyo SKIPPED ${jobs.skipped} — re-run to sweep them`);
if (jobs.incomplete) console.error(`!! ${jobs.incomplete} job(s) did not reach complete`);
if (jobs.unpollable) console.error(`!! ${jobs.unpollable} address(es) were in batches with no job id — unverifiable`);

// Async job: a 2xx says queued, not suppressed. Sample SPREAD across the batches.
console.log('\nqueued — waiting before verifying');
await new Promise((r) => setTimeout(r, 30000));
const sample = verificationSample(emails, 25);
let yes = 0; let no = 0; let unknown = 0;
for (const email of sample) {
  const f = encodeURIComponent(`equals(email,"${email}")`);
  try {
    const d = await klaviyoRequest('GET', `/profiles/?filter=${f}&additional-fields%5Bprofile%5D=subscriptions`);
    const m = d.data?.[0]?.attributes?.subscriptions?.email?.marketing ?? null;
    if (!m) { unknown += 1; continue; }
    const s = m.suppression ?? [];
    if (Array.isArray(s) ? s.length > 0 : Boolean(s)) yes += 1; else no += 1;
  } catch { unknown += 1; }
}
console.log(`verified sample of ${sample.length}: suppressed ${yes} · not ${no} · unreadable ${unknown}`);
if (no || unknown) {
  console.error('!! not all sampled are suppressed — the jobs are async; re-check in a few minutes');
  process.exitCode = 1;
} else {
  console.log(`✓ ${emails.length} suppressed — they leave the billable active-profile count`);
}
