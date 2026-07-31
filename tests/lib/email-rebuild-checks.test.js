import { strict as assert } from 'node:assert';
import { classifyLinks, linkFindings } from '../../lib/email-rebuild-checks.js';

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

console.log('email-rebuild-checks: all assertions passed');
