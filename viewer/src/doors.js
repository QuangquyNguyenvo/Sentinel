import * as THREE from 'three';

// Swinging doors for door and exit openings.
//
// Each opening gets one leaf, or two (a double door) when it is wider than
// DOUBLE_DOOR_METERS. Leaves hang on one face of the wall and swing one way,
// towards `swing` (the egress side), folding flat against the wall when fully
// open. A door opens when someone comes within reach, stays open while people
// pass and closes a moment after the last one. While a leaf swings it is a
// solid obstacle (see leafSegments). Positions here are in map pixels; the
// meshes are placed through the caller's pixel-to-world function.

const DOUBLE_DOOR_METERS = 1.4;
export const DOOR_OPEN_SECONDS = 0.6;
export const DOOR_CLOSE_SECONDS = 1.4;
// How long a door stays open after the last person has left its reach.
export const DOOR_HOLD_SECONDS = 1.5;
// Fully open leaves lie flat against the wall.
const OPEN_ANGLE = Math.PI;
// Leaf thickness as a share of the wall thickness.
const LEAF_THICKNESS_RATIO = 0.15;

/**
 * Door geometry for a navmesh region with `bounds_px`. The opening runs along
 * the longer side; `normal` points across the wall and `swing` (+1 or -1)
 * picks the side of the wall the leaves hang on and open into.
 */
export function doorLayout(region, metersPerPixel, swing = 1) {
  const [x0, y0, x1, y1] = region.bounds_px.map(Number);
  const alongX = x1 - x0 >= y1 - y0;
  const center = [(x0 + x1) / 2, (y0 + y1) / 2];
  const width = alongX ? x1 - x0 : y1 - y0;
  const thickness = alongX ? y1 - y0 : x1 - x0;
  const axis = alongX ? [1, 0] : [0, 1];
  const normal = alongX ? [0, 1] : [1, 0];
  const start = alongX ? [x0, center[1]] : [center[0], y0];
  const end = alongX ? [x1, center[1]] : [center[0], y1];
  const double = width * metersPerPixel > DOUBLE_DOOR_METERS;
  const leaves = double
    ? [
      { hinge: start, direction: axis, length: width / 2 },
      { hinge: end, direction: [-axis[0], -axis[1]], length: width / 2 },
    ]
    : [{ hinge: start, direction: axis, length: width }];
  return {
    id: region.id,
    kind: region.kind,
    bounds: [x0, y0, x1, y1],
    center,
    width,
    thickness,
    normal,
    leaves,
    leafThickness: thickness * LEAF_THICKNESS_RATIO,
    open: 0,
    swing: swing < 0 ? -1 : 1,
    hold: 0,
  };
}

/** Hinge of `leaf` in map pixels: just outside the wall face on the swing side. */
function leafHinge(door, leaf) {
  const offset = (door.thickness / 2 + door.leafThickness / 2) * door.swing;
  return [leaf.hinge[0] + door.normal[0] * offset, leaf.hinge[1] + door.normal[1] * offset];
}

/** Direction of `leaf` from its hinge towards its free edge, at the current opening. */
function leafDirection(door, leaf) {
  const angle = door.open * OPEN_ANGLE;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle) * door.swing;
  return [leaf.direction[0] * cos + door.normal[0] * sin, leaf.direction[1] * cos + door.normal[1] * sin];
}

/**
 * The leaves as line segments [x0, y0, x1, y1] in map pixels, or an empty
 * list when the door is at rest (closed in its frame or folded against the
 * wall), where it is part of the wall.
 */
export function leafSegments(door, output = []) {
  output.length = 0;
  if (door.open <= 0 || door.open >= 1) return output;
  for (const leaf of door.leaves) {
    const [hx, hy] = leafHinge(door, leaf);
    const [dx, dy] = leafDirection(door, leaf);
    output.push([hx, hy, hx + dx * leaf.length, hy + dy * leaf.length]);
  }
  return output;
}

/**
 * Advance a door by `delta` seconds. `visitor` is the nearest person within
 * reach (a pixel point) or null.
 */
export function stepDoor(door, delta, visitor) {
  if (visitor) {
    door.hold = DOOR_HOLD_SECONDS;
  } else {
    door.hold = Math.max(0, door.hold - delta);
  }
  const rate = door.hold > 0 ? delta / DOOR_OPEN_SECONDS : -delta / DOOR_CLOSE_SECONDS;
  door.open = Math.max(0, Math.min(1, door.open + rate));
  return door.open;
}

/** Walking speed factor inside a door: people slow down to push it open. */
export function doorPassFactor(door) {
  return Math.min(1, 0.35 + door.open);
}

export function isInsideDoor(door, point, margin = 0) {
  const [x0, y0, x1, y1] = door.bounds;
  return point[0] >= x0 - margin && point[0] < x1 + margin && point[1] >= y0 - margin && point[1] < y1 + margin;
}

/**
 * Meshes for all doors. `toWorld(pixelPoint, vector3)` maps map pixels to
 * the scene; `scale` is world units per pixel.
 */
export function createDoorMeshes(doors, { toWorld, scale, wallHeight, materials }) {
  const group = new THREE.Group();
  group.name = 'doors';
  const leafHeight = wallHeight * 0.8;
  for (const door of doors) {
    const leafThickness = Math.max(0.02, door.leafThickness * scale);
    const material = door.kind === 'exit' ? materials.exitDoor : materials.door;
    door.pivots = door.leaves.map((leaf) => {
      const length = leaf.length * scale;
      // A small gap keeps a leaf from touching its frame and the other leaf.
      const geometry = new THREE.BoxGeometry(length * 0.97, leafHeight, leafThickness);
      geometry.translate(length * 0.5, leafHeight / 2, 0);
      const mesh = new THREE.Mesh(geometry, material);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      const pivot = new THREE.Group();
      toWorld(leafHinge(door, leaf), pivot.position).y = 0.08;
      pivot.add(mesh);
      group.add(pivot);
      return pivot;
    });
    // Wall above the door.
    const [x0, y0, x1, y1] = door.bounds;
    const lintel = new THREE.Mesh(
      new THREE.BoxGeometry((x1 - x0) * scale, wallHeight - leafHeight - 0.08, (y1 - y0) * scale),
      materials.wall,
    );
    toWorld(door.center, lintel.position);
    lintel.position.y = (wallHeight + leafHeight + 0.08) / 2;
    lintel.castShadow = true;
    lintel.receiveShadow = true;
    group.add(lintel);
    if (door.kind === 'exit') {
      // A lit green EXIT sign over the door.
      const sign = new THREE.Mesh(
        new THREE.BoxGeometry(Math.max(0.12, door.width * scale * 0.35), 0.1, Math.max(0.12, door.width * scale * 0.35)),
        materials.exitSign,
      );
      toWorld(door.center, sign.position);
      sign.position.y = wallHeight + 0.05;
      group.add(sign);
    }
    updateDoorMesh(door);
  }
  return group;
}

export function updateDoorMesh(door) {
  door.leaves.forEach((leaf, index) => {
    const pivot = door.pivots?.[index];
    if (!pivot) return;
    // Map pixels (x, y) are world (x, z); a yaw of 0 points the leaf along +x.
    const [dx, dz] = leafDirection(door, leaf);
    pivot.rotation.y = Math.atan2(-dz, dx);
  });
}
