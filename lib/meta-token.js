// lib/meta-token.js
/**
 * Resolve a Meta Graph API access token. ONE implementation, because there
 * were two byte-identical copies (`lib/meta-capi.js`'s `resolveLeadAccessToken`
 * and `lib/giveaway/meta-spend.js`'s `resolveAccessToken`) and a third was
 * about to be added. Same rule as AWARENESS_LEVELS and HEALTH_CLAIM_PATTERNS:
 * a hand-copied resolver is a resolver that drifts.
 *
 * TWO KEYS, IN THIS ORDER, AND THE ORDER IS THE WHOLE DESIGN:
 *
 *   1. FACEBOOK_ACCESS_TOKEN  — a USER token. The proven live path: a real
 *      giveaway entry took the dataset's Lead count 6 -> 7 on 2026-08-17
 *      through this token. It stays FIRST so nothing that works today changes
 *      behaviour. Measured 2026-09-19: expires 2026-10-19, data access
 *      2026-11-18, 6 scopes.
 *
 *   2. META_USER_ACCESS_TOKEN — a SYSTEM_USER token, and a strict superset.
 *      Measured 2026-09-19 via debug_token: `expires_at: 0` AND
 *      `data_access_expires_at: 0` (neither clock runs), 38 scopes containing
 *      all 6 of the user token's, all granular scopes unrestricted, and the
 *      CLI system user is role ADMIN with both Pages and act_946015593265647
 *      assigned. It can also read the product catalog, which the user token
 *      CANNOT (`(#100) This application has not been approved to use this api`).
 *
 * WHY A FALLBACK RATHER THAN A SWAP: the user token expires 2026-10-19, inside
 * the Meta launch window (docs/superpowers/specs/2026-09-19-meta-paid-launch-design.md).
 * Without this, every Graph call in the fleet starts failing on that date and
 * the failure looks like a permissions bug rather than an expiry. With it, the
 * expiry becomes a no-op. One thing deliberately NOT verified: SENDING a CAPI
 * event on the system token, which would require firing a real event — keeping
 * the user token first means the live Lead path is untouched either way.
 *
 * DATA ACCESS EXPIRES SEPARATELY FROM THE TOKEN. A Meta token can read
 * `expires_at: 0` and still have `data_access_expires_at` lapse, which presents
 * as a permission error rather than an expiry. Check both.
 *
 * PRECEDENCE WITHIN EACH KEY: process.env first, then .env — the precedence
 * this repo already uses for CREATIVES_BUDGET_BYTES, and for the same reason.
 * The paths that run unattended do not source .env, while a hand-run script
 * deliberately keeps .env out of process.env. Reading only one of them means
 * the token is missing in exactly one of those two worlds, and silently.
 *
 * Note the key order beats the source order: a FACEBOOK_ACCESS_TOKEN in .env
 * wins over a META_USER_ACCESS_TOKEN in process.env. That is intentional —
 * "which token" is a correctness question, "which source" is a plumbing one.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The keys to try, in order. Exported so a caller can report which it used. */
export const META_TOKEN_KEYS = Object.freeze(['FACEBOOK_ACCESS_TOKEN', 'META_USER_ACCESS_TOKEN']);

/** The real .env, and the default for `envFilePath`. */
export const ENV_FILE = join(ROOT, '.env');

/** Read one key out of an env file. Returns null when absent or unreadable. */
function fromEnvFile(key, envFilePath) {
  try {
    for (const line of readFileSync(envFilePath, 'utf8').split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const i = t.indexOf('=');
      if (i === -1) continue;
      if (t.slice(0, i).trim() === key) {
        const value = t.slice(i + 1).trim();
        return value || null;
      }
    }
  } catch { /* no .env is a valid state */ }
  return null;
}

/**
 * @param {Record<string, string|undefined>} [env]
 * @param {{ envFilePath?: string }} [opts] `envFilePath` is injectable ONLY so
 *   tests can be deterministic. A checkout with a real .env resolves key 1 from
 *   disk before the key-2 fallback is ever reached, so without this the fallback
 *   is untestable — which is exactly the branch that has to work on 2026-10-19.
 * @returns {string|null} the token, or null when neither key resolves anywhere.
 */
export function resolveMetaAccessToken(env = process.env, { envFilePath = ENV_FILE } = {}) {
  for (const key of META_TOKEN_KEYS) {
    if (env?.[key]) return env[key];
    const onDisk = fromEnvFile(key, envFilePath);
    if (onDisk) return onDisk;
  }
  return null;
}
