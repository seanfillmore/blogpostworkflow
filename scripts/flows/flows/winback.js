/**
 * Customer Winback (rebuild) — trigger: Placed Order (V69ueg) + 75 days lapsed.
 * Discount ladder (softest first, save margin for the closer):
 *   E1 (75d)  no discount — re-engage + best sellers
 *   E2 (+15d) free shipping (SHIPFREE)
 *   E3 (+7d)  25% off (ComeBack25) — final, with urgency
 * Preserves old profile filter (excludes anyone who has since re-ordered).
 */
import { shell, H1, P_, SIGN, button, productCard, codeBox, P } from '../components.js';

export default {
  name: 'Customer Winback (RSC v2)',
  oldFlowId: 'T4FNSc',
  entry: 'd1',
  emails: {
    winback_1: {
      name: 'Winback — 01 We Miss You',
      subject: 'It\'s not the same without you',
      preview: 'A little while since your last order — here\'s what people are loving.',
      html: shell(
        'A little while since your last order — here\'s what people are loving.',
        H1('It\'s not the same without you') +
        P_('Hi {{ first_name|default:"there" }}, it\'s been a little while, and we wanted to check in. We\'re still here, still making clean coconut-oil skincare by hand — and a few things have become real favorites since we saw you last.') +
        productCard({ ...P.deodorant, note: 'Still our #1 — aluminum-free, actually works.' }) +
        productCard({ ...P.set, note: 'The easy way to restock your whole routine.' }) +
        button(P.bestSellers.url, 'See what\'s new') +
        SIGN,
      ),
    },
    winback_2: {
      name: 'Winback — 02 Free Shipping',
      subject: 'Come back — shipping\'s on us 🌿',
      preview: 'Free shipping to pick up right where you left off.',
      html: shell(
        'Free shipping to pick up right where you left off.',
        H1('Let\'s make this easy') +
        P_('We\'d love to have you back. To make it easy, here\'s <strong>free shipping</strong> on your next order:') +
        codeBox('Free shipping — welcome back', 'SHIPFREE') +
        button(P.bestSellers.url, 'Restock your favorites') +
        P_('Use the code at checkout. No minimum, no catch.') +
        SIGN,
      ),
    },
    winback_3: {
      name: 'Winback — 03 Last Chance 25% Off',
      subject: 'Last chance: 25% off inside ❤️',
      preview: 'Our best offer to welcome you back — don\'t let it slip away.',
      html: shell(
        'Our best offer to welcome you back — don\'t let it slip away.',
        H1('One more try — 25% off') +
        P_('We won\'t sugarcoat it: we want you back, and this is the best offer we\'ve got. Take <strong>25% off your entire order</strong> — our way of saying we\'d love to see you again.') +
        codeBox('25% off your order', 'ComeBack25') +
        button(P.bestSellers.url, 'Claim 25% off') +
        P_('This is the last email in this series, so if you\'ve been meaning to restock — now\'s the moment.') +
        SIGN,
      ),
    },
  },
  actions(msg, { send, delay }, sendStatus) {
    return [
      delay('d1', 75, 'days', 'e1'),
      send('e1', msg('winback_1'), 'd2', sendStatus),
      delay('d2', 15, 'days', 'e2'),
      send('e2', msg('winback_2'), 'd3', sendStatus),
      delay('d3', 7, 'days', 'e3'),
      send('e3', msg('winback_3'), null, sendStatus),
    ];
  },
};
