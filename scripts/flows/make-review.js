/**
 * Render every rebuilt flow email with representative context and generate a
 * consolidated review page (Artifact content). Review aid — not part of the build.
 */
import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import k from '../../lib/klaviyo.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRATCH = '/private/tmp/claude-501/-Users-seanfillmore-Code-Claude/a4c848d1-f4cb-4610-824d-3139a4187110/scratchpad';
const state = JSON.parse(readFileSync(join(__dirname, 'build-state.json'), 'utf8'));

const CTX = {
  base: { first_name: 'Sarah', organization: { name: 'Real Skin Care' } },
  viewed: { event: { Name: 'Coconut Oil Toothpaste — Natural Oral Care, Fluoride Free', URL: 'https://www.realskincare.com/products/coconut-oil-toothpaste', ImageURL: 'https://www.realskincare.com/cdn/shop/products/AMZ_RealSkin_Toothpaste-Hero-Mint_JRA_2000x2000_002B_grande.jpg', Price: '13.00' } },
  cart: { event: { extra: { checkout_url: 'https://www.realskincare.com/checkouts/ac/RECOVER', line_items: [
    { quantity: 1, product: { title: 'Best Coconut Oil Deodorant — All Natural Formula | 2oz', images: [{ src: 'https://www.realskincare.com/cdn/shop/products/deodorant_grande.jpg' }] } },
    { quantity: 2, product: { title: 'Coconut Oil Toothpaste — Natural Oral Care, Fluoride Free', images: [{ src: 'https://www.realskincare.com/cdn/shop/products/AMZ_RealSkin_Toothpaste-Hero-Mint_JRA_2000x2000_002B_grande.jpg' }] } },
  ] } } },
  order: { event: { Items: ['Best Coconut Oil Deodorant — All Natural Formula | 2oz', 'Coconut Oil Toothpaste — Natural Oral Care, Fluoride Free'] } },
};

// flow -> {title, trigger, emails:[{key, when, ctx}]}
const FLOWS = [
  { name: 'welcome-series', title: 'Welcome Series', trigger: 'Signs up to the list', emails: [
    { key: 'welcome_1', when: 'immediately', ctx: 'base' }, { key: 'welcome_2', when: '+1 day', ctx: 'base' },
    { key: 'welcome_3', when: '+3 days', ctx: 'base' }, { key: 'welcome_4', when: '+6 days', ctx: 'base' },
    { key: 'welcome_5', when: '+10 days', ctx: 'base' } ] },
  { name: 'abandoned-cart', title: 'Abandoned Cart', trigger: 'Starts checkout, doesn\'t finish', emails: [
    { key: 'cart_1', when: '+4 hr', ctx: 'cart' }, { key: 'cart_2', when: '+1 day', ctx: 'cart' }, { key: 'cart_3', when: '+3 days', ctx: 'cart' } ] },
  { name: 'browse-abandonment', title: 'Browse Abandonment', trigger: 'Views a product, doesn\'t add to cart', emails: [
    { key: 'browse_1', when: '+6 hr', ctx: 'viewed' }, { key: 'browse_2', when: '+30 hr', ctx: 'viewed' } ] },
  { name: 'product-review', title: 'Product Review / Cross-Sell', trigger: 'Order delivered', emails: [
    { key: 'review_1', when: '+14 days', ctx: 'order' } ] },
  { name: 'winback', title: 'Customer Winback', trigger: 'Ordered, then lapsed', emails: [
    { key: 'winback_1', when: '+75 days', ctx: 'base' }, { key: 'winback_2', when: '+90 days', ctx: 'base' }, { key: 'winback_3', when: '+97 days', ctx: 'base' } ] },
];

const esc = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
const escT = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const sections = [];
for (const f of FLOWS) {
  const templates = state[f.name].templates;
  const cards = [];
  for (const e of f.emails) {
    const ctx = { ...CTX.base, ...CTX[e.ctx] };
    const mod = (await import(`./flows/${f.name}.js`)).default;
    const meta = mod.emails[e.key];
    let r;
    try {
      r = await k.renderTemplate(templates[e.key], ctx);
    } catch (err) {
      // Coupon-tag emails can't be preview-rendered (Klaviyo assigns a unique code
      // per recipient at send). Substitute a sample code so the layout still shows.
      const html = (await k.getTemplate(templates[e.key])).html.replace(/\{%\s*coupon_code[^%]*%\}/g, 'WB25-SAMPLE');
      const r2 = await k.createTemplate({ name: `__ZZ_PREVIEW_${e.key}`, html });
      r = await k.renderTemplate(r2.id, ctx).catch(() => ({ html }));
      await k.klaviyoRequest('DELETE', `/templates/${r2.id}/`).catch(() => {});
    }
    cards.push(`
      <article class="card">
        <div class="card-meta">
          <div class="chip">${e.when}</div>
          <h3>${escT(meta.name.replace(/^.*— \d+ /, ''))}</h3>
          <p class="subject"><span class="k">Subject</span>${escT(meta.subject)}</p>
          <p class="preview"><span class="k">Preview</span>${escT(meta.preview)}</p>
        </div>
        <div class="card-frame"><iframe loading="lazy" title="${esc(meta.name)}" srcdoc="${esc(r.html)}"></iframe></div>
      </article>`);
  }
  sections.push(`
    <section class="flow">
      <div class="flow-head">
        <h2>${escT(f.title)}</h2>
        <p class="trigger"><span class="dot"></span>Triggers when a customer ${escT(f.trigger.toLowerCase())} · ${f.emails.length} email${f.emails.length > 1 ? 's' : ''}</p>
      </div>
      ${cards.join('\n')}
    </section>`);
}

const page = `<title>Klaviyo Flows — Rebuild Review</title>
<style>
  :root{ --bg:#e9ebe8;--panel:#f6f7f4;--ink:#1c2420;--muted:#5c675f;--line:#d3d8d1;--accent:#2f5e3f;--accent-soft:#4f7d5f;--frame-mat:#dfe3dd;--shadow:0 1px 2px rgba(28,36,32,.06),0 8px 24px rgba(28,36,32,.06); }
  @media (prefers-color-scheme:dark){ :root{ --bg:#131715;--panel:#1b201d;--ink:#e7ece7;--muted:#9aa79d;--line:#2b322d;--accent:#8fc2a1;--accent-soft:#6fa27f;--frame-mat:#0e120f;--shadow:0 1px 2px rgba(0,0,0,.4),0 10px 30px rgba(0,0,0,.35); } }
  :root[data-theme="light"]{ --bg:#e9ebe8;--panel:#f6f7f4;--ink:#1c2420;--muted:#5c675f;--line:#d3d8d1;--accent:#2f5e3f;--accent-soft:#4f7d5f;--frame-mat:#dfe3dd; }
  :root[data-theme="dark"]{ --bg:#131715;--panel:#1b201d;--ink:#e7ece7;--muted:#9aa79d;--line:#2b322d;--accent:#8fc2a1;--accent-soft:#6fa27f;--frame-mat:#0e120f; }
  *{box-sizing:border-box} body{margin:0;background:var(--bg);color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;line-height:1.5;}
  .wrap{max-width:940px;margin:0 auto;padding:0 20px;}
  header.top{border-bottom:1px solid var(--line);background:color-mix(in srgb,var(--panel) 80%,transparent);position:sticky;top:0;z-index:5;backdrop-filter:blur(8px);}
  .top-in{display:flex;align-items:baseline;justify-content:space-between;gap:16px;flex-wrap:wrap;padding:16px 20px;max-width:940px;margin:0 auto;}
  .brand{font-family:Georgia,serif;letter-spacing:.14em;font-size:12px;text-transform:uppercase;color:var(--accent-soft);}
  .pill{font-size:11px;letter-spacing:.1em;text-transform:uppercase;padding:4px 10px;border-radius:999px;border:1px solid var(--accent);color:var(--accent);font-weight:600;}
  .hero{padding:42px 0 10px;} .hero h1{font-family:Georgia,serif;font-weight:600;font-size:32px;line-height:1.12;margin:0 0 12px;max-width:20ch;}
  .hero p{margin:0;max-width:64ch;color:var(--muted);font-size:16px;}
  .flow{padding:34px 0 8px;border-top:1px solid var(--line);margin-top:26px;}
  .flow-head h2{font-family:Georgia,serif;font-size:23px;margin:0 0 4px;} .trigger{margin:0 0 8px;color:var(--muted);font-size:14px;}
  .dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--accent);margin-right:8px;vertical-align:middle;}
  .card{display:grid;grid-template-columns:280px 1fr;gap:0;background:var(--panel);border:1px solid var(--line);border-radius:14px;overflow:hidden;box-shadow:var(--shadow);margin:16px 0;}
  @media(max-width:760px){.card{grid-template-columns:1fr;}}
  .card-meta{padding:22px 20px;border-right:1px solid var(--line);} @media(max-width:760px){.card-meta{border-right:none;border-bottom:1px solid var(--line);}}
  .chip{display:inline-block;font-family:ui-monospace,Menlo,monospace;font-size:11px;color:var(--muted);background:color-mix(in srgb,var(--accent) 10%,transparent);border-radius:6px;padding:3px 8px;margin-bottom:12px;}
  .card-meta h3{font-family:Georgia,serif;font-weight:600;font-size:17px;margin:0 0 12px;line-height:1.2;}
  .subject,.preview{font-size:13px;margin:0 0 9px;color:var(--ink);} .preview{color:var(--muted);}
  .k{display:block;font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:var(--accent-soft);margin-bottom:2px;font-weight:600;}
  .card-frame{background:var(--frame-mat);padding:18px;display:flex;justify-content:center;align-items:flex-start;}
  iframe{width:100%;max-width:600px;border:0;background:#fff;border-radius:8px;box-shadow:0 6px 18px rgba(0,0,0,.12);height:620px;}
  footer{border-top:1px solid var(--line);padding:28px 0 60px;color:var(--muted);font-size:14px;margin-top:26px;}
  footer h2{font-family:Georgia,serif;font-size:18px;color:var(--ink);margin:0 0 10px;} footer code{font-family:ui-monospace,Menlo,monospace;font-size:12.5px;background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:2px 7px;}
  footer ul{padding-left:18px;} footer li{margin:6px 0;}
</style>
<header class="top"><div class="top-in"><span class="brand">Real Skin Care · Klaviyo</span><span class="pill">Drafts · awaiting go-live</span></div></header>
<div class="wrap">
  <section class="hero">
    <h1>Flow rebuilds — review</h1>
    <p>All five remaining flows rebuilt as code-based templates on the Post-Purchase design bar: preview text everywhere, live www links (no more staging URLs), $50 free-shipping framing, dynamic personalization (viewed product, cart items, purchased products), and a clear buy path in every email. Built as drafts — nothing sends until you say go.</p>
  </section>
  ${sections.join('\n')}
  <footer>
    <h2>To go live</h2>
    <p>Each flow: <code>node scripts/flows/build.js &lt;flow&gt; golive</code> — recreates with live messages, sets it live, and flips the old flow to draft so nothing double-sends. Flows: <code>welcome-series</code>, <code>abandoned-cart</code>, <code>browse-abandonment</code>, <code>product-review</code>, <code>winback</code>.</p>
    <ul>
      <li>Discounts used: <code>SHIPFREE</code> (free ship) in Welcome + Winback; <code>ComeBack25</code> (25%) as the Winback closer only.</li>
      <li>The Product Review flow now owns the review ask; it was removed from Post-Purchase Email 4.</li>
    </ul>
  </footer>
</div>
<script>
  function fit(f){ try{var d=f.contentDocument||f.contentWindow.document;var h=d.body.scrollHeight;if(h>60)f.style.height=(h+24)+'px';}catch(e){} }
  document.querySelectorAll('iframe').forEach(function(f){f.addEventListener('load',function(){fit(f);});fit(f);});
</script>`;

writeFileSync(`${SCRATCH}/flows-review.html`, page);
console.log('wrote flows-review.html', page.length, 'bytes,', FLOWS.reduce((n, f) => n + f.emails.length, 0), 'emails');
