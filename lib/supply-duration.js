/**
 * How long does a bundle actually last?
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * On 2026-08-02 a gallery frame shipped to the storefront saying the Head-to-Toe
 * box was "60 DAYS of everything". It holds one of each of seven products. The
 * 90-Day Clean Swap sells THREE of each for 90 days, so one of each is thirty —
 * the store's own arithmetic contradicted the claim by 2x, and nothing in the
 * codebase was in a position to notice, because the number came from a metafield
 * somebody typed and the frame's verify() only checked it was a positive integer.
 *
 * A metafield is not evidence. This module is the evidence.
 *
 * ── The rule ────────────────────────────────────────────────────────────────
 * A box lasts as long as the FIRST thing in it runs out. Not the average, not the
 * longest, not the headline product — the minimum. Head-to-Toe makes the point:
 * its deodorant is ~90 days of supply and its body cream is ~28, so the box stops
 * being "everything" after about four weeks while three of its seven items are
 * still half full.
 *
 * And because every rate in config/consumption-rates.json is a reorder gap, every
 * rate is an UPPER bound — consumption plus however long the customer waited. So
 * the number this returns is itself a ceiling, and a claim should sit at or under
 * it, never on top of it and never above.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { rates } = JSON.parse(readFileSync(join(ROOT, 'config', 'consumption-rates.json'), 'utf8'));

/**
 * The binding duration of a set of components.
 *
 * @param {Array<{product: string, qty: number}>} components
 * @returns {{days: number|null, limitedBy: string|null, unknown: string[], detail: Array}}
 *   `days` is null when nothing in the box has a measured rate — in which case
 *   there is no evidence for ANY duration claim, which is a different and more
 *   honest answer than a number.
 */
export function bindingDuration(components) {
  const detail = [], unknown = [];
  for (const c of components) {
    const r = rates[c.product];
    if (!r) { unknown.push(c.product); continue; }
    detail.push({ product: c.product, qty: c.qty, daysPerUnit: r.daysPerUnit, days: r.daysPerUnit * c.qty, confidence: r.confidence });
  }
  detail.sort((a, b) => a.days - b.days);
  return {
    days: detail.length ? detail[0].days : null,
    limitedBy: detail.length ? detail[0].product : null,
    unknown,
    detail,
  };
}

/**
 * Throw unless `claimedDays` is supportable for these components.
 *
 * Deliberately strict in one direction only. Claiming less than the box holds
 * costs a little persuasion; claiming more is telling a customer the product
 * will last twice as long as it does, and over-supply promises are the
 * documented reason RSC subscribers churned.
 */
export function assertDurationClaim(claimedDays, components, label = 'this bundle') {
  if (!Number.isInteger(claimedDays) || claimedDays <= 0) {
    throw new Error(`${label}: duration claim "${claimedDays}" is not a positive whole number of days`);
  }
  const { days, limitedBy, unknown, detail } = bindingDuration(components);
  if (days === null) {
    throw new Error(`${label}: no component has a measured consumption rate, so a ${claimedDays}-day supply claim `
      + `has no evidence behind it. Add rates to config/consumption-rates.json or drop the claim.`);
  }
  if (claimedDays > days) {
    const worst = detail[0];
    throw new Error(
      `${label}: claims ${claimedDays} days, but the box stops being complete after ~${days} — `
      + `${limitedBy} runs out first (${worst.qty} x ${worst.daysPerUnit} d/unit, confidence: ${worst.confidence}). `
      + `That rate is itself an upper bound derived from reorder gaps, so the true figure is lower still.`
      + (unknown.length ? ` No rate for ${unknown.join(', ')} — the real binding component may not even be in this list.` : ''));
  }
  return { days, limitedBy, unknown, detail };
}
