/** Pure helpers for hazard-aware route sampling and weighted shortest paths. */

function numberOr(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function pointDistance(a, b) {
  return Math.hypot(numberOr(a?.[0]) - numberOr(b?.[0]), numberOr(a?.[1]) - numberOr(b?.[1]));
}

function pointAt(start, end, fraction, target = [0, 0]) {
  target[0] = numberOr(start?.[0]) + (numberOr(end?.[0]) - numberOr(start?.[0])) * fraction;
  target[1] = numberOr(start?.[1]) + (numberOr(end?.[1]) - numberOr(start?.[1])) * fraction;
  return target;
}

function sampleValue(value) {
  if (value == null) return {};
  if (typeof value === 'number') return { heatFlux: value };
  return value;
}

/** Convert a sample into a comparable hazard severity for escape monotonicity. */
export function hazardSeverity(sample = {}) {
  const value = sampleValue(sample);
  const heat = Math.max(0, numberOr(value.heatFlux ?? value.heat ?? value.radiantHeat));
  const flame = value.activeFlame || value.flaming || value.onFire ? 1 : 0;
  return flame * 1_000_000 + heat;
}

/**
 * Sample an actual geometric segment. The returned maxima are suitable for
 * hard hazard rejection, while the average smoke value becomes a routing
 * penalty. `sample` receives [x, y] points and may return heatFlux, smoke,
 * smokeDensity, or activeFlame/flaming.
 */
export function sampleSegmentHazard(start, end, sample, {
  stepPx = 2,
  maxSamples = Infinity,
} = {}) {
  const lengthPx = pointDistance(start, end);
  const requestedCount = Math.max(1, Math.ceil(lengthPx / Math.max(0.01, numberOr(stepPx, 2))));
  // A caller may opt into a finite cap for a deliberately coarse preview, but
  // the default samples every requested step so a one-pixel flame cannot be
  // skipped on a long graph edge.
  const count = Number.isFinite(maxSamples)
    ? Math.max(1, Math.min(requestedCount, Math.max(1, Math.floor(maxSamples))))
    : requestedCount;
  const samples = [];
  let maxHeat = 0;
  let maxSmoke = 0;
  let totalSmoke = 0;
  let activeFlame = false;
  let maximumSeverity = 0;
  let first = {};
  let last = {};
  const point = [0, 0];
  for (let index = 0; index <= count; index += 1) {
    pointAt(start, end, count ? index / count : 0, point);
    const value = sampleValue(sample?.(point) ?? {});
    if (!index) first = { ...value };
    last = { ...value };
    const heat = Math.max(0, numberOr(value.heatFlux ?? value.heat ?? value.radiantHeat));
    const smoke = Math.max(0, numberOr(value.smokeDensity ?? value.smoke ?? value.ks));
    maxHeat = Math.max(maxHeat, heat);
    maxSmoke = Math.max(maxSmoke, smoke);
    totalSmoke += smoke;
    activeFlame ||= Boolean(value.activeFlame || value.flaming || value.onFire);
    maximumSeverity = Math.max(maximumSeverity, hazardSeverity(value));
    samples.push({ point: [point[0], point[1]], ...value });
  }
  return {
    lengthPx,
    samples,
    first,
    last,
    maxHeat,
    maxSmoke,
    averageSmoke: totalSmoke / samples.length,
    activeFlame,
    maximumSeverity,
    startSeverity: hazardSeverity(first),
    endSeverity: hazardSeverity(last),
  };
}

/** Route penalty for an already sampled segment. Infinity means hard reject. */
export function hazardEdgePenalty(hazard, {
  hardHeatFlux = 2.5,
  smokePenalty = 2.5,
  smokeReferenceDensity = 0.5,
  rejectFlames = true,
} = {}) {
  if (!hazard) return 1;
  if (rejectFlames && hazard.activeFlame) return Infinity;
  if (numberOr(hazard.maxHeat) >= hardHeatFlux) return Infinity;
  const smoke = Math.max(0, numberOr(hazard.averageSmoke));
  const reference = Math.max(0.0001, numberOr(smokeReferenceDensity, 0.5));
  return 1 + Math.max(0, numberOr(smokePenalty)) * Math.min(1, smoke / reference);
}

/** Return true when a previously unavailable route should be queried again. */
export function shouldRetryNoRoute(now, lastAttempt, retrySeconds = 1) {
  const current = numberOr(now, 0);
  const previous = Number(lastAttempt);
  const interval = Math.max(0, numberOr(retrySeconds, 1));
  return !Number.isFinite(previous) || current - previous >= interval;
}

function createMinHeap() {
  const heap = [];
  const push = (item) => {
    heap.push(item);
    let index = heap.length - 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (heap[parent][0] <= item[0]) break;
      heap[index] = heap[parent];
      index = parent;
    }
    heap[index] = item;
  };
  const pop = () => {
    const first = heap[0];
    const last = heap.pop();
    if (heap.length && last) {
      let index = 0;
      while (true) {
        const left = index * 2 + 1;
        const right = left + 1;
        if (left >= heap.length) break;
        const child = right < heap.length && heap[right][0] < heap[left][0] ? right : left;
        if (heap[child][0] >= last[0]) break;
        heap[index] = heap[child];
        index = child;
      }
      heap[index] = last;
    }
    return first;
  };
  return { heap, push, pop };
}

/**
 * Weighted Dijkstra over an adjacency map. Smoke increases cost; active flame
 * and high heat are rejected. A route may leave a person's initial hazard if
 * each accepted edge lowers the endpoint severity, but it cannot re-enter a
 * hard hazard after the path has cleared it.
 */
export function hazardAwareShortestPath({
  startId,
  goalId,
  adjacency,
  positionOf,
  startHazard = null,
  sampleEdge,
  edgePenalty = hazardEdgePenalty,
  edgePenaltyOptions,
  allowEscapeFromHazard = true,
} = {}) {
  if (!adjacency || typeof adjacency.get !== 'function' || typeof positionOf !== 'function') {
    return { status: 'invalid_graph', path: [], lengthPx: Infinity, cost: Infinity, edgeHazards: [] };
  }
  const initial = sampleValue(startHazard ?? {});
  const initialSeverity = hazardSeverity(initial);
  const queue = createMinHeap();
  const distances = new Map();
  const previous = new Map();
  const severityBucket = (value) => Number.isFinite(value) ? Math.round(Math.min(1_000_000, Math.max(0, value)) * 10) : 0;
  const stateKey = (node, cleared, severity) => `${String(node)}|${cleared ? 1 : 0}|${severityBucket(severity)}`;
  const startState = stateKey(startId, false, initialSeverity);
  distances.set(startState, 0);
  queue.push([0, startId, false, initialSeverity]);
  let finalState = null;
  while (queue.heap.length) {
    const [cost, current, cleared, currentSeverity] = queue.pop();
    const state = stateKey(current, cleared, currentSeverity);
    if (cost !== distances.get(state)) continue;
    if (current === goalId) {
      finalState = state;
      break;
    }
    for (const edge of adjacency.get(current) ?? []) {
      const fromPoint = positionOf(current);
      const toPoint = positionOf(edge.node);
      const hazard = sampleEdge ? sampleEdge(fromPoint, toPoint, edge, current) : null;
      const rawPenalty = numberOr(edgePenalty(hazard, edgePenaltyOptions), Infinity);
      const hardRejected = !Number.isFinite(rawPenalty);
      const endpointSeverity = hazard?.endSeverity ?? hazardSeverity(hazard?.last ?? {});
      const hardHeatFlux = Math.max(0, numberOr(edgePenaltyOptions?.hardHeatFlux, 2.5));
      const samples = hazard?.samples ?? [];
      const monotonicEscape = allowEscapeFromHazard && !cleared && initialSeverity > 0
        && samples.every((item, index) => index === 0 || hazardSeverity(item) <= hazardSeverity(samples[index - 1]) + 1e-6)
        && samples.every((item) => {
          const value = sampleValue(item);
          const heat = Math.max(0, numberOr(value.heatFlux ?? value.heat ?? value.radiantHeat));
          return hazardSeverity(value) <= currentSeverity + 1e-6 && (!value.activeFlame && !value.flaming && !value.onFire ? heat <= currentSeverity + 1e-6 : true);
        });
      const descendingEscape = monotonicEscape && endpointSeverity <= currentSeverity + 1e-6;
      if (hardRejected && !descendingEscape) continue;
      const endpointValue = sampleValue(hazard?.last ?? {});
      const endpointHeat = Math.max(0, numberOr(endpointValue.heatFlux ?? endpointValue.heat ?? endpointValue.radiantHeat));
      const endpointHard = Boolean(endpointValue.activeFlame || endpointValue.flaming || endpointValue.onFire) || endpointHeat >= hardHeatFlux;
      const nextCleared = cleared || (initialSeverity > 0 && !endpointHard);
      const lengthPx = Math.max(0, numberOr(edge.lengthPx ?? edge.length));
      // Escape edges still pay their geometric length. A tiny finite penalty
      // avoids making a flame crossing look free in the displayed cost.
      const penalty = Number.isFinite(rawPenalty) ? rawPenalty : 1;
      const candidate = cost + lengthPx * penalty;
      const keyedNextState = stateKey(edge.node, nextCleared, endpointSeverity);
      if (candidate >= (distances.get(keyedNextState) ?? Infinity)) continue;
      distances.set(keyedNextState, candidate);
      previous.set(keyedNextState, { state, node: current, edge, hazard });
      queue.push([candidate, edge.node, nextCleared, endpointSeverity]);
    }
  }
  if (!finalState) return { status: 'unreachable', path: [], lengthPx: Infinity, cost: Infinity, edgeHazards: [] };
  const path = [goalId];
  const edgeHazards = [];
  const pathEdges = [];
  let lengthPx = 0;
  let cursor = finalState;
  while (cursor !== startState) {
    const step = previous.get(cursor);
    if (!step) return { status: 'unreachable', path: [], lengthPx: Infinity, cost: Infinity, edgeHazards: [] };
    path.push(step.node);
    pathEdges.push(step.edge);
    edgeHazards.push(step.hazard);
    lengthPx += Math.max(0, numberOr(step.edge.lengthPx ?? step.edge.length));
    cursor = step.state;
  }
  path.reverse();
  edgeHazards.reverse();
  pathEdges.reverse();
  return {
    status: 'ok',
    path,
    lengthPx,
    cost: distances.get(finalState),
    edgeHazards,
    edges: pathEdges,
    escapedFromHazard: initialSeverity > 0 && finalState.includes('|1|'),
  };
}
