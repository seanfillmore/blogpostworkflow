#!/usr/bin/env node
/**
 * Point the remaining consolation sends at the ENGAGED segment.
 *
 *   node scripts/giveaway/retarget-offer-audience.mjs           # report
 *   node scripts/giveaway/retarget-offer-audience.mjs --apply   # re-point them
 *
 * WHY. The draw-day send was built with `--audience all`: the whole entrant list,
 * including the ~2,283 people who never confirmed anything. Measured, it returned
 * a healthy 25.96% open rate and then 0.31% CTR, 1.2% click-to-open, and a 4.32%
 * unsubscribe rate — 138 people left over one email. Continuing to mail everybody
 * spends store-wide domain reputation on an audience that has already answered.
 *
 * The engaged segment is `config.offerEngagedSegmentId`: on the entrant list AND
 * opened or clicked at least once. Measured 2,457 members / 1,920 mailable, which
 * matched an independent event-stream count exactly.
 *
 * THE FLOOR IS THE POINT. A freshly created Klaviyo segment reads 0 members until
 * it materialises — minutes, on this account. Re-pointing inside that window hands
 * the campaign an EMPTY audience, and it then sends to nobody at its scheduled
 * time and reports zero recipients as though that were the answer. So the
 * membership is counted first and `assertAudienceViable` refuses below the floor.
 *
 * Editing a scheduled campaign is the revert → edit → requeue cycle in
 * lib/giveaway/scheduled-campaign.js, which requeues in a `finally` — a campaign
 * left in Draft is a send that silently never happens.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { klaviyoRequest } from '../../lib/klaviyo.js';
import { withIncludedAudience, assertAudienceViable } from '../../lib/giveaway/offer-exclusion.js';
import { reviseScheduledCampaign } from '../../lib/giveaway/scheduled-campaign.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const config = JSON.parse(readFileSync(join(ROOT, 'config', 'giveaway.json'), 'utf8'));
const APPLY = process.argv.includes('--apply');
const FLOOR = 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const segmentId = config.offerEngagedSegmentId;
if (!segmentId) {
  console.error('Refusing: config/giveaway.json has no offerEngagedSegmentId.');
  process.exit(1);
}

async function segmentMemberCount(id) {
  let url = `/segments/${id}/profiles/?fields%5Bprofile%5D=email&page%5Bsize%5D=100`;
  let n = 0;
  for (let g = 0; url && g < 500; g += 1) {
    const d = await klaviyoRequest('GET', url);
    n += (d.data || []).length;
    const nx = d.links?.next;
    url = nx ? nx.replace(/^https:\/\/[^/]+\/api/, '') : null;
  }
  return n;
}

const seg = await klaviyoRequest('GET', `/segments/${segmentId}/`);
const count = await segmentMemberCount(segmentId);
console.log(`engaged segment ${segmentId} "${seg.data.attributes.name}" — ${count} members`);
assertAudienceViable(count, FLOOR);
console.log(`✓ viable (floor ${FLOOR})\n`);

let bad = 0;
for (const [file, id] of Object.entries(config.offerCampaigns || {})) {
  const before = (await klaviyoRequest('GET', `/campaigns/${id}/`)).data.attributes;
  console.log(`▸ ${file} (${id}) · ${before.status} · send ${before.send_strategy?.datetime ?? '—'}`);
  console.log(`   audiences ${JSON.stringify(before.audiences)}`);

  if (before.status === 'Sent' || before.status === 'Sending') {
    console.log('   already sent — left alone\n');
    continue;
  }

  let plan;
  try {
    plan = withIncludedAudience(before.audiences, segmentId);
  } catch (e) {
    console.error(`   ✗ refusing: ${e.message}\n`);
    bad += 1;
    continue;
  }
  if (!plan.changed) { console.log('   ✓ already targets the engaged segment\n'); continue; }
  if (!APPLY) { console.log(`   would target ${segmentId} instead\n`); continue; }

  const r = await reviseScheduledCampaign({
    id,
    plan: () => ({ audiences: plan.audiences }),
    deps: { request: klaviyoRequest, sleep, log: (m) => console.log(`  ${m}`), warn: (m) => console.error(m) },
  });
  for (const p of r.problems) { console.error(`   !! ${p}`); bad += 1; }

  const after = (await klaviyoRequest('GET', `/campaigns/${id}/`)).data.attributes;
  const ok = (after.audiences?.included || []).includes(segmentId);
  console.log(`   read-back: ${after.status} · audiences ${JSON.stringify(after.audiences)} · targets segment: ${ok}\n`);
  if (!ok) bad += 1;
}

if (!APPLY) console.log('Dry run — pass --apply to re-point.');
process.exitCode = bad ? 1 : 0;
