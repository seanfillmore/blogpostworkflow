import { strict as assert } from 'assert';
import { stripHtmlForReview, truncateToWord, renderReviewBody } from '../../lib/judgeme.js';

// stripHtmlForReview removes tags and collapses whitespace
assert.equal(
  stripHtmlForReview('<p>Great <strong>product</strong>!</p>'),
  'Great product !'
);
assert.equal(
  stripHtmlForReview('  <br>  Hello  <br>  world  '),
  'Hello world'
);

// truncateToWord does not cut mid-word
assert.equal(truncateToWord('one two three four five', 14), 'one two three');
assert.equal(truncateToWord('short', 200), 'short');
assert.equal(truncateToWord('exactlytwenty!', 14), 'exactlytwenty!');

// renderReviewBody: strips HTML, checks word count ≥ 20, truncates to 200
const longReview = 'word '.repeat(25).trim(); // 25 words
assert.equal(renderReviewBody(longReview), longReview.slice(0, 200).trimEnd());
assert.equal(renderReviewBody('too short'), null); // under 20 words
assert.equal(renderReviewBody('<p>' + 'word '.repeat(25).trim() + '</p>'), 'word '.repeat(25).trim().slice(0, 200).trimEnd());

console.log('✓ judgeme lib unit tests pass');
