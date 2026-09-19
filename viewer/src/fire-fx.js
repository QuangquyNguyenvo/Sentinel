import * as THREE from 'three';

// Sprites from Kenney's Particle Pack (CC0), see public/assets/fx/README.md.
const TEXTURE_URLS = {
  fire: '/assets/fx/fire_01.png',
  smoke: '/assets/fx/smoke_04.png',
};

const textureLoader = new THREE.TextureLoader();
const textures = {};
function texture(name) {
  if (!textures[name]) {
    textures[name] = textureLoader.load(TEXTURE_URLS[name]);
    textures[name].colorSpace = THREE.SRGBColorSpace;
  }
  return textures[name];
}

const particleVertexShader = /* glsl */`
  attribute float aSize;
  attribute float aAlpha;
  attribute float aAngle;
  attribute vec3 aColor;
  uniform float uScale;
  varying float vAlpha;
  varying float vAngle;
  varying vec3 vColor;
  void main() {
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    gl_PointSize = aSize * uScale / -mvPosition.z;
    vAlpha = aAlpha;
    vAngle = aAngle;
    vColor = aColor;
  }
`;

const particleFragmentShader = /* glsl */`
  uniform sampler2D uMap;
  varying float vAlpha;
  varying float vAngle;
  varying vec3 vColor;
  void main() {
    vec2 centered = gl_PointCoord - 0.5;
    float s = sin(vAngle);
    float c = cos(vAngle);
    vec2 uv = vec2(c * centered.x - s * centered.y, s * centered.x + c * centered.y) + 0.5;
    if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) discard;
    vec4 sprite = texture2D(uMap, vec2(uv.x, 1.0 - uv.y));
    float alpha = sprite.a * vAlpha;
    if (alpha < 0.004) discard;
    gl_FragColor = vec4(vColor * sprite.rgb, alpha);
  }
`;

/**
 * A fixed-size pool of camera-facing sprites drawn as one THREE.Points.
 * `spawn(particle)` fills a particle; `step(particle, t)` animates it where t
 * is its normalised age (0..1).
 */
class SpritePool {
  constructor({ name, capacity, map, blending, spawn, step }) {
    this.capacity = capacity;
    this.spawnParticle = spawn;
    this.stepParticle = step;
    this.particles = Array.from({ length: capacity }, () => ({
      alive: false, age: 0, life: 1, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, size: 0, spin: 0, angle: 0, seed: 0, density: 1,
    }));
    this.cursor = 0;
    this.spawnDebt = 0;
    const geometry = new THREE.BufferGeometry();
    this.positions = new Float32Array(capacity * 3);
    this.sizes = new Float32Array(capacity);
    this.alphas = new Float32Array(capacity);
    this.angles = new Float32Array(capacity);
    this.colors = new Float32Array(capacity * 3);
    geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute('aSize', new THREE.BufferAttribute(this.sizes, 1).setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute('aAlpha', new THREE.BufferAttribute(this.alphas, 1).setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute('aAngle', new THREE.BufferAttribute(this.angles, 1).setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute('aColor', new THREE.BufferAttribute(this.colors, 3).setUsage(THREE.DynamicDrawUsage));
    this.material = new THREE.ShaderMaterial({
      uniforms: { uMap: { value: map }, uScale: { value: 500 } },
      vertexShader: particleVertexShader,
      fragmentShader: particleFragmentShader,
      transparent: true,
      depthWrite: false,
      blending,
    });
    this.points = new THREE.Points(geometry, this.material);
    this.points.name = name;
    this.points.frustumCulled = false;
  }

  update(delta, rate, context) {
    this.spawnDebt += rate * delta;
    while (this.spawnDebt >= 1) {
      this.spawnDebt -= 1;
      const particle = this.particles[this.cursor];
      this.cursor = (this.cursor + 1) % this.capacity;
      particle.alive = true;
      particle.age = 0;
      particle.seed = Math.random();
      this.spawnParticle(particle, context);
    }
    let drawn = 0;
    for (const particle of this.particles) {
      if (!particle.alive) continue;
      particle.age += delta;
      if (particle.age >= particle.life) {
        particle.alive = false;
        continue;
      }
      particle.x += particle.vx * delta;
      particle.y += particle.vy * delta;
      particle.z += particle.vz * delta;
      particle.angle += particle.spin * delta;
      const look = this.stepParticle(particle, particle.age / particle.life, context);
      this.positions.set([particle.x, particle.y, particle.z], drawn * 3);
      this.colors.set(look.color, drawn * 3);
      this.sizes[drawn] = look.size;
      this.alphas[drawn] = look.alpha;
      this.angles[drawn] = particle.angle;
      drawn += 1;
    }
    const geometry = this.points.geometry;
    geometry.setDrawRange(0, drawn);
    for (const name of ['position', 'aSize', 'aAlpha', 'aAngle', 'aColor']) geometry.getAttribute(name).needsUpdate = true;
  }

  dispose() {
    this.points.geometry.dispose();
    this.material.dispose();
  }
}

const colorScratch = [0, 0, 0];
function mixColor(a, b, t) {
  colorScratch[0] = a[0] + (b[0] - a[0]) * t;
  colorScratch[1] = a[1] + (b[1] - a[1]) * t;
  colorScratch[2] = a[2] + (b[2] - a[2]) * t;
  return colorScratch;
}
const HOT = [1, 0.92, 0.55];
const WARM = [1, 0.45, 0.08];
const EMBER = [0.75, 0.12, 0.03];
const SMOKE_LIGHT = [0.42, 0.42, 0.44];
const SMOKE_DARK = [0.12, 0.12, 0.13];
const SMOKE_LIT = [0.9, 0.45, 0.2];

const flameVertexShader = /* glsl */`
  attribute vec3 aCenter;
  attribute vec2 aSize;
  attribute float aSeed;
  attribute float aFade;
  varying vec2 vUv;
  varying float vSeed;
  varying float vFade;
  void main() {
    // Billboard that stays upright from the side and leans towards the
    // screen's up direction when seen from above, so it never turns edge-on.
    vec3 right = normalize(vec3(viewMatrix[0][0], 0.0, viewMatrix[2][0]) + 1e-5);
    vec3 cameraUp = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
    vec3 up = normalize(mix(vec3(0.0, 1.0, 0.0), cameraUp, 0.6));
    vec3 center = (modelMatrix * vec4(aCenter, 1.0)).xyz;
    vec3 world = center + right * position.x * aSize.x + up * position.y * aSize.y;
    gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
    vUv = vec2(position.x + 0.5, position.y);
    vSeed = aSeed;
    vFade = aFade;
  }
`;

// A flame from two layers of rising noise: a teardrop body with licking
// tongues, dark red at the edges, orange, then yellow-white in the core.
const flameFragmentShader = /* glsl */`
  uniform float uTime;
  varying vec2 vUv;
  varying float vSeed;
  varying float vFade;
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
  }
  float fbm(vec2 p) {
    return noise(p) * 0.5 + noise(p * 2.03) * 0.28 + noise(p * 4.1) * 0.14 + noise(p * 8.3) * 0.08;
  }
  void main() {
    float t = uTime * 1.4 + vSeed * 37.0;
    float y = vUv.y;
    float n = fbm(vec2(vUv.x * 2.5 + vSeed * 13.0, y * 2.0 - t));
    float n2 = fbm(vec2(vUv.x * 6.0 + vSeed * 7.0, y * 5.0 - t * 1.6));
    // Sway the body sideways, more towards the top.
    float x = (vUv.x - 0.5) * 2.0 + (n - 0.5) * 1.2 * y;
    // Rounded teardrop (width ~ sqrt(1 - y)) with ragged, flickering edges.
    float width = 0.9 * sqrt(max(0.0, 1.0 - y)) + 0.02;
    float body = 1.0 - smoothstep(0.35, 1.0, abs(x) / width + (n2 - 0.5) * 0.9);
    float top = 1.0 - smoothstep(0.35, 1.0, y + (n2 - 0.5) * 0.8);
    // The upper part breaks up into separate tongues.
    float tongues = mix(1.0, smoothstep(0.3, 0.65, n2), y);
    // Round the base off so the flame does not stand on a flat edge.
    float base = smoothstep(0.0, 0.3, y + (1.0 - abs(x) / width) * 0.15 - 0.08 + (n2 - 0.5) * 0.2);
    float heat = clamp(body * top * tongues * base * 1.3, 0.0, 1.0);
    if (heat < 0.02) discard;
    vec3 color = mix(vec3(0.45, 0.04, 0.0), vec3(1.0, 0.36, 0.04), smoothstep(0.05, 0.5, heat));
    // A yellow core only low in the flame.
    color = mix(color, vec3(1.0, 0.78, 0.38), smoothstep(0.7, 1.0, heat) * (1.0 - vUv.y));
    gl_FragColor = vec4(color, heat * vFade * 0.7);
  }
`;

/**
 * Procedural flames: a pool of camera-facing quads animated entirely in the
 * shader. The CPU only places them; each lives a second or two and fades
 * in and out so the fire front moves smoothly.
 */
class FlamePool {
  constructor(capacity) {
    this.capacity = capacity;
    this.flames = Array.from({ length: capacity }, () => ({ alive: false, age: 0, life: 1, x: 0, y: 0, z: 0, w: 0, h: 0, seed: 0 }));
    this.cursor = 0;
    this.spawnDebt = 0;
    const quad = new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0);
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.index = quad.index;
    geometry.setAttribute('position', quad.getAttribute('position'));
    this.centers = new Float32Array(capacity * 3);
    this.sizes = new Float32Array(capacity * 2);
    this.seeds = new Float32Array(capacity);
    this.fades = new Float32Array(capacity);
    const dynamic = (array, size) => new THREE.InstancedBufferAttribute(array, size).setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('aCenter', dynamic(this.centers, 3));
    geometry.setAttribute('aSize', dynamic(this.sizes, 2));
    geometry.setAttribute('aSeed', dynamic(this.seeds, 1));
    geometry.setAttribute('aFade', dynamic(this.fades, 1));
    geometry.instanceCount = 0;
    this.material = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 } },
      vertexShader: flameVertexShader,
      fragmentShader: flameFragmentShader,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.mesh = new THREE.Mesh(geometry, this.material);
    this.mesh.name = 'fire-flames';
    this.mesh.frustumCulled = false;
  }

  update(delta, rate, { place, radius, height }) {
    this.material.uniforms.uTime.value += delta;
    this.spawnDebt += rate * delta;
    while (this.spawnDebt >= 1) {
      this.spawnDebt -= 1;
      const flame = this.flames[this.cursor];
      this.cursor = (this.cursor + 1) % this.capacity;
      place(flame);
      flame.alive = true;
      flame.age = 0;
      flame.life = 1.2 + Math.random() * 1.2;
      // Mostly smaller tongues with the odd big one.
      const size = 0.45 + Math.random() ** 2 * 0.75;
      flame.w = radius * 2 * size * (0.8 + Math.random() * 0.4);
      flame.h = height * (0.5 + size * 0.7) * (0.8 + Math.random() * 0.4);
      flame.seed = Math.random();
    }
    let drawn = 0;
    for (const flame of this.flames) {
      if (!flame.alive) continue;
      flame.age += delta;
      if (flame.age >= flame.life) {
        flame.alive = false;
        continue;
      }
      const t = flame.age / flame.life;
      this.centers[drawn * 3] = flame.x;
      this.centers[drawn * 3 + 1] = 0.01;
      this.centers[drawn * 3 + 2] = flame.z;
      this.sizes[drawn * 2] = flame.w;
      this.sizes[drawn * 2 + 1] = flame.h * (0.85 + 0.15 * Math.sin(Math.PI * t));
      this.seeds[drawn] = flame.seed;
      this.fades[drawn] = Math.min(1, t * 5) * Math.min(1, (1 - t) * 3);
      drawn += 1;
    }
    const geometry = this.mesh.geometry;
    geometry.instanceCount = drawn;
    for (const name of ['aCenter', 'aSize', 'aSeed', 'aFade']) geometry.getAttribute(name).needsUpdate = true;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}

/**
 * Flames, glow, embers and rising smoke over a burning area. Each frame the
 * caller passes `update(delta, { place, radius, height, ceiling, intensity })`
 * where `place(particle)` sets particle.x/z to a random burning spot in
 * world coordinates and radius/height describe one local flame.
 */
export function createFireEffect() {
  const group = new THREE.Group();
  group.name = 'fire-effect';
  const look = { color: HOT, size: 0, alpha: 0 };

  const flames = new FlamePool(220);

  // Soft glow at the base of the flames.
  const glow = new SpritePool({
    name: 'fire-glow',
    capacity: 240,
    map: texture('fire'),
    blending: THREE.AdditiveBlending,
    spawn(particle, { place, radius, height }) {
      place(particle);
      particle.life = 0.6 + Math.random() * 0.5;
      particle.vx = (Math.random() - 0.5) * radius * 0.3;
      particle.vz = (Math.random() - 0.5) * radius * 0.3;
      particle.vy = (height / particle.life) * 0.35;
      particle.size = Math.max(radius * 1.8, height * 0.5) * (0.7 + Math.random() * 0.4);
      // Sprites face the camera; start them above the floor so the floor
      // does not cut their lower half off flat.
      particle.y = particle.size * 0.3;
      particle.angle = Math.random() * Math.PI * 2;
      particle.spin = (Math.random() - 0.5) * 2;
    },
    step(particle, t) {
      look.color = t < 0.35 ? mixColor(HOT, WARM, t / 0.35) : mixColor(WARM, EMBER, (t - 0.35) / 0.65);
      look.size = particle.size * (0.6 + 0.5 * Math.sin(Math.PI * Math.min(1, t * 1.2)));
      look.alpha = Math.min(1, t * 6) * (1 - t) * 0.3;
      return look;
    },
  });

  // Embers: small sparks carried up by the plume, drifting and flickering.
  const embers = new SpritePool({
    name: 'fire-embers',
    capacity: 260,
    map: texture('fire'),
    blending: THREE.AdditiveBlending,
    spawn(particle, { place, radius, height }) {
      place(particle);
      particle.y = height * Math.random() * 0.4;
      particle.life = 1.2 + Math.random() * 1.8;
      particle.vx = (Math.random() - 0.5) * radius * 0.8;
      particle.vz = (Math.random() - 0.5) * radius * 0.8;
      particle.vy = height * (0.5 + Math.random() * 0.7);
      particle.size = Math.max(0.025, radius * 0.08) * (0.6 + Math.random() * 0.8);
      particle.angle = 0;
      particle.spin = 0;
    },
    step(particle, t, { ceiling }) {
      if (particle.y > ceiling) particle.vy = 0;
      particle.vx += Math.sin(particle.seed * 50 + t * 9) * 0.02;
      particle.vz += Math.cos(particle.seed * 70 + t * 7) * 0.02;
      look.color = mixColor(HOT, EMBER, t);
      look.size = particle.size;
      look.alpha = (1 - t) * (0.6 + 0.4 * Math.sin(particle.seed * 90 + t * 40));
      return look;
    },
  });

  const smoke = new SpritePool({
    name: 'smoke-particles',
    capacity: 200,
    map: texture('smoke'),
    blending: THREE.NormalBlending,
    spawn(particle, { place, radius, height, ceiling }) {
      place(particle);
      particle.y = Math.min(height * 0.9, ceiling * 0.7);
      particle.life = 3 + Math.random() * 2;
      particle.vx = (Math.random() - 0.5) * 0.25;
      particle.vz = (Math.random() - 0.5) * 0.25;
      particle.vy = ceiling * 0.35;
      particle.size = Math.max(radius * 2, ceiling * 0.5) * (0.8 + Math.random() * 0.4);
      particle.angle = Math.random() * Math.PI * 2;
      particle.spin = (Math.random() - 0.5) * 0.6;
    },
    step(particle, t, { ceiling }) {
      // The plume hits the ceiling and spreads sideways as a ceiling jet.
      if (particle.y > ceiling) {
        particle.y = ceiling;
        particle.vy = 0;
        particle.vx *= 1.02;
        particle.vz *= 1.02;
      }
      // Smoke leaves the flames lit orange, turns black, then greys as it thins.
      look.color = t < 0.15 ? mixColor(SMOKE_LIT, SMOKE_DARK, t / 0.15) : mixColor(SMOKE_DARK, SMOKE_LIGHT, (t - 0.15) * 0.6);
      look.size = particle.size * (0.6 + t * 1.6);
      look.alpha = Math.min(1, t * 4) * (1 - t) * 0.8;
      return look;
    },
  });

  // Drifting smoke under the ceiling wherever the smoke has reached;
  // `placeHaze(particle)` sets x/y/z and `density` (0..1).
  const haze = new SpritePool({
    name: 'smoke-haze',
    capacity: 320,
    map: texture('smoke'),
    blending: THREE.NormalBlending,
    spawn(particle, { placeHaze, ceiling }) {
      placeHaze(particle);
      particle.life = 5 + Math.random() * 4;
      particle.vx = (Math.random() - 0.5) * ceiling * 0.12;
      particle.vz = (Math.random() - 0.5) * ceiling * 0.12;
      particle.vy = 0;
      particle.size = ceiling * (0.9 + Math.random() * 0.7);
      particle.angle = Math.random() * Math.PI * 2;
      particle.spin = (Math.random() - 0.5) * 0.25;
    },
    step(particle, t) {
      look.color = mixColor(SMOKE_LIGHT, SMOKE_DARK, particle.density);
      look.size = particle.size * (0.8 + t * 0.5);
      look.alpha = Math.sin(Math.PI * t) * (0.15 + 0.4 * particle.density);
      return look;
    },
  });

  const pools = [haze, smoke, glow, embers];
  pools.forEach((pool) => group.add(pool.points));
  group.add(flames.mesh);
  // Draw the flames over their own smoke.
  haze.points.renderOrder = 3;
  smoke.points.renderOrder = 3;
  glow.points.renderOrder = 4;
  flames.mesh.renderOrder = 5;
  embers.points.renderOrder = 6;

  let budget = 1;
  return {
    group,
    /** Scale particle emission, e.g. 0.35 on slow machines. */
    setBudget(value) {
      budget = Math.max(0.1, Math.min(1, value));
    },
    setPixelScale(scale) {
      for (const pool of pools) pool.material.uniforms.uScale.value = scale;
    },
    /** `intensity` in 0..1 scales how many flames and particles are emitted. */
    update(delta, context) {
      const intensity = Math.max(0, Math.min(1, context.intensity ?? 1));
      // `flameCount` flames alive at a time (average life 1.8 s).
      const flameCount = context.flameCount ?? 8 + 60 * intensity;
      flames.update(delta, (flameCount / 1.8) * Math.max(0.4, budget), context);
      glow.update(delta, (30 + 160 * intensity) * budget, context);
      embers.update(delta, (10 + 80 * intensity) * budget, context);
      smoke.update(delta, context.smoke ? (8 + 34 * intensity) * budget : 0, context);
      // `haze` is the share of the floor under smoke (0..1).
      const hazeCover = Math.max(0, Math.min(1, context.haze ?? 0));
      haze.update(delta, context.placeHaze && hazeCover > 0 ? (12 + 90 * hazeCover) * budget : 0, context);
    },
    dispose() {
      pools.forEach((pool) => pool.dispose());
      flames.dispose();
    },
  };
}
