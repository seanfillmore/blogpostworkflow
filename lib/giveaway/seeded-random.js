/**
 * Deterministic randomness for the drawing.
 *
 * Math.random() cannot be reproduced, which would defeat the whole
 * published-seed design: the point is that anyone can re-run the draw against
 * the committed snapshot and get the same winner. Node ships no seeded RNG, so
 * this is a small, well-known one implemented in-repo.
 *
 * mulberry32 is chosen for being short enough to audit by eye. It is not
 * cryptographically secure and does not need to be — the seed is public by
 * design, and the property that matters is reproducibility, not unpredictability
 * after the fact.
 */
import { createHash } from 'node:crypto';

/** A 32-bit unsigned seed derived from an arbitrary seed string (e.g. "43214.87"). */
export function seedFromString(seed) {
  const digest = createHash('sha256').update(String(seed), 'utf8').digest();
  return digest.readUInt32BE(0);
}

/** mulberry32: returns a generator of floats in [0, 1). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Fisher-Yates, on a COPY.
 *
 * Descending loop with `j = floor(rand() * (i + 1))` — the ascending variant
 * with the wrong bound leaves element 0 fixed, which is a bias no casual test
 * catches and which would be indefensible in a prize draw.
 */
export function shuffle(items, rand) {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
