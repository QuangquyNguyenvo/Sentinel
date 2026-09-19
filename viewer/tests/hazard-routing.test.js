import test from 'node:test';
import assert from 'node:assert/strict';
import {
  hazardAwareShortestPath,
  hazardEdgePenalty,
  sampleSegmentHazard,
  shouldRetryNoRoute,
} from '../src/hazard-routing.js';

function graph(edges) {
  const adjacency = new Map();
  for (const [source, target, length] of edges) {
    const edge = { node: target, length, lengthPx: length };
    const reverse = { node: source, length, lengthPx: length };
    (adjacency.get(source) ?? adjacency.set(source, []).get(source)).push(edge);
    (adjacency.get(target) ?? adjacency.set(target, []).get(target)).push(reverse);
  }
  return adjacency;
}

test('segment sampling sees a tiny flame bottleneck and chooses a longer alternative', () => {
  const positions = { s: [0, 0], flame: [5, 0], detour: [0, 5], g: [10, 0] };
  const adjacency = graph([['s', 'flame', 5], ['flame', 'g', 5], ['s', 'detour', 5], ['detour', 'g', 11]]);
  const route = hazardAwareShortestPath({
    startId: 's', goalId: 'g', adjacency, positionOf: (id) => positions[id],
    sampleEdge: (start, end) => sampleSegmentHazard(start, end, (point) => ({
      activeFlame: point[0] > 4 && point[0] < 6 && point[1] < 1,
    }), { stepPx: 0.5 }),
  });
  assert.equal(route.status, 'ok');
  assert.deepEqual(route.path, ['s', 'detour', 'g']);
  assert.equal(route.lengthPx, 16);
});

test('smoke is a cost penalty, not a universal route ban', () => {
  const positions = { s: [0, 0], smoky: [5, 0], g: [10, 0] };
  const adjacency = graph([['s', 'smoky', 5], ['smoky', 'g', 5]]);
  const route = hazardAwareShortestPath({
    startId: 's', goalId: 'g', adjacency, positionOf: (id) => positions[id],
    sampleEdge: () => sampleSegmentHazard([0, 0], [1, 0], () => ({ smokeDensity: 1 })),
  });
  assert.equal(route.status, 'ok');
  assert.ok(route.cost > route.lengthPx);
  assert.equal(Number.isFinite(hazardEdgePenalty({ averageSmoke: 1 })), true);
});

test('a person starting in flame may take a descending escape edge', () => {
  const positions = { s: [0, 0], safe: [5, 0], g: [10, 0] };
  const adjacency = graph([['s', 'safe', 5], ['safe', 'g', 5]]);
  const route = hazardAwareShortestPath({
    startId: 's', goalId: 'g', adjacency, positionOf: (id) => positions[id],
    startHazard: { activeFlame: true, heatFlux: 60 },
    sampleEdge: (start, end) => sampleSegmentHazard(start, end, (point) => ({
      activeFlame: point[0] < 1,
      heatFlux: point[0] < 1 ? 60 : 0,
    }), { stepPx: 0.5 }),
  });
  assert.equal(route.status, 'ok');
  assert.deepEqual(route.path, ['s', 'safe', 'g']);
});

test('escape cannot cross a deeper flame before reaching safety', () => {
  const positions = { s: [0, 0], deep: [5, 0], g: [10, 0] };
  const adjacency = graph([['s', 'deep', 5], ['deep', 'g', 5]]);
  const route = hazardAwareShortestPath({
    startId: 's', goalId: 'g', adjacency, positionOf: (id) => positions[id],
    startHazard: { heatFlux: 3 },
    sampleEdge: (start, end) => sampleSegmentHazard(start, end, (point) => ({
      heatFlux: point[0] < 1 ? 3 : point[0] < 4 ? 60 : 0,
    }), { stepPx: 0.5 }),
  });
  assert.equal(route.status, 'unreachable');
});

test('a monotonic high-heat retreat may remain hazardous across a plateau', () => {
  const positions = { s: [0, 0], middle: [5, 0], g: [10, 0] };
  const adjacency = graph([['s', 'middle', 5], ['middle', 'g', 5]]);
  const route = hazardAwareShortestPath({
    startId: 's', goalId: 'g', adjacency, positionOf: (id) => positions[id],
    startHazard: { heatFlux: 60, activeFlame: true },
    sampleEdge: (start, end) => sampleSegmentHazard(start, end, (point) => ({
      activeFlame: point[0] < 5,
      heatFlux: point[0] < 5 ? 60 : 0,
    }), { stepPx: 0.5 }),
  });
  assert.equal(route.status, 'ok');
  assert.deepEqual(route.path, ['s', 'middle', 'g']);
});

test('no-route agents retry after the fire has evolved', () => {
  assert.equal(shouldRetryNoRoute(4, 3.2, 1), false);
  assert.equal(shouldRetryNoRoute(4.2, 3.2, 1), true);
  assert.equal(shouldRetryNoRoute(0, -Infinity, 1), true);
});
