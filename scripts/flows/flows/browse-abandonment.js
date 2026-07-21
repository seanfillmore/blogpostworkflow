/**
 * Browse Abandonment (rebuild) — trigger: Viewed Product (YAmYTQ).
 * Fixes: staging-domain links -> www; hardcoded products -> the actually-viewed
 * product (event.Name/URL/ImageURL/Price); adds preview text, free-ship nudge,
 * and a 2nd touch with best-seller fallback.
 */
import { shell, H1, P_, SIGN, FREESHIP_NOTE, button, productCard, imageCard, P, FREE_SHIP } from '../components.js';

// Dynamic block for the product they viewed (guarded so a missing image degrades gracefully).
const viewedProduct = `{% if event.ImageURL %}` +
  imageCard({ image: '{{ event.ImageURL }}', url: '{{ event.URL }}', name: '{{ event.Name }}', price: '${{ event.Price }}', cta: 'Take another look' }) +
  `{% else %}` +
  productCard({ url: `{{ event.URL|default:'https://www.realskincare.com/collections/all' }}`, name: `{{ event.Name|default:'the item you were looking at' }}`, note: 'Pick up where you left off.' }) +
  `{% endif %}`;

export default {
  name: 'Browse Abandonment (RSC v2)',
  oldFlowId: 'WSWAUX',
  entry: 'd1',
  emails: {
    browse_1: {
      name: 'Browse Abandonment — 01 Still Looking',
      subject: 'Still thinking it over, {{ first_name|default:"there" }}?',
      preview: 'The clean skincare you were just looking at — plus why people switch.',
      html: shell(
        'The clean skincare you were just looking at — plus why people switch.',
        H1('Still thinking it over?') +
        P_('Hi {{ first_name|default:"there" }}, we noticed you were checking this out — here it is again in case you want another look.') +
        viewedProduct +
        P_('Everything we make is handmade in the USA from a short list of clean, coconut-oil-based ingredients — no fillers, no synthetic fragrance. That\'s why people make the switch and stay.') +
        button(`{{ event.URL|default:'https://www.realskincare.com/collections/all' }}`, 'Take another look') +
        FREESHIP_NOTE,
      ),
    },
    browse_2: {
      name: 'Browse Abandonment — 02 Best Sellers',
      subject: 'A few favorites before you go 🥥',
      preview: `Still on your mind? Here are our best sellers — free shipping over ${FREE_SHIP}.`,
      html: shell(
        `Still on your mind? Here are our best sellers — free shipping over ${FREE_SHIP}.`,
        H1('Still on your mind?') +
        P_('No rush — but if you\'re still deciding, here\'s what our customers reach for most.') +
        productCard({ ...P.deodorant, note: 'Our #1 — aluminum-free, actually works.' }) +
        productCard({ ...P.set, note: 'The easy way to build a full clean routine.' }) +
        productCard({ ...P.toothpaste, note: 'Fluoride-free, SLS-free, genuinely fresh.' }) +
        P_(`And everything ships free over ${FREE_SHIP}.`) +
        button(P.bestSellers.url, 'Shop best sellers') +
        SIGN,
      ),
    },
  },
  actions(msg, { send, delay }, sendStatus) {
    return [
      delay('d1', 6, 'hours', 'e1'),
      send('e1', msg('browse_1'), 'd2', sendStatus),
      delay('d2', 1, 'days', 'e2'),
      send('e2', msg('browse_2'), null, sendStatus),
    ];
  },
};
