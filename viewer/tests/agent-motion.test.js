import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SpatialHash,
  circlesOverlap,
  movementBlockedByCircle,
  segmentIntersectsCircle,
  shortestAngleDelta,
  stepHeading,
} from '../src/agent-motion.js';

test('heading turns by the shortest bounded step', () => {
  assert.ok(Math.abs(stepHeading(0, Math.PI / 2, Math.PI / 4) - Math.PI / 4) < 1e-9);
  assert.ok(Math.abs(shortestAngleDelta(Math.PI * 0.95, -Math.PI * 0.95)) < Math.PI * 0.2);
});

test('circular hitboxes detect overlap and separation', () => {
  assert.equal(circlesOverlap([0, 0], 1, [1.5, 0], 1), true);
  assert.equal(circlesOverlap([0, 0], 1, [2.1, 0], 1), false);
  assert.equal(circlesOverlap([0, 0], 1, [2.1, 0], 1, 0.2), true);
});

test('swept circular hitboxes catch fast movement between frames', () => {
  assert.equal(segmentIntersectsCircle([0, 0], [10, 0], [5, 0], 0.5), true);
  assert.equal(segmentIntersectsCircle([0, 0], [10, 0], [5, 1], 0.5), false);
  assert.equal(segmentIntersectsCircle([0, 0], [0, 0], [0.4, 0], 0.5), true);
});

test('an overlapping queue leader may move away but not deeper into a neighbour', () => {
  assert.equal(movementBlockedByCircle([0, 0], [1, 0], [-0.5, 0], 1), false);
  assert.equal(movementBlockedByCircle([0, 0], [-0.25, 0], [-0.5, 0], 1), true);
  assert.equal(movementBlockedByCircle([0, 0], [10, 0], [5, 0], 1), true);
});

test('spatial hash returns local neighbors without global scanning', () => {
  const hash = new SpatialHash(1);
  const near = { id: 'near' };
  const far = { id: 'far' };
  hash.insert(near, 0.4, 0.2);
  hash.insert(far, 8, 8);
  const neighbors = [];
  hash.queryInto(0, 0, 1.2, neighbors);
  assert.deepEqual(neighbors.map((item) => item.id), ['near']);
  hash.move(near, 8, 8);
  hash.queryInto(0, 0, 1.2, neighbors);
  assert.deepEqual(neighbors, []);
});
