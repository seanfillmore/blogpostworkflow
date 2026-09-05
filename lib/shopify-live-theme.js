/**
 * Which theme is PUBLISHED right now — asked of the API, never remembered.
 *
 * WHY THIS MODULE EXISTS
 * ──────────────────────
 * Two scripts each hardcoded the same live theme id and each used it to refuse
 * a write to production. The store was republished on 2026-09-01, the id became
 * an unpublished backup, and both guards went on protecting a dead theme while
 * waving through the real one. Nothing failed, nothing warned; a push simply
 * landed on a theme nobody serves, and the same guard would have allowed a push
 * to the live one.
 *
 * A guard that recognises its target by a constant expires the next time
 * somebody clicks Publish. `role === 'main'` is the only thing that cannot go
 * stale, so that is what this asks.
 *
 * It is a separate module from `lib/shopify.js` for the same reason
 * `lib/shopify-api-version.js` is: that file reads `.env` and throws at import
 * time without OAuth credentials, and these are standalone scripts.
 *
 * RETURNS `null` RATHER THAN THROWING, and callers must treat null as "refuse",
 * never as "allow". The failure direction is always "we declined to push".
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.SEO_CLAUDE_ROOT
  || join(dirname(fileURLToPath(import.meta.url)), '..');

export function envValue(key) {
  if (process.env[key]) return process.env[key];
  try {
    const m = readFileSync(join(ROOT, '.env'), 'utf8')
      .match(new RegExp(`^${key}=(.*)$`, 'm'));
    return m ? m[1].trim().replace(/^["']|["']$/g, '') : null;
  } catch {
    return null;
  }
}

/**
 * @returns {Promise<string|null>} the published theme's id, or null if it could
 *   not be determined for any reason (no credentials, network, bad response).
 */
export async function resolveLiveThemeId({ fetchImpl = fetch } = {}) {
  try {
    const { getAccessToken } = await import('./shopify.js');
    const { API_VERSION } = await import('./shopify-api-version.js');
    const store = envValue('SHOPIFY_STORE');
    const token = await getAccessToken();
    if (!store || !token) return null;

    const res = await fetchImpl(
      `https://${store}/admin/api/${API_VERSION}/themes.json`,
      { headers: { 'X-Shopify-Access-Token': token } },
    );
    if (!res.ok) return null;

    const body = await res.json();
    const main = (body?.themes || []).find((t) => t?.role === 'main');
    return main?.id ? String(main.id) : null;
  } catch {
    return null;
  }
}

/**
 * Shared refusal message so all three call sites say the same thing when the
 * live theme cannot be identified.
 */
export const UNRESOLVED_LIVE_THEME_REASON =
  'could not resolve which theme is live, so an explicit --theme target is refused';
