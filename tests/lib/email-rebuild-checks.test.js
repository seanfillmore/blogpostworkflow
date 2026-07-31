import { strict as assert } from 'node:assert';
import {
  classifyLinks,
  linkFindings,
  tagFindings,
  unsubscribeFindings,
} from '../../lib/email-rebuild-checks.js';

// classifyLinks — compliance links are the ones a redesign may never drop.
{
  const { compliance, marketing } = classifyLinks([
    'https://www.realskincare.com/collections/best-sellers',
    '{% unsubscribe %}',
    'https://www.realskincare.com/policies/privacy-policy',
    'https://www.instagram.com/realskincare_com/',
  ]);
  assert.deepEqual(compliance.sort(), [
    'https://www.realskincare.com/policies/privacy-policy',
    '{% unsubscribe %}',
  ].sort());
  assert.deepEqual(marketing.sort(), [
    'https://www.instagram.com/realskincare_com/',
    'https://www.realskincare.com/collections/best-sellers',
  ]);
}

// A redesign that drops a marketing link warns — it does not fail.
// The format matrix mandates "at most two destinations", so dropping CTAs is the
// intended outcome of a redesign, not a defect.
{
  const before = '<a href="https://a.com/1">a</a><a href="https://a.com/2">b</a><a href="{% unsubscribe %}">u</a>';
  const after = '<a href="https://a.com/1">a</a><a href="{% unsubscribe %}">u</a>';
  const { problems, warnings } = linkFindings(before, after, { redesign: true });
  assert.deepEqual(problems, []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /https:\/\/a\.com\/2/);
}

// The same drop in a restyle is a hard failure — a restyle must preserve every link.
{
  const before = '<a href="https://a.com/1">a</a><a href="https://a.com/2">b</a>';
  const after = '<a href="https://a.com/1">a</a>';
  const { problems, warnings } = linkFindings(before, after, { redesign: false });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /links dropped/);
  assert.deepEqual(warnings, []);
}

// Dropping unsubscribe is a CAN-SPAM violation and fails even under --redesign.
{
  const before = '<a href="https://a.com/1">a</a><a href="{% unsubscribe %}">u</a>';
  const after = '<a href="https://a.com/1">a</a>';
  const { problems } = linkFindings(before, after, { redesign: true });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /compliance/i);
  assert.match(problems[0], /unsubscribe/);
}

// Dropping a policy link fails under --redesign too.
{
  const before = '<a href="https://www.realskincare.com/policies/privacy-policy">p</a>';
  const after = '<p>no link</p>';
  const { problems } = linkFindings(before, after, { redesign: true });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /compliance/i);
}

// A redesign that keeps every link is clean — no warning noise.
{
  const before = '<a href="https://a.com/1">a</a>';
  const after = '<a href="https://a.com/1">a</a><a href="https://a.com/new">n</a>';
  const { problems, warnings } = linkFindings(before, after, { redesign: true });
  assert.deepEqual(problems, []);
  assert.deepEqual(warnings, []);
}

// {% unsubscribe %} expands to a whole <a> element, so putting it in an href nests an
// anchor inside an attribute and leaks raw markup into the rendered email. Klaviyo's
// tag for a bare URL is {% unsubscribe_link %}.
{
  const html = '<a href="{% unsubscribe %}" style="color:#000000;">Unsubscribe</a>';
  const { problems } = unsubscribeFindings(html);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /unsubscribe_link/);
}

// The correct tag passes.
{
  const html = '<a href="{% unsubscribe_link %}" style="color:#000000;">Unsubscribe</a>';
  assert.deepEqual(unsubscribeFindings(html).problems, []);
}

// Bare {% unsubscribe %} outside an href is Klaviyo's documented usage — it renders its
// own link, so it is correct and must not be flagged.
{
  const html = '<p>{% unsubscribe %}</p>';
  assert.deepEqual(unsubscribeFindings(html).problems, []);
}

// Swapping the broken {% unsubscribe %} for the correct {% unsubscribe_link %} is a fix,
// not a dropped compliance link. Without normalisation the compliance check fires on
// every one of the 22 rebuilds and hard-fails the very repair it should be demanding.
{
  const before = '<a href="{% unsubscribe %}">Unsubscribe</a>';
  const after = '<a href="{% unsubscribe_link %}">Unsubscribe</a>';
  const { problems, warnings } = linkFindings(before, after, { redesign: true });
  assert.deepEqual(problems, []);
  assert.deepEqual(warnings, []);
}

// Removing unsubscribe altogether is still a hard failure — the normalisation above must
// not become a hole that lets the link vanish.
{
  const before = '<a href="{% unsubscribe %}">Unsubscribe</a>';
  const after = '<p>nothing</p>';
  const { problems } = linkFindings(before, after, { redesign: true });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /compliance/i);
}

// The tag check needs the same unsubscribe normalisation as the link check, or the
// documented repair reads as a dropped Klaviyo tag.
{
  const before = "<a href=\"{% unsubscribe %}\">u</a>{% coupon_code 'WINBACK25' %}";
  const after = "<a href=\"{% unsubscribe_link %}\">u</a>{% coupon_code 'WINBACK25' %}";
  assert.deepEqual(tagFindings(before, after).problems, []);
}

// A genuinely dropped coupon tag still fails — it ships a broken offer.
{
  const before = "{% coupon_code 'WINBACK25' %}{% unsubscribe %}";
  const after = '{% unsubscribe %}';
  const { problems } = tagFindings(before, after);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /coupon_code/);
}

// Losing unsubscribe entirely still fails at the tag layer too.
{
  const { problems } = tagFindings('{% unsubscribe %}', '<p>nothing</p>');
  assert.equal(problems.length, 1);
  assert.match(problems[0], /unsubscribe/);
}

console.log('email-rebuild-checks: all assertions passed');
