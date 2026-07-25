import { strict as assert } from 'node:assert';
import { blocksCoreQuery } from '../../scripts/fix-shopping-test-targeting.mjs';

// The guard exists so legacy negatives inherited from old campaigns can never
// silently switch off the traffic the Shopping test depends on.

// PHRASE negatives block when the text appears contiguously in a core query.
assert.equal(blocksCoreQuery('body lotion', 'PHRASE'), true);
assert.equal(blocksCoreQuery('coconut', 'PHRASE'), true);
assert.equal(blocksCoreQuery('dry skin', 'PHRASE'), true);
assert.equal(blocksCoreQuery('coconut oil body lotion', 'PHRASE'), true);

// ...and do not block unrelated competitor / wrong-product terms.
assert.equal(blocksCoreQuery('nivea', 'PHRASE'), false);
assert.equal(blocksCoreQuery('cocoa butter', 'PHRASE'), false);
assert.equal(blocksCoreQuery('face cream', 'PHRASE'), false);
assert.equal(blocksCoreQuery('homemade', 'PHRASE'), false);
assert.equal(blocksCoreQuery('walmart', 'PHRASE'), false);

// EXACT only blocks on a full-string match.
assert.equal(blocksCoreQuery('coconut oil body lotion', 'EXACT'), true);
assert.equal(blocksCoreQuery('coconut oil', 'EXACT'), false);

// BROAD blocks when every word appears somewhere in the query, any order.
assert.equal(blocksCoreQuery('lotion', 'BROAD'), true);
assert.equal(blocksCoreQuery('lotion coconut', 'BROAD'), true);
assert.equal(blocksCoreQuery('lotion nivea', 'BROAD'), false);

// Normalisation: casing and whitespace must not defeat the guard.
assert.equal(blocksCoreQuery('  Body   Lotion ', 'PHRASE'), true);

// Empty / missing text is never treated as blocking.
assert.equal(blocksCoreQuery('', 'PHRASE'), false);
assert.equal(blocksCoreQuery(null, 'PHRASE'), false);

console.log('fix-shopping-test-targeting: all assertions passed');
