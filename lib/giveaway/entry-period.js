/**
 * The Entry Period boundary, decided in one place.
 *
 * Pure: no clock, no Klaviyo, no filesystem — callers pass the time and the
 * facts they read. Three consumers must agree about the same instant:
 *
 *   - the entry routes stop accepting writes once it has passed;
 *   - close-entry-period.mjs stops the flows and freezes the pool after it, and
 *     REFUSES before it (the 2026-08-20 cron bug fired 1.92h early and would have
 *     stopped the giveaway on people still entering);
 *   - the snapshot is never retaken once written, because the cron line has no
 *     year field and fires again every September 15.
 *
 * The boundary is inclusive, matching lib/giveaway/draw-snapshot.js: an action
 * AT the closing instant is inside the period.
 */

// A full ISO-8601 instant WITH its offset. Date.parse is far too forgiving to be
// the validator: 'September 14' parses (to the year 2001), which would read as
// closed long ago and refuse every entry, and a date with no offset parses in
// whatever timezone the host happens to run.
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

/** True once `nowMs` is strictly after the close. Throws on an unreadable date. */
export function isEntryPeriodClosed(nowMs, entryClosesAt) {
  const closesMs = ISO_INSTANT.test(String(entryClosesAt ?? '')) ? Date.parse(entryClosesAt) : NaN;
  if (!Number.isFinite(closesMs)) {
    throw new Error(`unparseable entryClosesAt: ${entryClosesAt}`);
  }
  return nowMs > closesMs;
}

/**
 * What the close job should do.
 *
 * @param {{nowMs:number, entryClosesAt:string, flows:Array<{id:string,status:string}>,
 *          apply:boolean, snapshotExists:boolean}} input
 * @returns {{refused:string|null, toDraft:string[], takeSnapshot:boolean}}
 */
export function planEntryPeriodClose({
  nowMs, entryClosesAt, flows = [], apply = false, snapshotExists = false,
}) {
  const closed = isEntryPeriodClosed(nowMs, entryClosesAt);
  if (apply && !closed) {
    return {
      refused: `refusing: it is before the close (${entryClosesAt}) — closing now would stop the giveaway on people still entering`,
      toDraft: [],
      takeSnapshot: false,
    };
  }
  return {
    refused: null,
    // Each flow independently. A flow already drafted (by hand, or by an earlier
    // run) must never skip the others — or the snapshot.
    toDraft: flows.filter((f) => f && f.id && f.status === 'live').map((f) => f.id),
    takeSnapshot: Boolean(apply && closed && !snapshotExists),
  };
}

/** Null when a snapshot may be written; otherwise the reason it may not. */
export function snapshotWriteRefusal({ exists, force }) {
  if (exists && !force) {
    return 'data/giveaway/draw-snapshot.json already exists — the frozen pool is never retaken without --force';
  }
  return null;
}
