#!/usr/bin/env node
/**
 * Push a rebuilt email from data/brand/email-rebuild/<id>.after.html into the live
 * Klaviyo flow that serves it.
 *
 *   node scripts/klaviyo-push-flow-template.mjs TA5Wi4              # dry run
 *   node scripts/klaviyo-push-flow-template.mjs TA5Wi4 --apply
 *   node scripts/klaviyo-push-flow-template.mjs --all [--apply]
 *   node scripts/klaviyo-push-flow-template.mjs --sweep-orphans [--apply]
 *
 * WHY THIS EXISTS. The README here used to say flow emails were API-read-only and
 * every rebuild had to be pasted into the Klaviyo UI by hand. That was wrong: it was
 * concluded from three 404s on API revisions that all predate the endpoint. Flow
 * message content is writable through `PATCH /api/flow-actions/{id}` on revision
 * 2025-10-15+.
 *
 * WHAT A PUSH ACTUALLY IS. Not an update — a replacement. Klaviyo will not take raw
 * HTML on a flow action (`'body' is not a valid field for the resource 'FlowEmail'`)
 * and will not let you PATCH a flow-owned template (404, always). What it accepts is
 * `template_id`, and pointing that at a LIBRARY template makes Klaviyo snapshot it
 * into a NEW flow-owned copy. So every push mints objects and strands the previous
 * snapshot; --sweep-orphans is the other half of this tool, not an afterthought.
 *
 * ORDER IS THE SAFETY PROPERTY, and it is the same order lib/queue-apply.js uses:
 * back up the live body BEFORE the write, refuse on drift, verify through the
 * CONSUMER after, and roll back on a failed verify. A 200 on the PATCH says the flow
 * action changed; it does not say the flow now serves the content we meant.
 *
 * Exit 0 = clean. 1 = something was refused or failed. 64 = usage error.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  listFlows,
  listFlowActionsWithDefinition,
  getTemplate,

  createTemplate,
  deleteTemplate,
  updateFlowActionMessage,
  getFlowMessageTemplate,
  FLOW_ACTION_REVISION,
} from '../lib/klaviyo.js';
import {
  buildTemplateIndex,
  emailMessage,
  driftFindings,
  pushVerdict,
  findOrphans,
  strandedIds,
  resolveTarget,
  alreadyInSync,
} from '../lib/flow-template-push.js';
import { tagFindings, linkFindings, postalFindings, unsubscribeFindings } from '../lib/email-rebuild-checks.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, 'data/brand/email-rebuild');
const REPORTS = join(ROOT, 'data/reports/klaviyo-flow-push');
const KIT = JSON.parse(readFileSync(join(ROOT, 'data/brand/brand-kit.json'), 'utf8'));

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const APPLY = has('--apply');
const ALL = has('--all');
const SWEEP = has('--sweep-orphans');
const ALLOW_DRIFT = has('--allow-drift');
const ids = argv.filter((a) => !a.startsWith('--'));

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
/** A stranded template younger than this is left for the next run; see the sweep. */
const SETTLE_MS = 10 * 60 * 1000;
const log = (...a) => console.log(...a);
const fail = (m) => { console.error(`✗ ${m}`); process.exitCode = 1; };

if (!ALL && !SWEEP && ids.length === 0) {
  console.error('usage: klaviyo-push-flow-template.mjs <templateId...> | --all | --sweep-orphans  [--apply]');
  process.exit(64);
}

/** Every flow with its actions, read once — both the push and the sweep need it. */
async function loadFlows() {
  const flows = await listFlows();
  const out = [];
  for (const flow of flows) {
    out.push({ flow, actions: await listFlowActionsWithDefinition(flow.id) });
  }
  return out;
}

/**
 * fileId -> the flow message it belongs to. Written on every successful push,
 * because a push changes the template id and the FILENAME cannot follow it: the id
 * in the filename is the one that was live when the rebuild was pulled. Committed,
 * so the mapping survives a fresh checkout.
 */
const MAP_PATH = join(DIR, 'flow-map.json');
const loadMap = () => (existsSync(MAP_PATH) ? JSON.parse(readFileSync(MAP_PATH, 'utf8')) : {});
function rememberTarget(fileId, use, servingTemplateId, replacedId) {
  const map = loadMap();
  const prev = map[fileId] ?? {};
  // `stranded` is append-only and is the ONLY allowlist --sweep-orphans will delete
  // from, so a push that forgets to record what it replaced leaks a template forever —
  // which is the safe direction. Never prune this list to tidy the file.
  const stranded = [...new Set([...(prev.stranded ?? []), replacedId])]
    .filter((id) => id && id !== servingTemplateId);
  map[fileId] = {
    flowId: use.flowId,
    flowName: use.flowName,
    messageId: use.messageId,
    actionId: use.actionId,
    servingTemplateId,
    stranded,
    updatedAt: new Date().toISOString(),
  };
  // Sorted by rebuilding the object, NOT via JSON.stringify's replacer array — that
  // allowlist applies at every nesting level and would silently drop flowId/messageId.
  const sorted = Object.fromEntries(Object.keys(map).sort().map((k) => [k, map[k]]));
  writeFileSync(MAP_PATH, JSON.stringify(sorted, null, 2) + '\n');
}

function backup(templateId, html) {
  const dir = join(REPORTS, 'backups', stamp);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${templateId}.html`);
  writeFileSync(path, html);
  return path;
}

function record(name, payload) {
  mkdirSync(REPORTS, { recursive: true });
  writeFileSync(join(REPORTS, `${name}-${stamp}.json`), JSON.stringify(payload, null, 2));
}

/**
 * The pre-flight gate. Identical in substance to verify-email-rebuild.mjs — a rebuild
 * that tool would refuse to let you paste must not become one this tool pushes
 * unattended.
 */
function rebuildIsShippable(before, after) {
  const redesign = true; // these 21 have no performance baseline; see the README
  const problems = [
    ...tagFindings(before ?? after, after, { redesign }).problems,
    ...linkFindings(before ?? after, after, { redesign }).problems,
    ...postalFindings(after, KIT.postal_address).problems,
    ...unsubscribeFindings(after).problems,
  ];
  return problems;
}

async function pushOne(templateId, index) {
  const afterPath = join(DIR, `${templateId}.after.html`);
  const beforePath = join(DIR, `${templateId}.before.html`);
  if (!existsSync(afterPath)) return fail(`${templateId}: no .after.html on file`);
  const intended = readFileSync(afterPath, 'utf8');
  const before = existsSync(beforePath) ? readFileSync(beforePath, 'utf8') : null;

  const { use, via, missing, ambiguous } = resolveTarget(templateId, index, loadMap());
  if (ambiguous) {
    return fail(
      `${templateId}: used by ${ambiguous.length} flows (${ambiguous.map((u) => u.flowName).join(', ')}) — ` +
      'repointing one would silently change the others. Resolve by hand.',
    );
  }
  if (!use) {
    return fail(
      `${templateId}: no live flow points at this email (looked up by ${via}: ${missing})` +
      (via === 'message id' ? ' — the flow was rebuilt or deleted; re-map by hand' : ''),
    );
  }

  const problems = rebuildIsShippable(before, intended);
  if (problems.length) {
    fail(`${templateId}: rebuild is not shippable`);
    problems.forEach((p) => log(`    · ${p}`));
    return;
  }

  // Read the template the flow SERVES, never the one the filename names. After a push
  // those are different objects: the file keeps its original id while the flow moves to
  // a fresh snapshot, so `getTemplate(templateId)` would compare the current rebuild
  // against the stranded pre-push copy and report drift on every already-pushed email.
  const live = await getFlowMessageTemplate(use.messageId);

  // A push is NOT idempotent — it mints a library template and a fresh snapshot even
  // when the content is identical, so an unguarded `--all` re-run churns every live
  // flow and strands one template per email for no change at all.
  if (alreadyInSync(intended, live.html)) {
    log(`  ${templateId} → "${use.flowName}" — already in sync, skipping`);
    return;
  }

  const drift = driftFindings(before, live.html);
  drift.warnings.forEach((w) => log(`  ! ${templateId}: ${w}`));
  if (drift.problems.length && !ALLOW_DRIFT) {
    fail(`${templateId}: live template has drifted from .before.html — pushing would revert a UI edit`);
    drift.problems.forEach((p) => log(`    · ${p}`));
    log('    pass --allow-drift only after diffing the backup and deciding the UI edit is expendable');
    return;
  }

  log(`  ${templateId} → "${use.flowName}" [${use.flowStatus}] / ${use.messageName ?? use.messageId}`);
  log(`    live ${live.html.length}b → rebuild ${intended.length}b`);

  if (!APPLY) { log('    DRY RUN — would create a library template and repoint the flow action'); return; }

  const backupPath = backup(templateId, live.html);
  log(`    backed up live body → ${backupPath.replace(ROOT + '/', '')}`);

  // Keep the live name so the snapshot Klaviyo mints is indistinguishable in the UI.
  const created = await createTemplate({ name: live.name, html: intended });
  log(`    created library template ${created.id}`);

  await updateFlowActionMessage(use.actionId, { template_id: created.id });
  const served = await getFlowMessageTemplate(use.messageId);
  log(`    flow now serves ${served.id} (${served.html?.length ?? 0}b)`);

  const verdict = pushVerdict({ intendedHtml: intended, liveHtml: served.html, postalAddress: KIT.postal_address });
  if (!verdict.ok) {
    fail(`${templateId}: push did not verify — rolling back`);
    verdict.problems.forEach((p) => log(`    · ${p}`));
    await updateFlowActionMessage(use.actionId, { template_id: templateId });
    const restored = await getFlowMessageTemplate(use.messageId);
    log(`    rolled back — flow serves ${restored.id} (${restored.html?.length ?? 0}b)`);
    await deleteTemplate(created.id).catch(() => {});
    return;
  }

  // Refresh the snapshot from what Klaviyo actually stored. Klaviyo pretty-prints CSS
  // and strips CSS comments on save, so leaving .before.html as the file we sent makes
  // every later run report drift that is not there.
  writeFileSync(beforePath, served.html);
  rememberTarget(templateId, use, served.id, live.id);
  log(`    ✓ verified; refreshed ${templateId}.before.html, mapped → message ${use.messageId}`);

  // Drop the library intermediate. Klaviyo has already copied it into its own
  // flow-owned snapshot and rewritten template_id to point at THAT, so this object is
  // referenced by nothing the moment the push verifies. Deleted here rather than left
  // for --sweep-orphans because litter this tool created is this tool's to clear, and
  // because the sweep deliberately spares anything touched in the last day.
  // Guarded on the served id: if Klaviyo ever stops snapshotting and serves the
  // library template directly, this would be deleting the live email.
  if (served.id !== created.id) {
    await deleteTemplate(created.id);
    log(`    cleaned up library intermediate ${created.id}`);
  } else {
    log(`    keeping ${created.id} — the flow serves it directly, it is not an intermediate`);
  }

  return {
    templateId, flow: use.flowName, actionId: use.actionId, messageId: use.messageId,
    libraryTemplate: created.id, servingTemplate: served.id, backup: backupPath,
    intermediateDeleted: served.id !== created.id,
  };
}

async function sweep(flows) {
  // Referenced = what any flow action points at, PLUS what each flow message actually
  // serves. Those differ, and missing the second set would delete live emails.
  const index = buildTemplateIndex(flows);
  const referenced = new Set(index.keys());
  for (const { actions } of flows) {
    for (const action of actions) {
      const msg = emailMessage(action);
      if (!msg) continue;
      const served = await getFlowMessageTemplate(msg.id).catch(() => null);
      if (served?.id) referenced.add(served.id);
    }
  }

  // ALLOWLIST: only templates a push recorded as replaced.
  //
  // Candidates come from flow-map.json and are fetched BY ID, never from
  // `GET /api/templates`. Measured on this account: that endpoint lists 47 templates
  // and shares ZERO ids with the 33 a flow actually serves — it enumerates LIBRARY
  // templates only, while flow-owned snapshots are readable by id and invisible to it.
  // So the list cannot find these, and an earlier version that swept whatever the list
  // showed as flow-unreferenced proposed deleting all 47: `camp_*` snapshots owned by
  // CAMPAIGNS (which nothing here walks) and the named library sources
  // scripts/giveaway/build-nurture-flow.mjs resolves through upsertTemplateByName.
  const map = loadMap();
  const sweepable = strandedIds(map);

  // When each id was STRANDED, not when Klaviyo last saved it. `getTemplate` requests a
  // sparse fieldset with no `updated`, so feeding its rows to the recency guard leaves
  // `updated: undefined` and the guard silently never fires — the same shape as the
  // winner lock that read a path that did not exist and looked like a working guard for
  // its whole life. The push time is also the more meaningful clock here: it is what
  // says whether a push might still be in flight.
  const strandedAt = new Map();
  for (const e of Object.values(map)) {
    for (const id of e.stranded ?? []) strandedAt.set(id, e.updatedAt);
  }

  const candidates = [];
  for (const id of sweepable) {
    const t = await getTemplate(id).catch(() => null);
    if (t) candidates.push({ ...t, updated: strandedAt.get(id) });
    else log(`  · ${id} already gone`);
  }

  const { orphans, kept } = findOrphans({
    templates: candidates,
    sweepableIds: sweepable,
    referencedIds: referenced,
    // The hazard is a CONCURRENT push that has recorded `stranded` but whose repoint
    // this run has not yet observed — a gap of one API round-trip, not a day. The real
    // protection is the live `referenced` re-check above; this is the belt to its
    // braces, so it is sized to the mechanism rather than picked round.
    olderThan: new Date(Date.now() - SETTLE_MS),
  });

  log(`\nOrphan sweep — ${referenced.size} templates are served by a live flow`);
  log(`  ${sweepable.size} recorded as stranded by a push; ${candidates.length} still exist; ${orphans.length} sweepable now`);
  kept.forEach((k) => log(`  keeping ${k.id} — ${k.reason}`));
  log('  library and campaign templates are never candidates here');
  for (const o of orphans) log(`  · ${o.id} "${o.name}" (updated ${o.updated})`);
  if (!orphans.length) return { deleted: [] };
  if (!APPLY) { log('  DRY RUN — pass --apply to delete these'); return { deleted: [] }; }

  const deleted = [];
  for (const o of orphans) {
    // Re-read immediately before deleting: the sweep walks every flow, which takes
    // long enough that a concurrent push could have claimed one of these.
    if (referenced.has(o.id)) continue;
    await deleteTemplate(o.id);
    deleted.push({ id: o.id, name: o.name, updated: o.updated });
    log(`  deleted ${o.id}`);
  }
  record('sweep', { stamp, deleted, kept: kept.length });
  return { deleted };
}

const flows = await loadFlows();
log(`Klaviyo flow template push — revision ${FLOW_ACTION_REVISION}${APPLY ? '' : '  (DRY RUN)'}`);
log(`${flows.length} flows, ${flows.reduce((n, f) => n + f.actions.length, 0)} actions\n`);

if (SWEEP) {
  await sweep(flows);
} else {
  const index = buildTemplateIndex(flows);
  const targets = ALL
    ? readdirSync(DIR).filter((f) => f.endsWith('.after.html')).map((f) => f.replace('.after.html', ''))
    : ids;
  const pushed = [];
  for (const id of targets) {
    const r = await pushOne(id, index);
    if (r) pushed.push(r);
  }
  if (APPLY && pushed.length) record('push', { stamp, pushed });
  log(`\n${pushed.length}/${targets.length} pushed${APPLY ? '' : ' (dry run — nothing written)'}`);
}
