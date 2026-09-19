export function wrapAngle(angle) {
  const fullTurn = Math.PI * 2;
  return ((angle + Math.PI) % fullTurn + fullTurn) % fullTurn - Math.PI;
}

export function shortestAngleDelta(current, target) {
  return wrapAngle(target - current);
}

export function stepHeading(current, target, maxStep) {
  const step = Math.max(0, Number(maxStep) || 0);
  const delta = shortestAngleDelta(current, target);
  if (Math.abs(delta) <= step) return wrapAngle(target);
  return wrapAngle(current + Math.sign(delta) * step);
}

export function circlesOverlap(aPoint, aRadius, bPoint, bRadius, padding = 0) {
  const dx = Number(aPoint[0]) - Number(bPoint[0]);
  const dy = Number(aPoint[1]) - Number(bPoint[1]);
  const distance = Math.hypot(dx, dy);
  return distance < Number(aRadius) + Number(bRadius) + Math.max(0, Number(padding) || 0);
}

/**
 * Returns true when a line segment comes within the supplied radius of a
 * point. Keeping this calculation allocation-free lets the simulation use it
 * for swept hitboxes instead of allowing a fast frame to tunnel through a
 * neighbour.
 */
export function segmentIntersectsCircle(start, end, center, radius) {
  const startX = Number(start[0]);
  const startY = Number(start[1]);
  const deltaX = Number(end[0]) - startX;
  const deltaY = Number(end[1]) - startY;
  const lengthSquared = deltaX * deltaX + deltaY * deltaY;
  let projection = 0;
  if (lengthSquared > 0) {
    projection = ((Number(center[0]) - startX) * deltaX + (Number(center[1]) - startY) * deltaY) / lengthSquared;
    projection = Math.min(1, Math.max(0, projection));
  }
  const closestX = startX + deltaX * projection;
  const closestY = startY + deltaY * projection;
  const distanceX = Number(center[0]) - closestX;
  const distanceY = Number(center[1]) - closestY;
  const safeRadius = Math.max(0, Number(radius) || 0);
  return distanceX * distanceX + distanceY * distanceY < safeRadius * safeRadius;
}

/**
 * Collision gate for a moving circle against a stationary neighbour circle.
 * Existing overlap is allowed to resolve when the proposed movement increases
 * separation; this prevents a queue from deadlocking its front-most agent.
 */
export function movementBlockedByCircle(start, end, center, combinedRadius) {
  const startX = Number(start[0]) - Number(center[0]);
  const startY = Number(start[1]) - Number(center[1]);
  const endX = Number(end[0]) - Number(center[0]);
  const endY = Number(end[1]) - Number(center[1]);
  const startDistanceSquared = startX * startX + startY * startY;
  const endDistanceSquared = endX * endX + endY * endY;
  const radius = Math.max(0, Number(combinedRadius) || 0);
  const radiusSquared = radius * radius;
  const startsOverlapping = startDistanceSquared < radiusSquared;
  const endsOverlapping = endDistanceSquared < radiusSquared;
  const movingCloser = endDistanceSquared < startDistanceSquared - 1e-9;

  if (startsOverlapping) return endsOverlapping && movingCloser;
  if (endsOverlapping) return true;
  return segmentIntersectsCircle(start, end, center, radius);
}

export class SpatialHash {
  constructor(cellSize = 1) {
    this.cellSize = Math.max(0.0001, Number(cellSize) || 1);
    this.buckets = new Map();
  }

  cellX(x) {
    return Math.floor(Number(x) / this.cellSize);
  }

  cellY(y) {
    return Math.floor(Number(y) / this.cellSize);
  }

  cellCoordinates(x, y) {
    return [this.cellX(x), this.cellY(y)];
  }

  key(cellX, cellY) {
    return `${cellX}:${cellY}`;
  }

  clear() {
    for (const bucket of this.buckets.values()) {
      for (const item of bucket) {
        item.__spatialBucket = null;
        item.__spatialIndex = -1;
      }
      bucket.length = 0;
    }
    this.buckets.clear();
  }

  insert(item, x, y) {
    const cellX = this.cellX(x);
    const cellY = this.cellY(y);
    const key = this.key(cellX, cellY);
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = [];
      this.buckets.set(key, bucket);
    }
    item.__spatialBucket = bucket;
    item.__spatialCellX = cellX;
    item.__spatialCellY = cellY;
    item.__spatialIndex = bucket.length;
    bucket.push(item);
  }

  remove(item) {
    const bucket = item.__spatialBucket;
    if (!bucket) return;
    const index = item.__spatialIndex;
    const last = bucket.pop();
    if (last && last !== item) {
      bucket[index] = last;
      last.__spatialIndex = index;
    }
    item.__spatialBucket = null;
    item.__spatialIndex = -1;
  }

  move(item, x, y) {
    const cellX = this.cellX(x);
    const cellY = this.cellY(y);
    if (item.__spatialBucket && item.__spatialCellX === cellX && item.__spatialCellY === cellY) return;
    this.remove(item);
    this.insert(item, x, y);
  }

  queryInto(x, y, radius, output) {
    output.length = 0;
    const centerX = this.cellX(x);
    const centerY = this.cellY(y);
    const cells = Math.max(0, Math.ceil(Number(radius) / this.cellSize));
    for (let cellY = centerY - cells; cellY <= centerY + cells; cellY += 1) {
      for (let cellX = centerX - cells; cellX <= centerX + cells; cellX += 1) {
        const bucket = this.buckets.get(this.key(cellX, cellY));
        if (!bucket) continue;
        for (const item of bucket) output.push(item);
      }
    }
    return output;
  }
}
