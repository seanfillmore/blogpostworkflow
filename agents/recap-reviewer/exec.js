/**
 * The one process runner the recap reviewer hands to lib/fix-session.js,
 * lib/fix-ship.js and its own re-runs.
 *
 * Contract (lib/fix-ship.js depends on both halves):
 *   - `opts.timeout` is honoured: SIGTERM at the deadline, SIGKILL after a grace,
 *     and the result is `{ code: null, timedOut: true }`.
 *   - an explicit `opts.env` is used EXACTLY. process.env is never merged into
 *     it, because shipFix passes a minimal env to the unprivileged `recapfix`
 *     user and a merge would hand it root's environment (tokens included).
 */
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CAP = 4 * 1024 * 1024;
const append = (cur, d) => { const n = cur + d; return n.length > CAP ? n.slice(-CAP) : n; };

/**
 * @returns {(cmd:string, args?:string[], opts?:{cwd?:string, env?:object, timeout?:number}) =>
 *   Promise<{code:number|null, signal:string|null, stdout:string, stderr:string, timedOut:boolean}>}
 */
export function makeExec({ spawnImpl = spawn, root = ROOT, killGraceMs = 10_000 } = {}) {
  return (cmd, args = [], opts = {}) => new Promise((resolve) => {
    const { cwd = root, env, timeout } = opts || {};
    let stdout = ''; let stderr = ''; let timedOut = false; let done = false;
    let timer; let killTimer;
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer); clearTimeout(killTimer);
      resolve(r);
    };
    let child;
    try {
      child = spawnImpl(cmd, args, { cwd, env: env === undefined ? process.env : env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      finish({ code: 127, signal: null, stdout: '', stderr: e.message, timedOut: false });
      return;
    }
    child.stdout?.on('data', (d) => { stdout = append(stdout, d); });
    child.stderr?.on('data', (d) => { stderr = append(stderr, d); });
    if (Number.isFinite(timeout) && timeout > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        try { child.kill('SIGTERM'); } catch { /* gone */ }
        killTimer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, killGraceMs);
      }, timeout);
    }
    child.on('error', (e) => finish({ code: 127, signal: null, stdout, stderr: `${stderr}${e.message}`, timedOut: false }));
    child.on('close', (code, signal) => finish({
      code: timedOut ? null : code, signal: signal || null, stdout, stderr, timedOut,
    }));
  });
}
