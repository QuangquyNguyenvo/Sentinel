export const WALKABLE_LABELS = new Set([0, 2, 3]);

// Validating every row is O(rows); cache it because the simulation checks
// segments against the same matrix many times per frame.
const dimensionCache = new WeakMap();

function matrixDimensions(matrix) {
  if (!Array.isArray(matrix) || matrix.length === 0) return null;
  const cached = dimensionCache.get(matrix);
  if (cached && cached.rows === matrix.length) return cached;
  const cols = matrix[0]?.length;
  if (!Number.isInteger(cols) || cols <= 0) return null;
  if (!matrix.every((row) => row && typeof row.length === 'number' && row.length === cols)) return null;
  const dimensions = { rows: matrix.length, cols };
  dimensionCache.set(matrix, dimensions);
  return dimensions;
}

function pointInMatrix(matrix, point, dimensions) {
  if (!Array.isArray(point) || point.length < 2) return null;
  const x = Number(point[0]);
  const y = Number(point[1]);
  if (!Number.isFinite(x) || !Number.isFinite(y)
    || x < 0 || y < 0 || x >= dimensions.cols || y >= dimensions.rows) return null;
  const col = Math.floor(x);
  const row = Math.floor(y);
  const label = Number(matrix[row][col]);
  if (!Number.isFinite(label)) return null;
  return { x, y, row, col, label };
}

/**
 * Check a straight, continuous segment against semantic pixel labels.
 * Sampling below one pixel ensures a thin one-pixel wall cannot be skipped.
 */
export function isWalkableSegment(matrix, start, goal, options = {}) {
  const dimensions = matrixDimensions(matrix);
  if (!dimensions) return { ok: false, reason: 'invalid-matrix' };

  const startPoint = pointInMatrix(matrix, start, dimensions);
  const goalPoint = pointInMatrix(matrix, goal, dimensions);
  if (!startPoint || !goalPoint) return { ok: false, reason: 'out-of-bounds' };

  const labels = options.walkableLabels ?? WALKABLE_LABELS;
  const samplesPerPixel = Number.isFinite(options.samplesPerPixel)
    ? Math.max(2, options.samplesPerPixel)
    : 4;
  const distance = Math.hypot(goalPoint.x - startPoint.x, goalPoint.y - startPoint.y);
  const steps = Math.max(1, Math.ceil(distance * samplesPerPixel));

  for (let index = 0; index <= steps; index += 1) {
    const t = index / steps;
    const x = startPoint.x + (goalPoint.x - startPoint.x) * t;
    const y = startPoint.y + (goalPoint.y - startPoint.y) * t;
    if (!Number.isFinite(x) || !Number.isFinite(y)
      || x < 0 || y < 0 || x >= dimensions.cols || y >= dimensions.rows) {
      return { ok: false, reason: 'out-of-bounds', point: [x, y] };
    }
    const label = Number(matrix[Math.floor(y)][Math.floor(x)]);
    if (!Number.isFinite(label) || !labels.has(label)) {
      return {
        ok: false,
        reason: 'non-walkable',
        point: [x, y],
        label,
      };
    }
  }

  return { ok: true, samples: steps + 1 };
}
