/**
 * Generate the internal email-review page (Artifact content) from the rendered
 * email HTML in scratchpad. Not part of the flow build — a review aid.
 */
import { readFileSync, writeFileSync } from 'fs';

const SCRATCH = '/private/tmp/claude-501/-Users-seanfillmore-Code-Claude/a4c848d1-f4cb-4610-824d-3139a4187110/scratchpad';
const meta = JSON.parse(readFileSync(`${SCRATCH}/render-meta.json`, 'utf8'));

const STEPS = [
  { key: 'e1_thankyou', when: '+1 hr', tag: 'Day 0', job: 'Thank-you + what to expect. Build trust, cut refunds.' },
  { key: 'e2_howto', when: '+2 days', tag: 'Day 2', job: 'How to use what they bought (personalized in-email). Deflect returns.' },
  { key: 'e3_set', when: '+3 days', tag: 'Day 5', job: 'Cross-sell the Set → clears $50 free-ship. The AOV lever.' },
  { key: 'e4_review', when: '+5 days', tag: 'Day 10', job: 'Judge.me review + soft referral (NEWCUS).' },
  { key: 'e5_restock', when: '+25 days', tag: 'Day 35', job: 'One-click reorder. Consumable buyers only. The repeat lever.' },
];

const esc = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
const escText = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const cards = STEPS.map((s, i) => {
  const m = meta[s.key];
  const html = readFileSync(`${SCRATCH}/render-${s.key}.html`, 'utf8');
  const num = String(i + 1).padStart(2, '0');
  return `
  <article class="card">
    <div class="card-meta">
      <div class="eyebrow"><span class="num">${num}</span><span class="chip">${s.tag} · ${s.when}</span></div>
      <h3>${escText(m.name.replace('Post-Purchase — ', '').replace(/^\d+\w?\s/, ''))}</h3>
      <p class="subject"><span class="k">Subject</span>${escText(m.subject)}</p>
      <p class="preview"><span class="k">Preview</span>${escText(m.preview)}</p>
      <p class="job">${escText(s.job)}</p>
    </div>
    <div class="card-frame">
      <iframe loading="lazy" title="${esc(m.name)}" srcdoc="${esc(html)}"></iframe>
    </div>
  </article>`;
}).join('\n');

const timeline = STEPS.map((s, i) => `
    <li>
      <span class="t-when">${s.when}</span>
      <span class="t-dot"></span>
      <span class="t-label">Email ${i + 1}</span>
    </li>`).join('');

const page = `<style>
  :root{
    --bg:#e9ebe8; --panel:#f6f7f4; --ink:#1c2420; --muted:#5c675f;
    --line:#d3d8d1; --accent:#2f5e3f; --accent-soft:#4f7d5f; --shadow:0 1px 2px rgba(28,36,32,.06),0 8px 24px rgba(28,36,32,.06);
    --frame-mat:#dfe3dd;
  }
  @media (prefers-color-scheme:dark){
    :root{ --bg:#131715; --panel:#1b201d; --ink:#e7ece7; --muted:#9aa79d;
      --line:#2b322d; --accent:#8fc2a1; --accent-soft:#6fa27f; --shadow:0 1px 2px rgba(0,0,0,.4),0 10px 30px rgba(0,0,0,.35);
      --frame-mat:#0e120f; }
  }
  :root[data-theme="light"]{ --bg:#e9ebe8; --panel:#f6f7f4; --ink:#1c2420; --muted:#5c675f; --line:#d3d8d1; --accent:#2f5e3f; --accent-soft:#4f7d5f; --frame-mat:#dfe3dd; --shadow:0 1px 2px rgba(28,36,32,.06),0 8px 24px rgba(28,36,32,.06); }
  :root[data-theme="dark"]{ --bg:#131715; --panel:#1b201d; --ink:#e7ece7; --muted:#9aa79d; --line:#2b322d; --accent:#8fc2a1; --accent-soft:#6fa27f; --frame-mat:#0e120f; --shadow:0 1px 2px rgba(0,0,0,.4),0 10px 30px rgba(0,0,0,.35); }

  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
    line-height:1.5;-webkit-font-smoothing:antialiased;}
  .mono{font-family:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;}
  .wrap{max-width:920px;margin:0 auto;padding:0 20px;}

  header.top{border-bottom:1px solid var(--line);background:color-mix(in srgb,var(--panel) 80%,transparent);position:sticky;top:0;z-index:5;backdrop-filter:blur(8px);}
  .top-in{display:flex;align-items:baseline;justify-content:space-between;gap:16px;flex-wrap:wrap;padding:18px 20px;max-width:920px;margin:0 auto;}
  .brand{font-family:Georgia,"Iowan Old Style",serif;letter-spacing:.14em;font-size:12px;text-transform:uppercase;color:var(--accent-soft);}
  .pill{font-size:11px;letter-spacing:.1em;text-transform:uppercase;padding:4px 10px;border-radius:999px;border:1px solid var(--accent);color:var(--accent);font-weight:600;}

  .hero{padding:46px 0 26px;}
  .hero h1{font-family:Georgia,"Iowan Old Style",serif;font-weight:600;font-size:34px;line-height:1.12;margin:0 0 12px;text-wrap:balance;max-width:18ch;}
  .hero p{margin:0;max-width:62ch;color:var(--muted);font-size:16px;}
  .hero .lead-accent{color:var(--ink);}

  .timeline{list-style:none;display:flex;gap:0;padding:22px;margin:26px 0 8px;background:var(--panel);border:1px solid var(--line);border-radius:14px;box-shadow:var(--shadow);overflow-x:auto;}
  .timeline li{flex:1;min-width:92px;display:flex;flex-direction:column;align-items:center;gap:8px;position:relative;text-align:center;}
  .timeline li:not(:last-child)::after{content:"";position:absolute;top:26px;left:50%;width:100%;height:2px;background:var(--line);}
  .t-when{font-size:11px;color:var(--muted);}
  .t-dot{width:11px;height:11px;border-radius:50%;background:var(--accent);position:relative;z-index:1;box-shadow:0 0 0 4px var(--panel);}
  .t-label{font-size:12px;font-weight:600;}

  .gallery{display:flex;flex-direction:column;gap:26px;padding:20px 0 60px;}
  .card{display:grid;grid-template-columns:300px 1fr;gap:0;background:var(--panel);border:1px solid var(--line);border-radius:16px;overflow:hidden;box-shadow:var(--shadow);}
  @media(max-width:760px){.card{grid-template-columns:1fr;}}
  .card-meta{padding:26px 24px;border-right:1px solid var(--line);}
  @media(max-width:760px){.card-meta{border-right:none;border-bottom:1px solid var(--line);}}
  .eyebrow{display:flex;align-items:center;gap:10px;margin-bottom:14px;}
  .num{font-family:Georgia,serif;font-size:13px;color:var(--accent);border:1px solid var(--accent);border-radius:50%;width:26px;height:26px;display:grid;place-items:center;}
  .chip{font-family:ui-monospace,Menlo,monospace;font-size:11px;letter-spacing:.03em;color:var(--muted);background:color-mix(in srgb,var(--accent) 10%,transparent);border-radius:6px;padding:3px 8px;}
  .card-meta h3{font-family:Georgia,"Iowan Old Style",serif;font-weight:600;font-size:19px;margin:0 0 14px;line-height:1.2;text-wrap:balance;}
  .subject,.preview{font-size:13.5px;margin:0 0 10px;color:var(--ink);}
  .preview{color:var(--muted);}
  .k{display:block;font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:var(--accent-soft);margin-bottom:2px;font-weight:600;}
  .job{font-size:13px;color:var(--muted);margin:16px 0 0;padding-top:14px;border-top:1px dashed var(--line);}
  .card-frame{background:var(--frame-mat);padding:20px;display:flex;justify-content:center;align-items:flex-start;}
  iframe{width:100%;max-width:600px;border:0;background:#fff;border-radius:8px;box-shadow:0 6px 18px rgba(0,0,0,.12);height:640px;}

  footer{border-top:1px solid var(--line);padding:30px 0 60px;color:var(--muted);font-size:14px;}
  footer h2{font-family:Georgia,serif;font-size:18px;color:var(--ink);margin:0 0 12px;}
  footer code{font-family:ui-monospace,Menlo,monospace;font-size:12.5px;background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:2px 7px;}
  footer ul{margin:8px 0 0;padding-left:18px;}
  footer li{margin:6px 0;}
  .status-good{color:var(--accent);font-weight:600;}
</style>

<header class="top"><div class="top-in">
  <span class="brand">Real Skin Care · Klaviyo</span>
  <span class="pill">Draft · not live</span>
</div></header>

<div class="wrap">
  <section class="hero">
    <h1>Post-Purchase Flow</h1>
    <p><span class="lead-accent">Five emails, built and staged as a draft in Klaviyo.</span> The sequence is engineered around the two things that move RSC revenue: pushing order value toward the <strong>$50 free-shipping</strong> line with a set cross-sell, and driving the repeat order with a one-click replenishment reorder. No price discounts — free shipping is the only lever, including a <strong>SETSHIP</strong> code that ships the bundle free in Email 3.</p>

    <ul class="timeline">${timeline}
    </ul>
  </section>

  <section class="gallery">
    ${cards}
  </section>

  <footer>
    <h2>Where this stands</h2>
    <p><span class="status-good">Built &amp; verified</span> — trigger (Placed Order, excludes cancellations), timing, links (all CTAs return 200, reorder cart-permalinks resolve), and per-product personalization all confirmed. Nothing sends yet.</p>
    <ul>
      <li>Emails&nbsp;2 &amp; 5 change content by what was purchased — previews above show a <em>deodorant&nbsp;+ toothpaste</em> order.</li>
      <li>To launch after your review: set the flow status to <code>live</code> in Klaviyo (or one API call), and archive the old unfinished draft so nobody double-sends.</li>
    </ul>
  </footer>
</div>

<script>
  // Size each email frame to its content (srcdoc is same-origin).
  function fit(f){ try{ var d=f.contentDocument||f.contentWindow.document; var h=d.body.scrollHeight; if(h>60) f.style.height=(h+24)+'px'; }catch(e){} }
  document.querySelectorAll('iframe').forEach(function(f){ f.addEventListener('load',function(){fit(f);}); fit(f); });
  window.addEventListener('resize',function(){ document.querySelectorAll('iframe').forEach(fit); });
</script>`;

writeFileSync(`${SCRATCH}/post-purchase-review.html`, page);
console.log('wrote review page', page.length, 'bytes');
