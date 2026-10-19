import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  thanksHistory, thanksProblems, composeThanks, renderThanksVariant, THANKS_VARIANT_COUNT,
  reelsForCreator, wordOverlap, thanksFacts, THANKS_SUBJECT, productWords,
} from '../../lib/creator-outreach.js';

const c = {
  firstName: 'Taylor', missing: ['Moisturizing Coconut Soap | 3.4oz'],
  submissions: [{ id: 's1', status: 'approved', createdAt: '2026-10-01', products: ['Coconut Moisturizer | 4oz'] }, { id: 's2', status: 'approved', createdAt: '2026-10-15', products: ['Body Lotion'] }],
};
const extra = { submissionIds: ['s2'], products: ['Body Lotion'], askSocials: false };
const good = { subject: 'Your body lotion video', body: 'Another one in, and I love it. The body lotion video is approved and it reads so natural. Thanks for sticking with us, Taylor.' };

test('legacy thank-yous (sent before history was kept) count as the old template', () => {
  const h = thanksHistory({ sent: { thanks: 3 } });
  assert.equal(h.length, 3);
  assert.ok(h.every((x) => x.source === 'variant:0' && x.subject === THANKS_SUBJECT));
  assert.equal(thanksHistory({ sent: { thanks: 2 }, thanksHistory: [{ source: 'model', body: 'x' }, { source: 'model', body: 'y' }] }).length, 2);
});

test('the old stock line, a repeated opening, or heavy overlap is refused', () => {
  const history = thanksHistory({ sent: { thanks: 1 } });
  assert.ok(thanksProblems('We just approved your lotion video. Thank you, it is exactly the kind of content we were hoping for.', { history }).some((p) => /stock line/.test(p)));
  const prior = [{ source: 'model', subject: 'a', body: 'Another one approved, thank you so much! The moisturizer video came out lovely.' }];
  assert.ok(thanksProblems('Another one approved, thank you! The body lotion video is lovely and so easy to watch.', { history: prior }).some((p) => /opens the same way/.test(p)));
  assert.ok(wordOverlap('The lotion video came out lovely, thank you', 'The lotion video came out lovely and warm') > 0.5);
  assert.deepEqual(thanksProblems(good.body, { history: prior, subject: good.subject }), []);
});

test('a Reel may only be mentioned when we really posted one', () => {
  const body = 'Thank you for the body lotion video! Your moisturizer one went up on our Instagram last week and people loved it.';
  assert.ok(thanksProblems(body, { reels: [] }).some((p) => /not posted/.test(p)));
  assert.ok(!thanksProblems(body, { reels: [{ product: 'Coconut Moisturizer', posted: '2026-10-10' }] }).some((p) => /not posted/.test(p)));
  const ledger = { posts: [{ submission_id: 's1', product_key: 'Coconut Moisturizer — 4oz', posted_at: '2026-10-10T00:00:00Z' }, { submission_id: 'other', posted_at: 'x' }] };
  assert.deepEqual(reelsForCreator(ledger, c), [{ product: 'Coconut Moisturizer', posted: '2026-10-10' }]);
  assert.deepEqual(reelsForCreator(null, c), []);
});

test('no greeting, sign-off, Instagram ask, link, money or em dash from the model', () => {
  for (const [body, re] of [
    [`Hi Taylor, ${good.body}`, /greeting/],
    [`${good.body}\n\nSean`, /sign-off/],
    [`${good.body} What is your Instagram handle?`, /Instagram handle/],
    [`${good.body} See https://realskincare.com`, /link/],
    [`${good.body} Your commission is on the way.`, /payment/],
    [`${good.body} Truly — great.`, /em dash/],
  ]) assert.ok(thanksProblems(body).some((p) => re.test(p)), String(re));
});

test('the subject must not repeat an earlier one when it starts a thread; a threaded reply ignores it', () => {
  const history = thanksHistory({ sent: { thanks: 1 } });
  assert.ok(thanksProblems(good.body, { history, subject: THANKS_SUBJECT }).some((p) => /subject repeats/.test(p)));
  assert.ok(!thanksProblems(good.body, { history, subject: THANKS_SUBJECT, threaded: true }).some((p) => /subject/.test(p)));
});

test('facts carry what came before and nothing invented', () => {
  const f = thanksFacts(c, extra, { history: thanksHistory({ sent: { thanks: 1 } }) });
  assert.deepEqual(f.just_approved, ['Body Lotion']);
  assert.deepEqual(f.approved_before_this.map((x) => x.products), [['Coconut Moisturizer']]);
  assert.equal(f.thank_you_emails_already_sent_to_them, 1);
  assert.deepEqual(f.reels_we_posted_from_their_videos, []);
});

test('the model gets one retry with the problems named, then a reviewed variant the creator has not had', async () => {
  const prompts = [];
  const bad = JSON.stringify({ subject: 'x', body: 'We just approved your lotion video. Thank you, it is exactly the kind of content we were hoping for.' });
  const r1 = await composeThanks({ c, extra, history: thanksHistory({ sent: { thanks: 1 } }), write: async (p) => { prompts.push(p); return prompts.length === 1 ? bad : JSON.stringify(good); } });
  assert.equal(r1.source, 'model');
  assert.match(prompts[1], /REJECTED[\s\S]*stock line/);
  assert.match(r1.text, /^Hi Taylor,\n\nAnother one in/);
  assert.match(r1.text, /Sean\nReal Skin Care/);

  const r2 = await composeThanks({ c, extra, history: thanksHistory({ sent: { thanks: 1 } }), write: async () => bad });
  assert.equal(r2.source, 'variant:1', 'variant 0 was the legacy template, so the next one');
  assert.equal(r2.attempts.length, 2);
});

test('with every variant used and no usable draft the note is HELD, never repeated', async () => {
  const history = Array.from({ length: THANKS_VARIANT_COUNT }, (_, v) => ({ source: `variant:${v}`, ...renderThanksVariant(v, c, extra) }));
  const r = await composeThanks({ c, extra, history, write: async () => 'not json' });
  assert.ok(r.held);
});

test('every reviewed variant is clean and distinct from every other', () => {
  for (let i = 0; i < THANKS_VARIANT_COUNT; i += 1) {
    const v = renderThanksVariant(i, c, extra);
    const others = [];
    for (let j = 0; j < THANKS_VARIANT_COUNT; j += 1) if (j !== i) others.push({ source: `variant:${j}`, ...renderThanksVariant(j, c, extra) });
    const ignore = productWords([...c.missing, ...extra.products, 'Coconut Moisturizer']);
    const problems = thanksProblems(v.body, { history: others, subject: v.subject, ignore })
      .filter((p) => i !== 0 || !/stock line/.test(p));
    assert.deepEqual(problems, [], `variant ${i}`);
  }
});

test('the Instagram ask is appended by code when owed', async () => {
  const r = await composeThanks({ c, extra: { ...extra, askSocials: true }, write: async () => JSON.stringify(good) });
  assert.match(r.text, /What's your Instagram handle\?/);
});

test('the same Reel is mentioned once, and the next-product ask never comes twice in a row', () => {
  const reels = [{ product: 'Body Lotion', posted: '2026-10-12' }];
  const missing = ['Coconut Oil Toothpaste'];
  const prior = [{ source: 'model', subject: 's', body: 'The soap video is approved. Your Body Lotion Reel went up on our Instagram. Would love a Coconut Oil Toothpaste one next.' }];
  const again = 'Your moisturizer video is approved and it looks great. The Body Lotion Reel is still up on our page. A Coconut Oil Toothpaste video would be fun sometime.';
  const p = thanksProblems(again, { history: prior, reels, missing });
  assert.ok(p.some((x) => /Reel an earlier note/.test(x)));
  assert.ok(p.some((x) => /Coconut Oil Toothpaste again/.test(x)));
  assert.ok(!thanksProblems(again, { history: [], reels, missing }).some((x) => /earlier note|again/.test(x)), 'first time is fine');
  const newReel = [...reels, { product: 'Coconut Moisturizer', posted: '2026-10-18' }];
  assert.ok(!thanksProblems('The soap video is approved, love it. Your Coconut Moisturizer Reel just went up on our Instagram too, which made my week.', { history: prior, reels: newReel, missing }).some((x) => /earlier note/.test(x)), 'a NEW Reel may be mentioned');
});
