/**
 * Edit a SCHEDULED Klaviyo campaign without losing its send.
 *
 * Klaviyo refuses to modify a campaign that is not in Draft, so changing one that
 * is already queued is a three-step cycle: revert → edit → requeue. The danger is
 * entirely in the middle: a campaign reverted to Draft and never requeued simply
 * never sends, at its scheduled time, with nothing erroring and no row anywhere
 * saying so. For the giveaway consolation sequence that is the whole revenue event
 * of a $1,895 campaign.
 *
 * So the requeue lives in a `finally` and runs whether or not the edit succeeded,
 * and the send time is compared before and after — a requeue that lands at a
 * different instant is reported as loudly as a failure.
 *
 * Extracted when the second caller appeared (audience re-pointing beside exclusion
 * attachment). A hand-copied revert/requeue cycle is one that drifts, and the
 * direction it drifts in is "the send silently never happened".
 *
 * I/O is injected so the policy is testable without Klaviyo credentials.
 */

/**
 * @param {object} o
 * @param {string} o.id campaign id
 * @param {(attrs:object)=>object|null} o.plan given current attributes, return the
 *   attributes to PATCH, or null to make no change (no revert, no requeue).
 * @param {object} o.deps { request, sleep, log, warn }
 * @param {number} [o.pollTries]
 * @returns {Promise<{changed:boolean, ok:boolean, problems:string[], status:string|null}>}
 */
export async function reviseScheduledCampaign({ id, plan, deps, pollTries = 20 }) {
  const { request, sleep, log = () => {}, warn = () => {} } = deps;
  const problems = [];

  const get = async () => (await request('GET', `/campaigns/${id}/`)).data.attributes;
  const before = await get();
  const sendBefore = before.send_strategy?.datetime ?? null;

  const patch = plan(before);
  if (!patch) return { changed: false, ok: true, problems, status: before.status };

  // Already sent: there is nothing to edit and nothing to requeue. Attempting it
  // throws, and in an ordered sequence that strands every later campaign.
  if (before.status === 'Sent' || before.status === 'Sending') {
    problems.push(`campaign ${id} is ${before.status} — cannot be edited`);
    return { changed: false, ok: false, problems, status: before.status };
  }

  const pollUntil = async (want) => {
    let s = null;
    for (let i = 0; i < pollTries; i += 1) {
      s = (await get()).status;
      if (want(s)) return s;
      await sleep(3000);
    }
    return s;
  };

  const wasDraft = before.status === 'Draft';
  let reverted = false;
  try {
    if (!wasDraft) {
      await request('PATCH', `/campaign-send-jobs/${id}/`, {
        data: { type: 'campaign-send-job', id, attributes: { action: 'revert' } },
      });
      reverted = true;
      const s = await pollUntil((x) => x === 'Draft');
      if (s !== 'Draft') throw new Error(`revert did not reach Draft (status ${s})`);
      log(`  reverted → Draft`);
    }
    await request('PATCH', `/campaigns/${id}/`, { data: { type: 'campaign', id, attributes: patch } });
    log(`  patched ${Object.keys(patch).join(', ')}`);
  } catch (err) {
    problems.push(`edit failed: ${err.message}`);
    warn(`  ✗ edit FAILED: ${err.message}`);
  } finally {
    // Unconditional: a reverted campaign left in Draft is a send that silently
    // never happens. Requeue even when the edit failed — a campaign with its old
    // content still going out beats one that goes out never.
    if (reverted) {
      try {
        await request('POST', '/campaign-send-jobs/', { data: { type: 'campaign-send-job', attributes: { id } } });
        const s = await pollUntil((x) => x === 'Scheduled');
        log(`  requeued · status ${s}`);
        if (s !== 'Scheduled') {
          problems.push(`did not settle to Scheduled (status ${s}) — CHECK THIS CAMPAIGN BY HAND NOW`);
          warn(`  !! did not settle to Scheduled (${s}) — check by hand NOW`);
        }
      } catch (err) {
        problems.push(`REQUEUE FAILED (${err.message}) — the campaign is stuck in Draft and will NOT send`);
        warn(`  !! REQUEUE FAILED: ${err.message} — campaign is in Draft and will NOT send`);
      }
    }
  }

  const after = await get();
  const sendAfter = after.send_strategy?.datetime ?? null;
  if (sendAfter !== sendBefore) {
    problems.push(`send time CHANGED ${sendBefore} → ${sendAfter}`);
    warn(`  !! send time CHANGED ${sendBefore} → ${sendAfter}`);
  }
  return { changed: true, ok: problems.length === 0, problems, status: after.status };
}
