import test from 'node:test';
import assert from 'node:assert/strict';
import { isWalkableSegment } from '../src/walkable-route.js';

test('open corridor succeeds', () => {
  const matrix = Array.from({ length: 5 }, () => new Uint8Array([0, 0, 0, 0, 0]));
  assert.equal(isWalkableSegment(matrix, [0.2, 2.5], [4.7, 2.5]).ok, true);
});

test('wall or obstacle crossing fails', () => {
  const matrix = Array.from({ length: 5 }, () => new Uint8Array([0, 0, 1, 0, 0]));
  assert.equal(isWalkableSegment(matrix, [0.2, 2.5], [4.7, 2.5]).ok, false);

  matrix[2][2] = 4;
  assert.equal(isWalkableSegment(matrix, [0.2, 2.5], [4.7, 2.5]).ok, false);
});

test('out-of-bounds endpoints fail', () => {
  const matrix = Array.from({ length: 4 }, () => new Uint8Array([0, 0, 0, 0]));
  assert.equal(isWalkableSegment(matrix, [-0.1, 1], [3, 1]).reason, 'out-of-bounds');
  assert.equal(isWalkableSegment(matrix, [0, 1], [4, 1]).reason, 'out-of-bounds');
});

test('same and adjacent walkable areas succeed', () => {
  const matrix = Array.from({ length: 3 }, () => new Uint8Array([0, 0, 2]));
  assert.equal(isWalkableSegment(matrix, [0.4, 1.4], [0.4, 1.4]).ok, true);
  assert.equal(isWalkableSegment(matrix, [1.4, 1.4], [2.4, 1.4]).ok, true);
});

