/**
 * Pre-state capture and applied-action logging for the 2026-07-27 collection
 * consolidation. Without this, reversing the run means re-deriving which of
 * 84 collections were published and deleting 61+ redirects by hand, and the
 * nav is worse — menuUpdate replaces the whole item tree, so the pre-state
 * exists nowhere else once it's overwritten.
 *
 * `capturePreState` is pure network-in, object-out so it's testable with
 * injected fetch functions. `writePreState` / `appendAction` do the actual
 * filesystem writes and take an explicit path so tests never touch the real
 * data/ directory.
 *
 * Call `capturePreState` + `writePreState` once, before the first mutation,
 * from setup-survivor-collections.mjs — the documented (and, via
 * `assertPreStateCaptured`, enforced) first script in the run order. The
 * other two mutating scripts (consolidate-collections.mjs,
 * update-navigation.mjs) call `assertPreStateCaptured` before their first
 * mutation and hard-fail if it hasn't run yet, rather than proceeding with no
 * rollback record. Call `appendAction` after every successful mutation in all
 * three mutating scripts.
 */

import fs from 'node:fs';
import path from 'node:path';

const REPORT_DIR = 'data/reports/collection-consolidation';
const MENUS_QUERY = `{ menus(first: 20) { nodes { id handle title
  items { id title type url resourceId items { id title type url resourceId } } } } }`;

function isoDate(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

export function preStatePath(date = new Date()) {
  return path.join(REPORT_DIR, `pre-state-${isoDate(date)}.json`);
}

export function actionLogPath(date = new Date()) {
  return path.join(REPORT_DIR, `actions-${isoDate(date)}.jsonl`);
}

/**
 * Gather everything a rollback would need: every collection's id/handle/
 * published_at, all 12 menus' full item trees, and the survivors' body_html.
 * Takes the fetch functions as arguments (rather than importing lib/shopify.js
 * directly) so it's testable without network access.
 */
export async function capturePreState({ getCustomCollections, getSmartCollections, shopifyGraphQL, survivorHandles }) {
  const [custom, smart] = await Promise.all([
    getCustomCollections({ limit: 250 }),
    getSmartCollections({ limit: 250 }),
  ]);
  const all = [...custom, ...smart];

  const { menus } = await shopifyGraphQL(MENUS_QUERY);

  const survivors = all
    .filter((c) => (survivorHandles || []).includes(c.handle))
    .map((c) => ({ handle: c.handle, id: c.id, body_html: c.body_html ?? null }));

  return {
    capturedAt: new Date().toISOString(),
    collections: all.map((c) => ({ id: c.id, handle: c.handle, published_at: c.published_at ?? null })),
    menus: menus.nodes,
    survivors,
  };
}

/**
 * Write-once. `filePath` is date-scoped (see `preStatePath`), so a same-day
 * re-run — e.g. an operator recovering from a mid-run crash — would otherwise
 * silently overwrite the true pre-mutation baseline with state captured after
 * some mutations already landed, destroying the only rollback record. Refuse
 * instead: the first file written for a given date is authoritative, and
 * callers that legitimately re-run the same day (see
 * setup-survivor-collections.mjs) must check `preStateExists` first and skip
 * the capture rather than call this twice.
 */
export function writePreState(state, filePath = preStatePath()) {
  if (fs.existsSync(filePath)) {
    throw new Error(
      `Refusing to overwrite existing pre-state snapshot at ${filePath}. ` +
      'A same-day re-run must not replace the true pre-mutation rollback baseline. ' +
      'If you have verified no mutations have landed since it was captured (e.g. this ' +
      'is a stale leftover from a previous day), delete it manually and re-run.'
    );
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(state, null, 2));
  return filePath;
}

/** Whether a pre-state snapshot has already been captured for the given date. */
export function preStateExists(date = new Date()) {
  return fs.existsSync(preStatePath(date));
}

/**
 * Hard precondition for the two mutating scripts that do not themselves
 * capture pre-state (consolidate-collections.mjs, update-navigation.mjs).
 * Only setup-survivor-collections.mjs captures pre-state, per the documented
 * run order — this turns that documentation into an enforced precondition
 * instead of a convention a mis-ordered run can silently violate. Call this
 * once, right before the first mutating call, under --apply only.
 */
export function assertPreStateCaptured(date = new Date()) {
  const p = preStatePath(date);
  if (!fs.existsSync(p)) {
    throw new Error(
      `No pre-state snapshot found at ${p}. Run setup-survivor-collections.mjs ` +
      '--apply first — it captures the rollback baseline (every collection\'s ' +
      'publish state, all menu item trees, survivor body_html) before anything else ' +
      'mutates the store. Re-run this script once that has completed.'
    );
  }
  return p;
}

/** Append one applied action to the JSONL log as it succeeds. */
export function appendAction(entry, filePath = actionLogPath()) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`);
  return filePath;
}
