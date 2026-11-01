import { fetchPageSpeed, parsePsiResult } from '/Users/seanfillmore/Code/Claude/lib/pagespeed.js';
import { writeFileSync } from 'node:fs';
const OUT = '/private/tmp/claude-501/-Users-seanfillmore-Code-Claude/363304d7-fc64-470b-8f25-d8d7cc74b167/scratchpad/psi-9.4.0.json';
const B = 'https://www.realskincare.com';
const pages = [['home', '/'], ['collection', '/collections/coconut-oil-lotion'], ['pdp-moisturizer', '/products/coconut-moisturizer'], ['pdp-lotion', '/products/coconut-lotion'], ['article', '/blogs/news/best-soap-for-tattoos-what-to-use-for-safe-healing-3']];
const results = [];
for (const [label, path] of pages) for (const strategy of ['mobile', 'desktop']) {
  try {
    const psi = await fetchPageSpeed(B + path, strategy);
    const parsed = parsePsiResult(psi, { url: B + path, strategy });
    const a = psi.lighthouseResult.audits;
    const tps = (a['third-party-summary']?.details?.items || []).map((i) => ({ entity: i.entity?.text ?? i.entity, kb: Math.round((i.transferSize || 0) / 1024), blockingMs: Math.round(i.blockingTime || 0), mainThreadMs: Math.round(i.mainThreadTime || 0) }));
    const boot = (a['bootup-time']?.details?.items || []).slice(0, 12).map((i) => ({ url: String(i.url).slice(0, 120), scriptingMs: Math.round(i.scripting || 0), totalMs: Math.round(i.total || 0) }));
    const unusedJs = (a['unused-javascript']?.details?.items || []).slice(0, 12).map((i) => ({ url: String(i.url).slice(0, 120), kb: Math.round((i.totalBytes || 0) / 1024), wastedKb: Math.round((i.wastedBytes || 0) / 1024) }));
    const lcpEl = a['largest-contentful-paint-element']?.details?.items?.[0]?.items?.[0]?.node?.snippet ?? null;
    results.push({ label, strategy, score: parsed.score, metrics: parsed.metrics, diagnostics: parsed.diagnostics, thirdParty: tps, bootup: boot, unusedJs, lcpEl });
    console.log(`${label}/${strategy} score ${parsed.score} lcp ${Math.round(parsed.metrics.lcp)} tbt ${Math.round(parsed.metrics.tbt)} cls ${(parsed.metrics.cls ?? 0).toFixed(3)}`);
  } catch (e) { results.push({ label, strategy, error: e.message }); console.log(`${label}/${strategy} ERROR ${e.message}`); }
  writeFileSync(OUT, JSON.stringify(results, null, 2));
}
console.log('done ->', OUT);
