/**
 * Bundle lander — pure helpers for the shared product.bundle-landing template.
 *
 * The value stack sums the components a bundle contains. Digital bonuses are
 * listed as contents but MUST NOT count toward the total: the total is shown
 * beside `compareAtPrice`, which is set from physical goods only. Summing the
 * digital rows too is what put "Total value $208 / You save $87" next to a
 * $174 strikethrough on the live Reset page.
 *
 * This mirrors the Liquid in the `value-stack` block. Change both together.
 */

export function computeStackTotals(stack, priceCents) {
  const rows = Array.isArray(stack) ? stack : [];
  const priced = rows.filter((r) => !r.digital);
  const included = rows.filter((r) => r.digital);
  const total = priced.reduce((s, r) => s + Number(r.amount || 0), 0);
  const price = Math.round(Number(priceCents || 0) / 100);
  return { priced, included, total, price, savings: total - price };
}

const L = 'product.metafields.bundle.lander.value';

const css = (s) => `<style>${s}</style>`;

/** Sections added to the shared bundle-landing template, in render order. */
export const SECTIONS = [
  {
    key: 'hook',
    type: 'custom-liquid',
    settings: {
      custom_liquid:
        css('.bhook{max-width:760px;margin:0 auto;padding:44px 18px;text-align:center}.bhook p{font-size:clamp(19px,2.4vw,25px);line-height:1.45;color:#1a1b18;font-weight:600;margin:0}') +
        `{%- assign hook = ${L}.hook -%}{%- if hook != blank -%}` +
        `<div class="bhook"><p>{{ hook | newline_to_br }}</p></div>{%- endif -%}`,
    },
  },
  {
    key: 'timeline',
    type: 'custom-liquid',
    settings: {
      custom_liquid:
        css('.btl{max-width:960px;margin:0 auto;padding:52px 18px}.btl__h{text-align:center;font-size:clamp(22px,3vw,30px);font-weight:700;margin:0 0 8px;color:#1a1b18}.btl__s{text-align:center;color:#6d7175;margin:0 0 30px;font-size:15px}.btl__g{display:grid;gap:18px;grid-template-columns:repeat(auto-fit,minmax(210px,1fr))}.btl__c{background:#f6f8f3;border-radius:14px;padding:22px 20px;border:1px solid #e2ead9}.btl__w{font-size:12.5px;font-weight:700;color:#4a8b3c;letter-spacing:.06em;text-transform:uppercase;margin:0 0 8px}.btl__t{font-size:16.5px;font-weight:700;color:#1a1b18;margin:0 0 6px;line-height:1.3}.btl__b{font-size:14px;color:#4a4a4a;line-height:1.6;margin:0}') +
        `{%- assign tl = ${L}.timeline.value -%}{%- if tl != blank and tl.size > 0 -%}` +
        '<div class="btl"><h2 class="btl__h">What to expect</h2>' +
        '<p class="btl__s">No before-and-after photos — just what you use, and when.</p><div class="btl__g">' +
        '{%- for step in tl -%}<div class="btl__c"><p class="btl__w">{{ step.when }}</p>' +
        '<p class="btl__t">{{ step.title }}</p><p class="btl__b">{{ step.body }}</p></div>{%- endfor -%}' +
        '</div></div>{%- endif -%}',
    },
  },
  {
    key: 'mechanism',
    type: 'custom-liquid',
    settings: {
      custom_liquid:
        css('.bmec{max-width:900px;margin:0 auto;padding:48px 18px}.bmec__h{text-align:center;font-size:clamp(22px,3vw,30px);font-weight:700;margin:0 0 26px;color:#1a1b18}.bmec__g{display:grid;gap:20px;grid-template-columns:repeat(auto-fit,minmax(250px,1fr))}.bmec__t{font-size:16px;font-weight:700;margin:0 0 6px;color:#1a1b18}.bmec__b{font-size:14.5px;color:#4a4a4a;line-height:1.6;margin:0}') +
        `{%- assign me = ${L}.mechanism.value -%}{%- if me != blank and me.size > 0 -%}` +
        '<div class="bmec"><h2 class="bmec__h">Two formulas, one routine</h2><div class="bmec__g">' +
        '{%- for m in me -%}<div><p class="bmec__t">{{ m.title }}</p><p class="bmec__b">{{ m.body }}</p></div>{%- endfor -%}' +
        '</div></div>{%- endif -%}',
    },
  },
  {
    key: 'ingredient-cards',
    type: 'custom-liquid',
    settings: {
      custom_liquid:
        css('.bing{max-width:900px;margin:0 auto;padding:48px 18px}.bing__h{text-align:center;font-size:clamp(22px,3vw,30px);font-weight:700;margin:0 0 26px;color:#1a1b18}.bing__g{display:grid;gap:16px;grid-template-columns:repeat(auto-fit,minmax(190px,1fr))}.bing__c{border:1px solid #e2ead9;border-radius:12px;padding:18px}.bing__n{font-size:15px;font-weight:700;margin:0 0 4px;color:#1a1b18}.bing__d{font-size:13.5px;color:#4a4a4a;line-height:1.55;margin:0}') +
        `{%- assign ic = ${L}.ingredient_cards.value -%}{%- if ic != blank and ic.size > 0 -%}` +
        '<div class="bing"><h2 class="bing__h">Everything that\'s in it</h2><div class="bing__g">' +
        '{%- for c in ic -%}<div class="bing__c"><p class="bing__n">{{ c.name }}</p><p class="bing__d">{{ c.role }}</p></div>{%- endfor -%}' +
        '</div></div>{%- endif -%}',
    },
  },
  {
    key: 'stats',
    type: 'custom-liquid',
    settings: {
      custom_liquid:
        css('.bstat{background:#f6f8f3;padding:38px 18px}.bstat__g{max-width:900px;margin:0 auto;display:grid;gap:20px;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));text-align:center}.bstat__v{font-size:clamp(24px,3.4vw,34px);font-weight:800;color:#4a8b3c;margin:0;line-height:1.1}.bstat__l{font-size:13.5px;color:#4a4a4a;margin:6px 0 0;line-height:1.4}') +
        `{%- assign st = ${L}.stats.value -%}{%- if st != blank and st.size > 0 -%}` +
        '<div class="bstat"><div class="bstat__g">' +
        '{%- for s in st -%}<div><p class="bstat__v">{{ s.value }}</p><p class="bstat__l">{{ s.label }}</p></div>{%- endfor -%}' +
        '</div></div>{%- endif -%}',
    },
  },
  {
    key: 'compare-rows',
    type: 'custom-liquid',
    settings: {
      custom_liquid:
        css('.bcmp{max-width:820px;margin:0 auto;padding:48px 18px}.bcmp__h{text-align:center;font-size:clamp(22px,3vw,30px);font-weight:700;margin:0 0 8px;color:#1a1b18}.bcmp__s{text-align:center;color:#6d7175;margin:0 0 24px;font-size:15px}.bcmp__r{display:grid;grid-template-columns:1fr auto auto;gap:12px;align-items:center;padding:13px 4px;border-bottom:1px solid #e3e3e3;font-size:14.5px}.bcmp__hd{font-weight:700;color:#6d7175;font-size:12.5px;text-transform:uppercase;letter-spacing:.04em}.bcmp__y{color:#4a8b3c;font-weight:700}.bcmp__n{color:#b23c3c}') +
        '{%- assign cr = product.metafields.bundle.comparison_rows.value -%}{%- if cr != blank and cr.size > 0 -%}' +
        '<div class="bcmp"><h2 class="bcmp__h">How this compares</h2>' +
        '<p class="bcmp__s">Against the drugstore brands most often recommended for sensitive skin.</p>' +
        '<div class="bcmp__r bcmp__hd"><span>&nbsp;</span><span>Us</span><span>Them</span></div>' +
        '{%- for r in cr -%}<div class="bcmp__r"><span>{{ r.attribute }}</span>' +
        '<span class="bcmp__y">{{ r.us }}</span><span class="bcmp__n">{{ r.them }}</span></div>{%- endfor -%}' +
        '</div>{%- endif -%}',
    },
  },
  {
    key: 'founder-note',
    type: 'custom-liquid',
    settings: {
      custom_liquid:
        css('.bfnd{max-width:720px;margin:0 auto;padding:48px 18px;text-align:center}.bfnd__b{font-size:16px;line-height:1.7;color:#33352f;margin:0 0 14px;font-style:italic}.bfnd__n{font-size:14px;font-weight:700;color:#1a1b18;margin:0}') +
        `{%- assign fn = ${L}.founder_note -%}{%- if fn != blank -%}` +
        '<div class="bfnd"><p class="bfnd__b">{{ fn | newline_to_br }}</p>' +
        '<p class="bfnd__n">— Sean Fillmore, founder</p></div>{%- endif -%}',
    },
  },
];
