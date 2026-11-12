#!/usr/bin/env node
/**
 * Culina Amazon inbound shipments: Travis emails a case list, FBA case labels go back to him.
 *
 *   node agents/amazon-inbound/index.js [--apply] [--dry-run] [--since YYYY-MM-DD] [--text "<message>"]
 *
 * Cron: every 15 minutes with --apply (scripts/setup-cron.sh EVERY_15_AMAZON_INBOUND, UTC).
 *
 * Per run, under a single-instance lock:
 *   1. Resume every state record left mid-way (claimed .. confirmed, failed, or a booked
 *      record whose AWD handoff never went out). A failed record resumes from failedAtStep.
 *   2. AWD: pending AWD shares are matched to AWD inbound shipments Sean created in Seller
 *      Central (the AWD API cannot book the partnered carrier); matched labels go to Travis in
 *      his thread. Past awd_reminder_days with no match, Sean gets one reminder.
 *   3. New mail from config.senders (every Hushmail folder, last 14 days or since --since; auto
 *      replies ignored): parse -> none (done) | invalid (ask Travis to resend) | shipment ->
 *      duplicate hold -> already-booked-by-hand check -> claim -> 30-day FBA/AWD split ->
 *      bookFba (cheapest total) -> case labels to Travis, CC Sean, threaded -> AWD handoff to Sean.
 *   4. One deferred digest row when anything happened.
 *
 * A Hushmail outage does not stop steps 1 and 2: booked shipments still get their labels. It adds
 * one digest row per day and emails Sean once it has lasted over an hour (then at most every 6 h).
 * A lock held by a live run for over 2 hours is never taken over; Sean is emailed at most every 6 h.
 *
 * Never books the same email twice: a record is persisted as 'claimed' before the first create
 * call, bookFba resumes from the stored step and adopts a plan already named for the message,
 * and an unreadable state file throws (after one immediate notify) instead of reading as empty.
 *
 * Labels not ready right after confirmation (no confirmation id / box ids yet, or a 404 on a
 * label or the bill of lading) are retried on the next run; after 6 misses Sean is told once.
 * Any other error marks the record failed at the step reached, notifies Sean immediately once per
 * (message, step), and the next run retries from that step.
 *
 * Dry by default: nothing is sent, no state is written, nothing is confirmed. A dry run quotes
 * under a separate plan name and then cancels that draft plan (cancelDraft), printing the parse,
 * the split and the cheapest total. --text treats the given text as a message received now.
 *
 * Off switch: config/amazon-inbound.json enabled: false. State: data/amazon-inbound/state.json
 * (gitignored, offsite server-state backup). Culina only: SKUs come from config.skus.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, statSync, openSync, writeSync, closeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDirectRun } from '../../lib/is-direct-run.js';
import { notify } from '../../lib/notify.js';
import { hushmailCredentials, sendMail, fetchFromAllFolders } from '../../lib/hushmail.js';
import { defaultDeps, fetchDailyUnits } from '../../lib/culina-data.js';
import { dailyPace, inferStockoutDates, seasonalIndex } from '../../lib/culina-forecast.js';
import { parseShipmentEmail, linesSignature } from '../../lib/amazon-inbound-parse.js';
import { splitCases, readFbaBySku, expirationDate } from '../../lib/amazon-inbound-split.js';
import { palletize } from '../../lib/amazon-inbound-cost.js';
import {
  loadState, saveState, planName, dryPlanName, DRY_PLAN_PREFIX, duplicateCheck, manualBookingCheck, matchAwdShipment,
} from '../../lib/amazon-inbound-state.js';
import { bookFba, fetchFbaLabels, cancelDraft } from '../../lib/amazon-inbound-fba.js';
import {
  labelsReply, awdLabelsReply, resendRequest, awdHandoff, awdReminder, heldNotice, alreadyPlacedNotice, failureNotice, esc,
} from '../../lib/amazon-inbound-email.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const STATE_DIR = join(ROOT, 'data', 'amazon-inbound');
const DAY = 864e5;
const MAX_AGE_DAYS = 14;
const PACE_WINDOW_DAYS = 120;
const LABEL_MISS_LIMIT = 6;
const LOCK_STALE_MS = 3 * 3600e3;
const LOCK_STUCK_MS = 2 * 3600e3;
const UNREADABLE_NOTIFY_MS = 6 * 3600e3;
const MAIL_OUTAGE_NOTIFY_MS = 3600e3;
const PACE_MS = 1000;
const V = '/inbound/fba/2024-03-20';
const AWD = '/awd/2024-05-09';
const AGENT = 'amazon-inbound';

const BOOKING = new Set(['claimed', 'plan_created', 'packing_confirmed', 'quoted', 'confirmed']);
const SKIP_PLAN_STATUS = new Set(['VOIDED', 'ERRORED']);
const LABELS_NOT_READY = /no shipmentConfirmationId yet|box IDs not available yet|returned no DownloadURL|\(404\)/;

// ---- args -----------------------------------------------------------------

export function parseArgs(argv) {
  const val = (flag) => {
    const i = argv.indexOf(flag);
    if (i === -1) return null;
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new Error(`${flag} needs a value`);
    return v;
  };
  const apply = argv.includes('--apply');
  if (apply && argv.includes('--dry-run')) throw new Error('--apply and --dry-run cannot both be given');
  const since = val('--since');
  if (since !== null && !/^\d{4}-\d{2}-\d{2}$/.test(since)) throw new Error(`--since must be YYYY-MM-DD, got ${since}`);
  const text = val('--text');
  return { apply, since, text };
}

// ---- small helpers ----------------------------------------------------------

const iso = (d) => new Date(d).toISOString();
const short = (id) => String(id || '').replace(/^<|>$/g, '').slice(0, 24);
const errText = (err) => String(err?.message || err);
const pause = (ctx) => ctx.deps.sleep(PACE_MS);

/**
 * Single-instance lock: a file holding { pid, startedAt }, created atomically (open 'wx').
 *
 * An existing lock is LIVE only when its pid is running THIS agent: /proc/<pid>/cmdline must
 * contain "amazon-inbound" (a pid reused by another process after a crash or reboot does not
 * count). Where /proc does not exist (macOS), a running pid counts as live. A live lock is never
 * taken over, however old: that run may be mid-booking. A dead or foreign pid's lock is taken
 * over. A lock with no readable pid is taken over only once it is older than LOCK_STALE_MS.
 *
 * Returns { acquired: true } or { acquired: false, pid, ageMs }.
 */
export function acquireLock(path, { procRoot = '/proc', nowMs = Date.now() } = {}) {
  mkdirSync(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, 'wx');
      try { writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date(nowMs).toISOString() })); } finally { closeSync(fd); }
      return { acquired: true };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
    const holder = readLock(path, nowMs);
    if (holder.gone) continue;
    if (holder.pid && pidRunsAgent(holder.pid, procRoot)) return { acquired: false, pid: holder.pid, ageMs: holder.ageMs };
    if (!holder.pid && holder.ageMs < LOCK_STALE_MS) return { acquired: false, pid: null, ageMs: holder.ageMs };
    try { unlinkSync(path); } catch { /* another run removed it first */ }
  }
  return { acquired: false, pid: null, ageMs: 0 }; // lost the race to another run
}

/** { pid, ageMs } from a lock file (gone: true if it vanished); accepts the old bare-pid format. pid 0 when unreadable. */
function readLock(path, nowMs) {
  if (!existsSync(path)) return { gone: true, pid: 0, ageMs: 0 };
  let raw = '';
  let mtimeMs = nowMs;
  try { mtimeMs = statSync(path).mtimeMs; } catch { return { gone: true, pid: 0, ageMs: 0 }; }
  try { raw = readFileSync(path, 'utf8').trim(); } catch { /* unreadable: no pid */ }
  let pid = 0;
  let started = mtimeMs;
  try {
    const j = JSON.parse(raw);
    if (j && typeof j === 'object') {
      pid = Number(j.pid);
      if (Number.isFinite(Date.parse(j.startedAt))) started = Date.parse(j.startedAt);
    } else {
      pid = Number(j);
    }
  } catch { pid = Number(raw); }
  if (!Number.isInteger(pid) || pid <= 0) pid = 0;
  return { pid, ageMs: nowMs - started };
}

function pidRunsAgent(pid, procRoot) {
  if (existsSync(procRoot)) {
    try { return readFileSync(join(procRoot, String(pid), 'cmdline'), 'utf8').includes(AGENT); } catch { return false; }
  }
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/** At most one immediate notify per UNREADABLE_NOTIFY_MS, tracked by a marker file's mtime. */
async function throttledNotify(deps, marker, msg) {
  let recent = false;
  try { recent = Date.now() - statSync(marker).mtimeMs < UNREADABLE_NOTIFY_MS; } catch { /* no marker */ }
  if (recent) return false;
  await deps.notify({ ...msg, status: 'error', category: 'amazon', immediate: true });
  try { writeFileSync(marker, new Date().toISOString()); } catch { /* best effort */ }
  return true;
}

function releaseLock(path) {
  try { unlinkSync(path); } catch { /* already gone */ }
}

function loadSeasonal(path, notes) {
  if (!path || !existsSync(path)) return seasonalIndex(null);
  try {
    return seasonalIndex(JSON.parse(readFileSync(path, 'utf8')).monthlySearches);
  } catch (err) {
    notes.push(`seasonal cache unreadable (${err.message}); flat seasonal index used`);
    return seasonalIndex(null);
  }
}

async function listPaged(ctx, path, key, params = {}) {
  const out = [];
  let token;
  let first = true;
  do {
    if (!first) await pause(ctx);
    first = false;
    const res = await ctx.deps.request('GET', path, token ? { ...params, paginationToken: token } : params);
    out.push(...(res?.[key] || []));
    token = res?.pagination?.nextToken;
  } while (token);
  return out;
}

function skuTable(config) {
  return Object.fromEntries(config.skus.map((s) => [s.sku, s]));
}

// ---- mail -------------------------------------------------------------------

function threadHeaders(record) {
  if (record.synthetic || !record.messageId) return {};
  const refs = [...(record.references || []), record.messageId].filter(Boolean);
  return { inReplyTo: record.messageId, references: [...new Set(refs)].join(' ') };
}

async function sendToTravis(ctx, record, msg, attachments) {
  const { deps, config } = ctx;
  return deps.sendMail(deps.creds, {
    to: config.to, cc: config.cc, subject: msg.subject, text: msg.text, html: msg.html,
    fromName: config.fromName, agent: AGENT, ...threadHeaders(record),
    ...(attachments?.length ? { attachments } : {}),
  }, { via: 'resend', resendKey: deps.resendKey });
}

async function sendToSean(ctx, msg) {
  const { deps, config } = ctx;
  return deps.sendMail(deps.creds, {
    to: config.from, subject: msg.subject, text: msg.text, html: msg.html, fromName: config.fromName, agent: AGENT,
  }, { via: 'resend', resendKey: deps.resendKey });
}

/** In a dry run nothing is sent; the message is printed instead. */
async function deliver(ctx, who, record, msg, attachments) {
  if (!ctx.apply) {
    ctx.log(`[dry] would email ${who === 'travis' ? `Travis (CC ${ctx.config.cc.join(', ')})` : 'Sean'}: ${msg.subject}${attachments?.length ? ` with ${attachments.length} attachment(s)` : ''}\n${msg.text}\n`);
    return { messageId: null };
  }
  return who === 'travis' ? sendToTravis(ctx, record, msg, attachments) : sendToSean(ctx, msg);
}

async function readMail(ctx) {
  const { deps, config, args } = ctx;
  const now = deps.now().getTime();
  let since = args.since ? new Date(`${args.since}T00:00:00Z`) : new Date(now - MAX_AGE_DAYS * DAY);
  // config.process_after: mail received at or before this instant is never read. Set at
  // rollout (Sean, 2026-11-12: "do not create labels until the next email Travis sends").
  if (config.process_after) {
    const cutoff = Date.parse(config.process_after);
    if (!Number.isFinite(cutoff)) throw new Error(`config.process_after is not a date: ${config.process_after}`);
    if (cutoff + 1 > since.getTime()) since = new Date(cutoff + 1);
  }
  // config.senders: every address a case list may come from (Travis, and the Culina office
  // inbox since 2026-11-12). config.sender stays the LTL pickup contact.
  const senders = (config.senders?.length ? config.senders : [config.sender]).map((a) => a.toLowerCase());
  const rows = await deps.fetchMail(deps.creds, { senders, since });
  const seen = new Set();
  return rows
    .filter((r) => r?.messageId && senders.includes(String(r.from || '').toLowerCase()) && !r.autoSubmitted)
    .filter((r) => Date.parse(r.date) >= since.getTime())
    .filter((r) => (seen.has(r.messageId) ? false : seen.add(r.messageId)))
    .sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
}

function textRow(ctx, text) {
  const id = `text-${createHash('sha256').update(text).digest('hex').slice(0, 12)}`;
  return { messageId: id, date: iso(ctx.deps.now()), subject: 'Culina case list', inReplyTo: null, references: [], text, synthetic: true };
}

// ---- Amazon reads -------------------------------------------------------------

/** FBA plans and AWD shipments created at or after `since`, as { id, createdAt, casesBySku }. */
async function laterShipments(ctx, record) {
  const since = Date.parse(record.receivedAt);
  const own = new Set([...Object.keys(ctx.state.messages), record.messageId].map(planName));
  const skus = skuTable(ctx.config);
  const out = [];

  const plans = [];
  let token;
  let first = true;
  for (;;) {
    if (!first) await pause(ctx);
    first = false;
    const res = await ctx.deps.request('GET', `${V}/inboundPlans`, {
      pageSize: 30, sortBy: 'CREATION_TIME', sortOrder: 'DESC', ...(token ? { paginationToken: token } : {}),
    });
    let older = false;
    for (const p of res?.inboundPlans || []) {
      if (!(Date.parse(p.createdAt) >= since)) { older = true; continue; }
      if (SKIP_PLAN_STATUS.has(p.status) || own.has(p.name) || String(p.name || '').startsWith(DRY_PLAN_PREFIX)) continue;
      plans.push(p);
    }
    token = res?.pagination?.nextToken;
    if (older || !token) break;
  }
  for (const p of plans) {
    await pause(ctx);
    let items;
    try {
      items = await listPaged(ctx, `${V}/inboundPlans/${p.inboundPlanId}/items`, 'items');
    } catch (err) {
      // GetInboundPlan/listInboundPlanItems answer 400 for AWD-type plans; those are read from the AWD API below.
      if (errText(err).includes('(400)')) { ctx.log(`skipping plan ${p.inboundPlanId}: ${errText(err).slice(0, 160)}`); continue; }
      throw err;
    }
    const casesBySku = {};
    for (const it of items) {
      const cfg = skus[it.msku];
      if (!cfg) continue;
      casesBySku[it.msku] = (casesBySku[it.msku] || 0) + Math.round(it.quantity / cfg.units_per_case);
    }
    out.push({ id: p.inboundPlanId, createdAt: p.createdAt, casesBySku });
  }

  const claimed = claimedAwdIds(ctx.state);
  for (const s of await awdShipmentsSince(ctx, since)) {
    if (!claimed.has(s.shipmentId)) out.push(s);
  }
  return out;
}

function claimedAwdIds(state) {
  return new Set(Object.values(state.messages).map((r) => r?.awdShare?.awdShipmentId).filter(Boolean));
}

/** AWD inbound shipments created at or after `since` (ms), with case counts per SKU (skuQuantities=SHOW). */
async function awdShipmentsSince(ctx, since) {
  const skus = skuTable(ctx.config);
  const summaries = [];
  let token;
  let first = true;
  for (;;) {
    if (!first) await pause(ctx);
    first = false;
    const res = await ctx.deps.request('GET', `${AWD}/inboundShipments`, {
      sortBy: 'CREATED_AT', sortOrder: 'DESCENDING', maxResults: 200, ...(token ? { nextToken: token } : {}),
    });
    let older = false;
    for (const s of res?.shipments || []) {
      if (!(Date.parse(s.createdAt) >= since)) { older = true; continue; }
      if (s.shipmentStatus === 'CANCELLED') continue;
      summaries.push(s);
    }
    token = res?.nextToken;
    if (older || !token) break;
  }
  const out = [];
  for (const s of summaries) {
    await pause(ctx);
    const d = await ctx.deps.request('GET', `${AWD}/inboundShipments/${s.shipmentId}`, { skuQuantities: 'SHOW' });
    const casesBySku = {};
    for (const q of d?.shipmentSkuQuantities || []) {
      const e = q.expectedQuantity || {};
      let cases = null;
      if (e.unitOfMeasurement === 'CASES') cases = e.quantity;
      else if (e.unitOfMeasurement === 'PRODUCT_UNITS' && skus[q.sku]) cases = e.quantity / skus[q.sku].units_per_case;
      if (cases === null || !q.sku) continue;
      casesBySku[q.sku] = (casesBySku[q.sku] || 0) + cases;
    }
    out.push({ id: s.shipmentId, shipmentId: s.shipmentId, createdAt: d?.createdAt || s.createdAt, casesBySku });
  }
  return out;
}

// ---- split ------------------------------------------------------------------

async function computeSplit(ctx, lines) {
  const { deps, config } = ctx;
  for (const l of lines) {
    if (String(l.sku).startsWith('amzn.gr.')) throw new Error(`refusing amzn.gr SKU ${l.sku}`);
  }
  const asins = [...new Set(lines.map((l) => l.asin))];
  const daily = await fetchDailyUnits(deps, asins, PACE_WINDOW_DAYS);
  const paceBySku = {};
  for (const l of lines) {
    const rows = daily[l.asin] || [];
    paceBySku[l.sku] = dailyPace(rows, { stockoutDates: inferStockoutDates(rows, {}) });
  }
  const fbaBySku = await readFbaBySku(deps);
  const seasonal = loadSeasonal(deps.seasonalPath, ctx.notes);
  const today = iso(deps.now()).slice(0, 10);
  const rows = splitCases({ lines, fbaBySku, paceBySku, today, seasonal, coverDays: config.fba_cover_days });

  const skus = skuTable(config);
  const fbaItems = [];
  const awdLines = [];
  for (const r of rows) {
    const cfg = skus[r.sku];
    if (!cfg) throw new Error(`SKU ${r.sku} is not in config/amazon-inbound.json`);
    if (r.fbaCases > 0) {
      // Fixed here, once, and persisted with the record: plan items and box items must carry the same date.
      const expiration = cfg.expiration_years ? { expiration: expirationDate(today, cfg.expiration_years) } : {};
      fbaItems.push({ key: cfg.key, sku: cfg.sku, asin: cfg.asin, cases: r.fbaCases, unitsPerCase: cfg.units_per_case, case_in: cfg.case_in, case_lb: cfg.case_lb, ...expiration });
    }
    if (r.awdCases > 0) {
      // Same rule as the FBA items, so Sean enters the same date in Seller Central.
      const expiration = cfg.expiration_years ? { expiration: expirationDate(today, cfg.expiration_years) } : {};
      awdLines.push({ key: cfg.key, sku: cfg.sku, asin: cfg.asin, cases: r.awdCases, units_per_case: cfg.units_per_case, case_in: cfg.case_in, case_lb: cfg.case_lb, ...expiration });
    }
  }
  const reasons = rows.map((r) => `${r.key}: ${r.reason}`);
  return { rows, fbaItems, awdLines, reasons };
}

function printSplit(ctx, split) {
  ctx.log('Split:');
  for (const r of split.rows) ctx.log(`  ${r.key}: ${r.fbaCases} case(s) to FBA, ${r.awdCases} to AWD (${r.reason})`);
}

// ---- per message ---------------------------------------------------------------

function bookDeps(ctx, apply) {
  const { deps } = ctx;
  return {
    request: deps.request, sleep: deps.sleep, now: deps.now, marketplaceId: deps.marketplaceId,
    contactPhone: deps.contactPhone, download: deps.download, apply,
  };
}

/** New (or failed-before-claim) message: decide none / invalid / held / placed / book. */
async function triage(ctx, record) {
  const { config, state } = ctx;
  const parsed = parseShipmentEmail(record.text, config.skus);
  if (!ctx.apply) ctx.log(`Message ${short(record.messageId)} (${record.receivedAt}): ${parsed.kind}`);

  if (parsed.kind === 'none') {
    record.step = 'done';
    record.kind = 'none';
    ctx.persist(record);
    ctx.event(`${short(record.messageId)}: email from Travis with no case list ("${record.subject || 'no subject'}"); nothing booked`, 'info');
    return;
  }
  if (parsed.kind === 'invalid') {
    record.problems = parsed.problems;
    const sent = await deliver(ctx, 'travis', record, resendRequest({ problems: parsed.problems }));
    record.resendRequestId = sent.messageId;
    record.step = 'invalid_replied';
    ctx.persist(record);
    ctx.event(`${short(record.messageId)}: could not read ${parsed.problems.length} line(s); asked Travis to resend`, 'info');
    return;
  }

  record.lines = parsed.lines;
  record.signature = linesSignature(parsed.lines);
  if (!ctx.apply) for (const l of parsed.lines) ctx.log(`  ${l.key}: ${l.cases} cases, ${l.units} units (${l.sku})`);

  const replyTo = new Set([record.inReplyTo, ...(record.references || [])].filter(Boolean));
  const asked = Object.values(state.messages).find((r) => r.step === 'invalid_replied' && r.resendRequestId && replyTo.has(r.resendRequestId));
  if (asked) record.resendOf = asked.messageId;

  const dup = duplicateCheck(state, {
    messageId: record.messageId, signature: record.signature, text: record.text, receivedAt: record.receivedAt,
    windowDays: config.duplicate_window_days, resendOf: record.resendOf,
  });
  if (dup.hold) {
    await hold(ctx, record, dup.reason);
    return;
  }

  const manual = manualBookingCheck(record.lines, await laterShipments(ctx, record), record.receivedAt);
  if (manual.verdict === 'placed') {
    await deliver(ctx, 'sean', record, alreadyPlacedNotice({ covering: manual.covering, lines: record.lines }));
    record.coveredBy = manual.covering;
    record.step = 'done';
    ctx.persist(record);
    ctx.event(`${short(record.messageId)}: already booked by hand (${manual.covering.join(', ')}); nothing booked`, 'info');
    return;
  }
  if (manual.verdict === 'partial') {
    await hold(ctx, record, `some of these cases already appear on shipments created after the email (${manual.covering.join(', ')})`);
    return;
  }

  record.step = 'claimed';
  record.claimedAt = iso(ctx.deps.now());
  ctx.persist(record); // claimed BEFORE the first create call
}

async function hold(ctx, record, reason) {
  await deliver(ctx, 'sean', record, heldNotice({ reason, text: record.text }));
  record.holdReason = reason;
  record.step = 'held';
  ctx.persist(record);
  ctx.event(`${short(record.messageId)}: held for Sean (${reason})`, 'info');
}

function needsHandoff(record) {
  return (record.step === 'labels_sent' || record.step === 'done') && record.awdLines?.length > 0 && !record.awdShare?.handoffAt;
}

/** Claimed record: split, book, labels, reply, AWD handoff. Each part is skipped once done. */
async function advance(ctx, record) {
  const { config } = ctx;
  if (!record.split) {
    const split = await computeSplit(ctx, record.lines);
    record.split = split.rows;
    record.fbaItems = split.fbaItems;
    record.awdLines = split.awdLines;
    record.splitReasons = split.reasons;
    ctx.persist(record);
  }

  if (record.fbaItems.length) {
    if (BOOKING.has(record.step) && record.step !== 'confirmed') {
      await bookFba({ record, items: record.fbaItems, config, deps: bookDeps(ctx, true), persist: ctx.persist });
    }
    if (record.step === 'confirmed') {
      const sent = await sendFbaLabels(ctx, record);
      if (!sent) return;
    }
  } else if (record.step === 'claimed') {
    record.step = 'done'; // every case goes to AWD; nothing to book through the FBA API
    ctx.persist(record);
  }

  if (needsHandoff(record)) {
    await deliver(ctx, 'sean', record, awdHandoff({ lines: record.awdLines, shipFrom: config.ship_from, reasons: record.splitReasons }));
    record.awdShare = { ...(record.awdShare || {}), lines: record.awdLines, handoffAt: iso(ctx.deps.now()) };
    ctx.persist(record);
    ctx.event(`${short(record.messageId)}: AWD share handed to Sean (${record.awdLines.map((l) => `${l.cases} x ${l.key}`).join(', ')})`, 'info');
  }
}

/** true when the reply went out; false when Amazon has not produced the labels yet (retry next run). */
async function sendFbaLabels(ctx, record) {
  let files;
  try {
    files = await fetchFbaLabels({ record, deps: bookDeps(ctx, true) });
  } catch (err) {
    if (!LABELS_NOT_READY.test(errText(err))) throw err;
    record.labelMisses = (record.labelMisses || 0) + 1;
    record.lastLabelMiss = errText(err);
    ctx.persist(record);
    ctx.log(`${short(record.messageId)}: labels not ready (${record.labelMisses}/${LABEL_MISS_LIMIT}): ${errText(err)}`);
    if (record.labelMisses >= LABEL_MISS_LIMIT && !record.labelMissNotified) {
      await notifyFailure(ctx, record, 'labels', `labels still not available after ${record.labelMisses} tries: ${errText(err)}`);
      record.labelMissNotified = true;
      ctx.persist(record);
    }
    return false;
  }
  const shipments = await describeShipments(ctx, record);
  const msg = labelsReply({ record, shipments, awdLines: record.awdLines });
  const sent = await deliver(ctx, 'travis', record, msg, files);
  record.labelsReplyId = sent.messageId;
  record.labelsSentAt = iso(ctx.deps.now());
  record.step = 'labels_sent';
  ctx.persist(record);
  ctx.event(`${short(record.messageId)}: booked ${shipments.length} FBA shipment(s) (${shipments.map((s) => s.shipmentId).join(', ')}), total $${record.quote?.total ?? '?'}; labels sent to Travis`, 'success');
  return true;
}

/** What labelsReply needs per shipment: confirmation id, destination, cases per pack, mode, carrier, pallets. */
async function describeShipments(ctx, record) {
  const { config, deps } = ctx;
  const skus = skuTable(config);
  const plan = `${V}/inboundPlans/${record.planId}`;
  const out = [];
  for (const pk of record.quote.picks) {
    await pause(ctx);
    const ship = await deps.request('GET', `${plan}/shipments/${pk.shipmentId}`);
    const items = await listPaged(ctx, `${plan}/shipments/${pk.shipmentId}/items`, 'items');
    const cases = items.map((i) => {
      const cfg = skus[i.msku];
      return { key: cfg?.key || i.msku, sku: i.msku, count: cfg ? Math.round(i.quantity / cfg.units_per_case) : i.quantity };
    });
    let carrier = null;
    try {
      const opts = await listPaged(ctx, `${plan}/transportationOptions`, 'transportationOptions', { shipmentId: pk.shipmentId });
      carrier = opts.find((o) => o.transportationOptionId === pk.transportationOptionId)?.carrier?.name || null;
    } catch (err) {
      ctx.log(`carrier name for ${pk.shipmentId} unavailable: ${errText(err)}`);
    }
    let pallets = null;
    if (pk.mode === 'FREIGHT_LTL') {
      pallets = palletize(cases.filter((c) => skus[c.sku]).map((c) => ({
        sku: c.sku, count: c.count, case_in: skus[c.sku].case_in, case_lb: skus[c.sku].case_lb,
      })), config.pallet).map((p) => ({ ...p, cases: p.cases.map((c) => ({ ...c, key: skus[c.sku].key })) }));
    }
    const d = ship?.destination || {};
    const where = [d.address?.city, d.address?.stateOrProvinceCode].filter(Boolean).join(', ');
    out.push({
      shipmentId: ship?.shipmentConfirmationId || pk.shipmentId,
      destination: [d.warehouseId, where && `(${where})`].filter(Boolean).join(' ') || 'Amazon',
      cases, mode: pk.mode, carrier, pallets,
    });
  }
  return out;
}

async function notifyFailure(ctx, record, step, error) {
  const msg = failureNotice({ messageId: record.messageId, step, planId: record.planId, error });
  await ctx.deps.notify({ subject: msg.subject, body: msg.text, status: 'error', category: 'amazon', immediate: true });
}

async function fail(ctx, record, err) {
  const at = record.step || 'received';
  ctx.errors.push({ messageId: record.messageId, step: at, error: errText(err) });
  if (!ctx.apply) {
    ctx.log(`${short(record.messageId)}: FAILED at ${at}: ${errText(err)}`);
    return;
  }
  record.failedAtStep = at;
  record.step = 'failed';
  record.error = errText(err);
  record.failedAt = iso(ctx.deps.now());
  ctx.persist(record);
  ctx.log(`${short(record.messageId)}: FAILED at ${at}: ${errText(err)}`);
  if (record.failureNotifiedFor !== at) {
    ctx.event(`${short(record.messageId)}: FAILED at ${at}: ${errText(err)} (Sean emailed)`, 'error');
    await notifyFailure(ctx, record, at, errText(err));
    record.failureNotifiedFor = at;
    ctx.persist(record);
  }
}

async function processRecord(ctx, record) {
  try {
    if (record.step === 'failed') {
      record.step = record.failedAtStep === 'received' ? null : record.failedAtStep;
    }
    if (!record.step) await triage(ctx, record);
    if (BOOKING.has(record.step) || needsHandoff(record)) await advance(ctx, record);
  } catch (err) {
    await fail(ctx, record, err);
  }
}

async function dryBook(ctx, record) {
  try {
    await triage(ctx, record);
    if (record.step !== 'claimed') return;
    const split = await computeSplit(ctx, record.lines);
    printSplit(ctx, split);
    if (!split.fbaItems.length) { ctx.log('No FBA cases: everything would go to AWD (handoff to Sean).'); return; }
    // A separate, recognisable name: never adopted by a real booking, never read as a manual one.
    const draft = { messageId: `dry-${record.messageId}`, planName: dryPlanName(record.messageId), step: 'claimed' };
    const deps = bookDeps(ctx, false);
    try {
      await bookFba({ record: draft, items: split.fbaItems, config: ctx.config, deps, persist: () => {} });
      const q = draft.quote;
      const money = (n) => (n === null ? 'unquoted' : `$${n}`);
      ctx.log('Placement options:');
      for (const o of q.options || []) {
        ctx.log(`  ${o.placementOptionId}: placement ${money(o.placementFee)}, ${o.shipments.length} shipment(s), lowest total ${money(o.total)}`);
        for (const s of o.shipments) ctx.log(`    ${s.shipmentId}: parcel ${money(s.parcel)}, LTL ${s.ltl === null ? 'not offered' : `$${s.ltl}`}`);
      }
      ctx.log(`Cheapest total: $${q.total} (placement $${q.placementFee}, packing $${q.packingFee}; ${q.picks.map((p) => `${p.shipmentId} ${p.mode} $${p.amount}`).join('; ')})`);
    } finally {
      if (draft.planId) {
        try {
          await cancelDraft({ record: draft, deps });
          ctx.log(`Draft plan ${draft.planId} cancelled (dry run).`);
        } catch (err) {
          ctx.leftActive.push(draft.planId);
          ctx.log(`DRAFT PLAN ${draft.planId} (${draft.planName}) LEFT ACTIVE, cancel it in Seller Central: ${errText(err)}`);
        }
      }
    }
  } catch (err) {
    await fail(ctx, record, err);
  }
}

// ---- AWD ------------------------------------------------------------------------

async function awdStep(ctx) {
  const { state, config, deps } = ctx;
  const pending = Object.values(state.messages).filter((r) => r?.awdShare?.handoffAt && !r.awdShare.labelsSentAt);
  if (!pending.length) return;
  const now = deps.now().getTime();

  try {
    const unmatched = pending.filter((r) => !r.awdShare.awdShipmentId);
    if (unmatched.length) {
      const since = Math.min(...unmatched.map((r) => Date.parse(r.awdShare.handoffAt)));
      const claimed = claimedAwdIds(state);
      const ships = (await awdShipmentsSince(ctx, since)).filter((s) => !claimed.has(s.shipmentId));
      const shares = unmatched.map((r) => ({ messageId: r.messageId, handoffAt: r.awdShare.handoffAt, lines: r.awdShare.lines }));
      const matches = matchAwdShipment(shares, ships);
      const used = new Set(matches.map((m) => m.shipmentId));
      for (const m of matches) {
        const r = state.messages[m.messageId];
        r.awdShare.awdShipmentId = m.shipmentId;
        r.awdShare.matchedAt = iso(now);
        ctx.persist(r);
        ctx.event(`${short(r.messageId)}: AWD shipment ${m.shipmentId} found`, 'info');
      }
      await reportPartialAwd(ctx, unmatched.filter((r) => !r.awdShare.awdShipmentId), ships.filter((s) => !used.has(s.shipmentId)));
    }
    if (state.awdError) { state.awdError = null; ctx.saveAll(); }
  } catch (err) {
    await awdFailure(ctx, state, 'awd_list', err);
  }

  for (const r of pending) {
    const share = r.awdShare;
    if (share.awdShipmentId) {
      try {
        await pause(ctx);
        const res = await deps.request('GET', `${AWD}/inboundShipments/${share.awdShipmentId}/labels`, { pageType: 'PLAIN_PAPER', formatType: 'PDF' });
        if (res?.labelStatus === 'GENERATION_FAILED') throw new Error(`AWD label generation failed for ${share.awdShipmentId}`);
        if (res?.labelStatus !== 'GENERATED' || !res.labelDownloadURL) {
          share.labelMisses = (share.labelMisses || 0) + 1;
          ctx.persist(r);
          ctx.log(`${short(r.messageId)}: AWD labels for ${share.awdShipmentId} not ready (${res?.labelStatus || 'no status'}, ${share.labelMisses}/${LABEL_MISS_LIMIT})`);
          if (share.labelMisses >= LABEL_MISS_LIMIT && !share.labelMissNotified) {
            await notifyFailure(ctx, r, 'awd_labels', `AWD labels for ${share.awdShipmentId} still ${res?.labelStatus || 'not ready'} after ${share.labelMisses} tries`);
            share.labelMissNotified = true;
            ctx.persist(r);
            ctx.event(`${short(r.messageId)}: AWD labels for ${share.awdShipmentId} not ready after ${share.labelMisses} tries (Sean emailed)`, 'error');
          }
          continue;
        }
        const pdf = await download(deps, res.labelDownloadURL, `AWD labels ${share.awdShipmentId}`);
        const msg = awdLabelsReply({ awdShipmentId: share.awdShipmentId, lines: share.lines });
        const sent = await sendToTravis(ctx, r, msg, [{ filename: `${share.awdShipmentId}-labels.pdf`, content: pdf }]);
        share.labelsReplyId = sent.messageId;
        share.labelsSentAt = iso(now);
        share.awdError = null;
        ctx.persist(r);
        ctx.event(`${short(r.messageId)}: AWD labels for ${share.awdShipmentId} sent to Travis`, 'success');
      } catch (err) {
        await awdFailure(ctx, share, 'awd_labels', err, r);
      }
    } else if (!share.remindedAt && now - Date.parse(share.handoffAt) >= config.awd_reminder_days * DAY) {
      try {
        const days = Math.floor((now - Date.parse(share.handoffAt)) / DAY);
        await sendToSean(ctx, awdReminder({ days, lines: share.lines }));
        share.remindedAt = iso(now);
        ctx.persist(r);
        ctx.event(`${short(r.messageId)}: AWD inbound still missing after ${days} days; reminded Sean`, 'info');
      } catch (err) {
        await awdFailure(ctx, share, 'awd_reminder', err, r);
      }
    }
  }
}

/** Partly-matching AWD shipment: shares a SKU with a pending share, created after its handoff, not an exact match. */
export function awdPartialNotice({ awdShipmentId, lines, casesBySku }) {
  const want = (lines || []).map((l) => `${l.cases} x ${l.key} (${l.sku})`);
  const got = Object.entries(casesBySku || {}).map(([k, n]) => `${n} x ${k}`);
  const text = [
    `AWD inbound ${awdShipmentId} shares packs with the AWD cases waiting from Travis's email, but the case counts do not match, so I did not use it and sent Travis no labels for it.`,
    `Waiting for AWD: ${want.join(', ')}`,
    `${awdShipmentId} holds: ${got.join(', ')}`,
    'If it is the right shipment, fix the counts in Seller Central (or tell me what to do); otherwise create the AWD inbound with the counts above.',
  ].join('\n\n');
  const html = text.split('\n\n').map((p) => `<p>${esc(p)}</p>`).join('\n');
  return { subject: `Culina: AWD inbound ${awdShipmentId} only partly matches`, text, html };
}

async function reportPartialAwd(ctx, records, ships) {
  for (const r of records) {
    const share = r.awdShare;
    const want = new Set((share.lines || []).map((l) => l.sku));
    for (const s of ships) {
      if (!(Date.parse(s.createdAt) > Date.parse(share.handoffAt))) continue;
      if (!Object.entries(s.casesBySku || {}).some(([k, n]) => want.has(k) && n > 0)) continue;
      share.partialNotified ||= [];
      if (share.partialNotified.includes(s.shipmentId)) continue;
      await sendToSean(ctx, awdPartialNotice({ awdShipmentId: s.shipmentId, lines: share.lines, casesBySku: s.casesBySku }));
      share.partialNotified.push(s.shipmentId);
      ctx.persist(r);
      ctx.event(`${short(r.messageId)}: AWD inbound ${s.shipmentId} only partly matches; told Sean`, 'info');
    }
  }
}

/** One immediate notify per (holder, step, error); `holder` keeps the last notified key. */
async function awdFailure(ctx, holder, step, err, record) {
  const key = `${step}: ${errText(err)}`;
  ctx.errors.push({ messageId: record?.messageId || null, step, error: errText(err) });
  ctx.log(`${record ? short(record.messageId) : 'AWD'}: ${key}`);
  if (holder.awdError === key) return;
  holder.awdError = key;
  ctx.event(`${record ? short(record.messageId) : 'AWD'}: ${key} (Sean emailed)`, 'error');
  if (record) ctx.persist(record); else ctx.saveAll();
  await notifyFailure(ctx, record || { messageId: 'AWD check', planId: null }, step, errText(err));
}

async function download(deps, url, what) {
  if (deps.download) return deps.download(url);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${what}: download failed (${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

// ---- run ----------------------------------------------------------------------

/**
 * Mail unreadable on an --apply run. Recorded in state.mailError { since, digestDay, notifiedAt }:
 * one digest row per UTC day, and one immediate email once the outage passes MAIL_OUTAGE_NOTIFY_MS,
 * repeated at most every UNREADABLE_NOTIFY_MS while it lasts. Cleared by the next good read.
 */
async function mailOutage(ctx, err) {
  const { state, deps } = ctx;
  const now = deps.now().getTime();
  const e = (state.mailError ||= { since: iso(now) });
  e.error = errText(err);
  ctx.errors.push({ messageId: null, step: 'read_mail', error: e.error });
  ctx.log(`amazon-inbound: mail unreadable since ${e.since}; resuming booked work without new mail: ${e.error}`);
  const day = iso(now).slice(0, 10);
  if (e.digestDay !== day) {
    e.digestDay = day;
    ctx.event(`Hushmail unreadable (since ${e.since}): ${e.error}. Booked shipments still advanced; new emails wait.`, 'error');
  }
  const down = now - Date.parse(e.since);
  if (down > MAIL_OUTAGE_NOTIFY_MS && !(e.notifiedAt && now - Date.parse(e.notifiedAt) < UNREADABLE_NOTIFY_MS)) {
    await deps.notify({
      subject: 'Culina inbound: Hushmail unreadable for over an hour',
      body: `Travis's emails cannot be read since ${e.since} (${Math.round(down / 60000)} min). Shipments already booked still get their labels; new case lists wait until mail is readable.\n\n${e.error}`,
      status: 'error', category: 'amazon', immediate: true,
    });
    e.notifiedAt = iso(now);
  }
  ctx.saveAll();
}

export async function run(argv, deps) {
  const args = parseArgs(argv);
  const config = deps.config;
  const log = deps.log || console.log;
  const summary = { apply: args.apply, events: [], errors: [], skipped: null };

  if (config.enabled === false) {
    log('amazon-inbound: disabled (config/amazon-inbound.json enabled: false); nothing done.');
    return { ...summary, skipped: 'disabled' };
  }
  if (config.process_after && !Number.isFinite(Date.parse(config.process_after))) {
    throw new Error(`config.process_after is not a date: ${config.process_after}`);
  }
  if (!deps.creds && (args.apply || !args.text)) throw new Error('HUSHMAIL_USER / HUSHMAIL_PASSWORD not set');
  if (args.apply && !deps.resendKey) throw new Error('cannot send: RESEND_API_KEY not set');

  if (args.apply) {
    const lock = acquireLock(deps.lockPath, { procRoot: deps.procRoot });
    if (!lock.acquired) {
      const mins = Math.round(lock.ageMs / 60000);
      log(`amazon-inbound: another run (pid ${lock.pid || 'unknown'}, ${mins} min old) holds the lock; nothing done.`);
      if (lock.pid && lock.ageMs > LOCK_STUCK_MS) {
        // Never taken over (it may be mid-booking); Sean is told at most once per 6 hours.
        await throttledNotify(deps, join(dirname(deps.lockPath), '.lock-stuck-notified'), {
          subject: 'Culina inbound: a run has held the lock for over 2 hours',
          body: `Run pid ${lock.pid} has held ${deps.lockPath} for ${mins} minutes, so no inbound emails are being processed. It is still running and was not stopped. If it is hung, stop that process; the next run takes over.`,
        });
      }
      return { ...summary, skipped: 'locked' };
    }
  }
  try {
    let state;
    try {
      state = loadState(deps.statePath);
    } catch (err) {
      // At most one immediate email per 6 hours; the run still throws (and logs) every 15 minutes.
      await throttledNotify(deps, join(dirname(deps.statePath), '.unreadable-notified'), {
        subject: 'Culina inbound: state file unreadable, nothing done', body: errText(err),
      });
      throw err;
    }

    const events = [];
    let worst = 'success';
    const rank = { success: 0, info: 1, error: 2 };
    const ctx = {
      args, deps, config, state, log, apply: args.apply, notes: [], errors: summary.errors, leftActive: [],
      persist(record) {
        if (!args.apply) return;
        state.messages[record.messageId] = record;
        saveState(deps.statePath, state);
      },
      saveAll() { if (args.apply) saveState(deps.statePath, state); },
      event(line, status = 'info') {
        events.push(line);
        if (rank[status] > rank[worst]) worst = status;
        log(line);
      },
    };

    // A mail outage must not strand bookings already made: on --apply the resume loop and the AWD
    // step still run with no new mail. A dry run (by hand) just fails.
    let rows = [];
    if (args.text) rows = [textRow(ctx, args.text)];
    else if (!args.apply) rows = await readMail(ctx);
    else {
      try {
        rows = await readMail(ctx);
        if (state.mailError) { state.mailError = null; ctx.saveAll(); }
      } catch (err) {
        await mailOutage(ctx, err);
      }
    }

    if (args.apply) {
      for (const record of Object.values(state.messages)) {
        if (record && (BOOKING.has(record.step) || record.step === 'failed' || needsHandoff(record))) {
          await processRecord(ctx, record);
        }
      }
      await awdStep(ctx);
    }

    for (const row of rows) {
      if (state.messages[row.messageId]) continue;
      const record = {
        messageId: row.messageId, receivedAt: row.date, subject: row.subject || '', inReplyTo: row.inReplyTo || null,
        references: row.references || [], text: row.text || '', synthetic: Boolean(row.synthetic), step: null,
      };
      if (args.apply) await processRecord(ctx, record);
      else await dryBook(ctx, record);
    }

    if (args.apply && events.length) {
      await deps.notify({
        subject: `Culina inbound: ${events.length} update(s)`,
        body: [...events, ...ctx.notes].join('\n'),
        status: worst === 'error' ? 'info' : worst,
        category: 'amazon',
      });
    }
    if (!args.apply) log('Dry run: nothing sent, no state written, nothing confirmed.');
    const exitCode = ctx.leftActive.length ? 1 : 0;
    return { ...summary, events, notes: ctx.notes, leftActive: ctx.leftActive, exitCode };
  } finally {
    if (args.apply) releaseLock(deps.lockPath);
  }
}

/**
 * `.env` text to an object, the way agents/press-outreach reads it: everything after
 * the first `=` is the value, outer quotes stripped. dotenv cuts an unquoted value at
 * " #", which silently truncated HUSHMAIL_PASSWORD to 6 characters (IMAP:
 * "Invalid password", 2026-11-12).
 */
export function parseEnvText(text) {
  const env = {};
  for (const line of String(text).split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i === -1) continue;
    env[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^["']|["']$/g, '');
  }
  return env;
}

async function realDeps() {
  await import('dotenv/config');
  let fileEnv = {};
  try { fileEnv = parseEnvText(readFileSync(join(ROOT, '.env'), 'utf8')); } catch { fileEnv = {}; }
  const envOf = (k) => fileEnv[k] || process.env[k];
  const amazon = await defaultDeps();
  return {
    ...amazon,
    config: JSON.parse(readFileSync(join(ROOT, 'config', 'amazon-inbound.json'), 'utf8')),
    statePath: join(STATE_DIR, 'state.json'),
    lockPath: join(STATE_DIR, '.lock'),
    seasonalPath: join(ROOT, 'data', 'reports', 'culina-report', 'seasonal.json'),
    contactPhone: envOf('AMAZON_INBOUND_CONTACT_PHONE') || undefined,
    creds: hushmailCredentials({ HUSHMAIL_USER: envOf('HUSHMAIL_USER'), HUSHMAIL_PASSWORD: envOf('HUSHMAIL_PASSWORD') }),
    resendKey: envOf('RESEND_API_KEY'),
    fetchMail: fetchFromAllFolders,
    sendMail,
    notify,
    log: console.log,
  };
}

async function main() {
  try {
    const out = await run(process.argv.slice(2), await realDeps());
    if (out?.exitCode) process.exitCode = out.exitCode; // a dry-run draft left ACTIVE
  } catch (e) {
    console.error(e);
    // Deferred: an unreadable state file already emailed Sean from run(); a mail or config
    // failure here repeats every 15 minutes and must not email him every 15 minutes.
    await notify({ subject: `Culina inbound run failed: ${e.message}`, body: String(e?.stack || e), status: 'error', category: 'amazon' }).catch(() => {});
    process.exit(1);
  }
}

if (isDirectRun(import.meta.url)) main();
