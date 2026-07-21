/**
 * Product Review / Cross-Sell (rebuild) — trigger: Fulfilled Order (QSgEAF) + 14 days.
 * Now the single owner of the review ask (removed from Post-Purchase E4).
 * Personalized review link to the product(s) they bought + a cross-sell block.
 * Fulfilled Order = they've received it, so this is the right moment to ask.
 */
import { shell, H1, P_, SIGN, button, productCard, P } from '../components.js';

// "Leave a review" rows for what they bought (PDP #reviews anchor where the Judge.me widget lives).
const reviewLinks =
  `{% with items=event.Items|join:", " %}` +
    `{% if "Deodorant" in items or "Toothpaste" in items or "Soap" in items or "Lotion" in items or "Moisturiz" in items %}` +
      `{% if "Deodorant" in items %}` + productCard({ url: `${P.deodorant.url}#reviews`, name: 'Review your Coconut Oil Deodorant', note: 'Tell others how the switch went &rarr;' }) + `{% endif %}` +
      `{% if "Toothpaste" in items %}` + productCard({ url: `${P.toothpaste.url}#reviews`, name: 'Review your Coconut Oil Toothpaste', note: 'A minute of your time helps a lot &rarr;' }) + `{% endif %}` +
      `{% if "Soap" in items %}` + productCard({ url: `${P.handsoap.url}#reviews`, name: 'Review your coconut soap', note: 'How does it feel on your skin? &rarr;' }) + `{% endif %}` +
      `{% if "Lotion" in items or "Moisturiz" in items %}` + productCard({ url: `${P.lotion.url}#reviews`, name: 'Review your lotion / moisturizer', note: 'Share your results &rarr;' }) + `{% endif %}` +
    `{% else %}` +
      productCard({ url: `${P.bestSellers.url}`, name: 'Leave a review', note: 'Find your product and share your thoughts &rarr;' }) +
    `{% endif %}` +
  `{% endwith %}`;

export default {
  name: 'Product Review / Cross-Sell (RSC v2)',
  oldFlowId: 'UgeSBy',
  entry: 'd1',
  emails: {
    review_1: {
      name: 'Product Review — 01 Review + Cross-Sell',
      subject: 'How\'s it treating you, {{ first_name|default:"there" }}?',
      preview: 'A quick review helps more than you know — and helps others find clean products.',
      html: shell(
        'A quick review helps more than you know — and helps others find clean products.',
        H1('How\'s it treating you?') +
        P_('Hi {{ first_name|default:"there" }}, your order has had a couple of weeks to earn its place in your routine. If it\'s working for you, would you leave a quick review? It genuinely helps us improve — and helps other people find clean products they can trust.') +
        reviewLinks +
        P_('<strong>While you\'re here —</strong> a lot of customers round out their routine with these:') +
        productCard({ ...P.set, note: 'The easy way to complete your clean routine.' }) +
        productCard({ ...P.lipbalm, note: 'A little everyday favorite.' }) +
        button(P.shopAll.url, 'Explore the collection') +
        SIGN,
      ),
    },
  },
  actions(msg, { send, delay }, sendStatus) {
    return [
      delay('d1', 14, 'days', 'e1'),
      send('e1', msg('review_1'), null, sendStatus),
    ];
  },
};
