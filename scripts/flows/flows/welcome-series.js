/**
 * Welcome Series (rebuild) — trigger: Email List signup (S6hKFq).
 * Trimmed from 7 (incl. 2 unfinished drafts) to a focused 5, all with preview text
 * and a real buy path. Offer = SHIPFREE (free shipping — on strategy, no % discount).
 * Social-follow moved to the footer (not its own email). Preserves old profile filter
 * (excludes existing purchasers).
 */
import { shell, H1, P_, SIGN, button, productCard, codeBox, P, FREE_SHIP } from '../components.js';

const SHIPFREE = codeBox('Free shipping — welcome gift', 'SHIPFREE');

export default {
  name: 'Welcome Series (RSC v2)',
  oldFlowId: 'WMhLtj',
  entry: 'e1',
  emails: {
    welcome_1: {
      name: 'Welcome — 01 Welcome + Free Shipping',
      subject: 'Welcome to Real Skin Care — free shipping inside 🌿',
      preview: 'Here\'s a little welcome gift to get you started.',
      html: shell(
        'Here\'s a little welcome gift to get you started.',
        H1('Welcome — we\'re glad you\'re here.') +
        P_('Hi {{ first_name|default:"there" }}, thanks for joining us. We make clean, coconut-oil-based skincare by hand in the USA — a short list of ingredients, nothing you can\'t pronounce.') +
        P_('To get you started, here\'s <strong>free shipping</strong> on your first order:') +
        SHIPFREE +
        button(P.bestSellers.url, 'Shop best sellers') +
        P_(`Use the code at checkout. Orders over ${FREE_SHIP} always ship free, too.`),
      ),
    },
    welcome_2: {
      name: 'Welcome — 02 Brand Story',
      subject: 'We started this for a reason',
      preview: 'The family story behind Real Skin Care.',
      html: shell(
        'The family story behind Real Skin Care.',
        H1('Why we started Real Skin Care') +
        P_('Hi {{ first_name|default:"there" }}, I\'m Sean, co-founder of Real Skin Care. My sister-in-law Julie started this over 20 years ago, after realizing there weren\'t skincare options that were both organic <em>and</em> completely natural.') +
        P_('So we make our own — coconut-oil-based, handmade in the USA, with ingredients simple enough to read on one hand. No fillers, no synthetic fragrance, nothing we wouldn\'t use on our own family.') +
        button(P.shopAll.url, 'See what we make') +
        SIGN,
      ),
    },
    welcome_3: {
      name: 'Welcome — 03 Best Sellers',
      subject: 'The ones everyone starts with',
      preview: 'Our most-loved clean essentials — free shipping over $50.',
      html: shell(
        'Our most-loved clean essentials — free shipping over $50.',
        H1('Where most people start') +
        P_('Not sure what to try first? These are the ones our customers reach for again and again.') +
        productCard({ ...P.deodorant, note: 'Aluminum-free and it actually works.' }) +
        productCard({ ...P.toothpaste, note: 'Fluoride-free, SLS-free, genuinely fresh.' }) +
        productCard({ ...P.set, note: 'The easy way to build a full clean routine.' }) +
        button(P.bestSellers.url, 'Shop best sellers') +
        P_(`Free shipping on orders over ${FREE_SHIP}.`),
      ),
    },
    welcome_4: {
      name: 'Welcome — 04 Why Clean / USP',
      subject: 'What makes ours different (in 30 seconds)',
      preview: 'Few ingredients, handmade in the USA — here\'s why it matters.',
      html: shell(
        'Few ingredients, handmade in the USA — here\'s why it matters.',
        H1('Clean isn\'t a buzzword for us') +
        P_('A lot of "natural" brands still hide fillers, synthetic fragrance, and a long list of things you can\'t pronounce. We don\'t.') +
        P_('<strong>Every product</strong> starts with coconut oil and a short list of clean ingredients. <strong>Handmade in the USA.</strong> <strong>No fillers, no synthetic fragrance.</strong> That\'s the whole idea — and why people switch and stay.') +
        productCard({ ...P.lotion, note: 'Only 6 clean ingredients.' }) +
        productCard({ ...P.barsoap, note: 'Cleans without stripping.' }) +
        button(P.shopAll.url, 'Explore the collection') +
        SIGN,
      ),
    },
    welcome_5: {
      name: 'Welcome — 05 Last Chance Free Shipping',
      subject: 'Your free shipping is still waiting',
      preview: 'Use it before it slips your mind — free shipping on your first order.',
      html: shell(
        'Use it before it slips your mind — free shipping on your first order.',
        H1('Still deciding? Here\'s a nudge.') +
        P_('Your welcome free-shipping code is still good — but don\'t let it slip your mind. Here it is one more time:') +
        SHIPFREE +
        button(P.bestSellers.url, 'Use it on a best seller') +
        P_('If you have any questions before you order, just reply — a real person (often me) will answer.') +
        SIGN,
      ),
    },
  },
  actions(msg, { send, delay }, sendStatus) {
    return [
      send('e1', msg('welcome_1'), 'd2', sendStatus),
      delay('d2', 1, 'days', 'e2'),
      send('e2', msg('welcome_2'), 'd3', sendStatus),
      delay('d3', 2, 'days', 'e3'),
      send('e3', msg('welcome_3'), 'd4', sendStatus),
      delay('d4', 3, 'days', 'e4'),
      send('e4', msg('welcome_4'), 'd5', sendStatus),
      delay('d5', 4, 'days', 'e5'),
      send('e5', msg('welcome_5'), null, sendStatus),
    ];
  },
};
