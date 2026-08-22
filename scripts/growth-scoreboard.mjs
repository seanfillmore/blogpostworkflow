// Salvaged from feature/growth-plan-1m before that branch was deleted (2026-08-21).
// The rest of that branch was superseded (dead Klaviyo flow ID XEMgA7, a PDF
// pipeline main has since replaced, a $99 price point that shipped at $121);
// this diagnostic had no equivalent on main and was lifted on its own.
/**
 * Growth KPI scoreboard — reconciles GA4 traffic against actual Shopify orders.
 *
 * GA4 "conversions" count multiple event types and overstate purchases (~4x as
 * of 2026-07-22), so any ad optimization against GA4 is optimizing against a
 * lie. This prints the TRUE purchase CVR (Shopify orders / GA4 sessions), the
 * GA4 CVR, and the overcount ratio — the standing instrument every Phase gate
 * in the $1M plan reads.
 *
 * CLI:  node scripts/growth-scoreboard.mjs [days]      (default 30)
 * Pure: computeScoreboard({ ga4Rows, orders })         (network-free, tested)
 */

export function computeScoreboard({ ga4Rows, orders }) {
  const sessions = ga4Rows.reduce((s, r) => s + r.sessions, 0);
  const ga4Conversions = ga4Rows.reduce((s, r) => s + r.conversions, 0);

  const byChannel = {};
  for (const r of ga4Rows) {
    (byChannel[r.channel] ??= { sessions: 0, conversions: 0, revenue: 0 });
    byChannel[r.channel].sessions += r.sessions;
    byChannel[r.channel].conversions += r.conversions;
    byChannel[r.channel].revenue += r.revenue;
  }

  const shopifyOrders = orders.count;
  return {
    sessions,
    ga4Conversions,
    shopifyOrders,
    ga4Cvr: sessions ? ga4Conversions / sessions : 0,
    trueCvr: sessions ? shopifyOrders / sessions : 0,
    ga4OvercountRatio: shopifyOrders ? ga4Conversions / shopifyOrders : null,
    aov: orders.aov,
    byChannel,
  };
}

function ymd(d) {
  return d.toISOString().slice(0, 10);
}

async function main() {
  const days = Number(process.argv[2]) || 30;
  const { fetchLandingPagesByChannel } = await import('../lib/ga4.js');
  const { getOrders } = await import('../lib/shopify.js');

  const end = ymd(new Date());
  const start = ymd(new Date(Date.now() - days * 864e5));

  const [ga4Rows, orders] = await Promise.all([
    fetchLandingPagesByChannel(start, end),
    getOrders(start, end),
  ]);

  const s = computeScoreboard({ ga4Rows, orders });
  const pct = (n) => `${(n * 100).toFixed(2)}%`;

  console.log(`\nGrowth scoreboard — ${days}d (${start}..${end})`);
  console.log('─'.repeat(52));
  console.log(`  Sessions (GA4):        ${s.sessions}`);
  console.log(`  Orders (Shopify):      ${s.shopifyOrders}   AOV $${s.aov}`);
  console.log(`  TRUE purchase CVR:     ${pct(s.trueCvr)}   <-- optimize on this`);
  console.log(`  GA4 reported CVR:      ${pct(s.ga4Cvr)}   (${s.ga4Conversions} "conversions")`);
  console.log(`  GA4 overcount ratio:   ${s.ga4OvercountRatio ? s.ga4OvercountRatio.toFixed(2) + 'x' : 'n/a'}   <-- 1.0x = trustworthy`);
  console.log('  By channel (sessions / GA4 conv / true-CVR-share):');
  Object.entries(s.byChannel)
    .sort((a, b) => b[1].sessions - a[1].sessions)
    .forEach(([k, v]) =>
      console.log(`    ${k.padEnd(18)} ${String(v.sessions).padStart(5)}  ${String(v.conversions).padStart(3)}c  $${v.revenue.toFixed(0)}`),
    );
  console.log('');
}

if (import.meta.url === `file://${process.argv[1]}`) main();
