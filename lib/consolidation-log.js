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
 * from whichever script runs first (setup-survivor-collections.mjs in the
 * documented run order). Call `appendAction` after every successful mutation
 * in all three mutating scripts.
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

export function writePreState(state, filePath = preStatePath()) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(state, null, 2));
  return filePath;
}

/** Append one applied action to the JSONL log as it succeeds. */
export function appendAction(entry, filePath = actionLogPath()) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`);
  return filePath;
}
