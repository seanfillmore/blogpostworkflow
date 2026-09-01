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

/**
 * Design tokens, repeated per section because each section is an isolated
 * custom_liquid block with no shared stylesheet. Derived from the live theme's
 * existing sage/cream palette; `husk` is the one new tone (coconut husk).
 */
const T =
  '--bl-ink:#1a1b18;--bl-sage:#4a8b3c;--bl-deep:#33502c;--bl-cream:#f6f8f3;' +
  '--bl-rule:#cbd8c0;--bl-husk:#e8e2d4;--bl-mute:#6d7175;' +
  "--bl-mono:ui-monospace,SFMono-Regular,'SF Mono',Menlo,Consolas,monospace;";

/** Shared type rules: eyebrow (mono, informational) + section heading + lede. */
const HEAD =
  '.bl-eyb{font-family:var(--bl-mono);font-size:11.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--bl-sage);margin:0 0 10px}' +
  '.bl-h{font-size:clamp(26px,3.6vw,40px);line-height:1.1;letter-spacing:-.02em;font-weight:700;color:var(--bl-ink);margin:0}' +
  '.bl-lede{font-size:15.5px;line-height:1.6;color:var(--bl-mute);margin:10px 0 0;max-width:52ch}';

/** Placeholder artwork. Renders only when no image is set on the metaobject. */
const PH =
  '<svg class="bl-ph" viewBox="0 0 4 3" preserveAspectRatio="xMidYMid slice" role="img" aria-label="Image coming soon">' +
  '<rect width="4" height="3" fill="#eff1f3"/>' +
  '<rect x=".2" y=".24" width="3.6" height="2.52" rx=".18" fill="none" stroke="#8c97a1" stroke-width=".15"/>' +
  '<circle cx="2.74" cy="1.04" r=".29" fill="#8c97a1"/>' +
  '<path d="M.52 2.36 1.52 1.12 2.3 2.04 2.68 1.68 3.48 2.36Z" fill="#8c97a1"/></svg>';

/** `field` is a metaobject file_reference that does not exist yet → placeholder. */
const img = (field, alt) =>
  `{%- assign im = ${L}.${field} -%}{%- if im != blank -%}` +
  `<img class="bl-img" src="{{ im | image_url: width: 1100 }}" alt="${alt}" loading="lazy" width="1100" height="825">` +
  `{%- else -%}${PH}{%- endif -%}`;

/** Sections added to the shared bundle-landing template, in render order. */
export const SECTIONS = [
  {
    key: 'hook',
    type: 'custom-liquid',
    settings: {
      custom_liquid:
        css(
          `.bhook{${T}background:#fff;padding:clamp(48px,7vw,84px) 18px}` +
            '.bhook__i{max-width:820px;margin:0 auto;text-align:center}' +
            '.bhook__r{width:34px;height:2px;background:var(--bl-sage);margin:0 auto 22px}' +
            '.bhook p{font-size:clamp(21px,2.9vw,31px);line-height:1.34;letter-spacing:-.015em;' +
            'color:var(--bl-ink);font-weight:600;margin:0;text-wrap:balance}',
        ) +
        `{%- assign hook = ${L}.hook -%}{%- if hook != blank -%}` +
        '<section class="bhook"><div class="bhook__i"><div class="bhook__r"></div>' +
        '<p>{{ hook | newline_to_br }}</p></div></section>{%- endif -%}',
    },
  },

  {
    // The signature module. Numbered stops are justified here and nowhere else
    // on the page: months 1-3 are a real sequence the reader has to follow.
    key: 'timeline',
    type: 'custom-liquid',
    settings: {
      custom_liquid:
        css(
          `.btl{${T}background:var(--bl-cream);padding:clamp(52px,7vw,88px) 18px;` +
            'border-top:1px solid var(--bl-rule);border-bottom:1px solid var(--bl-rule)}' +
            '.btl__i{max-width:1040px;margin:0 auto}' +
            HEAD +
            '.btl__hd{text-align:center;margin-bottom:44px}.btl__hd .bl-lede{margin-left:auto;margin-right:auto}' +
            '.btl__rail{display:grid;grid-template-columns:repeat(3,1fr);gap:22px;position:relative}' +
            '.btl__rail:before{content:"";position:absolute;left:12%;right:12%;top:19px;height:2px;' +
            'background:linear-gradient(90deg,var(--bl-sage),var(--bl-rule));z-index:0}' +
            '.btl__c{position:relative;z-index:1;text-align:center}' +
            '.btl__n{width:38px;height:38px;border-radius:50%;background:var(--bl-sage);color:#fff;' +
            'font-family:var(--bl-mono);font-size:14px;font-weight:700;display:flex;align-items:center;' +
            'justify-content:center;margin:0 auto 16px;box-shadow:0 0 0 6px var(--bl-cream)}' +
            '.btl__w{font-family:var(--bl-mono);font-size:11px;letter-spacing:.12em;text-transform:uppercase;' +
            'color:var(--bl-sage);margin:0 0 6px}' +
            '.btl__t{font-size:17px;font-weight:700;color:var(--bl-ink);margin:0 0 8px;line-height:1.25}' +
            '.btl__b{font-size:14.5px;line-height:1.6;color:#4a4a4a;margin:0;max-width:30ch;margin-inline:auto}' +
            '@media(max-width:749px){.btl__rail{grid-template-columns:1fr;gap:30px}.btl__rail:before{display:none}}',
        ) +
        `{%- assign tl = ${L}.timeline.value -%}{%- if tl != blank and tl.size > 0 -%}` +
        '<section class="btl"><div class="btl__i"><div class="btl__hd">' +
        '<p class="bl-eyb">The 90 days</p><h2 class="bl-h">What to expect</h2>' +
        '<p class="bl-lede">No before-and-after photos — just what you use, and when.</p></div>' +
        '<div class="btl__rail">{%- for step in tl -%}<div class="btl__c">' +
        '<div class="btl__n">{{ forloop.index }}</div>' +
        '<p class="btl__w">{{ step.when }}</p><p class="btl__t">{{ step.title }}</p>' +
        '<p class="btl__b">{{ step.body }}</p></div>{%- endfor -%}</div></div></section>{%- endif -%}',
    },
  },

  {
    // Asymmetric and alternating — the deliberate break from the page's
    // otherwise centred rhythm, and where the product returns to view.
    key: 'mechanism',
    type: 'custom-liquid',
    settings: {
      custom_liquid:
        css(
          `.bmec{${T}background:#fff;padding:clamp(52px,7vw,88px) 18px}` +
            '.bmec__i{max-width:1040px;margin:0 auto}' +
            HEAD +
            '.bmec__hd{margin-bottom:40px}' +
            '.bmec__row{display:grid;grid-template-columns:minmax(0,5fr) minmax(0,6fr);gap:clamp(24px,4vw,56px);' +
            'align-items:center;margin-top:44px}' +
            '.bmec__row:nth-child(even) .bmec__fig{order:2}' +
            '.bmec__fig{margin:0;border-radius:14px;overflow:hidden;background:#eff1f3;aspect-ratio:4/3}' +
            '.bl-img,.bl-ph{display:block;width:100%;height:100%;object-fit:cover}' +
            '.bmec__t{font-size:clamp(19px,2.2vw,24px);font-weight:700;color:var(--bl-ink);margin:0 0 12px;' +
            'letter-spacing:-.015em}' +
            '.bmec__b{font-size:15.5px;line-height:1.7;color:#4a4a4a;margin:0}' +
            '@media(max-width:749px){.bmec__row{grid-template-columns:1fr;gap:18px}' +
            '.bmec__row:nth-child(even) .bmec__fig{order:0}}',
        ) +
        `{%- assign me = ${L}.mechanism.value -%}{%- if me != blank and me.size > 0 -%}` +
        '<section class="bmec"><div class="bmec__i"><div class="bmec__hd">' +
        '<p class="bl-eyb">How it works</p><h2 class="bl-h">Two formulas, one routine</h2></div>' +
        '{%- for m in me -%}<div class="bmec__row"><figure class="bmec__fig">' +
        `{%- assign im = ${L}.mechanism_images[forloop.index0] -%}{%- if im != blank -%}` +
        '<img class="bl-img" src="{{ im | image_url: width: 1100 }}" alt="{{ m.title }}" loading="lazy" width="1100" height="825">' +
        `{%- else -%}${PH}{%- endif -%}` +
        '</figure><div><p class="bmec__t">{{ m.title }}</p><p class="bmec__b">{{ m.body }}</p></div>' +
        '</div>{%- endfor -%}</div></section>{%- endif -%}',
    },
  },

  {
    // An ingredient panel, not a card grid: reading the actual list is what
    // customers say closes the sale, so it is set like a label.
    key: 'ingredient-cards',
    type: 'custom-liquid',
    settings: {
      custom_liquid:
        css(
          `.bing{${T}background:var(--bl-husk);padding:clamp(52px,7vw,88px) 18px}` +
            '.bing__i{max-width:940px;margin:0 auto}' +
            HEAD +
            '.bing__hd{margin-bottom:32px}' +
            '.bing__list{display:grid;grid-template-columns:1fr 1fr;gap:0 clamp(28px,5vw,64px)}' +
            '.bing__r{padding:16px 0;border-top:1px solid rgba(26,27,24,.14)}' +
            '.bing__n{font-size:15.5px;font-weight:700;color:var(--bl-ink);margin:0 0 3px;letter-spacing:-.01em}' +
            '.bing__d{font-size:14px;line-height:1.55;color:#5c5a52;margin:0}' +
            '.bing__ct{font-family:var(--bl-mono);font-size:11.5px;letter-spacing:.12em;text-transform:uppercase;' +
            'color:var(--bl-deep);margin:26px 0 0;text-align:right}' +
            '@media(max-width:749px){.bing__list{grid-template-columns:1fr}}',
        ) +
        `{%- assign ic = ${L}.ingredient_cards.value -%}{%- if ic != blank and ic.size > 0 -%}` +
        '<section class="bing"><div class="bing__i"><div class="bing__hd">' +
        '<p class="bl-eyb">The full list</p><h2 class="bl-h">Everything that\'s in it</h2>' +
        '<p class="bl-lede">Both formulas, every ingredient. Nothing held back for a footnote.</p></div>' +
        '<div class="bing__list">{%- for c in ic -%}<div class="bing__r">' +
        '<p class="bing__n">{{ c.name }}</p><p class="bing__d">{{ c.role }}</p></div>{%- endfor -%}</div>' +
        '<p class="bing__ct">{{ ic.size }} ingredients — that\'s the whole list</p>' +
        '</div></section>{%- endif -%}',
    },
  },

  {
    key: 'stats',
    type: 'custom-liquid',
    settings: {
      custom_liquid:
        css(
          `.bstat{${T}background:#fff;padding:clamp(44px,6vw,72px) 18px}` +
            '.bstat__g{max-width:1000px;margin:0 auto;display:grid;gap:0;' +
            'grid-template-columns:repeat(4,1fr)}' +
            '.bstat__c{text-align:center;padding:6px 14px;border-left:1px solid var(--bl-rule)}' +
            '.bstat__c:first-child{border-left:0}' +
            '.bstat__v{font-family:var(--bl-mono);font-size:clamp(30px,4.4vw,46px);font-weight:700;' +
            'color:var(--bl-sage);margin:0;line-height:1;letter-spacing:-.03em}' +
            '.bstat__l{font-size:13px;line-height:1.45;color:var(--bl-mute);margin:12px 0 0}' +
            '@media(max-width:749px){.bstat__g{grid-template-columns:1fr 1fr;gap:28px 0}' +
            '.bstat__c:nth-child(odd){border-left:0}}',
        ) +
        `{%- assign st = ${L}.stats.value -%}{%- if st != blank and st.size > 0 -%}` +
        '<section class="bstat"><div class="bstat__g">' +
        '{%- for s in st -%}<div class="bstat__c"><p class="bstat__v">{{ s.value }}</p>' +
        '<p class="bstat__l">{{ s.label }}</p></div>{%- endfor -%}</div></section>{%- endif -%}',
    },
  },

  {
    // The page's second anchor. This is the most adversarial content on it, so
    // it gets the strongest contrast rather than the palest treatment.
    key: 'compare-rows',
    type: 'custom-liquid',
    settings: {
      custom_liquid:
        css(
          `.bcmp{${T}background:var(--bl-ink);padding:clamp(52px,7vw,88px) 18px;color:#fff}` +
            '.bcmp__i{max-width:860px;margin:0 auto}' +
            '.bcmp__eyb{font-family:var(--bl-mono);font-size:11.5px;letter-spacing:.14em;' +
            'text-transform:uppercase;color:#8fbf7f;margin:0 0 10px}' +
            '.bcmp__h{font-size:clamp(26px,3.6vw,40px);line-height:1.1;letter-spacing:-.02em;' +
            'font-weight:700;color:#fff;margin:0}' +
            '.bcmp__s{font-size:15.5px;line-height:1.6;color:#a6a8a1;margin:10px 0 34px;max-width:54ch}' +
            '.bcmp__r{display:grid;grid-template-columns:minmax(0,1.5fr) minmax(0,1fr) minmax(0,1fr);' +
            'gap:14px;align-items:center;padding:15px 0;border-top:1px solid rgba(255,255,255,.14);font-size:15px}' +
            '.bcmp__hd{font-family:var(--bl-mono);font-size:11px;letter-spacing:.14em;text-transform:uppercase;' +
            'color:#8a8d85;border-top:0;padding-bottom:6px}' +
            '.bcmp__a{color:#e7e8e4}' +
            '.bcmp__us{color:#9fd98b;font-weight:700}' +
            '.bcmp__them{color:#9a8f8f}' +
            '@media(max-width:749px){.bcmp__r{grid-template-columns:1fr;gap:4px;padding:14px 0}' +
            '.bcmp__hd{display:none}' +
            '.bcmp__us:before{content:"Us — ";color:#8a8d85;font-weight:400}' +
            '.bcmp__them:before{content:"Them — ";color:#8a8d85}}',
        ) +
        '{%- assign cr = product.metafields.bundle.comparison_rows.value -%}' +
        '{%- if cr != blank and cr.size > 0 -%}' +
        '<section class="bcmp"><div class="bcmp__i">' +
        '<p class="bcmp__eyb">Side by side</p><h2 class="bcmp__h">How this compares</h2>' +
        '<p class="bcmp__s">Against the drugstore brands most often recommended for sensitive skin.</p>' +
        '<div class="bcmp__r bcmp__hd"><span>&nbsp;</span><span>Us</span><span>Them</span></div>' +
        '{%- for r in cr -%}<div class="bcmp__r"><span class="bcmp__a">{{ r.attribute }}</span>' +
        '<span class="bcmp__us">{{ r.us }}</span><span class="bcmp__them">{{ r.them }}</span></div>' +
        '{%- endfor -%}</div></section>{%- endif -%}',
    },
  },

  {
    key: 'founder-note',
    type: 'custom-liquid',
    settings: {
      custom_liquid:
        css(
          `.bfnd{${T}background:var(--bl-deep);padding:clamp(52px,7vw,88px) 18px;color:#fff}` +
            '.bfnd__i{max-width:860px;margin:0 auto;display:grid;' +
            'grid-template-columns:minmax(0,140px) minmax(0,1fr);gap:clamp(22px,4vw,44px);align-items:center}' +
            '.bfnd__fig{margin:0;width:140px;height:140px;border-radius:50%;overflow:hidden;background:#eff1f3}' +
            // repeated deliberately: each section is an isolated <style>, and the
            // founder note must size its own art even if `mechanism` is blank.
            '.bfnd__fig .bl-img,.bfnd__fig .bl-ph{display:block;width:100%;height:100%;object-fit:cover}' +
            '.bfnd__q{font-size:clamp(17px,2.1vw,21px);line-height:1.6;color:#f2f5ef;margin:0 0 16px;' +
            'letter-spacing:-.01em}' +
            '.bfnd__n{font-family:var(--bl-mono);font-size:11.5px;letter-spacing:.12em;text-transform:uppercase;' +
            'color:#a9c99c;margin:0}' +
            '@media(max-width:749px){.bfnd__i{grid-template-columns:1fr;justify-items:center;text-align:center}}',
        ) +
        `{%- assign fn = ${L}.founder_note -%}{%- if fn != blank -%}` +
        '<section class="bfnd"><div class="bfnd__i"><figure class="bfnd__fig">' +
        img('founder_image', 'Sean Fillmore, co-founder of Real Skin Care') +
        '</figure><div><p class="bfnd__q">{{ fn | newline_to_br }}</p>' +
        '<p class="bfnd__n">Sean Fillmore — co-founder</p></div></div></section>{%- endif -%}',
    },
  },
];
