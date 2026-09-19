import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js';

// People from Kenney's Mini Characters (CC0), see public/assets/people.
// Several characters are baked so a crowd is not made of clones.
export const CHARACTER_URLS = [
  '/assets/people/character-male-a.glb',
  '/assets/people/character-female-a.glb',
  '/assets/people/character-male-c.glb',
  '/assets/people/character-female-c.glb',
  '/assets/people/character-male-e.glb',
  '/assets/people/character-female-e.glb',
];
export const CHARACTER_MAX_INSTANCES = 1024;

// Frames baked per animation. Each character gets, in order: one standing
// frame, then the walk, run, panic and death frames.
const CYCLE_FRAMES = { walk: 12, run: 10, panic: 10 };
export const CHARACTER_DEATH_FRAME_COUNT = 6;
// Collision radius as a share of height. The chibi characters are much wider
// than a person (about 0.13), so they are drawn narrower to keep a realistic
// number of people fitting through a door.
const TARGET_FOOTPRINT = 0.21;
// A death clip this short would snap to the floor; it is played slower.
const MIN_DEATH_SECONDS = 0.9;

/**
 * Frame index within one character for `pace` ('idle', 'walk', 'run' or
 * 'panic'). `phase` is the cycle position in cycles (any real number);
 * `deathProgress` runs from 0 (falling) to 1 (lying).
 */
export function characterFrameFor(render, pace, phase, dead = false, deathProgress = 1) {
  if (dead) {
    const step = Math.floor(Math.max(0, Math.min(1, deathProgress)) * render.deathFrameCount);
    return render.deadFrame + Math.min(render.deathFrameCount - 1, step);
  }
  const cycle = render.cycles?.[pace];
  if (!cycle) return 0;
  const position = phase - Math.floor(phase);
  return cycle.start + (Math.floor(position * cycle.count) % cycle.count);
}

function bakeMesh(mesh) {
  const geometry = new THREE.BufferGeometry();
  const source = mesh.geometry;
  const position = source.getAttribute('position');
  if (mesh.isSkinnedMesh) {
    const baked = new Float32Array(position.count * 3);
    const vertex = new THREE.Vector3();
    for (let index = 0; index < position.count; index += 1) {
      vertex.fromBufferAttribute(position, index);
      mesh.applyBoneTransform(index, vertex);
      vertex.toArray(baked, index * 3);
    }
    geometry.setAttribute('position', new THREE.BufferAttribute(baked, 3));
  } else {
    geometry.setAttribute('position', position.clone());
  }
  // The texture atlas needs the UVs; normals are rebuilt from the pose.
  if (source.getAttribute('uv')) geometry.setAttribute('uv', source.getAttribute('uv').clone());
  if (source.index) geometry.setIndex(source.index.clone());
  geometry.applyMatrix4(mesh.matrixWorld);
  geometry.computeVertexNormals();
  return geometry;
}

function bakePose(scene) {
  const parts = [];
  scene.traverse((object) => {
    if (object.isMesh) parts.push(bakeMesh(object));
  });
  const pose = BufferGeometryUtils.mergeGeometries(parts, false);
  parts.forEach((geometry) => geometry.dispose());
  return pose;
}

function createFrameMesh(group, geometry, material, capacity, name) {
  const mesh = new THREE.InstancedMesh(geometry, material, capacity);
  mesh.name = `simulation-character-${name}`;
  mesh.count = 0;
  mesh.visible = false;
  mesh.frustumCulled = false;
  mesh.castShadow = true;
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  // Allocate instance colours up front; setColorAt would otherwise create
  // the buffer lazily after the material program was compiled.
  mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3).fill(1), 3);
  mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
  group.add(mesh);
  return mesh;
}

/** Keep only the tracks of `clip` whose bone is (or is not) in `bones`. */
function filterTracks(clip, bones, keep) {
  const tracks = clip.tracks.filter((track) => bones.has(track.name.split('.')[0]) === keep);
  return new THREE.AnimationClip(`${clip.name}-${keep ? 'only' : 'without'}`, clip.duration, tracks);
}

/**
 * Bake one character's poses. Panic is the sprint's legs and body with the
 * arms and head of the falling clip, flailing twice per stride.
 */
function bakeCharacter(gltf) {
  const scene = gltf.scene;
  const clip = (name) => gltf.animations.find((item) => item.name === name);
  const idle = clip('idle');
  const walk = clip('walk');
  const sprint = clip('sprint');
  const fall = clip('fall');
  const die = clip('die');
  if (!idle || !walk || !sprint) throw new Error('The character has no idle/walk/sprint clips.');

  const mixer = new THREE.AnimationMixer(scene);
  const sample = (actions) => {
    mixer.stopAllAction();
    for (const [item, time, once] of actions) {
      const action = mixer.clipAction(item);
      // A looping clip sampled at its end wraps back to the first frame.
      action.setLoop(once ? THREE.LoopOnce : THREE.LoopRepeat, Infinity);
      action.clampWhenFinished = once;
      action.reset().play();
      action.time = once ? Math.min(time, item.duration) : time % item.duration;
    }
    mixer.update(0);
    scene.updateMatrixWorld(true);
    return bakePose(scene);
  };

  const poses = [sample([[idle, 0]])];
  const cycles = {};
  const addCycle = (name, source, count, extra = null) => {
    cycles[name] = { start: poses.length, count, seconds: source.duration };
    for (let index = 0; index < count; index += 1) {
      const time = (source.duration * index) / count;
      const actions = [[source, time]];
      if (extra) actions.push(extra(time));
      poses.push(sample(actions));
    }
  };
  addCycle('walk', walk, CYCLE_FRAMES.walk);
  addCycle('run', sprint, CYCLE_FRAMES.run);
  if (fall) {
    const upper = new Set(['arm-left', 'arm-right', 'head']);
    const legs = filterTracks(sprint, upper, false);
    const arms = filterTracks(fall, upper, true);
    const flailsPerStride = 2;
    addCycle('panic', legs, CYCLE_FRAMES.panic, (time) => [arms, (time / legs.duration) * flailsPerStride * arms.duration]);
  } else {
    cycles.panic = cycles.run;
  }
  const deadFrame = poses.length;
  const deathFrameCount = die ? CHARACTER_DEATH_FRAME_COUNT : 1;
  for (let index = 1; index <= deathFrameCount; index += 1) {
    poses.push(die ? sample([[die, (die.duration * index) / deathFrameCount, true]]) : sample([[idle, 0]]));
  }
  mixer.stopAllAction();
  mixer.uncacheRoot(scene);

  // Normalise every pose with the standing pose's bounds so frames share the
  // same origin and scale: feet on y = 0, centred, height 1.
  poses[0].computeBoundingBox();
  const bounds = poses[0].boundingBox;
  const inverseHeight = 1 / Math.max(1e-6, bounds.max.y - bounds.min.y);
  const center = bounds.getCenter(new THREE.Vector3());
  const footprint = (Math.max(bounds.max.x - bounds.min.x, bounds.max.z - bounds.min.z) / 2) * inverseHeight;
  for (const pose of poses) {
    pose.translate(-center.x, -bounds.min.y, -center.z);
    pose.scale(inverseHeight, inverseHeight, inverseHeight);
    pose.computeBoundingSphere();
  }
  let material = null;
  scene.traverse((object) => {
    if (object.isMesh && !material) material = object.material;
  });
  return {
    poses,
    cycles,
    deadFrame,
    deathFrameCount,
    deathSeconds: Math.max(MIN_DEATH_SECONDS, die?.duration ?? 1),
    footprint,
    material,
  };
}

/**
 * Load and bake the characters into shared instanced meshes. A crowd costs
 * one draw call per (character, frame) in use and no per-person skeletons.
 * Mesh index = character * framesPerCharacter + frame.
 */
export async function createPeopleRender({ group, capacity = CHARACTER_MAX_INSTANCES, urls = CHARACTER_URLS } = {}) {
  const loader = new GLTFLoader();
  const loaded = await Promise.allSettled(urls.map((url) => loader.loadAsync(url)));
  const characters = loaded.filter((result) => result.status === 'fulfilled').map((result) => bakeCharacter(result.value));
  if (!characters.length) throw loaded.find((result) => result.status === 'rejected')?.reason ?? new Error('No characters.');
  const first = characters[0];
  const footprint = Math.max(...characters.map((character) => character.footprint));
  const widthScale = Math.min(1, TARGET_FOOTPRINT / footprint);
  // The characters share one texture atlas; keep a single material.
  const material = first.material.clone();
  material.roughness = 0.75;
  material.metalness = 0;
  // People are spread evenly over the characters (see the caller), so one
  // frame mesh never holds more than its share.
  const meshCapacity = Math.ceil(capacity / characters.length);
  const frameMeshes = [];
  characters.forEach((character, characterIndex) => {
    character.poses.forEach((pose, frame) => {
      frameMeshes.push(createFrameMesh(group, pose, material, meshCapacity, `${characterIndex}-${frame}`));
    });
  });
  return {
    mode: 'people',
    group,
    capacity,
    meshCapacity,
    frameMeshes,
    materials: [material],
    variants: characters.length,
    framesPerVariant: first.poses.length,
    cycles: first.cycles,
    deadFrame: first.deadFrame,
    deathFrameCount: first.deathFrameCount,
    deathSeconds: first.deathSeconds,
    footprintRadius: footprint * widthScale,
    widthScale,
    textured: true,
  };
}

/**
 * Single-frame capsule person used while the characters load or if they fail.
 */
export function createFallbackCharacterRender({ group, capacity = CHARACTER_MAX_INSTANCES } = {}) {
  const parts = [
    new THREE.CapsuleGeometry(0.075, 0.3, 3, 8).translate(0, 0.4, 0),
    new THREE.SphereGeometry(0.085, 10, 8).translate(0, 0.78, 0),
    new THREE.ConeGeometry(0.035, 0.08, 4).rotateX(Math.PI / 2).translate(0, 0.7, 0.1),
  ].map((geometry) => geometry.toNonIndexed());
  parts.forEach((geometry) => geometry.deleteAttribute('uv'));
  const geometry = BufferGeometryUtils.mergeGeometries(parts, false);
  parts.forEach((part) => part.dispose());
  const material = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.7 });
  return {
    mode: 'fallback',
    group,
    capacity,
    meshCapacity: capacity,
    frameMeshes: [createFrameMesh(group, geometry, material, capacity, 'fallback')],
    materials: [material],
    variants: 1,
    framesPerVariant: 1,
    cycles: null,
    deadFrame: 0,
    deathFrameCount: 1,
    deathSeconds: 1,
    footprintRadius: 0.1,
    widthScale: 1,
    textured: false,
  };
}

export function disposeCharacterRender(render) {
  if (!render) return;
  render.disposed = true;
  for (const mesh of render.frameMeshes) {
    mesh.parent?.remove(mesh);
    mesh.geometry.dispose();
    mesh.dispose();
  }
  for (const material of render.materials) material.dispose();
}
