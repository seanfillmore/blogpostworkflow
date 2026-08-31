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

const ROOT = process.env.SEO_CLAUDE_ROOT || join(dirname(fileURLToPath(import.meta.url)), '..');

/** The live theme on this store. Named so the guard can recognise it by id. */
export const LIVE_THEME_ID = '147480051882';

/**
 * Arguments that could point a write at the published theme.
 * `--allow-live-theme` is the deliberate override and is stripped before exec.
 */
export const LIVE_TARGETING_FLAGS = Object.freeze([
  '--live', '--publish', '--allow-live', '--development-theme-id',
]);

/**
 * @returns {{ok:true, argv:string[]}|{ok:false, reason:string}}
 */
export function guardArgs(argv) {
  const allowLive = argv.includes('--allow-live-theme');
  const rest = argv.filter((a) => a !== '--allow-live-theme');

  if (allowLive) return { ok: true, argv: rest };

  for (const flag of LIVE_TARGETING_FLAGS) {
    if (rest.includes(flag)) {
      return { ok: false, reason: `${flag} targets the published theme` };
    }
  }
  const themeIdx = rest.indexOf('--theme');
  if (themeIdx !== -1 && String(rest[themeIdx + 1] || '').includes(LIVE_THEME_ID)) {
    return { ok: false, reason: `--theme ${LIVE_THEME_ID} is the LIVE theme` };
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

  const guard = guardArgs(argv);
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
