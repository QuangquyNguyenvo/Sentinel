import * as THREE from 'three';

// Textured, fire-aware surfaces for the floor map.
//
// Map geometry is made of stretched instanced boxes, so box UVs would smear a
// texture across a whole wall. Textures are instead projected from world
// coordinates on the three axes ("triplanar" mapping), which keeps the tile
// size constant on every face.
//
// Walls and doors can also read the fire's hazard texture (see main.js):
// G = smoke density next to this spot, A = fire next to it (1 flaming, about
// 0.55 burnt out); both are spread a little into the wall cells.
// Smoke stains the upper wall, fire chars it and flames lick up the surface.

// Colour maps from ambientCG (CC0), see public/assets/textures/README.md.
const TEXTURE_URLS = {
  floor: '/assets/textures/floor.jpg',
  wall: '/assets/textures/wall.jpg',
  door: '/assets/textures/door.jpg',
  concrete: '/assets/textures/concrete.jpg',
};

/** Uniforms shared by every fire-aware surface. */
export const hazardUniforms = {
  uHazard: { value: null },
  uHazardOn: { value: 0 },
  // World x/z of the hazard texture's (0, 0) pixel corner, and its width/depth.
  uHazardRect: { value: new THREE.Vector4(0, 0, 1, 1) },
  uWallHeight: { value: 1 },
  uFireTime: { value: 0 },
};

const loader = new THREE.TextureLoader();
function loadTexture(name, onLoad) {
  const texture = loader.load(TEXTURE_URLS[name], onLoad);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = 4;
  return texture;
}

const vertexDeclarations = /* glsl */`
  varying vec3 vSurfaceWorld;
  varying vec3 vSurfaceNormal;
`;

const vertexBody = /* glsl */`
  vec4 surfaceWorld = vec4(transformed, 1.0);
  vec3 surfaceNormal = objectNormal;
  #ifdef USE_INSTANCING
    surfaceWorld = instanceMatrix * surfaceWorld;
    surfaceNormal = mat3(instanceMatrix) * surfaceNormal;
  #endif
  surfaceWorld = modelMatrix * surfaceWorld;
  vSurfaceWorld = surfaceWorld.xyz;
  vSurfaceNormal = normalize(mat3(modelMatrix) * surfaceNormal);
`;

const fragmentDeclarations = /* glsl */`
  varying vec3 vSurfaceWorld;
  varying vec3 vSurfaceNormal;
  uniform float uTileSize;
  #ifdef FIRE_AWARE
    uniform sampler2D uHazard;
    uniform float uHazardOn;
    uniform vec4 uHazardRect;
    uniform float uWallHeight;
    uniform float uFireTime;
    float surfaceHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
    float surfaceNoise(vec2 p) {
      vec2 i = floor(p);
      vec2 f = fract(p);
      f = f * f * (3.0 - 2.0 * f);
      return mix(mix(surfaceHash(i), surfaceHash(i + vec2(1.0, 0.0)), f.x),
        mix(surfaceHash(i + vec2(0.0, 1.0)), surfaceHash(i + vec2(1.0, 1.0)), f.x), f.y);
    }
    float surfaceFbm(vec2 p) {
      return surfaceNoise(p) * 0.55 + surfaceNoise(p * 2.1) * 0.3 + surfaceNoise(p * 4.3) * 0.15;
    }
  #endif
`;

const mapFragment = /* glsl */`
  vec3 surfaceEmissive = vec3(0.0);
  #ifdef USE_MAP
    vec3 blend = pow(abs(vSurfaceNormal), vec3(4.0));
    blend /= blend.x + blend.y + blend.z;
    vec3 tiled = vSurfaceWorld / uTileSize;
    vec4 sampledDiffuseColor = texture2D(map, tiled.zy) * blend.x
      + texture2D(map, tiled.xz) * blend.y
      + texture2D(map, tiled.xy) * blend.z;
    diffuseColor *= sampledDiffuseColor;
  #endif
  #ifdef FIRE_AWARE
    if (uHazardOn > 0.5) {
      vec2 hazardUv = vec2(
        (vSurfaceWorld.x - uHazardRect.x) / uHazardRect.z,
        1.0 - (vSurfaceWorld.z - uHazardRect.y) / uHazardRect.w);
      vec4 hazard = texture2D(uHazard, hazardUv);
      float height = clamp(vSurfaceWorld.y / uWallHeight, 0.0, 1.0);
      vec2 along = vec2(vSurfaceWorld.x + vSurfaceWorld.z, vSurfaceWorld.y) * 3.0;
      float n = surfaceFbm(along);
      // Smoke stains the wall under the ceiling first.
      float soot = hazard.g * smoothstep(0.25, 0.95, height + 0.25 * n) * 0.7;
      // Fire chars the wall from the floor up.
      float charred = smoothstep(0.05, 0.5, hazard.a) * smoothstep(-0.2, 0.25, n * 0.9 - height * 0.4 + hazard.a * 0.6);
      diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.025, 0.02, 0.018), clamp(max(charred, soot), 0.0, 0.92));
      // Flames lick up a wall next to flaming floor.
      float flaming = smoothstep(0.75, 1.0, hazard.a);
      float lick = surfaceFbm(vec2(along.x, along.y * 0.6 - uFireTime * 2.2));
      float flame = flaming * smoothstep(0.0, 0.35, lick * 1.25 - height * 0.9);
      surfaceEmissive = mix(vec3(1.0, 0.3, 0.04), vec3(1.0, 0.72, 0.28), lick) * flame * 3.0
        + vec3(0.6, 0.12, 0.02) * flaming * (1.0 - height) * 0.35;
    }
  #endif
`;

/**
 * Patch a MeshStandardMaterial for world-space tiling (`tileSize` world
 * units per texture repeat) and, when `fireAware`, fire and smoke damage.
 */
function patchSurface(material, { tileSize, fireAware }) {
  if (fireAware) material.defines = { ...material.defines, FIRE_AWARE: '' };
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTileSize = { value: tileSize };
    if (fireAware) Object.assign(shader.uniforms, hazardUniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${vertexDeclarations}`)
      .replace('#include <project_vertex>', `#include <project_vertex>\n${vertexBody}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${fragmentDeclarations}`)
      .replace('#include <map_fragment>', mapFragment)
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += surfaceEmissive;');
  };
  material.customProgramCacheKey = () => `surface-${fireAware ? 'fire' : 'plain'}`;
  return material;
}

/**
 * Materials for the floor map. `onTextureLoad` is called as each texture
 * arrives so the caller can re-render.
 */
export function createSurfaceMaterials(onTextureLoad = () => {}) {
  const surface = (name, options, tileSize, fireAware) => {
    const material = new THREE.MeshStandardMaterial({ ...options, map: loadTexture(name, onTextureLoad) });
    return patchSurface(material, { tileSize, fireAware });
  };
  return {
    floor: surface('floor', { color: 0xc9b8a4, roughness: 0.78, metalness: 0.02 }, 1.6, false),
    wall: surface('wall', { color: 0xf1ede6, roughness: 0.86, metalness: 0 }, 2.2, true),
    // A door opening's threshold is floor; the leaf is a wooden door.
    threshold: surface('concrete', { color: 0x9aa3ad, roughness: 0.9 }, 1.2, false),
    door: surface('door', { color: 0xd2b48c, roughness: 0.62, metalness: 0.02 }, 0.9, true),
    exitDoor: surface('door', { color: 0x7dd3a0, roughness: 0.55, metalness: 0.04 }, 0.9, true),
    ground: surface('concrete', { color: 0x4b5563, roughness: 0.95 }, 3, false),
  };
}
