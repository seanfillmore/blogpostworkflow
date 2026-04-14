/**
 * Device Weights Library
 *
 * Blends desktop and mobile rank positions into a single "effective position"
 * weighted by where the site actually earns revenue. Used by decision agents
 * that need to translate per-device rankings into a single number for
 * filtering and scoring.
 *
 * Weights are computed by agents/device-weights/ and refreshed monthly.
 * See data/reports/device-weights/latest.json for the current values.
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const WEIGHTS_PATH = join(ROOT, 'data', 'reports', 'device-weights', 'latest.json');

/**
 * Normalize a URL to the path-only form GA4 uses as a landingPage value
 * (e.g. "https://site.com/blogs/news/foo" → "/blogs/news/foo"). Both the
 * input URL format from rank-tracker and the GA4 path format are supported.
 */
function urlToPath(url) {
  if (!url) return null;
  try {
    if (url.startsWith('http')) return new URL(url).pathname;
    return url.startsWith('/') ? url : '/' + url;
  } catch { return null; }
}

/**
 * Load the latest device-weights report, or null if it hasn't been computed
 * yet. Consumers should tolerate null — in that case `effectivePosition`
 * falls back to desktop-only behaviour.
 */
export function loadDeviceWeights() {
  if (!existsSync(WEIGHTS_PATH)) return null;
  try { return JSON.parse(readFileSync(WEIGHTS_PATH, 'utf8')); } catch { return null; }
}

/**
 * Compute the effective rank position by blending desktop and mobile
 * positions using revenue-share weights.
 *
 * Resolution order for weights:
 *   1. Per-page override if `url` resolves to a path in `weights.pages`
 *      (those pages have enough conversion history to be trusted).
 *   2. Site-wide weights.
 *
 * Null / degenerate cases:
 *   - Both positions null                → null (not ranking anywhere)
 *   - Only one device has a position     → that position (can't blend)
 *   - Weights missing entirely           → desktop position (safe fallback)
 *   - Weights present but desktop+mobile → 0 (e.g., all tablet): desktop position
 *
 * Returns an integer position (rounded).
 */
export function effectivePosition({ url, desktopPos, mobilePos, weights }) {
  if (desktopPos == null && mobilePos == null) return null;
  if (desktopPos == null) return mobilePos;
  if (mobilePos == null)  return desktopPos;
  if (!weights)           return desktopPos;

  let w = weights.site;
  if (url && weights.pages) {
    const path = urlToPath(url);
    if (path && weights.pages[path]) w = weights.pages[path];
  }

  const wM = w.mobile  || 0;
  const wD = w.desktop || 0;
  // Renormalize onto {mobile, desktop} — tablet rankings aren't tracked, so
  // we attribute tablet revenue proportionally to the two devices we do have.
  const total = wM + wD;
  if (total === 0) return desktopPos;
  const blended = (wM * mobilePos + wD * desktopPos) / total;
  return Math.round(blended);
}
