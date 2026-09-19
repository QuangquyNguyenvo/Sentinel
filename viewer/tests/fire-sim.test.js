import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createFireScenario,
  heatReleaseRate,
  heatToleranceTime,
  smokeArrivalField,
  smokeDensity,
  roomFillTime,
  smokeFrontSpeed,
  smokeOnsetTime,
  tenabilityTime,
} from '../src/fire-sim.js';

const FAST_ALPHA = 0.0469;
const SLOW_ALPHA = 0.00293;

// 3 x 12 px floor strip with a wall column at x = 6 and one door pixel row.
function stripMatrix({ door = true } = {}) {
  return Array.from({ length: 3 }, (_, y) => Uint16Array.from({ length: 12 }, (_, x) => {
    if (x !== 6) return 0;
    return door && y === 1 ? 2 : 1;
  }));
}

test('heat release follows the t-squared curve and is capped', () => {
  assert.ok(Math.abs(heatReleaseRate(0.01172, 100) - 117.2) < 1e-9);
  assert.equal(heatReleaseRate(0.1876, 1000, 5000), 5000);
  assert.equal(heatReleaseRate(0.1876, -1), 0);
});

test('smoke onset waits for the fire to reach the onset size', () => {
  assert.ok(Math.abs(smokeOnsetTime(0.01, 100) - 100) < 1e-9);
  assert.ok(smokeOnsetTime(FAST_ALPHA) < smokeOnsetTime(SLOW_ALPHA));
});

test('tenability time solves Ks(H) = limit', () => {
  const params = { ksMax: 1.4, tau: 25, ksLimit: 0.5 };
  const h = tenabilityTime(10, params);
  assert.ok(Math.abs(smokeDensity(h, 10, params) - 0.5) < 1e-9);
  // 25 * ln(1.4 / 0.9) is about 11 s, not the 15-20 s sometimes quoted.
  assert.ok(Math.abs(h - 10 - 11.05) < 0.01);
  assert.equal(tenabilityTime(Infinity, params), Infinity);
});

test('smoke front spreads through doors but not walls', () => {
  const open = smokeArrivalField({ matrix: stripMatrix(), originPoint: [0.5, 1.5], metersPerPixel: 1, smokeSpeed: 1, cellSize: 1 });
  assert.equal(open.arrival[1 * 12 + 0], 0);
  assert.ok(Math.abs(open.arrival[1 * 12 + 11] - 11) < 1e-6);
  assert.equal(open.arrival[0 * 12 + 6], Infinity);
  const closed = smokeArrivalField({ matrix: stripMatrix({ door: false }), originPoint: [0.5, 1.5], metersPerPixel: 1, smokeSpeed: 1, cellSize: 1 });
  assert.equal(closed.arrival[1 * 12 + 11], Infinity);
});

test('scenario reports untenable points and regions over time', () => {
  const scenario = createFireScenario({
    matrix: stripMatrix(),
    regions: [{ id: 1, bounds_px: [0, 0, 6, 3] }, { id: 2, bounds_px: [7, 0, 12, 3] }],
    originRegionId: 1,
    originPoint: [0.5, 1.5],
    metersPerPixel: 1,
    smokeSpeedMin: 1,
    smokeSpeedMax: 1,
    smokeOnsetKw: 0,
    initialHrrKw: 0,
    cellSize: 1,
  });
  // The ignition cell burns from the start.
  assert.equal(scenario.isUntenableAt([0.5, 1.5], 0.1), true);
  // Three cells away: smoke arrives at 3 s, untenable about 11 s later.
  assert.equal(scenario.isUntenableAt([3.5, 1.5], 12), false);
  assert.equal(scenario.isUntenableAt([3.5, 1.5], 15), true);
  assert.equal(scenario.isUntenableAt([11.5, 1.5], 12), false);
  assert.equal(scenario.isRegionUntenable(1, 20), true);
  assert.equal(scenario.isRegionUntenable(2, 12), false);
});

// Two 7.5 x 5 m rooms (0.25 m per pixel) joined by a door in the wall at x = 30.
function twoRoomMatrix() {
  return Array.from({ length: 20 }, (_, y) => Uint16Array.from({ length: 61 }, (_, x) => {
    if (x !== 30) return 0;
    return y >= 8 && y < 12 ? 2 : 1;
  }));
}

test('fire grows with Q, flashes over at 1055 kW and spreads to the next room', () => {
  const scenario = createFireScenario({
    matrix: twoRoomMatrix(),
    regions: [
      { id: 1, kind: 'floor', bounds_px: [0, 0, 30, 20] },
      { id: 2, kind: 'door', bounds_px: [30, 8, 31, 12] },
      { id: 3, kind: 'floor', bounds_px: [31, 0, 61, 20] },
    ],
    originRegionId: 1,
    originPoint: [5.5, 10.5],
    metersPerPixel: 0.25,
    growth: 'ultrafast',
    initialHrrKw: 0,
    cellSize: 1,
  });
  // Ultra-fast reaches 1055 kW after 75 s.
  assert.ok(Math.abs(scenario.flashover - 75) < 0.1);
  assert.ok(Math.abs(scenario.hrr(60) - 0.1876 * 3600) < 1e-6);
  assert.equal(scenario.isBurningAt([5.5, 10.5], 1), true);
  assert.equal(scenario.isBurningAt([25.5, 2.5], 70), false);
  // Flashover: the whole origin room burns at once.
  assert.equal(scenario.isBurningAt([25.5, 2.5], 75.2), true);
  assert.ok(scenario.hrr(80) >= 7.5 * 5 * 250 * 0.9);
  // The next room is reached through the door, then flashes over 60 s later.
  assert.equal(scenario.isBurningAt([59.5, 0.5], 110), false);
  assert.equal(scenario.isBurningAt([59.5, 0.5], 150), true);
  // Walls never burn.
  assert.equal(scenario.isBurningAt([30.5, 2.5], 1000), false);
});

test('smoke fills a long open floor', () => {
  // Regression: float32 rounding once stopped the front after a few cells.
  const matrix = Array.from({ length: 40 }, () => new Uint16Array(400));
  const field = smokeArrivalField({ matrix, originPoint: [200, 20], metersPerPixel: 0.05, smokeSpeed: 1.5, cellSize: 4 });
  assert.ok(field.arrival.every(Number.isFinite));
});

test('smoke speed grows with the fire and stays in the measured range', () => {
  assert.ok(Math.abs(smokeFrontSpeed(100) - 0.78) < 0.02);
  assert.ok(Math.abs(smokeFrontSpeed(500) - 1.33) < 0.02);
  assert.equal(smokeFrontSpeed(1), 0.3);
  assert.equal(smokeFrontSpeed(50000), 1.5);
});

test('a room fire fills its room before smoke spills out', () => {
  // 500 kW in a 112 m2 room with a 0.9 m deep layer above the door: ~40 s.
  const fill = roomFillTime(500, 112);
  assert.ok(fill > 30 && fill < 60, String(fill));
});

test('a fire found at 500 kW is already smoking and nearer flashover', () => {
  const base = {
    matrix: twoRoomMatrix(),
    regions: [
      { id: 1, kind: 'floor', bounds_px: [0, 0, 30, 20] },
      { id: 2, kind: 'door', bounds_px: [30, 8, 31, 12] },
      { id: 3, kind: 'floor', bounds_px: [31, 0, 61, 20] },
    ],
    originRegionId: 1,
    originPoint: [5.5, 10.5],
    metersPerPixel: 0.25,
    growth: 'medium',
    cellSize: 1,
  };
  const found = createFireScenario(base);
  assert.equal(found.onset, 0);
  assert.ok(Math.abs(found.hrr(0) - 500) < 1e-6);
  // Medium reaches 1055 kW at 300 s from ignition, 500 kW at 206 s.
  assert.ok(Math.abs(found.flashover - (300 - 206.5)) < 1);
  // Smoke reaches the next room only after the fire room has filled.
  const nextRoom = found.smokeArrival[10 * 61 + 45];
  assert.ok(nextRoom > found.fillDelay, `${nextRoom} <= ${found.fillDelay}`);
});

test('the fire front speeds up as the fire grows', () => {
  // 100 m x 10 m corridor (not a room, so no whole-room flashover).
  const matrix = Array.from({ length: 40 }, () => new Uint16Array(400));
  const scenario = createFireScenario({
    matrix,
    regions: [{ id: 1, kind: 'floor', bounds_px: [0, 0, 400, 40] }],
    originRegionId: 1,
    originPoint: [2, 20],
    metersPerPixel: 0.25,
    growth: 'ultrafast',
    initialHrrKw: 0,
    cellSize: 2,
  });
  const at = (x) => scenario.ignition[10 * scenario.field.cols + Math.floor(x / 2)];
  const early = at(100) - at(20);
  const late = at(180) - at(100);
  assert.ok(late < early, `late ${late} >= early ${early}`);
  // Left alone, the whole floor burns.
  assert.ok(scenario.ignition.every(Number.isFinite));
});

test('radiant heat: seconds in the flames, harmless far away, blocked by walls', () => {
  // Purser: about 4 s inside the flames, about 47 s at 10 kW/m2, none below 1.7.
  assert.ok(Math.abs(heatToleranceTime(60) - 4.3) < 0.1);
  assert.ok(Math.abs(heatToleranceTime(10) - 47) < 1);
  assert.equal(heatToleranceTime(1.5), Infinity);
  const scenario = createFireScenario({
    matrix: twoRoomMatrix(),
    regions: [
      { id: 1, kind: 'floor', bounds_px: [0, 0, 30, 20], neighbours: [2] },
      { id: 2, kind: 'door', bounds_px: [30, 8, 31, 12], neighbours: [1, 3] },
      { id: 3, kind: 'floor', bounds_px: [31, 0, 61, 20], neighbours: [2] },
    ],
    originRegionId: 1,
    originPoint: [5.5, 10.5],
    metersPerPixel: 0.25,
    growth: 'ultrafast',
    initialHrrKw: 0,
    cellSize: 1,
  });
  // Standing in the flames.
  assert.equal(scenario.heatFlux([5.5, 10.5], 10), scenario.params.flameFlux);
  assert.equal(scenario.isFlamingAt([5.5, 10.5], 10), true);
  // Just after flashover the whole room burns. Right behind the wall, half a
  // metre from the flames, only a little heat comes through the doorway.
  assert.ok(scenario.heatFlux([31.5, 2.5], 80) < 1.7);
  // In the open, close to the flaming door strip, it is painful.
  assert.ok(scenario.heatFlux([33, 10], 80) > 1.7);
  // Beyond the heat range there is nothing.
  assert.equal(scenario.heatFlux([60.5, 19.5], 80), 0);
  // Burnt-out floor no longer flames.
  assert.equal(scenario.isFlamingAt([5.5, 10.5], 10 + scenario.params.burnDuration + 1), false);
});

test('smoke is never later than the fire at any cell', () => {
  const scenario = createFireScenario({
    matrix: twoRoomMatrix(),
    regions: [
      { id: 1, kind: 'floor', bounds_px: [0, 0, 30, 20] },
      { id: 2, kind: 'door', bounds_px: [30, 8, 31, 12] },
      { id: 3, kind: 'floor', bounds_px: [31, 0, 61, 20] },
    ],
    originRegionId: 1,
    originPoint: [5.5, 10.5],
    metersPerPixel: 0.25,
    growth: 'ultrafast',
    cellSize: 1,
  });
  scenario.ignition.forEach((ignited, cell) => {
    if (Number.isFinite(ignited)) assert.ok(scenario.smokeArrival[cell] <= ignited);
  });
});
