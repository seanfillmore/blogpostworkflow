import puppeteer from 'puppeteer';
import { fileURLToPath } from 'url';
import path from 'path';

const html = `<!DOCTYPE html>
<html>
<head>
<style>
  body { font-family: 'Segoe UI', Arial, sans-serif; max-width: 800px; margin: 0 auto; padding: 40px; color: #1a1a1a; line-height: 1.6; }
  h1 { font-size: 24px; border-bottom: 3px solid #1a1a1a; padding-bottom: 12px; margin-bottom: 24px; }
  h2 { font-size: 18px; color: #2d2d2d; margin-top: 32px; border-bottom: 1px solid #ddd; padding-bottom: 8px; }
  p { margin: 8px 0; }
  strong { color: #111; }
  table { width: 100%; border-collapse: collapse; margin: 16px 0; font-size: 14px; }
  th { background: #1a1a1a; color: white; text-align: left; padding: 10px 12px; }
  td { padding: 10px 12px; border-bottom: 1px solid #ddd; }
  tr:nth-child(even) { background: #f9f9f9; }
  .issue { margin: 12px 0; }
  .issue-num { font-weight: bold; color: #c0392b; }
  .date { color: #666; font-size: 14px; margin-bottom: 24px; }
  .footer { margin-top: 40px; padding-top: 16px; border-top: 1px solid #ddd; font-size: 12px; color: #888; }
</style>
</head>
<body>

<h1>Landing Page Conversion Analysis — Real Skin Care Body Lotion</h1>
<p class="date">Generated: April 3, 2026 | Site: www.realskincare.com</p>

<h2>Above the Fold Issues</h2>

<div class="issue"><p><span class="issue-num">1. Weak headline hierarchy.</span> "Non-Toxic Body Lotion Made With Only 6 Clean Ingredients" leads with what the product <em>isn't</em> (non-toxic) rather than the benefit to the customer. The value proposition is buried in body text.</p></div>

<div class="issue"><p><span class="issue-num">2. Hero image is generic.</span> The product bottle on a plain background doesn't evoke emotion or show the product in use. No lifestyle imagery, no skin texture, no human element to create desire.</p></div>

<div class="issue"><p><span class="issue-num">3. No clear single CTA above the fold.</span> The purchase area with variant selection (1/2/3 bottles) is visible but the "Add 1 Bottle to My Cart" button is small and low-contrast green on white. It doesn't demand attention.</p></div>

<div class="issue"><p><span class="issue-num">4. Too much text in the hero.</span> The bullet points listing ingredients and features create cognitive overload before the visitor has even decided to care. This reads like a spec sheet, not a sales pitch.</p></div>

<h2>Mid-Page Issues</h2>

<div class="issue"><p><span class="issue-num">5. Comparison table is negative-framed.</span> "What You'll Never Find In Our Lotion" forces the customer to think about bad ingredients — associated with your brand. Flip this: lead with what makes yours <em>better</em>.</p></div>

<div class="issue"><p><span class="issue-num">6. Coconut Oil section has poor readability.</span> The image is beautiful but the supporting text is tiny and hard to read. The three benefit callouts (Supports Skin Barrier, Naturally Protective, Deep Hydration) are buried.</p></div>

<div class="issue"><p><span class="issue-num">7. No social proof until very late in the page.</span> The "4.7/5 from 91 reviews" and testimonials appear roughly 70% down the page. This is your strongest conversion asset and it's nearly invisible. The star rating should be right under the headline.</p></div>

<h2>Bottom-Page Issues</h2>

<div class="issue"><p><span class="issue-num">8. Reviews section is weak.</span> Only 3 reviews shown, small text, no photos from customers. User-generated content with real skin photos would dramatically increase trust.</p></div>

<div class="issue"><p><span class="issue-num">9. FAQ section is passive.</span> The questions are collapsed by default — most visitors won't click. The most common objections (sensitive skin, greasiness) should be answered proactively earlier in the page.</p></div>

<div class="issue"><p><span class="issue-num">10. Redundant CTAs at the bottom.</span> Visitors who scrolled this far likely need more convincing, not another button. A money-back guarantee callout or a limited-time offer would be more effective here.</p></div>

<h2>Structural Problems</h2>

<div class="issue"><p><span class="issue-num">11. No urgency or scarcity.</span> No limited stock indicators, no time-sensitive offers, no reason to buy <em>today</em> vs. bookmarking and forgetting.</p></div>

<div class="issue"><p><span class="issue-num">12. No clear benefit-driven section flow.</span> The page goes: Features → Comparison → Ingredients → Comparison Again → Reviews → FAQ. There's no emotional narrative arc (Problem → Agitation → Solution → Proof → Action).</p></div>

<div class="issue"><p><span class="issue-num">13. Sticky banner uses prime real estate.</span> The "30-day Money Back Guarantee" banner at the top is good but takes space away from a more compelling hook or offer.</p></div>

<div class="issue"><p><span class="issue-num">14. No exit intent or lead capture.</span> If someone isn't ready to buy, there's no email capture, no "get 10% off your first order" — you lose them forever.</p></div>

<h2>Top 5 Fixes by Impact</h2>

<table>
  <tr><th>Priority</th><th>Fix</th><th>Expected Impact</th></tr>
  <tr><td>1</td><td>Move star rating + review count directly under headline</td><td>Immediate trust boost</td></tr>
  <tr><td>2</td><td>Rewrite headline to be benefit-led: <em>"Finally, a lotion that actually hydrates — without the chemicals"</em></td><td>Higher engagement above fold</td></tr>
  <tr><td>3</td><td>Add urgency element (limited batch, shipping cutoff, first-order discount)</td><td>Drives immediate action</td></tr>
  <tr><td>4</td><td>Add email popup/exit intent with discount offer</td><td>Captures visitors who aren't ready to buy</td></tr>
  <tr><td>5</td><td>Add customer photos/UGC section near the top</td><td>Social proof that converts</td></tr>
</table>

<h2>Summary</h2>
<p>The page is well-designed visually but reads like an informational page, not a sales page. It educates but doesn't <em>persuade</em>. The core issue: it assumes visitors already want the product and just need specs — when most visitors need to be sold on <em>why they should care</em>.</p>

<div class="footer">Analysis generated by SEO Claude Team — blogpostworkflow</div>

</body>
</html>`;

const outPath = path.resolve('data/reports/landing-page-analysis-2026-04-03.pdf');

const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.setContent(html, { waitUntil: 'networkidle0' });
await page.pdf({ path: outPath, format: 'A4', margin: { top: '40px', bottom: '40px', left: '40px', right: '40px' } });
await browser.close();

console.log('PDF saved to:', outPath);
