#!/usr/bin/env node
/**
 * Run Shopify CLI theme commands with this repo's existing custom-app token.
 *
 * WHY THIS EXISTS
 * ───────────────
 * Theme work was happening on the LIVE theme because there was no other way to
 * see a change render. Sean, 2026-08-30: "We should not be making changes to the
 * live theme and testing them in production."
 *
 * The obvious answer, Shopify's Theme Access app, is not installed on this store
 * and the operator does not want another app. It is also not required. Shopify
 * documents THREE auth methods for `shopify theme`, and the third is a
 * **custom app access token** with `read_themes` + `write_themes`, passed as
 * `--password`. This store's existing custom app already holds both (verified
 * 2026-08-30 against /admin/oauth/access_scopes.json), which is why every theme
 * read in this repo already works. So the CLI needs no new credential at all —
 * only the token it was never handed.
 *
 * `unauthenticated_read_content` is NOT granted, and that is a known, bounded
 * gap: per Shopify's docs it enables HOT RELOADING via the Storefront API. The
 * dev server runs without it; edits need a manual refresh.
 *
 * THE GUARD
 * ─────────
 * `shopify theme push` writes to whichever theme it is pointed at, and the
 * default target is the one you last used — which on this store is the LIVE
 * theme. That is precisely the accident this wrapper exists to prevent, so:
 *
 *   - `dev` and `push` default to a DEVELOPMENT/unpublished theme.
 *   - Anything that could target the live theme (`--live`, `--theme <live id>`,
 *     `--publish`, `--allow-live`) is REFUSED unless `--allow-live-theme` is
 *     passed, which a human types after deciding. Same shape as the publisher's
 *     `--allow-divergent-mirror`: the routine caller must not be able to disarm
 *     the gate, or it is not a gate.
 *
 * USAGE
 *   npm run theme -- dev                 # local server, development theme
 *   npm run theme -- push --unpublished  # a preview theme nobody is served
 *   npm run theme -- list
 */

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isDirectRun } from '../lib/is-direct-run.js';
import { resolveLiveThemeId, UNRESOLVED_LIVE_THEME_REASON } from '../lib/shopify-live-theme.js';

const ROOT = process.env.SEO_CLAUDE_ROOT || join(dirname(fileURLToPath(import.meta.url)), '..');

/** The live theme on this store. Named so the guard can recognise it by id. */
/**
 * THIS FILE HOLDS NO HARDCODED LIVE THEME ID, and that absence is the fix
 * rather than an omission. It used to pin one as a constant; the store was
 * republished on 2026-09-01, that theme became an unpublished backup, and the
 * guard went on protecting a dead theme while waving through the real one.
 * See `lib/shopify-live-theme.js` for the full account. The published theme is
 * resolved from the API at call time by `role === 'main'`, which is the only
 * thing that cannot go stale.
 */

/**
 * Every spelling the Shopify CLI accepts for "target this theme id".
 * `indexOf('--theme')` alone missed `--theme=<id>` entirely, which is the
 * form a scripted caller naturally writes — the second half of the same bug.
 */
export function targetedThemeIds(argv) {
  const ids = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = String(argv[i]);
    const eq = a.match(/^(?:--theme|-t)=(.+)$/);
    if (eq) { ids.push(eq[1]); continue; }
    if (a === '--theme' || a === '-t') {
      if (argv[i + 1] !== undefined) ids.push(String(argv[i + 1]));
    }
  }
  return ids;
}

/**
 * Arguments that could point a write at the published theme.
 * `--allow-live-theme` is the deliberate override and is stripped before exec.
 */
export const LIVE_TARGETING_FLAGS = Object.freeze([
  '--live', '--publish', '--allow-live', '--development-theme-id',
]);

/**
 * @param {string[]} argv
 * @param {string|null} liveThemeId  resolved at call time; `null` means "could
 *   not determine", which REFUSES an id-targeting push rather than allowing it.
 * @returns {{ok:true, argv:string[]}|{ok:false, reason:string}}
 */
export function guardArgs(argv, liveThemeId) {
  const allowLive = argv.includes('--allow-live-theme');
  const rest = argv.filter((a) => a !== '--allow-live-theme');

  if (allowLive) return { ok: true, argv: rest };

  for (const flag of LIVE_TARGETING_FLAGS) {
    if (rest.includes(flag)) {
      return { ok: false, reason: `${flag} targets the published theme` };
    }
  }

  const targeted = targetedThemeIds(rest);
  if (targeted.length > 0) {
    // Unknown live id + an explicit target = refuse. The failure direction has
    // to be "we declined to push", never "we pushed to production because we
    // could not check". A `--unpublished` push needs no id and is unaffected.
    if (!liveThemeId) return { ok: false, reason: UNRESOLVED_LIVE_THEME_REASON };
    if (targeted.some((id) => id === String(liveThemeId))) {
      return { ok: false, reason: `--theme ${liveThemeId} is the LIVE theme` };
    }
  }
  // A bare `push` with no target reuses the last-used theme, which on this store
  // is the live one. Make the safe choice explicit rather than inherited.
  if (rest[0] === 'push' && !rest.includes('--unpublished') && !rest.includes('--theme')) {
    return { ok: false, reason: 'a bare `push` reuses the last-used theme, which here is LIVE' };
  }
  return { ok: true, argv: rest };
}

function envValue(key) {
  if (process.env[key]) return process.env[key];
  try {
    const m = readFileSync(join(ROOT, '.env'), 'utf8').match(new RegExp(`^${key}=(.*)$`, 'm'));
    return m ? m[1].trim().replace(/^["']|["']$/g, '') : null;
  } catch { return null; }
}

async function main(argv) {
  if (!argv.length || argv.includes('--help')) {
    console.log('Usage: npm run theme -- <dev|push --unpublished|list|info> [...]');
    console.log('Live-theme writes require --allow-live-theme, typed deliberately.');
    return 0;
  }

  // Resolved from the API, never from a constant — see resolveLiveThemeId.
  // A failure here yields null, which makes the guard refuse rather than allow.
  let liveThemeId = null;
  try {
    liveThemeId = await resolveLiveThemeId();
  } catch {
    liveThemeId = null;
  }
  if (!liveThemeId) {
    console.error('WARNING: could not resolve the live theme id from the API.');
  }

  const guard = guardArgs(argv, liveThemeId);
  if (!guard.ok) {
    console.error(`REFUSED: ${guard.reason}.`);
    console.error('This wrapper exists so theme changes are not tested in production.');
    console.error('Preview instead:  npm run theme -- push --unpublished');
    console.error('If you have decided to write to the live theme, pass --allow-live-theme.');
    return 64;
  }

  const { getAccessToken } = await import('../lib/shopify.js');
  const token = await getAccessToken();
  const store = envValue('SHOPIFY_STORE');
  if (!token || !store) { console.error('missing SHOPIFY token or SHOPIFY_STORE'); return 1; }

  // `theme` is prepended here rather than typed by the caller, so the guard
  // above always sees the subcommand in a known position and a caller can never
  // reach a NON-theme command (`shopify app deploy`) through this wrapper.
  const args = ['theme', ...guard.argv, '--store', store, '--password', token];
  console.log(`shopify theme ${guard.argv.join(' ')} --store ${store} --password ***`);

  return new Promise((resolve) => {
    const child = spawn('shopify', args, {
      cwd: join(ROOT, 'theme'),
      stdio: 'inherit',
      // Hot reload needs unauthenticated_read_content, which this app lacks.
      env: { ...process.env, SHOPIFY_CLI_THEME_TOKEN: token, SHOPIFY_FLAG_STORE: store },
    });
    child.on('close', (c) => resolve(c ?? 1));
    child.on('error', (e) => { console.error(`could not run the Shopify CLI: ${e.message}`); resolve(1); });
  });
}

if (isDirectRun(import.meta.url)) {
  main(process.argv.slice(2)).then((c) => process.exit(c));
}
