/**
 * The edit gate for LIVE blog articles: one question every writer asks before it
 * changes a page Google has already ranked. "May I make THIS KIND of edit to
 * THIS page NOW?"
 *
 * ── WHY IT EXISTS ───────────────────────────────────────────────────────────
 *
 * `toothpaste-without-sls-what-to-know-best-options` was the biggest page on the
 * blog (#5 for "sls free toothpaste", ~13 clicks/day). Between 2026-08-31 and
 * 2026-09-22 SIX different writers changed it NINE times: meta-optimizer
 * retitled it twice (list framing -> product framing), a title sweep minted a
 * truncated SERP title, cannibalization-resolver LLM-merged two other posts into
 * its body twice (09-06, 09-13), internal-linker added links, and a link fixer
 * sent its Add to Cart button to a blog post. On 2026-09-13 it fell to #10 and
 * clicks fell 93%. It was a locked winner the whole time; nothing could see the
 * lock because a second post directory named for its handle shadowed the real
 * one. And `lib/change-log.js` already had the rule "one change, then measure
 * 28 days", in `proposeChange`, which no writer had ever called.
 *
 * So this is not a new idea. It is the existing rule, made unavoidable.
 *
 * ── THE POLICY ──────────────────────────────────────────────────────────────
 *
 *   kind         what it is                                  frozen  cooldown  winner
 *   compliance   removing a claim the law forbids            allow   allow     allow
 *   repair       fixing a broken/redirected link, mechanical allow   allow     allow
 *   enhance      additive: internal links, schema, buy box   BLOCK   allow     allow
 *   serp         title / H1 / title_tag / description        BLOCK   BLOCK     allow*
 *   rewrite      body rewrite, merge, refresh, LLM revision  BLOCK   BLOCK     BLOCK
 *
 *   * a winner's title/meta may still be tested (lib/post-lock.js: a winner's
 *     CTR is the lever it has left), but only once per cooldown.
 *
 * COOLDOWN: after a `serp` or `rewrite` edit, no further `serp` or `rewrite`
 * edit for COOLDOWN_DAYS (28, the change-log's MEASUREMENT_DAYS: the window
 * every measurement in this fleet reads). One change at a time, then measure.
 * The clock starts at the LATER of:
 *   - `last_material_edit.at` in the post's state.json (stamped by
 *     `recordMaterialEdit` from every gated writer), and
 *   - the newest `title` / `meta_description` event the daily
 *     change-diff-detector logged for this page. That detector sees EVERY
 *     writer, gated or not, so an ungated script still starts the clock. Body
 *     events are NOT used: a body hash also moves on a link repair, and a repair
 *     must not lock out the next real improvement.
 *
 * FREEZE: `edit_freeze: { until, reason, set_at }` in state.json, set by
 * `scripts/post-edit-freeze.mjs`. Blocks everything but compliance and repair
 * until `until`. It always EXPIRES: a hold without an expiry is how the
 * pinned-mirror list and the six-day held merge became outages nobody looked for.
 *
 * ── HOW IT FAILS ────────────────────────────────────────────────────────────
 *
 * Every local directory that could BE this article is read (the handle's own
 * dir, `resolvePostSlug`, `resolveArticleHandle`, and any post declaring the
 * handle) and the STRICTEST answer wins. A shadow directory can add protection,
 * never remove it. An unreadable state on any candidate refuses serp/rewrite,
 * the same "I could not read it is not it is not locked" rule as post-lock.js.
 * A page with no local post at all gets the cooldown from change events only.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  listAllSlugs, getMetaPath, getStatePath, handleFromUrl,
  resolvePostSlug, resolveArticleHandle, declaredHandles, writePostMeta,
} from './posts.js';
import { readLockState, LOCK_LOCKED, LOCK_UNREADABLE } from './post-lock.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EVENTS_DIR = process.env.CHANGE_LOG_ROOT_OVERRIDE
  ? join(process.env.CHANGE_LOG_ROOT_OVERRIDE, 'events')
  : join(ROOT, 'data', 'changes', 'events');

export const COOLDOWN_DAYS = 28;
export const KINDS = ['compliance', 'repair', 'enhance', 'serp', 'rewrite'];
const MATERIAL = new Set(['serp', 'rewrite']);
const DAY = 86400000;

/**
 * Pure policy. Given what we know about a page, may this kind of edit happen?
 * @param {string} kind one of KINDS
 * @param {{now:string, freeze?:{until:string,reason?:string}|null, locked?:boolean,
 *          unreadable?:boolean, lastMaterialAt?:string|null}} facts
 * @returns {{allowed:boolean, reason:string, until?:string}}
 */
export function decideEdit(kind, facts) {
  if (!KINDS.includes(kind)) throw new Error(`post-edit-gate: unknown edit kind "${kind}" (expected ${KINDS.join('/')})`);
  const { now, freeze = null, locked = false, unreadable = false, lastMaterialAt = null } = facts;
  if (kind === 'compliance' || kind === 'repair') return { allowed: true, reason: `${kind} edits are always allowed` };

  if (freeze && freeze.until && now < freeze.until) {
    return { allowed: false, reason: `page frozen until ${freeze.until.slice(0, 10)}${freeze.reason ? `: ${freeze.reason}` : ''}`, until: freeze.until };
  }
  if (kind === 'enhance') return { allowed: true, reason: 'additive edit, page not frozen' };

  if (unreadable) return { allowed: false, reason: 'post state unreadable, refusing rather than guessing' };
  if (kind === 'rewrite' && locked) return { allowed: false, reason: 'locked winner: its body is not rewritten' };

  if (lastMaterialAt) {
    const until = new Date(Date.parse(lastMaterialAt) + COOLDOWN_DAYS * DAY).toISOString();
    if (now < until) {
      return { allowed: false, reason: `measuring the last change (${lastMaterialAt.slice(0, 10)}); next ${kind} edit allowed ${until.slice(0, 10)}`, until };
    }
  }
  return { allowed: true, reason: 'no freeze, no cooldown' };
}

function readJson(path) {
  if (!existsSync(path)) return { value: null };
  try { return { value: JSON.parse(readFileSync(path, 'utf8')) }; } catch (e) { return { error: e.message }; }
}

/** Every local post dir that could be this article. */
export function candidateSlugs(target) {
  const handle = handleFromUrl(String(target || '')) || String(target || '');
  const set = new Set();
  if (!handle) return [];
  if (existsSync(getMetaPath(handle)) || existsSync(getStatePath(handle))) set.add(handle);
  for (const s of [resolvePostSlug(handle), resolveArticleHandle(handle)]) if (s) set.add(s);
  for (const slug of listAllSlugs()) {
    const meta = readJson(getMetaPath(slug)).value || {};
    const state = readJson(getStatePath(slug)).value || {};
    if (declaredHandles({ ...meta, ...state }).includes(handle)) set.add(slug);
  }
  return [...set];
}

/** Newest title / meta_description change event for this handle, or null. */
export function lastSerpEventAt(handle, eventsDir = EVENTS_DIR) {
  if (!handle || !existsSync(eventsDir)) return null;
  let newest = null;
  const re = new RegExp(`^ch-\\d{4}-\\d{2}-\\d{2}-${handle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-(title|meta_description)-[a-z0-9]+\\.json$`);
  for (const month of readdirSync(eventsDir).sort().slice(-3)) {
    const dir = join(eventsDir, month);
    let files = [];
    try { files = readdirSync(dir); } catch { continue; }
    for (const f of files) {
      if (!re.test(f)) continue;
      const ev = readJson(join(dir, f)).value;
      if (ev?.changed_at && (!newest || ev.changed_at > newest)) newest = ev.changed_at;
    }
  }
  return newest;
}

/** Gather facts across every candidate dir; the strictest wins. */
export function readEditFacts(target, { now = new Date().toISOString(), eventsDir } = {}) {
  const handle = handleFromUrl(String(target || '')) || String(target || '');
  const slugs = candidateSlugs(target);
  const facts = { now, freeze: null, locked: false, unreadable: false, lastMaterialAt: null, slugs, handle };
  const later = (a, b) => (!a ? b : !b ? a : (a > b ? a : b));
  for (const slug of slugs) {
    const m = readJson(getMetaPath(slug));
    const s = readJson(getStatePath(slug));
    if (m.error || s.error) { facts.unreadable = true; continue; }
    const merged = { ...(m.value || {}), ...(s.value || {}) };
    // The lock is read only through lib/post-lock.js (pinned by
    // tests/agents/winner-lock-readers.test.js), once per candidate dir.
    const lock = readLockState(slug);
    if (lock.slug === slug && lock.state === LOCK_LOCKED) facts.locked = true;
    if (lock.slug === slug && lock.state === LOCK_UNREADABLE) facts.unreadable = true;
    const fz = merged.edit_freeze;
    if (fz?.until && (!facts.freeze || fz.until > facts.freeze.until)) facts.freeze = fz;
    facts.lastMaterialAt = later(facts.lastMaterialAt, merged.last_material_edit?.at || null);
  }
  facts.lastMaterialAt = later(facts.lastMaterialAt, lastSerpEventAt(handle, eventsDir));
  return facts;
}

/**
 * May a writer make this edit to this live article now?
 * @param {string} target article handle, URL or local slug
 * @param {'compliance'|'repair'|'enhance'|'serp'|'rewrite'} kind
 * @returns {{allowed:boolean, reason:string, until?:string, kind:string, slugs:string[]}}
 */
export function mayEditLivePost(target, kind, opts = {}) {
  const facts = readEditFacts(target, opts);
  return { ...decideEdit(kind, facts), kind, slugs: facts.slugs };
}

/**
 * Stamp a material edit so the cooldown starts. Call AFTER a successful live
 * write of kind serp or rewrite. Stamps every candidate dir, so a later lookup
 * through any of them sees it. A no-op for other kinds.
 */
export function recordMaterialEdit(target, kind, source, { now = new Date().toISOString() } = {}) {
  if (!MATERIAL.has(kind)) return [];
  const slugs = candidateSlugs(target);
  for (const slug of slugs) writePostMeta(slug, { last_material_edit: { at: now, kind, source } });
  return slugs;
}
