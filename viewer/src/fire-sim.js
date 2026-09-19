// Simplified fire and smoke model used by the evacuation preview.
//
// Fire
// 1. The fire is found when it is already `initialHrrKw` (too big for an
//    extinguisher), then follows the NFPA 92 / SFPE t-squared curve:
//    Q(t) = alpha * (t + t0)^2 with t0 = sqrt(Q0 / alpha). The burning floor
//    area is A(t) = Q(t) / HRRPUA.
// 2. The t-squared classes are defined by the time to reach 1055 kW; at that
//    size a room flashes over and all of it burns.
// 3. After flashover the fire front travels along the floor, through doors
//    and around walls. Its speed grows with the fire: v = spreadSpeed *
//    (Q / 1055 kW)^(1/3), capped at `spreadSpeedMax`, so a bigger fire spreads
//    faster. When the front enters another room, that room flashes over
//    `roomFlashoverDelay` seconds later. A cell flames for `burnDuration`
//    seconds and is burnt out afterwards. Nothing stops the fire: left alone
//    it burns every reachable part of the floor.
//
// Smoke
// 4. Smoke spreads once Q reaches `smokeOnsetKw`. A fire in a room first fills
//    the room above the door soffit (plume mass flow, NFPA 92 axisymmetric
//    plume) before smoke spills out of the door.
// 5. The smoke front then travels over a coarse grid of the floor plan along
//    shortest paths (walls block, doors and exits do not) at a speed that
//    grows with the fire, v = 0.8 * (g Q / (rho cp T W))^(1/3) for a corridor
//    of width W (the usual buoyant gravity-current scaling), about 0.8 m/s at
//    100 kW and 1.3 m/s at 500 kW.
// 6. After arrival, Ks(t) = KsMax * (1 - exp(-(t - tArrive) / tau)); a cell is
//    untenable once Ks reaches the visibility limit, or once it has caught fire.
//    A burning cell always has smoke, so smoke never arrives after the fire.
//
// Heat
// 7. People near flames receive radiant heat from the flaming cells in sight
//    (same or adjacent navmesh region), each a point source with 30 % of its
//    heat radiated: q = sum(chi_r * Q_cell / (4 pi d^2)). Inside the flames
//    q = `flameFlux`. Purser's tolerance time for severe burns,
//    t = 16.7 * q^-1.33 minutes (q in kW/m2, no effect below 1.7 kW/m2),
//    gives about 4 s in the flames, half a minute at 10 kW/m2 and no harm
//    from walking briefly past a fire.
//
// This is a teaching/visualisation model, not a CFD or zone-model substitute.

export const FIRE_GROWTH = {
  slow: { label: 'Slow', alpha: 0.00293 },
  medium: { label: 'Medium', alpha: 0.01172 },
  fast: { label: 'Fast', alpha: 0.0469 },
  ultrafast: { label: 'Ultra-fast', alpha: 0.1876 },
};

export const SMOKE_DEFAULTS = Object.freeze({
  initialHrrKw: 500, // kW, fire size when it is discovered
  smokeOnsetKw: 100, // kW, fire size at which a ceiling jet starts to spread
  smokeSpeedMin: 0.3, // m/s
  smokeSpeedMax: 1.5, // m/s
  corridorWidth: 3, // m, W in the smoke-front speed
  ceilingHeight: 3, // m
  doorHeight: 2.1, // m, smoke spills out of a room below this soffit
  ksMax: 1.4, // 1/m, dense smoke plateau
  tau: 25, // s, accumulation time constant
  ksLimit: 0.5, // 1/m, tenability limit (visibility about 5 m)
  visibilityConstant: 2.5, // V = C / Ks
  hrrPerArea: 250, // kW/m2, heat release rate per unit burning area (office fuel)
  flashoverKw: 1055, // kW, room flashover (the size that defines the t-squared classes)
  // m/s, fire front along the floor right after flashover (Q = 1055 kW).
  // Measured travelling fires spread at about 0.001-0.02 m/s; this is faster
  // so spread is visible. The speed grows with Q^(1/3).
  spreadSpeed: 0.05,
  spreadSpeedMax: 0.4, // m/s
  roomFlashoverDelay: 60, // s from the front entering a room until the whole room burns
  burnDuration: 300, // s a floor cell keeps flaming before it is burnt out
  radiantFraction: 0.3, // share of the heat release radiated
  flameFlux: 60, // kW/m2 on a person standing in the flames
  heatRange: 4, // m, flames further away are ignored
});

/** Seconds of exposure to a radiant flux of `q` kW/m2 until severe burns (Purser). */
export function heatToleranceTime(q) {
  if (!(q > 1.7)) return Infinity;
  return 16.7 * 60 * q ** -1.33;
}

// Semantic labels smoke cannot pass: walls and unknown/outside pixels.
const SMOKE_BLOCKING_LABELS = new Set([1, 255]);

export function heatReleaseRate(alpha, seconds, maxKw = Infinity) {
  if (!(seconds > 0)) return 0;
  return Math.min(maxKw, alpha * seconds * seconds);
}

export function smokeOnsetTime(alpha, onsetKw = SMOKE_DEFAULTS.smokeOnsetKw) {
  return onsetKw > 0 ? Math.sqrt(onsetKw / alpha) : 0;
}

/** Smoke-front speed (m/s) for a fire of `hrrKw` in a corridor of width `width`. */
export function smokeFrontSpeed(hrrKw, {
  corridorWidth = SMOKE_DEFAULTS.corridorWidth,
  smokeSpeedMin = SMOKE_DEFAULTS.smokeSpeedMin,
  smokeSpeedMax = SMOKE_DEFAULTS.smokeSpeedMax,
} = {}) {
  // g = 9.81 m/s2, rho = 1.2 kg/m3, cp = 1.0 kJ/kgK, T = 293 K.
  const speed = 0.8 * Math.cbrt((9.81 * Math.max(0, hrrKw)) / (1.2 * 1.0 * 293 * corridorWidth));
  return Math.min(smokeSpeedMax, Math.max(smokeSpeedMin, speed));
}

/**
 * Seconds for a fire of `hrrKw` to fill a room of `floorArea` m2 down to the
 * door soffit, from the NFPA 92 plume mass flow at the soffit height:
 * m = 0.071 Qc^(1/3) z^(5/3) + 0.0018 Qc with Qc = 0.7 Q, smoke at ~1 kg/m3.
 */
export function roomFillTime(hrrKw, floorArea, {
  ceilingHeight = SMOKE_DEFAULTS.ceilingHeight,
  doorHeight = SMOKE_DEFAULTS.doorHeight,
} = {}) {
  const convective = 0.7 * Math.max(1, hrrKw);
  const massFlow = 0.071 * Math.cbrt(convective) * doorHeight ** (5 / 3) + 0.0018 * convective;
  return (floorArea * Math.max(0, ceilingHeight - doorHeight)) / massFlow;
}

export function smokeDensity(seconds, arrival, { ksMax = SMOKE_DEFAULTS.ksMax, tau = SMOKE_DEFAULTS.tau } = {}) {
  if (!Number.isFinite(arrival) || seconds <= arrival) return 0;
  return ksMax * (1 - Math.exp(-(seconds - arrival) / tau));
}

/** Time H at which Ks(H) reaches ksLimit: H = tArrive - tau * ln(1 - ksLimit / ksMax). */
export function tenabilityTime(arrival, {
  ksMax = SMOKE_DEFAULTS.ksMax,
  tau = SMOKE_DEFAULTS.tau,
  ksLimit = SMOKE_DEFAULTS.ksLimit,
} = {}) {
  if (!Number.isFinite(arrival) || ksLimit >= ksMax) return Infinity;
  return arrival - tau * Math.log(1 - ksLimit / ksMax);
}

export function visibilityDistance(ks, constant = SMOKE_DEFAULTS.visibilityConstant) {
  return ks > 0 ? constant / ks : Infinity;
}

/** Binary min-heap of [time, index] pairs. */
function createMinHeap() {
  const heap = [];
  return {
    size: () => heap.length,
    push(time, index) {
      heap.push([time, index]);
      let i = heap.length - 1;
      while (i > 0) {
        const parent = (i - 1) >> 1;
        if (heap[parent][0] <= time) break;
        [heap[parent], heap[i]] = [heap[i], heap[parent]];
        i = parent;
      }
    },
    pop() {
      const top = heap[0];
      const last = heap.pop();
      if (heap.length) {
        heap[0] = last;
        let i = 0;
        for (;;) {
          const left = i * 2 + 1;
          const right = left + 1;
          let smallest = i;
          if (left < heap.length && heap[left][0] < heap[smallest][0]) smallest = left;
          if (right < heap.length && heap[right][0] < heap[smallest][0]) smallest = right;
          if (smallest === i) break;
          [heap[smallest], heap[i]] = [heap[i], heap[smallest]];
          i = smallest;
        }
      }
      return top;
    },
  };
}

const NEIGHBOUR_STEPS = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2]];

/**
 * Travel time (s) at a constant `smokeSpeed` from `originPoint` to every grid
 * cell; with the default speed of 1 m/s this is the walking distance in metres.
 * A cell of `cellSize` x `cellSize` pixels is open only if none of its pixels
 * is a wall, so a thin wall cannot leak smoke through the coarse grid.
 */
export function smokeArrivalField({ matrix, originPoint, metersPerPixel, smokeSpeed = 1, cellSize = 4 }) {
  const pixelRows = matrix.length;
  const pixelCols = matrix[0].length;
  const cols = Math.ceil(pixelCols / cellSize);
  const rows = Math.ceil(pixelRows / cellSize);
  const open = new Uint8Array(cols * rows).fill(1);
  for (let y = 0; y < pixelRows; y += 1) {
    const row = matrix[y];
    const cellRow = Math.floor(y / cellSize) * cols;
    for (let x = 0; x < pixelCols; x += 1) {
      if (SMOKE_BLOCKING_LABELS.has(row[x])) open[cellRow + Math.floor(x / cellSize)] = 0;
    }
  }

  const arrival = new Float32Array(cols * rows).fill(Infinity);
  const originX = Math.min(cols - 1, Math.max(0, Math.floor(originPoint[0] / cellSize)));
  const originY = Math.min(rows - 1, Math.max(0, Math.floor(originPoint[1] / cellSize)));
  const secondsPerCell = (cellSize * metersPerPixel) / smokeSpeed;

  const { push, pop, size } = createMinHeap();

  const originIndex = originY * cols + originX;
  arrival[originIndex] = 0;
  push(0, originIndex);
  while (size()) {
    const [time, index] = pop();
    if (time > arrival[index]) continue;
    const x = index % cols;
    const y = (index - x) / cols;
    for (const [dx, dy, length] of NEIGHBOUR_STEPS) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
      const next = ny * cols + nx;
      if (!open[next]) continue;
      // Do not cut diagonally past a wall corner.
      if (dx && dy && (!open[y * cols + nx] || !open[ny * cols + x])) continue;
      // Round to float32 so the stored value and the heap key compare equal.
      const candidate = Math.fround(time + length * secondsPerCell);
      if (candidate < arrival[next]) {
        arrival[next] = candidate;
        push(candidate, next);
      }
    }
  }
  return { cellSize, cols, rows, arrival };
}

function median(values) {
  if (!values.length) return Infinity;
  values.sort((a, b) => a - b);
  return values[Math.floor(values.length / 2)];
}

/** A room can flash over as a whole; corridors and door strips cannot. */
function isRoomLike(region, metersPerPixel) {
  if (region.kind !== 'floor') return false;
  const [x0, y0, x1, y1] = region.bounds_px.map(Number);
  const short = Math.min(x1 - x0, y1 - y0) * metersPerPixel;
  const long = Math.max(x1 - x0, y1 - y0) * metersPerPixel;
  return short >= 2.5 && long / short <= 3;
}

/**
 * Ignition time (s) of every smoke-grid cell. Cells the smoke cannot reach
 * (walls, outside) never ignite.
 */
export function fireIgnitionField({ field, regions, originRegionId, metersPerPixel, alpha, params, startOffset = 0 }) {
  const { cols, rows, cellSize, arrival } = field;
  const cellCount = cols * rows;
  const cellArea = (cellSize * metersPerPixel) ** 2;

  // Which region each open cell belongs to (by cell centre).
  const regionIndex = new Int32Array(cellCount).fill(-1);
  const regionList = regions ?? [];
  const regionCells = regionList.map(() => []);
  regionList.forEach((region, index) => {
    const [x0, y0, x1, y1] = region.bounds_px.map(Number);
    for (let y = Math.max(0, Math.floor(y0 / cellSize)); y < Math.min(rows, Math.ceil(y1 / cellSize)); y += 1) {
      const cy = (y + 0.5) * cellSize;
      if (cy < y0 || cy >= y1) continue;
      for (let x = Math.max(0, Math.floor(x0 / cellSize)); x < Math.min(cols, Math.ceil(x1 / cellSize)); x += 1) {
        const cx = (x + 0.5) * cellSize;
        const cell = y * cols + x;
        if (cx < x0 || cx >= x1 || regionIndex[cell] >= 0 || !Number.isFinite(arrival[cell])) continue;
        regionIndex[cell] = index;
        regionCells[index].push(cell);
      }
    }
  });
  const roomLike = regionList.map((region) => isRoomLike(region, metersPerPixel));

  // Times are measured from discovery, when the fire is already `startOffset`
  // seconds into its t-squared growth.
  const flashover = Math.max(0, Math.sqrt(params.flashoverKw / alpha) - startOffset);
  const ignition = new Float32Array(cellCount).fill(Infinity);
  const front = new Float32Array(cellCount).fill(Infinity);
  const { push, pop, size } = createMinHeap();
  const seed = (cell, time) => {
    const value = Math.fround(time);
    if (value < front[cell]) {
      front[cell] = value;
      push(value, cell);
    }
  };

  // Before flashover the burning area grows with Q, nearest cells first.
  const byDistance = [];
  for (let cell = 0; cell < cellCount; cell += 1) if (Number.isFinite(arrival[cell])) byDistance.push(cell);
  byDistance.sort((a, b) => arrival[a] - arrival[b]);
  for (let rank = 0; rank < byDistance.length; rank += 1) {
    const time = Math.max(0, Math.sqrt((rank * cellArea * params.hrrPerArea) / alpha) - startOffset);
    if (time >= flashover) break;
    ignition[byDistance[rank]] = time;
    seed(byDistance[rank], flashover);
  }

  // After flashover the front spreads along the floor; rooms it enters
  // flash over shortly afterwards.
  const entered = new Uint8Array(regionList.length);
  const originIndex = regionList.findIndex((region) => region.id === originRegionId);
  if (originIndex >= 0) {
    entered[originIndex] = 1;
    if (roomLike[originIndex]) for (const cell of regionCells[originIndex]) seed(cell, flashover);
  }
  // The front speed depends on the fire size, estimated from the cells that
  // have ignited so far and are still flaming. Cells pop in time order, so
  // this is known when a cell's neighbours are relaxed.
  const cellMeters = cellSize * metersPerPixel;
  const flamingSince = [];
  for (const cell of byDistance) if (Number.isFinite(ignition[cell])) flamingSince.push(ignition[cell]);
  let burntOut = 0;
  const done = new Uint8Array(cellCount);
  const spreadSpeedAt = (time) => {
    while (burntOut < flamingSince.length && flamingSince[burntOut] < time - params.burnDuration) burntOut += 1;
    const hrr = Math.max(params.flashoverKw, (flamingSince.length - burntOut) * cellArea * params.hrrPerArea);
    return Math.min(params.spreadSpeedMax, params.spreadSpeed * Math.cbrt(hrr / params.flashoverKw));
  };
  while (size()) {
    const [time, cell] = pop();
    if (time > front[cell] || done[cell]) continue;
    done[cell] = 1;
    if (!(ignition[cell] <= time)) flamingSince.push(time);
    const secondsPerCell = cellMeters / spreadSpeedAt(time);
    const region = regionIndex[cell];
    if (region >= 0 && !entered[region]) {
      entered[region] = 1;
      if (roomLike[region]) for (const other of regionCells[region]) seed(other, time + params.roomFlashoverDelay);
    }
    const x = cell % cols;
    const y = (cell - x) / cols;
    for (const [dx, dy, length] of NEIGHBOUR_STEPS) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
      const next = ny * cols + nx;
      if (!Number.isFinite(arrival[next])) continue;
      if (dx && dy && (!Number.isFinite(arrival[y * cols + nx]) || !Number.isFinite(arrival[ny * cols + x]))) continue;
      seed(next, time + length * secondsPerCell);
    }
  }
  for (let cell = 0; cell < cellCount; cell += 1) {
    if (front[cell] < ignition[cell]) ignition[cell] = front[cell];
  }
  return { ignition, flashover, regionIndex, originIndex, roomLike, regionList };
}

/** Number of values in the ascending `sorted` array that are <= limit. */
function countAtMost(sorted, limit) {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (sorted[mid] <= limit) low = mid + 1;
    else high = mid;
  }
  return low;
}

export function createFireScenario({ matrix, regions, originRegionId, originPoint, metersPerPixel, growth = 'medium', cellSize = 4, ...overrides }) {
  const params = { ...SMOKE_DEFAULTS, ...overrides };
  const alpha = (FIRE_GROWTH[growth] ?? FIRE_GROWTH.medium).alpha;
  const startOffset = Math.sqrt(Math.max(0, params.initialHrrKw) / alpha);
  const growthHrr = (seconds) => heatReleaseRate(alpha, seconds + startOffset);
  const onset = Math.max(0, smokeOnsetTime(alpha, params.smokeOnsetKw) - startOffset);
  // With smokeSpeed = 1 the field holds walking distances in metres.
  const field = smokeArrivalField({ matrix, originPoint, metersPerPixel, smokeSpeed: 1, cellSize });
  const { ignition, flashover, regionIndex, originIndex, roomLike, regionList } = fireIgnitionField({
    field, regions, originRegionId, metersPerPixel, alpha, params, startOffset,
  });
  const cellArea = (cellSize * metersPerPixel) ** 2;

  // A room fire fills its own room before smoke spills out of the door.
  let fillDelay = 0;
  if (originIndex >= 0 && roomLike[originIndex]) {
    const [x0, y0, x1, y1] = regionList[originIndex].bounds_px.map(Number);
    fillDelay = roomFillTime(growthHrr(onset), (x1 - x0) * (y1 - y0) * metersPerPixel ** 2, params);
  }
  // Distance covered by the smoke front since onset, D(s) = integral of v(Q).
  const step = 0.25;
  const covered = [0];
  let maxDistance = 0;
  for (const value of field.arrival) if (Number.isFinite(value) && value > maxDistance) maxDistance = value;
  while (covered[covered.length - 1] < maxDistance && covered.length < 200000) {
    const t = onset + (covered.length - 0.5) * step;
    covered.push(covered[covered.length - 1] + smokeFrontSpeed(growthHrr(t), params) * step);
  }
  const travelTime = (distance) => {
    let low = 0;
    let high = covered.length - 1;
    if (!(distance <= covered[high])) return Infinity;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (covered[mid] < distance) low = mid + 1;
      else high = mid;
    }
    if (low === 0) return 0;
    const span = covered[low] - covered[low - 1];
    return (low - 1 + (span > 0 ? (distance - covered[low - 1]) / span : 1)) * step;
  };
  const smokeArrival = new Float32Array(field.arrival.length).fill(Infinity);
  let lastSmokeArrival = 0;
  field.arrival.forEach((distance, cell) => {
    if (!Number.isFinite(distance)) return;
    const inOrigin = originIndex >= 0 && regionIndex[cell] === originIndex;
    const time = Math.min(ignition[cell], onset + (inOrigin ? 0 : fillDelay) + travelTime(distance));
    smokeArrival[cell] = time;
    if (time > lastSmokeArrival) lastSmokeArrival = time;
  });

  // Cells sorted by ignition time: the cells flaming at time t are the
  // contiguous range [ignited(t - burnDuration), ignited(t)).
  const ignitable = [];
  ignition.forEach((value, index) => { if (Number.isFinite(value)) ignitable.push(index); });
  ignitable.sort((a, b) => ignition[a] - ignition[b]);
  const burnOrder = Uint32Array.from(ignitable);
  const sortedIgnition = Float32Array.from(ignitable, (index) => ignition[index]);
  const flashoverOrFirst = sortedIgnition.length ? sortedIgnition[0] : Infinity;
  const ignitedCount = (seconds) => countAtMost(sortedIgnition, seconds);
  const flamingRange = (seconds) => [ignitedCount(seconds - params.burnDuration), ignitedCount(seconds)];
  const flamingArea = (seconds) => {
    const [start, end] = flamingRange(seconds);
    return (end - start) * cellArea;
  };
  const hrr = (seconds) => (seconds < flashover ? growthHrr(seconds) : flamingArea(seconds) * params.hrrPerArea);

  const cellAt = (point) => {
    const x = Math.floor(point[0] / field.cellSize);
    const y = Math.floor(point[1] / field.cellSize);
    if (x < 0 || y < 0 || x >= field.cols || y >= field.rows) return -1;
    return y * field.cols + x;
  };
  const cellArrival = (point) => {
    const cell = cellAt(point);
    return cell < 0 ? Infinity : smokeArrival[cell];
  };
  const cellIgnition = (point) => {
    const cell = cellAt(point);
    return cell < 0 ? Infinity : ignition[cell];
  };
  const isFlaming = (cell, seconds) => seconds >= ignition[cell] && seconds < ignition[cell] + params.burnDuration;

  // Regions a person can see into: its own and the regions next to it.
  const regionPosition = new Map(regionList.map((region, index) => [region.id, index]));
  const inSight = regionList.map((region, index) => {
    const visible = new Set([index]);
    for (const id of region.neighbours ?? []) if (regionPosition.has(id)) visible.add(regionPosition.get(id));
    return visible;
  });
  const cellMeters = cellSize * metersPerPixel;
  const heatReach = Math.ceil(params.heatRange / cellMeters);
  const cellRadiant = params.radiantFraction * params.hrrPerArea * cellArea;
  /** Radiant heat flux (kW/m2) at `point`. */
  const heatFlux = (point, seconds) => {
    const cell = cellAt(point);
    if (cell < 0 || seconds < flashoverOrFirst) return 0;
    if (isFlaming(cell, seconds)) return params.flameFlux;
    const x0 = cell % field.cols;
    const y0 = (cell - x0) / field.cols;
    const own = regionIndex[cell];
    let flux = 0;
    for (let y = Math.max(0, y0 - heatReach); y <= Math.min(field.rows - 1, y0 + heatReach); y += 1) {
      for (let x = Math.max(0, x0 - heatReach); x <= Math.min(field.cols - 1, x0 + heatReach); x += 1) {
        const other = y * field.cols + x;
        if (!isFlaming(other, seconds)) continue;
        const region = regionIndex[other];
        if (own >= 0 && region >= 0 && !inSight[own].has(region)) continue;
        const distance = Math.hypot(x - x0, y - y0) * cellMeters;
        if (distance > params.heatRange) continue;
        flux += cellRadiant / (4 * Math.PI * Math.max(cellMeters, distance) ** 2);
      }
    }
    return Math.min(params.flameFlux, flux);
  };

  // Routing works on navmesh regions. A region counts as blocked once its
  // median cell is untenable or on fire, so one smoky corner does not close
  // a corridor.
  const regionTenability = new Map();
  const regionIgnition = new Map();
  for (const region of regions ?? []) {
    const [x0, y0, x1, y1] = region.bounds_px.map(Number);
    const arrivals = [];
    const ignitions = [];
    for (let y = Math.floor(y0 / cellSize); y < Math.ceil(y1 / cellSize); y += 1) {
      for (let x = Math.floor(x0 / cellSize); x < Math.ceil(x1 / cellSize); x += 1) {
        const cell = y * field.cols + x;
        if (!Number.isFinite(field.arrival[cell])) continue;
        arrivals.push(smokeArrival[cell]);
        ignitions.push(ignition[cell]);
      }
    }
    const ignited = median(ignitions);
    regionIgnition.set(region.id, ignited);
    regionTenability.set(region.id, Math.min(tenabilityTime(median(arrivals), params), ignited));
  }

  return {
    originRegionId,
    originPoint: [Number(originPoint[0]), Number(originPoint[1])],
    growth,
    alpha,
    onset,
    fillDelay,
    flashover,
    smokeArrival,
    lastSmokeArrival,
    params,
    field,
    ignition,
    burnOrder,
    lastIgnition: sortedIgnition.length ? sortedIgnition[sortedIgnition.length - 1] : 0,
    regionTenability,
    hrr,
    flamingRange,
    flamingArea,
    isBurningAt: (point, seconds) => seconds >= cellIgnition(point),
    isFlamingAt: (point, seconds) => {
      const cell = cellAt(point);
      return cell >= 0 && isFlaming(cell, seconds);
    },
    heatFlux,
    densityAt: (point, seconds) => smokeDensity(seconds, cellArrival(point), params),
    isUntenableAt: (point, seconds) => seconds >= cellIgnition(point) || seconds >= tenabilityTime(cellArrival(point), params),
    isRegionUntenable: (regionId, seconds) => seconds >= (regionTenability.get(regionId) ?? Infinity),
    isRegionBurning: (regionId, seconds) => seconds >= (regionIgnition.get(regionId) ?? Infinity),
    /** Calls visit(cellIndex, Ks) for every grid cell. */
    densityField(seconds, visit) {
      for (let index = 0; index < smokeArrival.length; index += 1) {
        visit(index, smokeDensity(seconds, smokeArrival[index], params));
      }
    },
  };
}
