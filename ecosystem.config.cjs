module.exports = {
  apps: [
    {
      name: 'seo-dashboard',
      script: 'agents/dashboard/index.js',
      args: '--port 4242 --public',
      interpreter: 'node',
      cwd: '/root/seo-claude',
      restart_delay: 5000,
      max_restarts: 10,
      // The dashboard leaks. Measured on the box 2026-09-05: it starts at ~64 MB
      // and climbs until the KERNEL OOM-killer takes it at ~420 MB anon-rss, on a
      // 961 MB machine — 7 kills in the trailing 24h and 647 lifetime restarts.
      // Every OOM victim in `journalctl` is this process.
      //
      // This caps the leak; it does not fix it. The cause is still unidentified —
      // see the PR for what was ruled in and out. What the cap buys is that the
      // restart becomes PM2's (graceful, logged, one process) instead of the
      // kernel's (SIGKILL, plus a system-wide OOM event that picks its own victim
      // by score). That second half is the real reason this is worth doing now:
      // the bloated dashboard is currently the fattest target on the box, so it
      // absorbs every kill. On 2026-09-05 14:00 UTC `chrome` invoked the
      // OOM-killer during the 15:00 scheduler window and the killer still chose
      // the dashboard — at a LOWER 331 MB, because the box was already tight. If
      // that selection ever inverts while `agents/publisher` is mid-Shopify-write,
      // the kill lands on a half-published post. Bounding the largest consumer is
      // what keeps the choice away from the scheduler.
      //
      // 300M is measured, not picked: ~3x normal operating size (64-92 MB
      // observed), and ~120 MB below the level the kernel has actually been
      // killing at, so PM2 always wins the race. Do not raise it toward 420
      // without re-measuring the kill point — the headroom IS the mechanism.
      max_memory_restart: '300M',
      // Restarts caused by the cap above are healthy and routine. min_uptime
      // scopes `max_restarts` to genuine crash-looping (10 exits inside a minute
      // of starting) so a memory recycle every few hours can never be mistaken
      // for instability and stop PM2 bringing the dashboard back.
      min_uptime: '60s',
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
