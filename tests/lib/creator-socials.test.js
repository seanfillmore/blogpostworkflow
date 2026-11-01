import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractInstagramHandle, mergeSocials, handleFor, declinedTag, recordHandle, recordDecline, DECLINE_TAG_PATTERN,
} from '../../lib/creator-socials.js';

test('extractInstagramHandle: a profile URL is accepted anywhere', () => {
  assert.equal(extractInstagramHandle('Sure! https://www.instagram.com/Ada.Luxe_/ thanks'), 'ada.luxe_');
  assert.equal(extractInstagramHandle('instagram.com/3r_jewel?igsh=abc'), '3r_jewel');
});

test('extractInstagramHandle: post links, our own handle and email addresses are never a handle', () => {
  assert.equal(extractInstagramHandle('see https://www.instagram.com/reel/DeilMiwAYk6/'), null);
  assert.equal(extractInstagramHandle('I follow @realskincare_com on IG'), null);
  assert.equal(extractInstagramHandle('my IG email is jane@gmail.com'), null);
});

test('extractInstagramHandle: a bare @handle needs Instagram in the message or in our ask', () => {
  assert.equal(extractInstagramHandle('It is @kaitlynn.e'), null, 'could be TikTok');
  assert.equal(extractInstagramHandle('It is @kaitlynn.e', { askedForInstagram: true }), 'kaitlynn.e');
  assert.equal(extractInstagramHandle('my insta is @kaitlynn.e!'), 'kaitlynn.e');
});

test('DECLINE_TAG_PATTERN: reads a no without catching ordinary sentences', () => {
  for (const t of ["I'd rather not be tagged", "please don't tag me", 'Not comfortable being tagged, sorry']) assert.ok(DECLINE_TAG_PATTERN.test(t), t);
  for (const t of ['Tag me! @jo', 'Sure, happy to be tagged']) assert.ok(!DECLINE_TAG_PATTERN.test(t), t);
});

test('mergeSocials: homepage handles join through the submission id; the creator\'s own reply wins', () => {
  const submissions = [{ id: 'submission_1', creator: { name: 'Marianne Lux' } }, { id: 'submission_2', creator: { name: 'Sierra Swinney' } }];
  const homepage = { ugc: { videos: [
    { trybe_id: 'submission_1', social_url: 'https://www.instagram.com/adaluxe_/' },
    { trybe_id: 'submission_2', social_url: 'https://www.instagram.com/3r_jewel/' },
  ] } };
  const registry = recordHandle({}, { name: 'Sierra Swinney', handle: 'sierra.new', at: 'x' });
  const s = mergeSocials({ registry, homepage, submissions });
  assert.equal(handleFor(s, 'marianne lux'), 'adaluxe_');
  assert.equal(handleFor(s, 'Sierra Swinney'), 'sierra.new');
});

test('a recorded decline means no handle and declinedTag true', () => {
  const s = mergeSocials({ registry: recordDecline({}, { name: 'Taylor B', at: 'x' }) });
  assert.equal(handleFor(s, 'Taylor B'), null);
  assert.equal(declinedTag(s, 'Taylor B'), true);
});
