import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { scoreBase } from '../../lib/pipeline-priority.js';

const CFG = {
  base: { intentMult: { transactional: 1.4, commercial: 1.2, informational: 1.0 },
          volumeDivisor: 100, volumeCap: 50, kdEasyThreshold: 5, kdEasyBonus: 10 },
};

test('scoreBase: volume normalized, capped, times intent', () => {
  // volume 2000 -> 20; commercial 1.2 -> 24
  assert.equal(scoreBase({ volume: 2000, search_intent: 'commercial', kd: 40 }, CFG), 24);
});

test('scoreBase: volume cap applies', () => {
  // volume 999999 -> capped 50; informational 1.0 -> 50
  assert.equal(scoreBase({ volume: 999999, search_intent: 'informational', kd: 40 }, CFG), 50);
});

test('scoreBase: low-KD bonus added', () => {
  // volume 1000 -> 10; transactional 1.4 -> 14; +10 kd bonus = 24
  assert.equal(scoreBase({ volume: 1000, search_intent: 'transactional', kd: 2 }, CFG), 24);
});

test('scoreBase: missing fields default safely', () => {
  assert.equal(scoreBase({}, CFG), 0);
});
