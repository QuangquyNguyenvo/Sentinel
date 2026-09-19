import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DOOR_CLOSE_SECONDS,
  DOOR_HOLD_SECONDS,
  DOOR_OPEN_SECONDS,
  doorLayout,
  doorPassFactor,
  isInsideDoor,
  leafSegments,
  stepDoor,
} from '../src/doors.js';

test('wide openings get double doors, narrow ones a single leaf', () => {
  const wide = doorLayout({ id: 1, kind: 'door', bounds_px: [180, 244, 228, 256] }, 0.05);
  assert.equal(wide.leaves.length, 2);
  assert.deepEqual(wide.normal, [0, 1]);
  assert.equal(wide.leaves[0].length, 24);
  const narrow = doorLayout({ id: 2, kind: 'exit', bounds_px: [60, 296, 72, 314] }, 0.05);
  assert.equal(narrow.leaves.length, 1);
  assert.deepEqual(narrow.normal, [1, 0]);
  assert.equal(isInsideDoor(narrow, [66, 300]), true);
  assert.equal(isInsideDoor(narrow, [80, 300]), false);
});

test('a door opens for a visitor, stays open, then closes', () => {
  const door = doorLayout({ id: 1, kind: 'door', bounds_px: [0, 10, 40, 20] }, 0.05, 1);
  for (let t = 0; t <= DOOR_OPEN_SECONDS; t += 0.1) stepDoor(door, 0.1, [20, 2]);
  assert.equal(door.open, 1);
  assert.equal(doorPassFactor(door), 1);
  // Nobody near: still open during the hold time, then it closes.
  for (let t = 0; t < DOOR_HOLD_SECONDS - 0.2; t += 0.1) stepDoor(door, 0.1, null);
  assert.equal(door.open, 1);
  for (let t = 0; t < DOOR_CLOSE_SECONDS + 0.5; t += 0.1) stepDoor(door, 0.1, null);
  assert.equal(door.open, 0);
  // A closed door slows people down while they push it.
  assert.ok(doorPassFactor(door) < 0.5);
});

test('swinging leaves are solid, on the swing side; resting leaves are wall', () => {
  // A 2.4 m double door in a horizontal wall (y 10..20), swinging to +y.
  const door = doorLayout({ id: 1, kind: 'door', bounds_px: [0, 10, 48, 20] }, 0.05, 1);
  assert.deepEqual(leafSegments(door), []);
  door.open = 0.5;
  const segments = leafSegments(door);
  assert.equal(segments.length, 2);
  for (const [x0, y0, x1, y1] of segments) {
    // Hinged just outside the +y wall face and turned 90 degrees into +y.
    assert.ok(y0 > 20);
    assert.ok(y1 - y0 > 23);
    assert.ok(Math.abs(x1 - x0) < 1e-9);
  }
  door.open = 1;
  assert.deepEqual(leafSegments(door), []);
});
