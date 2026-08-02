/**
 * The Clean Swap — frame 2 (grid, variant-linked): what the chosen kit contains.
 *
 * Media plan: "Show exactly what the chosen kit contains." Built on the 90-Day's
 * contentsFrame with qtyEach 1 — the two bundles are the same four products at
 * different multiples, which is the whole reason that builder takes a quantity.
 *
 * Note from the plan, still true: Gentle and Calm differ only in the bar soap,
 * and Fresh changes all four. The per-kit renders make that visible rather than
 * asking the buyer to read three lists.
 */
import { contentsFrame } from '../90-day-clean-swap/contents-frame.mjs';

export default contentsFrame({
  handle: 'clean-swap',
  name: 'frame-02-kit-contents-cleanswap-fresh',
  kitName: 'Fresh',
  price: 59,
  qtyEach: 1,
  headline: 'Four full-size<br>products.',
  subline: 'One of each. Nothing travel-sized.',
});
