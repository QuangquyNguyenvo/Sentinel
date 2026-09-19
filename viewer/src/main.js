import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { gsap } from 'gsap';
import {
  Box,
  Building2,
  ChartLine,
  Flame,
  MoreHorizontal,
  PanelLeft,
  Pause,
  PersonStanding,
  Play,
  RotateCcw,
  ShieldCheck,
  Upload,
  X,
  createIcons,
} from 'lucide';
import './style.css';
import { isWalkableSegment } from './walkable-route.js';
import {
  SpatialHash,
  circlesOverlap,
  movementBlockedByCircle,
  stepHeading,
} from './agent-motion.js';
import {
  CHARACTER_MAX_INSTANCES,
  characterFrameFor,
  createFallbackCharacterRender,
  createPeopleRender,
  disposeCharacterRender,
} from './character-render.js';
import { FIRE_GROWTH, createFireScenario, heatToleranceTime, visibilityDistance } from './fire-sim.js';
import { createFireEffect } from './fire-fx.js';
import { createSurfaceMaterials, hazardUniforms } from './surfaces.js';
import { createDoorMeshes, doorLayout, doorPassFactor, isInsideDoor, leafSegments, stepDoor, updateDoorMesh } from './doors.js';
import { accumulateExposure, smokeMovementFactor } from './hazard-exposure.js';
import { hazardAwareShortestPath, hazardEdgePenalty, hazardSeverity, sampleSegmentHazard, shouldRetryNoRoute } from './hazard-routing.js';

createIcons({
  icons: {
    Box,
    Building2,
    ChartLine,
    Flame,
    MoreHorizontal,
    PanelLeft,
    Pause,
    PersonStanding,
    Play,
    RotateCcw,
    ShieldCheck,
    Upload,
    X,
  },
});

const viewport = document.querySelector('#viewport');
const fileInput = document.querySelector('#json-file');
const statusNode = document.querySelector('#status');
const titleNode = document.querySelector('#map-title');
const sizeNode = document.querySelector('#map-size');
const zoneNode = document.querySelector('#zone-count');
const doorNode = document.querySelector('#door-count');
const exitNode = document.querySelector('#exit-count');
const pickStartButton = document.querySelector('#pick-start');
const pickGoalButton = document.querySelector('#pick-goal');
const cancelPickButton = document.querySelector('#cancel-pick');
const clearRouteButton = document.querySelector('#clear-route');
const exitSelect = document.querySelector('#exit-select');
const routeHint = document.querySelector('#route-hint');
const routeStartNode = document.querySelector('#route-start');
const routeGoalNode = document.querySelector('#route-goal');
const routeLengthNode = document.querySelector('#route-length');
const validationStatusNode = document.querySelector('#validation-status');
const validationDescriptionNode = document.querySelector('#validation-description');
const validationRegionsNode = document.querySelector('#validation-regions');
const validationPortalsNode = document.querySelector('#validation-portals');
const validationComponentsNode = document.querySelector('#validation-components');
const validationExitsNode = document.querySelector('#validation-exits');
const validationIsolatedNode = document.querySelector('#validation-isolated');
const validationDetailsNode = document.querySelector('#validation-details');
const validationIssuesNode = document.querySelector('#validation-issues');
const viewportMapNameNode = document.querySelector('#viewport-map-name');
const topbarStateNode = document.querySelector('#topbar-state');
const placementHintNode = document.querySelector('#placement-hint');
const dropHintLabelNode = document.querySelector('#drop-hint-label');
const inspectModeButton = document.querySelector('#mode-inspect');
const simulateModeButton = document.querySelector('#mode-simulate');
const modeNav = document.querySelector('.mode-nav');
const modeIndicator = document.querySelector('.mode-indicator');
const inspectPanel = document.querySelector('#inspect-panel');
const simulatePanel = document.querySelector('#simulate-panel');
const personSourceButton = document.querySelector('#person-source');
const toolbarPersonButton = document.querySelector('#toolbar-person');
const populateRoomsButton = document.querySelector('#populate-rooms');
const crowdPerRoomSelect = document.querySelector('#crowd-per-room');
const personSizeInput = document.querySelector('#person-size');
const personSizeOutput = document.querySelector('#person-size-output');
const showSimulationRoutesInput = document.querySelector('#show-simulation-routes');
const simulationPlayButton = document.querySelector('#simulation-play');
const toolbarPlayButton = document.querySelector('#toolbar-play');
const simulationResetButton = document.querySelector('#simulation-reset');
const toolbarResetButton = document.querySelector('#toolbar-reset');
const inspectDrawerToggle = document.querySelector('#inspect-drawer-toggle');
const inspectDrawerClose = document.querySelector('#inspect-drawer-close');
const simulationMoreButton = document.querySelector('#simulation-more');
const simulationMoreClose = document.querySelector('#simulation-more-close');
const simulationStateNode = document.querySelector('#simulation-state');
const simulationElapsedNode = document.querySelector('#simulation-elapsed');
const simTotalNode = document.querySelector('#sim-total');
const simMovingNode = document.querySelector('#sim-moving');
const simEvacuatedNode = document.querySelector('#sim-evacuated');
const simNoRouteNode = document.querySelector('#sim-no-route');
const simTrappedNode = document.querySelector('#sim-trapped');
const hudTrappedNode = document.querySelector('#hud-trapped');
const toolbarFireButton = document.querySelector('#toolbar-fire');
const fireGrowthSelect = document.querySelector('#fire-growth');
const fireInitialSelect = document.querySelector('#fire-initial');
const clearFireButton = document.querySelector('#clear-fire');
const fireReadoutNode = document.querySelector('#fire-readout');
const hudNode = document.querySelector('.sim-hud');
const hudStateNode = document.querySelector('#hud-state-label');
const hudTimeNode = document.querySelector('#hud-time');
const hudTotalNode = document.querySelector('#hud-total');
const hudMovingNode = document.querySelector('#hud-moving');
const hudEvacuatedNode = document.querySelector('#hud-evacuated');
const hudNoRouteNode = document.querySelector('#hud-no-route');
const speedButtons = [...document.querySelectorAll('[data-speed]')];

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x06101c);
scene.fog = new THREE.FogExp2(0x06101c, 0.018);

const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 300);
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5)); // see QUALITY_LEVELS
// Real-time shadows from the daylight and the fire (see QUALITY_LEVELS).
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.domElement.tabIndex = 0;
renderer.domElement.setAttribute('role', 'img');
renderer.domElement.setAttribute('aria-label', 'Interactive 3D floor map. Drag to rotate, scroll to zoom, and right drag to pan.');
viewport.appendChild(renderer.domElement);

// Bright flames and signs glow through a bloom pass; tone mapping moves to
// the output pass while it is in use.
const composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 }));
composer.addPass(new RenderPass(scene, camera));
const bloomPass = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.6, 0.45, 0.88);
composer.addPass(bloomPass);
composer.addPass(new OutputPass());

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.075;
controls.maxPolarAngle = Math.PI / 2.03;
controls.minDistance = 4;
controls.maxDistance = 80;
controls.addEventListener('change', requestRender);

scene.add(new THREE.HemisphereLight(0xbfd8ff, 0x17202d, 1.65));
const keyLight = new THREE.DirectionalLight(0xffffff, 2.15);
keyLight.position.set(-8, 15, 7);
keyLight.castShadow = true;
keyLight.shadow.mapSize.set(2048, 2048);
keyLight.shadow.bias = -0.0004;
keyLight.shadow.normalBias = 0.02;
keyLight.shadow.radius = 2;
scene.add(keyLight);

/** Fit the daylight shadow to a map of `width` x `depth` world units. */
function fitKeyShadow(width, depth) {
  const half = Math.hypot(width, depth) / 2 + 1;
  const shadowCamera = keyLight.shadow.camera;
  shadowCamera.left = -half;
  shadowCamera.right = half;
  shadowCamera.top = half;
  shadowCamera.bottom = -half;
  shadowCamera.near = 0.5;
  shadowCamera.far = keyLight.position.length() + half * 2;
  shadowCamera.updateProjectionMatrix();
}

// Floor, walls and doors are textured (see surfaces.js); walls and doors
// also show smoke stains, charring and flames from the fire.
const materials = {
  ...createSurfaceMaterials(() => requestRender()),
  exitSign: new THREE.MeshStandardMaterial({ color: 0x22c55e, emissive: 0x22c55e, emissiveIntensity: 2.4 }),
  exit: new THREE.MeshStandardMaterial({ color: 0x16a34a, emissive: 0x052d15, emissiveIntensity: 0.55, roughness: 0.58 }),
  obstacle: new THREE.MeshStandardMaterial({ color: 0xdc2626, roughness: 0.65 }),
};

let mapGroup = null;
let routeGroup = null;
let selectionSurface = null;
let currentFrame = { target: new THREE.Vector3(), distance: 18 };
let currentModel = null;
let mapState = null;
let selectionMode = null;
let selectedStart = null;
let selectedGoal = null;
let pointerDown = null;
let personPlacementMode = false;
let personDragActive = false;
let simulationRunning = false;
let simulationElapsed = 0;
let simulationSpeed = 1;
let crowdPerRoom = 3;
let personSize = 1;
let showSimulationRoutes = false;
let agents = [];
let agentSequence = 0;
let lastSimulationMetricsUpdate = -Infinity;
let agentsDirty = false;
let renderRequested = true;
let routingCache = null;
let routingHazardCache = { model: null, scenario: null, timeKey: null, values: new Map() };
let firePlacementMode = false;
let fireGrowth = 'medium';
// A fire people run from is already too big for an extinguisher.
let fireInitialKw = 500;
let fireScenario = null;
let fireVisual = null;
let lastFireUpdate = -Infinity;
let evacuationSummaryShown = false;
let doors = [];
let hazardDirty = false;
let lastHazardUpload = -Infinity;
// Render quality steps, best first. Shadows and bloom are dropped on slow
// machines before the resolution.
const baseQualityRatio = Math.min(window.devicePixelRatio, 1.5);
const QUALITY_LEVELS = [
  { pixelRatio: baseQualityRatio, particles: 1, keyShadow: true, fireShadow: true, bloom: true, smokeLayerStep: 1 },
  { pixelRatio: Math.min(baseQualityRatio, 1), particles: 0.6, keyShadow: true, fireShadow: false, bloom: true, smokeLayerStep: 2 },
  { pixelRatio: Math.min(baseQualityRatio, 0.75), particles: 0.35, keyShadow: false, fireShadow: false, bloom: false, smokeLayerStep: 2 },
];
// `?quality=high|medium|low` in the address fixes the level (for demos and
// screenshots); otherwise it adapts to the frame rate.
const QUALITY_NAMES = ['high', 'medium', 'low'];
const fixedQuality = QUALITY_NAMES.indexOf(new URLSearchParams(window.location.search).get('quality'));
const quality = { level: Math.max(0, fixedQuality), average: 1 / 60, slowFor: 0, fastFor: 0 };
const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
const simulationTimer = new THREE.Timer();
simulationTimer.connect(document);
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
const agentMatrixScratch = new THREE.Matrix4();
const agentPositionScratch = new THREE.Vector3();
const agentScaleScratch = new THREE.Vector3();
const agentColorScratch = new THREE.Color();
const doseColor = new THREE.Color(0xef4444);
const agentHeadingQuaternionScratch = new THREE.Quaternion();
const agentYAxis = new THREE.Vector3(0, 1, 0);
const collisionNeighborsScratch = [];
const collisionStartScratch = [0, 0];
const candidateScratch = [0, 0];
// How long a person waits behind someone before taking right-of-way.
const YIELD_SECONDS = 0.6;
// Free space kept to the person in front, in body radii (about half a metre).
const FOLLOW_GAP_RADII = 1.5;
// SFPE specific flow through a door: persons per second per metre of width.
const EXIT_FLOW_PER_METER = 1.3;
const followNeighborsScratch = [];
const doorNeighborsScratch = [];
const leafSegmentsScratch = [];
const leafClosestScratch = [0, 0];
// People within this distance of a door (metres from its opening) open it.
const DOOR_REACH_METERS = 0.8;
const agentRingDirections = [
  [1, 0], [Math.SQRT1_2, Math.SQRT1_2], [0, 1], [-Math.SQRT1_2, Math.SQRT1_2],
  [-1, 0], [-Math.SQRT1_2, -Math.SQRT1_2], [0, -1], [Math.SQRT1_2, -Math.SQRT1_2],
];
// Semantic doors are only a few pixels wide in generated maps. Keep the
// physical person-person radius realistic, but use a smaller wall-clearance
// probe so the rasterized doorway does not become narrower than the person.
const AGENT_WALL_CLEARANCE_FACTOR = 0.42;
const motionOrder = [];
const agentSpatialHash = new SpatialHash(4);
// Generated maps usually carry no real-world scale. Assume 5 cm per pixel so
// walking speed and smoke spread use plausible metres and seconds.
const ASSUMED_METERS_PER_PIXEL = 0.05;
const WALK_SPEED_MPS = 1.3;
// People are drawn at about 60 % of the wall height.
const PERSON_HEIGHT_FACTOR = 0.6;
// Walking, running (people who see smoke or feel heat) and panicked running
// (people burnt by the fire) speeds, m/s.
const PACE_SPEED_MPS = { walk: WALK_SPEED_MPS, run: 2.6, panic: 3.2 };
// Smoke density (1/m) and radiant heat (kW/m2) that make people run, and the
// heat that makes them panic (severe pain). Both last a few seconds after.
const RUN_SMOKE_KS = 0.1;
const RUN_HEAT_FLUX = 1;
const PANIC_HEAT_FLUX = 5;
const PACE_HOLD_SECONDS = 5;
const FIRE_UPDATE_INTERVAL = 0.25;
// Radiant heat people notice and move away from (pain threshold, kW/m2).
const HEAT_AVOID_FLUX = 2.5;
const SIMULATION_STEP = 0.1;
const NO_ROUTE_RETRY_SECONDS = 1;
const ROUTE_REPLAN_INTERVAL_SECONDS = 2;
const ROUTE_HAZARD_SAMPLE_STEP_PX = 0.5;
const ROUTE_SMOKE_PENALTY = 2.5;
const BREATHING_HEIGHT_METERS = 1.6;
const WALKABLE_KINDS = new Set(['floor', 'door', 'exit']);

// Agents live outside mapGroup so the baked character meshes survive map
// reloads; clearing a simulation only resets instance counts.
const agentGroup = new THREE.Group();
agentGroup.name = 'simulation-agents';
scene.add(agentGroup);
let agentRender = createFallbackCharacterRender({ group: agentGroup });
createPeopleRender({ group: agentGroup })
  .then((people) => {
    disposeCharacterRender(agentRender);
    agentRender = people;
    refreshAgentRadius();
    agentsDirty = true;
  })
  .catch((error) => console.warn('Character model unavailable; using capsule fallback.', error));

function requestRender() {
  renderRequested = true;
}

// Status messages show briefly as a toast; errors stay a little longer.
let statusTimer = 0;
function setStatus(message, isError = false) {
  statusNode.textContent = message;
  statusNode.classList.toggle('error', isError);
  statusNode.classList.add('is-visible');
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => statusNode.classList.remove('is-visible'), isError ? 8000 : 4000);
}

function formatSimulationTime(seconds) {
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds - minutes * 60;
  return `${String(minutes).padStart(2, '0')}:${remainder.toFixed(1).padStart(4, '0')}`;
}

function simulationCounts() {
  let evacuated = 0;
  let noRoute = 0;
  let trapped = 0;
  for (const agent of agents) {
    if (agent.status === 'evacuated') evacuated += 1;
    else if (agent.status === 'no_route') noRoute += 1;
    else if (agent.status === 'trapped') trapped += 1;
  }
  const total = agents.length;
  return { total, moving: total - evacuated - noRoute - trapped, evacuated, noRoute, trapped };
}

function setSimulationState(state, message = null) {
  const labels = { ready: 'Ready', running: 'Running', paused: 'Paused', complete: 'Complete', empty: 'Ready' };
  const label = labels[state] ?? labels.ready;
  simulationStateNode.textContent = label;
  simulationStateNode.className = `status-pill ${state === 'ready' || state === 'empty' ? 'neutral' : state}`;
  hudStateNode.textContent = label;
  hudNode.dataset.state = state;
  if (topbarStateNode) topbarStateNode.textContent = message ?? (state === 'running' ? 'Simulation running' : state === 'paused' ? 'Simulation paused' : 'Map ready');
  updateSimulationMetrics();
}

function updateSimulationMetrics(counts = simulationCounts()) {
  const values = [
    [simTotalNode, counts.total], [simMovingNode, counts.moving], [simEvacuatedNode, counts.evacuated], [simNoRouteNode, counts.noRoute],
    [hudTotalNode, counts.total], [hudMovingNode, counts.moving], [hudEvacuatedNode, counts.evacuated], [hudNoRouteNode, counts.noRoute],
    [simTrappedNode, counts.trapped], [hudTrappedNode, counts.trapped],
  ];
  for (const [node, value] of values) if (node) node.textContent = String(value);
  const time = formatSimulationTime(simulationElapsed);
  simulationElapsedNode.textContent = time;
  hudTimeNode.textContent = time;
}

const validationMetricNames = [
  'region_count',
  'portal_count',
  'connected_component_count',
  'reachable_exit_count',
  'isolated_region_count',
];

function readValidationReport(model) {
  const report = model?.graph_validation;
  if (!report || typeof report !== 'object' || Array.isArray(report)) return null;
  if (report.schema_version !== 'graph-validation-1') return null;
  if (!['valid', 'warning', 'error'].includes(report.status)) return null;
  if (!report.summary || typeof report.summary !== 'object' || Array.isArray(report.summary)) return null;
  if (!Array.isArray(report.issues)) return null;
  const summary = {};
  for (const name of validationMetricNames) {
    const value = report.summary[name];
    if (!Number.isSafeInteger(value) || value < 0) return null;
    summary[name] = value;
  }
  const issues = [];
  for (const issue of report.issues) {
    if (!issue || typeof issue !== 'object' || Array.isArray(issue)
      || typeof issue.code !== 'string' || !['error', 'warning', 'info'].includes(issue.severity)
      || typeof issue.message !== 'string') return null;
    // Copy only trusted display fields. A malformed or surprising object in
    // an uploaded JSON file must not be able to inject markup or break the UI.
    issues.push({ code: issue.code, severity: issue.severity, message: issue.message });
  }
  return { status: report.status, summary, issues };
}

function resetValidationHealth(message = 'This map does not include a graph validation report.') {
  validationStatusNode.textContent = 'Unavailable';
  validationStatusNode.dataset.status = 'unavailable';
  validationDescriptionNode.textContent = message;
  validationRegionsNode.textContent = '-';
  validationPortalsNode.textContent = '-';
  validationComponentsNode.textContent = '-';
  validationExitsNode.textContent = '-';
  validationIsolatedNode.textContent = '-';
  validationIssuesNode.replaceChildren();
  validationDetailsNode.hidden = true;
}

function renderValidationHealth(model) {
  const report = readValidationReport(model);
  if (!report) {
    resetValidationHealth();
    return;
  }
  const label = report.status[0].toUpperCase() + report.status.slice(1);
  validationStatusNode.textContent = `Status: ${label}`;
  validationStatusNode.dataset.status = report.status;
  validationDescriptionNode.textContent = report.status === 'valid'
    ? 'The generated navmesh passed all structural checks.'
    : `${report.issues.length} validation ${report.issues.length === 1 ? 'issue' : 'issues'} require attention.`;
  validationRegionsNode.textContent = String(report.summary.region_count);
  validationPortalsNode.textContent = String(report.summary.portal_count);
  validationComponentsNode.textContent = String(report.summary.connected_component_count);
  validationExitsNode.textContent = String(report.summary.reachable_exit_count);
  validationIsolatedNode.textContent = String(report.summary.isolated_region_count);
  validationIssuesNode.replaceChildren();
  for (const issue of report.issues) {
    const item = document.createElement('li');
    item.textContent = `${issue.severity.toUpperCase()}: ${issue.message}`;
    validationIssuesNode.appendChild(item);
  }
  validationDetailsNode.hidden = report.issues.length === 0;
}

function decodeRle(layer) {
  if (!layer || layer.encoding !== 'rle_rows' || !Array.isArray(layer.shape) || !Array.isArray(layer.data)) {
    throw new Error('The semantic layer is not valid RLE row data.');
  }
  const [rows, cols] = layer.shape;
  if (!Number.isInteger(rows) || !Number.isInteger(cols) || rows <= 0 || cols <= 0 || layer.data.length !== rows) {
    throw new Error('The semantic layer has an invalid shape.');
  }
  return layer.data.map((runs, rowIndex) => {
    const row = new Uint16Array(cols);
    let cursor = 0;
    for (const run of runs) {
      if (!Array.isArray(run) || run.length !== 2 || !Number.isInteger(run[0]) || !Number.isInteger(run[1]) || run[1] <= 0) {
        throw new Error(`Invalid RLE run on row ${rowIndex}.`);
      }
      const [value, count] = run;
      if (cursor + count > cols) throw new Error(`RLE row ${rowIndex} exceeds the declared width.`);
      row.fill(value, cursor, cursor + count);
      cursor += count;
    }
    if (cursor !== cols) throw new Error(`RLE row ${rowIndex} is incomplete.`);
    return row;
  });
}

function rectanglesForLabel(matrix, label) {
  const finished = [];
  let active = new Map();
  matrix.forEach((row, y) => {
    const spans = [];
    for (let x = 0; x < row.length;) {
      if (row[x] !== label) { x += 1; continue; }
      const x0 = x;
      while (x < row.length && row[x] === label) x += 1;
      spans.push([x0, x]);
    }
    const next = new Map();
    for (const [x0, x1] of spans) {
      const key = `${x0}:${x1}`;
      const rectangle = active.get(key) ?? { x0, x1, y0: y, y1: y };
      rectangle.y1 = y + 1;
      next.set(key, rectangle);
    }
    for (const [key, rectangle] of active) {
      if (!next.has(key)) finished.push(rectangle);
    }
    active = next;
  });
  finished.push(...active.values());
  return finished;
}

function addRectangles(group, rectangles, rows, cols, scale, height, material, yBase = 0) {
  if (!rectangles.length) return;
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  const mesh = new THREE.InstancedMesh(geometry, material, rectangles.length);
  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const size = new THREE.Vector3();
  const rotation = new THREE.Quaternion();
  rectangles.forEach((rect, index) => {
    const width = (rect.x1 - rect.x0) * scale;
    const depth = (rect.y1 - rect.y0) * scale;
    position.set(((rect.x0 + rect.x1) / 2 - cols / 2) * scale, yBase + height / 2, ((rect.y0 + rect.y1) / 2 - rows / 2) * scale);
    size.set(width, height, depth);
    matrix.compose(position, rotation, size);
    mesh.setMatrixAt(index, matrix);
  });
  mesh.castShadow = height > 0.2;
  mesh.receiveShadow = true;
  group.add(mesh);
}

function toWorld([x, y], target = null) {
  const { rows, cols, scale } = mapState;
  const result = target instanceof THREE.Vector3 ? target : new THREE.Vector3();
  return result.set((x - cols / 2) * scale, 0.15, (y - rows / 2) * scale);
}

function clearRouteGeometry() {
  if (!routeGroup) return;
  routeGroup.traverse((object) => {
    object.geometry?.dispose();
    if (Array.isArray(object.material)) object.material.forEach((item) => item.dispose());
    else object.material?.dispose();
  });
  mapGroup?.remove(routeGroup);
  routeGroup = null;
}

function updateRouteVisibility() {
  if (!routeGroup) return;
  routeGroup.visible = document.body.dataset.mode !== 'simulate' || showSimulationRoutes;
}

function addMarker(group, point, color, ring = false) {
  const radius = Math.max(0.11, mapState.scale * 5.5);
  const marker = new THREE.Mesh(
    ring ? new THREE.TorusGeometry(radius, radius * 0.28, 12, 28) : new THREE.SphereGeometry(radius, 20, 14),
    new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.28 }),
  );
  marker.position.copy(toWorld(point));
  if (ring) marker.rotation.x = Math.PI / 2;
  marker.position.y = ring ? 0.17 : radius + 0.12;
  group.add(marker);
}

function drawRoute(route, { showMarkers = true } = {}) {
  clearRouteGeometry();
  routeGroup = new THREE.Group();
  routeGroup.visible = document.body.dataset.mode !== 'simulate' || showSimulationRoutes;
  mapGroup.add(routeGroup);
  if (route?.status === 'ok' && Array.isArray(route.polyline_px) && route.polyline_px.length >= 2) {
    const points = route.polyline_px.map(toWorld);
    const curve = new THREE.CurvePath();
    for (let index = 1; index < points.length; index += 1) {
      curve.add(new THREE.LineCurve3(points[index - 1], points[index]));
    }
    const radius = Math.max(0.025, mapState.scale * 1.5);
    const tube = new THREE.Mesh(
      new THREE.TubeGeometry(curve, Math.max(12, route.polyline_px.length * 8), radius, 8, false),
      new THREE.MeshStandardMaterial({ color: 0xf59e0b, emissive: 0x7c3e00, emissiveIntensity: 0.55, roughness: 0.45 }),
    );
    tube.position.y = 0.03;
    routeGroup.add(tube);
  }
  if (showMarkers && selectedStart) addMarker(routeGroup, selectedStart, 0x22d3ee);
  if (showMarkers && selectedGoal) addMarker(routeGroup, selectedGoal.point, 0x22c55e, true);
}

function metersPerPixel() {
  const value = Number(currentModel?.navmesh?.meters_per_pixel);
  return value > 0 ? value : ASSUMED_METERS_PER_PIXEL;
}

function markerColor(status) {
  if (status === 'evacuated') return 0x34d399;
  if (status === 'no_route') return 0xfb7185;
  if (status === 'trapped') return 0xdc2626;
  if (status === 'moving') return 0xfbbf24;
  return 0x63e1ed;
}

/**
 * Collision radius at 1x size, taken from the drawn character's footprint so
 * two agents whose circles do not overlap never touch on screen.
 */
function refreshAgentRadius() {
  if (!mapState) return;
  const heightFactor = agentRender.mode === 'people' ? PERSON_HEIGHT_FACTOR : 1;
  mapState.personBaseRadiusPx = (agentRender.footprintRadius * mapState.personHeight * heightFactor) / mapState.scale;
  agentSpatialHash.cellSize = Math.max(1, mapState.personBaseRadiusPx * 2);
  for (const agent of agents) agent.radiusPx = mapState.personBaseRadiusPx * personSize;
}

function updatePersonSize(value = personSizeInput?.value ?? personSize) {
  const next = Number(value);
  personSize = Number.isFinite(next) ? Math.min(1.8, Math.max(0.6, next)) : 1;
  if (personSizeInput && Number(personSizeInput.value) !== personSize) personSizeInput.value = String(personSize);
  if (personSizeOutput) {
    const label = `${personSize.toFixed(1)}×`;
    personSizeOutput.value = label;
    personSizeOutput.textContent = label;
  }
  for (const agent of agents) agent.radiusPx = (mapState?.personBaseRadiusPx ?? 0) * personSize;
  agentsDirty = true;
}

/**
 * Write every agent into the instanced mesh of its current animation frame.
 * Instances are packed per frame, so each frame mesh draws only its agents.
 */
function syncAgentInstances() {
  agentsDirty = false;
  const meshes = agentRender.frameMeshes;
  for (const mesh of meshes) mesh.count = 0;
  if (mapState) {
    const heightFactor = agentRender.mode === 'people' ? PERSON_HEIGHT_FACTOR : 1;
    const height = mapState.personHeight * personSize * heightFactor;
    const width = height * (agentRender.widthScale ?? 1);
    agentScaleScratch.set(width, height, width);
    for (const agent of agents) {
      if (agent.status === 'evacuated') continue;
      const dead = agent.status === 'trapped';
      const incapacitatedProgress = dead
        ? (simulationElapsed - (agent.incapacitatedTime ?? 0)) / agentRender.deathSeconds
        : 0;
      const pace = agent.status === 'moving' && agent.walking ? agent.pace : 'idle';
      const frame = characterFrameFor(agentRender, pace, agent.walkPhase, dead, incapacitatedProgress);
      toWorld(agent.point, agentPositionScratch).y = 0.08;
      const variant = agent.variant % agentRender.variants;
      const mesh = agentRender.frameMeshes[variant * agentRender.framesPerVariant + frame];
      if (mesh.count >= agentRender.meshCapacity) continue;
      agentHeadingQuaternionScratch.setFromAxisAngle(agentYAxis, agent.heading ?? 0);
      agentMatrixScratch.compose(agentPositionScratch, agentHeadingQuaternionScratch, agentScaleScratch);
      mesh.setMatrixAt(mesh.count, agentMatrixScratch);
      // Textured people keep their clothes' colours; collapsed people are
      // greyed out. The capsule fallback shows the status colour.
      if (agentRender.textured) agentColorScratch.setHex(dead ? 0x5b6270 : 0xffffff);
      else agentColorScratch.setHex(markerColor(agent.status));
      // People turn red as their accumulated heat injury dose builds up.
      if (!dead && agent.heatDose > 0.02) agentColorScratch.lerp(doseColor, Math.min(1, agent.heatDose) * 0.8);
      mesh.setColorAt(mesh.count, agentColorScratch);
      mesh.count += 1;
    }
  }
  for (const mesh of meshes) {
    mesh.visible = mesh.count > 0;
    mesh.instanceMatrix.needsUpdate = true;
    mesh.instanceColor.needsUpdate = true;
  }
  requestRender();
}

function updateAgentPosition(agent, point, delta = 0) {
  const dx = Number(point[0]) - agent.point[0];
  const dy = Number(point[1]) - agent.point[1];
  agent.point[0] = Number(point[0]);
  agent.point[1] = Number(point[1]);
  if (Math.abs(dx) + Math.abs(dy) < 0.0001) return;
  agent.targetHeading = Math.atan2(dx, dy);
  agent.heading = Number.isFinite(agent.heading)
    ? stepHeading(agent.heading, agent.targetHeading, Math.max(0.02, delta * 12))
    : agent.targetHeading;
}

function makeAgentRoute(route) {
  if (route?.status !== 'ok' || !Array.isArray(route.polyline_px) || route.polyline_px.length < 2) return null;
  const points = route.polyline_px.map((point) => [Number(point[0]), Number(point[1])]);
  const lengths = [];
  let total = 0;
  for (let index = 1; index < points.length; index += 1) {
    const length = pointDistance(points[index - 1], points[index]);
    lengths.push(length);
    total += length;
  }
  return { points, lengths, total, regionIds: route.region_ids ?? [] };
}

function pointAlongAgentRoute(agent) {
  const route = agent.route;
  if (!route) return agent.motionPoint ?? agent.point;
  const target = agent.motionPoint ?? agent.point;
  if (agent.segmentIndex >= route.lengths.length) {
    const end = route.points[route.points.length - 1];
    target[0] = end[0];
    target[1] = end[1];
    return target;
  }
  const start = route.points[agent.segmentIndex];
  const end = route.points[agent.segmentIndex + 1];
  const length = route.lengths[agent.segmentIndex] || 1;
  const t = Math.min(1, Math.max(0, agent.segmentOffset / length));
  target[0] = start[0] + (end[0] - start[0]) * t;
  target[1] = start[1] + (end[1] - start[1]) * t;
  return target;
}

function updatePlayButton(button, isRunning) {
  if (!button) return;
  button.classList.toggle('is-running', isRunning);
  button.setAttribute('aria-pressed', String(isRunning));
  button.setAttribute('aria-label', isRunning ? 'Pause simulation' : 'Play simulation');
  const text = button.querySelector('span:last-child');
  if (text) text.textContent = isRunning ? 'Pause' : 'Play';
}

function updatePlayControls() {
  updatePlayButton(simulationPlayButton, simulationRunning);
  updatePlayButton(toolbarPlayButton, simulationRunning);
}

function clearSimulation({ announce = false } = {}) {
  if (personPlacementMode) setPersonPlacementMode(false);
  personDragActive = false;
  viewport.classList.remove('dragging');
  simulationRunning = false;
  simulationElapsed = 0;
  lastSimulationMetricsUpdate = -Infinity;
  agentSpatialHash.clear();
  agents = [];
  agentSequence = 0;
  agentsDirty = true;
  evacuationSummaryShown = false;
  for (const door of doors) {
    door.open = 0;
    door.hold = 0;
    updateDoorMesh(door);
  }
  resetFireTimeline();
  updatePlayControls();
  setSimulationState('ready');
  updateSimulationMetrics();
  if (announce) setStatus('Simulation reset. Place people or populate rooms to begin.');
}

function isWalkableAgentPoint(point, radiusPx = 0) {
  if (!mapState?.semanticMatrix) return false;
  if (!isWalkableSegment(mapState.semanticMatrix, point, point).ok) return false;
  const safeRadius = Math.max(0, Number(radiusPx) || 0);
  if (!safeRadius) return true;
  // Check a compact ring around the circular hitbox. This keeps placement and
  // movement on semantic floor/door/exit labels instead of only checking the
  // centre point.
  for (const [directionX, directionY] of agentRingDirections) {
    collisionStartScratch[0] = Number(point[0]) + directionX * safeRadius * AGENT_WALL_CLEARANCE_FACTOR;
    collisionStartScratch[1] = Number(point[1]) + directionY * safeRadius * AGENT_WALL_CLEARANCE_FACTOR;
    if (!isWalkableSegment(mapState.semanticMatrix, collisionStartScratch, collisionStartScratch).ok) return false;
  }
  return true;
}

function isWalkableAgentSegment(start, end, radiusPx = 0) {
  // The route centreline must remain on floor/door/exit pixels. Door masks in
  // generated maps are intentionally thin, so expanding the semantic probe by
  // the full shoulder radius would close otherwise valid portals. The circular
  // radius is still enforced for person-person collision below.
  return Boolean(mapState?.semanticMatrix
    && isWalkableSegment(mapState.semanticMatrix, start, end).ok);
}

function agentCanOccupy(point, radiusPx, ignore = null) {
  if (!isWalkableAgentPoint(point, radiusPx)) return false;
  for (const other of agents) {
    if (other === ignore || other.status === 'evacuated') continue;
    if (circlesOverlap(point, radiusPx, other.point, other.radiusPx ?? radiusPx, 0.05)) return false;
  }
  return true;
}

function resolveAgentSpawnPoint(point) {
  const radiusPx = mapState?.personBaseRadiusPx ? mapState.personBaseRadiusPx * personSize : 0;
  const requested = [Number(point[0]), Number(point[1])];
  const spacing = Math.max(2, radiusPx * 2.15);
  const candidates = [requested];
  for (let index = 0; index < 8; index += 1) {
    const angle = (index * Math.PI) / 4;
    candidates.push([requested[0] + Math.cos(angle) * spacing, requested[1] + Math.sin(angle) * spacing]);
  }
  for (const candidate of candidates) {
    if (agentCanOccupy(candidate, radiusPx)) return candidate;
  }
  return null;
}

function spawnAgent(point, source = 'manual') {
  if (!mapState || !currentModel) {
    setStatus('Load a floor-map JSON before placing a person.', true);
    return null;
  }
  if (agents.length >= CHARACTER_MAX_INSTANCES) {
    setStatus(`The simulation supports up to ${CHARACTER_MAX_INSTANCES} people.`, true);
    return null;
  }
  const requestedPoint = [Number(point[0]), Number(point[1])];
  const owners = ownerRegions(requestedPoint);
  if (!owners.length || !owners.some((region) => ['floor', 'door', 'exit'].includes(region.kind))) {
    setStatus('Invalid placement. Choose a point inside the walkable navmesh.', true);
    return null;
  }
  const spawnPoint = resolveAgentSpawnPoint(requestedPoint);
  if (!spawnPoint) {
    setStatus('That spot is occupied. Choose a little more space between people.', true);
    return null;
  }
  const route = escapeRoute(spawnPoint);
  const status = route.status !== 'ok'
    ? 'no_route'
    : route.reason === 'already-in-exit' ? 'evacuated' : 'ready';
  const firstRoutePoint = route.polyline_px?.[1] ?? route.polyline_px?.[0] ?? spawnPoint;
  const initialHeading = pointDistance(spawnPoint, firstRoutePoint) > 0.0001
    ? Math.atan2(firstRoutePoint[0] - spawnPoint[0], firstRoutePoint[1] - spawnPoint[1])
    : 0;
  const agent = {
    id: `person_${++agentSequence}`,
    point: [spawnPoint[0], spawnPoint[1]],
    motionPoint: [spawnPoint[0], spawnPoint[1]],
    route: makeAgentRoute(route),
    exitId: route.exitId ?? null,
    routePolylinePx: route.polyline_px ?? [],
    routeResult: route,
    routeLengthPx: Number.isFinite(route.length_px) ? route.length_px : null,
    routeLengthM: Number.isFinite(route.length_m) ? route.length_m : null,
    routeCostPx: Number.isFinite(route.cost_px) ? route.cost_px : null,
    status,
    segmentIndex: 0,
    segmentOffset: 0,
    distanceTravelled: 0,
    speedPx: WALK_SPEED_MPS / metersPerPixel(),
    smokeFactor: 1,
    radiusPx: (mapState.personBaseRadiusPx ?? 0) * personSize,
    heading: initialHeading,
    targetHeading: initialHeading,
    walking: false,
    walkPhase: Math.random(),
    pace: 'walk',
    paceUntil: 0,
    variant: agentSequence,
    // Sideways displacement from the route centreline, set by crowd separation.
    offset: [0, 0],
    stuckTime: 0,
    // `dose` remains as a render compatibility alias for the heat injury dose.
    heatDose: 0,
    dose: 0,
    smokeVisibilityExposure: 0,
    heat: 0,
    incapacitatedTime: null,
    lastHazardTime: simulationElapsed,
    lastRouteAttemptTime: -Infinity,
    order: agentSequence,
  };
  agents.push(agent);
  agentsDirty = true;
  if (simulationRunning) simulationRunning = false;
  updatePlayControls();
  setSimulationState('ready');
  setStatus(agent.status === 'no_route'
    ? 'Person placed, but no reachable exit was found.'
    : agent.status === 'evacuated'
      ? 'Person placed inside an exit and marked evacuated.'
      : `Person placed with a ${route.length_px.toFixed(1)} px route to the nearest exit.`);
  return agent;
}

function representativeFloorRegions() {
  const grouped = new Map();
  for (const region of currentModel?.navmesh?.regions ?? []) {
    if (region.kind !== 'floor' || !Array.isArray(region.bounds_px)) continue;
    const key = region.zone_id == null ? `region:${region.id}` : `zone:${region.zone_id}`;
    const existing = grouped.get(key);
    if (!existing || Number(region.area_px ?? 0) > Number(existing.area_px ?? 0)) grouped.set(key, region);
  }
  return [...grouped.values()];
}

function populateRooms() {
  if (!currentModel) {
    setStatus('Load a floor-map JSON before populating rooms.', true);
    return;
  }
  clearSimulation();
  const patterns = {
    1: [[0, 0]],
    3: [[-0.22, -0.18], [0.22, 0], [-0.18, 0.2]],
    5: [[-0.24, -0.2], [0.24, -0.2], [0, 0], [-0.24, 0.2], [0.24, 0.2]],
  };
  const offsets = patterns[crowdPerRoom] ?? patterns[3];
  const regions = representativeFloorRegions();
  for (const region of regions) {
    const [x0, y0, x1, y1] = region.bounds_px.map(Number);
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    const halfWidth = Math.max(2, (x1 - x0) * 0.34);
    const halfHeight = Math.max(2, (y1 - y0) * 0.34);
    for (const [dx, dy] of offsets) {
      const point = [Math.min(x1 - 1, Math.max(x0 + 1, cx + dx * halfWidth)), Math.min(y1 - 1, Math.max(y0 + 1, cy + dy * halfHeight))];
      spawnAgent(point, 'populate');
    }
  }
  setSimulationState('ready');
  setStatus(`${agents.length} people placed across ${regions.length} representative floor regions. Press Play to start.`);
}

function setSimulationRunning(running) {
  if (running && !agents.length && !fireScenario) {
    setStatus('Place at least one person or a fire before starting the simulation.', true);
    setSimulationState('ready');
    return;
  }
  const counts = simulationCounts();
  if (running && counts.moving === 0 && !fireActive()) {
    setSimulationState('complete');
    setStatus('Simulation has no moving agents to run. Reset and place people again.', true);
    return;
  }
  simulationRunning = running;
  updatePlayControls();
  setSimulationState(running ? 'running' : 'paused');
  setStatus(running
    ? (reducedMotion ? 'Reduced motion is enabled; simulation is running because you pressed Play.' : 'Simulation running. Agents follow their nearest reachable exit.')
    : 'Simulation paused. Press Play to continue.');
}

function rebuildAgentSpatialHash() {
  agentSpatialHash.clear();
  for (const agent of agents) {
    if (!isSolidAgent(agent)) continue;
    agentSpatialHash.insert(agent, agent.point[0], agent.point[1]);
  }
}

function compareMotionOrder(a, b) {
  const remainingA = (a.routeLengthPx ?? Infinity) - (a.distanceTravelled ?? 0);
  const remainingB = (b.routeLengthPx ?? Infinity) - (b.distanceTravelled ?? 0);
  if (remainingA !== remainingB) return remainingA - remainingB;
  return a.id.localeCompare(b.id);
}

/**
 * Speed factor (0..1) from the nearest person ahead in the same lane: full
 * speed with FOLLOW_GAP_RADII radii of free space, stopping when touching.
 */
function followingFactor(agent) {
  const route = agent.route;
  const target = route.points[Math.min(agent.segmentIndex + 1, route.points.length - 1)];
  let dx = target[0] + agent.offset[0] - agent.point[0];
  let dy = target[1] + agent.offset[1] - agent.point[1];
  const length = Math.hypot(dx, dy);
  if (length < 1e-6) return 1;
  dx /= length;
  dy /= length;
  const radius = agent.radiusPx ?? 0;
  const comfortGap = radius * FOLLOW_GAP_RADII;
  agentSpatialHash.queryInto(agent.point[0], agent.point[1], radius * 2 + comfortGap, followNeighborsScratch);
  let factor = 1;
  for (const other of followNeighborsScratch) {
    if (other === agent || !isSolidAgent(other)) continue;
    // After waiting a moment, the person nearer to the exit goes first.
    if (compareMotionOrder(agent, other) < 0 && agent.stuckTime > YIELD_SECONDS) continue;
    const ox = other.point[0] - agent.point[0];
    const oy = other.point[1] - agent.point[1];
    const ahead = ox * dx + oy * dy;
    if (ahead <= 0) continue;
    const combined = radius + (other.radiusPx ?? radius);
    // Someone beside the lane can be passed.
    if (Math.abs(ox * dy - oy * dx) >= combined) continue;
    factor = Math.min(factor, Math.max(0, Math.min(1, (ahead - combined) / comfortGap)));
  }
  return factor;
}

/**
 * The side of a door (+1 or -1 along its wall normal) people leave through:
 * outdoors for an exit, otherwise the side nearer to an exit. Doors swing
 * that way, as fire codes require for escape routes.
 */
function egressSide(region) {
  const [x0, y0, x1, y1] = region.bounds_px.map(Number);
  const alongX = x1 - x0 >= y1 - y0;
  const center = [(x0 + x1) / 2, (y0 + y1) / 2];
  const reach = (alongX ? y1 - y0 : x1 - x0) / 2 + 4;
  const side = (sign) => (alongX ? [center[0], center[1] + sign * reach] : [center[0] + sign * reach, center[1]]);
  if (region.kind === 'exit') return isWalkableAgentPoint(side(1)) ? -1 : 1;
  const exits = (currentModel?.navmesh?.regions ?? []).filter((item) => item.kind === 'exit' && Array.isArray(item.center_px));
  const nearestExit = (point) => Math.min(...exits.map((item) => pointDistance(point, item.center_px.map(Number))));
  return exits.length && nearestExit(side(-1)) < nearestExit(side(1)) ? -1 : 1;
}

/** Distance from point (px, py) to segment [x0, y0, x1, y1] and the closest point. */
function segmentDistance(px, py, [x0, y0, x1, y1], closest = null) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared > 0 ? Math.max(0, Math.min(1, ((px - x0) * dx + (py - y0) * dy) / lengthSquared)) : 0;
  const cx = x0 + dx * t;
  const cy = y0 + dy * t;
  if (closest) {
    closest[0] = cx;
    closest[1] = cy;
  }
  return Math.hypot(px - cx, py - cy);
}

/**
 * True when moving from `start` to `end` brings a person into a swinging
 * door leaf. Moving away from a leaf is always allowed.
 */
function leafBlocksMove(start, end, radius) {
  for (const door of doors) {
    if (door.open <= 0 || door.open >= 1) continue;
    for (const segment of leafSegments(door, leafSegmentsScratch)) {
      const after = segmentDistance(end[0], end[1], segment);
      if (after < radius && after < segmentDistance(start[0], start[1], segment)) return true;
    }
  }
  return false;
}

function pushFromLeaves(door) {
  const reach = door.width + door.thickness;
  agentSpatialHash.queryInto(door.center[0], door.center[1], reach, doorNeighborsScratch);
  for (const segment of leafSegments(door, leafSegmentsScratch)) {
    for (const agent of doorNeighborsScratch) {
      if (!isSolidAgent(agent)) continue;
      const radius = (agent.radiusPx ?? 0) * AGENT_WALL_CLEARANCE_FACTOR;
      const distance = segmentDistance(agent.point[0], agent.point[1], segment, leafClosestScratch);
      if (distance >= radius) continue;
      let nx = agent.point[0] - leafClosestScratch[0];
      let ny = agent.point[1] - leafClosestScratch[1];
      if (distance < 1e-6) {
        // Exactly on the leaf: step to the leaf's front, the way it swings.
        nx = segment[3] - segment[1];
        ny = segment[0] - segment[2];
      }
      const length = Math.hypot(nx, ny) || 1;
      const push = radius - distance + 0.05;
      pushAgent(agent, (nx / length) * push, (ny / length) * push);
    }
  }
}

function doorAt(point) {
  for (const door of doors) if (isInsideDoor(door, point)) return door;
  return null;
}

/**
 * Open doors for people within reach and close them after the last one has
 * passed. Uses the spatial hash of standing (not collapsed) people.
 */
function updateDoors(delta) {
  if (!doors.length) return;
  const reach = DOOR_REACH_METERS / metersPerPixel();
  let changed = false;
  for (const door of doors) {
    const [x0, y0, x1, y1] = door.bounds;
    agentSpatialHash.queryInto(door.center[0], door.center[1], door.width / 2 + reach, doorNeighborsScratch);
    let visitor = null;
    let nearest = Infinity;
    for (const agent of doorNeighborsScratch) {
      if (!isSolidAgent(agent)) continue;
      // Distance from the person to the door opening.
      const dx = Math.max(x0 - agent.point[0], 0, agent.point[0] - x1);
      const dy = Math.max(y0 - agent.point[1], 0, agent.point[1] - y1);
      const distance = Math.hypot(dx, dy);
      if (distance <= reach && distance < nearest) {
        nearest = distance;
        visitor = agent.point;
      }
    }
    const before = door.open;
    stepDoor(door, delta, visitor);
    if (door.open !== before) {
      updateDoorMesh(door);
      pushFromLeaves(door);
      changed = true;
    }
  }
  if (changed) requestRender();
}

function isInsideExit(point) {
  for (const region of currentModel?.navmesh?.regions ?? []) {
    if (region.kind !== 'exit') continue;
    const [x0, y0, x1, y1] = region.bounds_px;
    if (x0 <= point[0] && point[0] < x1 && y0 <= point[1] && point[1] < y1) return true;
  }
  return false;
}

function isSolidAgent(agent) {
  return agent.status !== 'evacuated' && agent.status !== 'trapped';
}

function pushAgent(agent, dx, dy) {
  const target = candidateScratch;
  target[0] = agent.point[0] + dx;
  target[1] = agent.point[1] + dy;
  if (!isWalkableAgentPoint(target) || !isWalkableAgentSegment(agent.point, target)) return;
  if (!movementHazardAllowed(agent.point, target, agent, { allowHazardEscape: false })) return;
  agent.point[0] = target[0];
  agent.point[1] = target[1];
  const limit = (agent.radiusPx ?? 0) * 3;
  agent.offset[0] += dx;
  agent.offset[1] += dy;
  const length = Math.hypot(agent.offset[0], agent.offset[1]);
  if (length > limit && length > 0) {
    agent.offset[0] *= limit / length;
    agent.offset[1] *= limit / length;
  }
  agentSpatialHash.move(agent, agent.point[0], agent.point[1]);
}

/**
 * Push overlapping people apart (two relaxation passes). Walls win: a push
 * that would leave the walkable floor is dropped for that person.
 */
function separateAgents() {
  rebuildAgentSpatialHash();
  for (let pass = 0; pass < 2; pass += 1) {
    for (const agent of agents) {
      if (!isSolidAgent(agent)) continue;
      agentSpatialHash.queryInto(agent.point[0], agent.point[1], (agent.radiusPx ?? 0) * 2.2, collisionNeighborsScratch);
      for (const other of collisionNeighborsScratch) {
        if (other === agent || !isSolidAgent(other) || other.order < agent.order) continue;
        let dx = other.point[0] - agent.point[0];
        let dy = other.point[1] - agent.point[1];
        let distance = Math.hypot(dx, dy);
        const minimum = (agent.radiusPx ?? 0) + (other.radiusPx ?? 0);
        if (distance >= minimum) continue;
        if (distance < 1e-6) {
          dx = Math.cos(agent.order);
          dy = Math.sin(agent.order);
          distance = 1;
        }
        const push = (minimum - distance) / 2 + 0.01;
        const nx = dx / distance;
        const ny = dy / distance;
        pushAgent(agent, -nx * push, -ny * push);
        pushAgent(other, nx * push, ny * push);
      }
    }
  }
}

/** Advance the simulation by `delta` simulated seconds (at most one step). */
function updateSimulation(delta) {
  if (!simulationRunning || (!agents.length && !fireScenario)) return;
  simulationElapsed += delta;
  if (fireScenario && simulationElapsed - lastFireUpdate >= FIRE_UPDATE_INTERVAL) updateFireHazard();
  rebuildAgentSpatialHash();
  motionOrder.length = 0;
  for (const agent of agents) {
    if (agent.status !== 'evacuated' && agent.status !== 'no_route' && agent.status !== 'trapped' && agent.route) motionOrder.push(agent);
  }
  motionOrder.sort(compareMotionOrder);
  const scaleMeters = metersPerPixel();
  for (const agent of motionOrder) {
    agent.status = 'moving';
    agent.walking = false;
    // Slow down behind the person in front instead of bumping into them.
    const follow = followingFactor(agent);
    if (follow <= 0.02) {
      agent.stuckTime += delta;
      continue;
    }
    // Pushing a door open takes a moment.
    const door = doors.length ? doorAt(agent.point) : null;
    const doorFactor = door ? doorPassFactor(door) : 1;
    const paceFactor = PACE_SPEED_MPS[agent.pace] / WALK_SPEED_MPS;
    const distancePerFrame = Math.max(0, agent.speedPx * paceFactor * agent.smokeFactor * follow * doorFactor * delta);
    let remaining = distancePerFrame;
    const previousSegmentIndex = agent.segmentIndex;
    const previousSegmentOffset = agent.segmentOffset;
    while (remaining > 0 && agent.segmentIndex < agent.route.lengths.length) {
      const left = agent.route.lengths[agent.segmentIndex] - agent.segmentOffset;
      if (remaining < left) {
        agent.segmentOffset += remaining;
        remaining = 0;
      } else {
        remaining -= left;
        agent.segmentIndex += 1;
        agent.segmentOffset = 0;
      }
    }
    const consumed = distancePerFrame - remaining;
    const routePoint = pointAlongAgentRoute(agent);
    // Drift slowly back towards the route centreline; people otherwise keep
    // the lane the crowd separation gave them.
    const relax = Math.max(0, 1 - delta * 0.15);
    agent.offset[0] *= relax;
    agent.offset[1] *= relax;
    const candidate = candidateScratch;
    candidate[0] = routePoint[0] + agent.offset[0];
    candidate[1] = routePoint[1] + agent.offset[1];
    if (!isWalkableAgentSegment(agent.point, candidate)) {
      agent.offset[0] = 0;
      agent.offset[1] = 0;
      candidate[0] = routePoint[0];
      candidate[1] = routePoint[1];
    }
    let blocked = consumed > 0 && !isWalkableAgentSegment(agent.point, candidate, agent.radiusPx ?? 0);
    // Fire can change between hazard updates. Revalidate the exact movement
    // segment so an agent never steps into a newly flaming cell. A person who
    // starts in a hard hazard may continue along a monotonic escape segment.
    let hazardBlocked = false;
    if (!blocked && consumed > 0 && !movementHazardAllowed(agent.point, candidate, agent)) {
      blocked = true;
      hazardBlocked = true;
    }
    // A swinging door leaf is solid.
    if (!blocked && consumed > 0 && doors.length) {
      blocked = leafBlocksMove(agent.point, candidate, (agent.radiusPx ?? 0) * AGENT_WALL_CLEARANCE_FACTOR);
    }
    if (!blocked && consumed > 0) {
      agentSpatialHash.queryInto(candidate[0], candidate[1], (agent.radiusPx ?? 0) * 2.2, collisionNeighborsScratch);
      for (const neighbor of collisionNeighborsScratch) {
        if (neighbor === agent || !isSolidAgent(neighbor)) continue;
        // Everyone yields to the person in front. When two people block each
        // other for a moment, the one nearer to its exit goes first and the
        // separation pass below slides the other aside.
        if (compareMotionOrder(agent, neighbor) < 0 && agent.stuckTime > YIELD_SECONDS) continue;
        const combinedRadius = (agent.radiusPx ?? 0) + (neighbor.radiusPx ?? agent.radiusPx ?? 0);
        if (movementBlockedByCircle(agent.point, candidate, neighbor.point, combinedRadius)) {
          blocked = true;
          break;
        }
      }
    }
    if (blocked) {
      agent.segmentIndex = previousSegmentIndex;
      agent.segmentOffset = previousSegmentOffset;
      pointAlongAgentRoute(agent);
      agent.stuckTime += delta;
      if (hazardBlocked && shouldRetryNoRoute(simulationElapsed, agent.lastRouteAttemptTime, NO_ROUTE_RETRY_SECONDS)) rerouteAgent(agent);
      continue;
    }
    agent.stuckTime = 0;
    if (consumed <= 0) continue;
    agent.walking = true;
    // Advance the walk cycle by distance so the feet do not slide.
    const cycleSeconds = agentRender.cycles?.[agent.pace]?.seconds ?? 1;
    agent.walkPhase += (consumed * scaleMeters) / (PACE_SPEED_MPS[agent.pace] * cycleSeconds);
    agent.distanceTravelled = Math.min(agent.route.total, (agent.distanceTravelled ?? 0) + consumed);
    if (agent.segmentIndex >= agent.route.lengths.length) {
      agent.status = 'evacuated';
      updateAgentPosition(agent, agent.route.points[agent.route.points.length - 1], delta);
      agentSpatialHash.remove(agent);
    } else if (isInsideExit(candidate)) {
      // Anyone stepping into an exit is out; they do not queue for its centre.
      agent.status = 'evacuated';
      updateAgentPosition(agent, candidate, delta);
      agentSpatialHash.remove(agent);
    } else {
      updateAgentPosition(agent, candidate, delta);
      agentSpatialHash.move(agent, agent.point[0], agent.point[1]);
    }
  }
  separateAgents();
  updateDoors(delta);
  agentsDirty = true;
  const counts = simulationCounts();
  if (simulationElapsed - lastSimulationMetricsUpdate >= 0.1) {
    updateSimulationMetrics(counts);
    updateFireReadout();
    lastSimulationMetricsUpdate = simulationElapsed;
  }
  // With a fire on the map the clock keeps running after the last person is
  // resolved, so the smoke can be watched until it has filled the floor.
  if (counts.moving === 0 && !fireActive()) {
    simulationRunning = false;
    updatePlayControls();
    setSimulationState('complete');
    setStatus(`Simulation complete. ${counts.evacuated} evacuated; ${counts.trapped} collapsed; ${counts.noRoute} without a route.`);
  } else if (counts.moving === 0 && agents.length && !evacuationSummaryShown) {
    evacuationSummaryShown = true;
    setStatus(`Evacuation finished: ${counts.evacuated} out, ${counts.trapped} collapsed, ${counts.noRoute} without a route. The fire keeps burning; press Pause to stop.`);
  }
}

/** True while the smoke is still changing (until it has saturated everywhere). */
function fireActive() {
  return Boolean(fireScenario) && fireTime() < fireScenario.settledTime;
}

function fireTime() {
  return fireScenario ? Math.max(0, simulationElapsed - fireScenario.startTime) : 0;
}

function walkableRegionAt(point) {
  return ownerRegions(point).find((region) => WALKABLE_KINDS.has(region.kind)) ?? null;
}

/** Smoke at a person's breathing height; optical smoke is not toxicity data. */
function breathingSmokeDensity(point, time = fireTime()) {
  if (!fireScenario) return 0;
  if (typeof fireScenario.breathingDensityAt === 'function') {
    const value = fireScenario.breathingDensityAt(point, time, BREATHING_HEIGHT_METERS);
    return Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;
  }
  const value = fireScenario.densityAt?.(point, time);
  return Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;
}

function hazardAtPoint(point, time = fireTime()) {
  if (!fireScenario) return {};
  return {
    activeFlame: Boolean(fireScenario.isFlamingAt?.(point, time)),
    heatFlux: Number(fireScenario.heatFlux?.(point, time)) || 0,
    smokeDensity: breathingSmokeDensity(point, time),
  };
}

function sampleHazardSegment(start, end, time = fireTime()) {
  return sampleSegmentHazard(start, end, (point) => hazardAtPoint(point, time), {
    stepPx: ROUTE_HAZARD_SAMPLE_STEP_PX,
  });
}

function hazardRoutePenalty(hazard) {
  return hazardEdgePenalty(hazard, {
    hardHeatFlux: HEAT_AVOID_FLUX,
    smokePenalty: ROUTE_SMOKE_PENALTY,
    smokeReferenceDensity: fireScenario?.params?.ksLimit ?? 0.5,
  });
}

function startHazard(point) {
  return hazardAtPoint(point, fireTime());
}

function movementHazardAllowed(start, end, agent = null, { allowHazardEscape = true } = {}) {
  if (!fireScenario) return true;
  const hazard = sampleHazardSegment(start, end);
  if (Number.isFinite(hazardRoutePenalty(hazard))) return true;
  const startSeverity = hazardSeverity(startHazard(start));
  const endSeverity = hazard.endSeverity;
  // A person already in a flame/high-heat cell must be able to take the
  // monotonic escape route out of it. Once clear, newly dangerous segments
  // remain blocked until a fresh route is found.
  if (!allowHazardEscape || startSeverity <= 0 || endSeverity > startSeverity + 1e-6) return false;
  const samples = hazard.samples ?? [];
  if (!samples.every((sample, index) => index === 0 || hazardSeverity(sample) <= hazardSeverity(samples[index - 1]) + 1e-6)) return false;
  return Boolean(agent?.routeResult?.escapedFromHazard || startSeverity > 0);
}

function routeHasHazardEscape(route) {
  return Boolean(route?.escapedFromHazard)
    || (route?.edge_hazards ?? route?.edgeHazards ?? []).some((hazard) => hazard?.endSeverity < hazard?.startSeverity && hazard?.startSeverity > 0);
}

function resetFireTimeline() {
  lastFireUpdate = -Infinity;
  if (!fireScenario) return;
  fireScenario.startTime = 0;
  updateSmokeOverlay();
  updateFireReadout();
}

function escapeRoute(point, agent = null) {
  return nearestExitRoute(point, null, agent);
}

function rerouteAgent(agent) {
  agent.lastRouteAttemptTime = simulationElapsed;
  const route = escapeRoute(agent.point, agent);
  if (route.status !== 'ok' || !route.polyline_px?.length) {
    // Never leave a stale path alive after a failed hazard-aware query. The
    // agent will be retried as the fire front and smoke field evolve.
    agent.status = 'no_route';
    agent.route = null;
    agent.routePolylinePx = [];
    agent.routeResult = route;
    agent.routeLengthPx = null;
    agent.routeLengthM = null;
    agent.routeCostPx = null;
    agent.offset[0] = 0;
    agent.offset[1] = 0;
    return false;
  }
  if (route.reason === 'already-in-exit') {
    agent.status = 'evacuated';
    agent.route = null;
    agent.routeResult = route;
    agent.routePolylinePx = route.polyline_px;
    agent.routeLengthPx = 0;
    agent.routeLengthM = 0;
    agent.routeCostPx = 0;
    agentSpatialHash.remove(agent);
    return true;
  }
  agent.route = makeAgentRoute(route);
  agent.exitId = route.exitId ?? null;
  agent.routePolylinePx = route.polyline_px;
  agent.routeResult = route;
  agent.routeLengthPx = route.length_px;
  agent.routeLengthM = route.length_m;
  agent.routeCostPx = route.cost_px;
  agent.status = 'ready';
  agent.segmentIndex = 0;
  agent.segmentOffset = 0;
  agent.distanceTravelled = 0;
  agent.offset[0] = 0;
  agent.offset[1] = 0;
  agent.motionPoint[0] = agent.point[0];
  agent.motionPoint[1] = agent.point[1];
  return true;
}

/**
 * Apply the fire model a few times per second: smoke affects visibility and
 * speed, heat accumulates injury dose, and live segment sampling updates paths
 * as the hazard field evolves.
 */
function updateFireHazard() {
  lastFireUpdate = simulationElapsed;
  const time = fireTime();
  for (const agent of agents) {
    if (agent.status === 'evacuated' || agent.status === 'trapped') continue;
    const previousHazardTime = Number.isFinite(agent.lastHazardTime)
      ? agent.lastHazardTime
      : simulationElapsed;
    const exposure = Math.max(0, simulationElapsed - previousHazardTime);
    agent.lastHazardTime = simulationElapsed;
    // Ks is optical smoke at breathing height. It slows movement and reduces
    // visibility; without CO/HCN inputs it is intentionally never added to
    // the injury dose.
    const ks = breathingSmokeDensity(agent.point, time);
    const heat = fireScenario.heatFlux(agent.point, time);
    agent.heat = heat;
    const integrated = accumulateExposure({
      heatDose: agent.heatDose ?? agent.dose ?? 0,
      smokeVisibilityExposure: agent.smokeVisibilityExposure ?? 0,
      heatFlux: heat,
      smokeDensity: ks,
      deltaSeconds: exposure,
      heatToleranceTime,
      smokeReferenceDensity: fireScenario.params?.ksLimit ?? 0.5,
    });
    agent.heatDose = integrated.heatDose;
    agent.dose = integrated.heatDose;
    agent.smokeVisibilityExposure = integrated.smokeVisibilityExposure;
    if (integrated.incapacitated) {
      agent.status = 'trapped';
      agent.walking = false;
      agent.incapacitatedTime = simulationElapsed;
      agent.route = null;
      agentSpatialHash.remove(agent);
      continue;
    }
    agent.smokeFactor = smokeMovementFactor(ks, { minimum: 0.3, coefficient: 0.5, referenceDensity: 1 });
    // Burnt people panic; people who see the fire or smoke, or feel heat, run.
    const seesFire = walkableRegionAt(agent.point)?.id === fireScenario.originRegionId;
    const pace = heat >= PANIC_HEAT_FLUX ? 'panic' : heat >= RUN_HEAT_FLUX || ks >= RUN_SMOKE_KS || seesFire ? 'run' : null;
    if (pace && (pace === 'panic' || agent.pace !== 'panic' || simulationElapsed >= agent.paceUntil)) {
      agent.pace = pace;
      agent.paceUntil = simulationElapsed + PACE_HOLD_SECONDS;
    } else if (!pace && simulationElapsed >= agent.paceUntil) {
      agent.pace = agent.pace === 'panic' ? 'run' : 'walk';
      agent.paceUntil = simulationElapsed + PACE_HOLD_SECONDS;
    }
    // Someone feeling the heat looks for a way away from the flames.
    const hot = heat > HEAT_AVOID_FLUX && simulationElapsed - (agent.heatRerouteTime ?? -Infinity) > 2;
    if (agent.status === 'no_route') {
      if (shouldRetryNoRoute(simulationElapsed, agent.lastRouteAttemptTime, NO_ROUTE_RETRY_SECONDS)) rerouteAgent(agent);
    } else if (hot) {
      agent.heatRerouteTime = simulationElapsed;
      rerouteAgent(agent);
    } else if (ks >= (fireScenario.params?.ksLimit ?? 0.5)
      && simulationElapsed - (agent.lastRouteAttemptTime ?? -Infinity) >= ROUTE_REPLAN_INTERVAL_SECONDS) {
      rerouteAgent(agent);
    }
  }
  agentsDirty = true;
  // The textures are uploaded from the render loop at most ten times a second.
  hazardDirty = true;
}

function updateFireReadout() {
  if (!fireReadoutNode) return;
  if (!fireScenario) {
    fireReadoutNode.textContent = 'No fire placed.';
    return;
  }
  const time = fireTime();
  const originKs = breathingSmokeDensity(fireScenario.originPoint, time);
  const visibility = visibilityDistance(originKs);
  const spill = fireScenario.onset + fireScenario.fillDelay;
  const transition = Number(fireScenario.growthSpreadTransition ?? fireScenario.spreadTransition ?? fireScenario.growthTransition ?? fireScenario.flashover);
  const transitionText = Number.isFinite(transition)
    ? (time < transition ? `growth/spread transition at ${transition.toFixed(0)} s` : 'growth/spread transition reached')
    : 'growth/spread transition not reached';
  const smoke = time < spill
    ? `smoke fills the fire room, spills out at ${spill.toFixed(0)} s`
    : `fire Ks = ${originKs.toFixed(2)} m⁻¹, visibility ${Number.isFinite(visibility) ? `${visibility.toFixed(1)} m` : 'clear'}`;
  fireReadoutNode.textContent = [
    `t = ${time.toFixed(1)} s`,
    `Q = ${Math.round(fireScenario.hrr(time))} kW`,
    `burning ${fireScenario.flamingArea(time).toFixed(1)} m²`,
    transitionText,
    smoke,
    'routes sample live flame, heat and smoke',
  ].join(' · ');
}

const smokeVertexShader = /* glsl */`
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const noiseShaderChunk = /* glsl */`
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
  }
  float fbm(vec2 p) {
    float value = 0.0;
    float amplitude = 0.5;
    for (int i = 0; i < 4; i++) {
      value += amplitude * noise(p);
      p *= 2.03;
      amplitude *= 0.5;
    }
    return value;
  }
`;

// The hazard grid texture holds R = Ks / KsMax and B = fire (1 flaming,
// about 0.55 burnt out). G and A are R and B spread one or two cells into the
// walls, for smoke stains and charring on wall faces (see surfaces.js).
// Smoke is drawn as stacked layers under the ceiling: the hot smoke layer
// deepens as it thickens, so denser smoke shows on lower layers too. Two
// drifting noise fields break the grid up into moving smoke.
const smokeFragmentShader = /* glsl */`
  uniform sampler2D uDensity;
  uniform float uTime;
  uniform vec2 uNoiseScale;
  uniform float uLevel;
  uniform vec3 uGlow;
  uniform vec2 uGlowRadius;
  varying vec2 vUv;
  ${noiseShaderChunk}
  void main() {
    vec4 cell = texture2D(uDensity, vUv);
    float coverage = smoothstep(uLevel * 0.85, uLevel * 0.85 + 0.2, cell.r);
    if (cell.r < 0.01 || coverage < 0.01) discard;
    vec2 p = vUv * uNoiseScale + uLevel * 3.7;
    float n = fbm(p + vec2(uTime * 0.12, uTime * 0.05)) * 0.6 + fbm(p * 2.1 - vec2(uTime * 0.07, 0.0)) * 0.4;
    float alpha = clamp(coverage * (0.2 + 0.5 * cell.r) * (0.35 + 1.0 * n), 0.0, 0.62);
    vec3 smoke = mix(vec3(0.58, 0.58, 0.6), vec3(0.1, 0.1, 0.11), cell.r);
    // Flames below light the smoke up orange.
    smoke = mix(smoke, vec3(1.0, 0.42, 0.12), step(0.9, cell.b) * (0.55 - 0.35 * uLevel) * n);
    // Rollover: before flashover the smoke layer over the fire glows.
    float glowDistance = length((vUv - uGlow.xy) / uGlowRadius);
    float rollover = uGlow.z * (1.0 - smoothstep(0.2, 1.0, glowDistance + (n - 0.5) * 0.5)) * (1.0 - 0.6 * uLevel);
    smoke = mix(smoke, vec3(0.85, 0.28, 0.06), clamp(rollover * (0.3 + 0.6 * n), 0.0, 0.6));
    alpha = max(alpha, rollover * coverage * 0.35);
    gl_FragColor = vec4(smoke, alpha);
  }
`;

// Burning floor: a flickering glow on the fire edge, charred floor behind it.
const burnFragmentShader = /* glsl */`
  uniform sampler2D uDensity;
  uniform float uTime;
  uniform vec2 uNoiseScale;
  varying vec2 vUv;
  ${noiseShaderChunk}
  void main() {
    vec4 cell = texture2D(uDensity, vUv);
    if (cell.b < 0.03) discard;
    vec2 p = vUv * uNoiseScale * 2.0;
    float n = fbm(p + vec2(0.0, -uTime * 1.6));
    float edge = smoothstep(0.62, 0.95, cell.b);
    vec3 charred = vec3(0.05, 0.04, 0.035) + vec3(0.35, 0.07, 0.0) * n * n * (1.0 - edge);
    vec3 glow = mix(vec3(0.95, 0.28, 0.02), vec3(1.0, 0.78, 0.25), n);
    vec3 color = mix(charred, glow, edge * (0.45 + 0.55 * n));
    // Fade the edge in over noise so the burnt area has no hard outline.
    gl_FragColor = vec4(color, smoothstep(0.03, 0.75, cell.b + (n - 0.5) * 0.3) * 0.95);
  }
`;

function particlePixelScale() {
  const height = renderer.getDrawingBufferSize(new THREE.Vector2()).y;
  return height / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
}

function buildFireVisual() {
  disposeFireVisual();
  const { scale, wallHeight } = mapState;
  const effect = createFireEffect();
  effect.setPixelScale(particlePixelScale());
  effect.setBudget(QUALITY_LEVELS[quality.level].particles);
  // Particles are placed in world coordinates over the burning cells.
  effect.group.position.y = 0.08;
  // The fire light follows the burning front and casts shadows.
  const light = new THREE.PointLight(0xff7a1a, 0, wallHeight * 9, 1.6);
  toWorld(fireScenario.originPoint, light.position).y = wallHeight * 0.6;
  light.castShadow = QUALITY_LEVELS[quality.level].fireShadow;
  light.shadow.mapSize.set(512, 512);
  light.shadow.camera.near = 0.05;
  light.shadow.camera.far = wallHeight * 9;
  light.shadow.bias = -0.002;
  light.shadow.normalBias = 0.03;
  light.shadow.radius = 3;
  effect.group.add(light);
  scene.add(effect.group);

  // Smoke and burnt floor are shaded from one hazard texture over the grid.
  const { field } = fireScenario;
  const data = new Uint8Array(field.cols * field.rows * 4);
  const densityTexture = new THREE.DataTexture(data, field.cols, field.rows, THREE.RGBAFormat);
  densityTexture.magFilter = THREE.LinearFilter;
  densityTexture.minFilter = THREE.LinearFilter;
  const width = field.cols * field.cellSize * scale;
  const depth = field.rows * field.cellSize * scale;
  // uGlow: fire origin in texture coordinates (x, y) and rollover strength (z).
  const glowRadiusM = 6;
  const fireOrigin = fireScenario.originPoint;
  const uniforms = {
    uDensity: { value: densityTexture },
    uTime: { value: 0 },
    uNoiseScale: { value: new THREE.Vector2(width / 1.2, depth / 1.2) },
    uGlow: { value: new THREE.Vector3(fireOrigin[0] / (field.cols * field.cellSize), 1 - fireOrigin[1] / (field.rows * field.cellSize), 0) },
    uGlowRadius: { value: new THREE.Vector2(glowRadiusM / (field.cols * field.cellSize * metersPerPixel()), glowRadiusM / (field.rows * field.cellSize * metersPerPixel())) },
  };
  const overlay = (fragmentShader, y, extra = {}) => {
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(width, depth).rotateX(-Math.PI / 2),
      new THREE.ShaderMaterial({
        uniforms: { ...uniforms, ...extra },
        vertexShader: smokeVertexShader,
        fragmentShader,
        transparent: true,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -1,
      }),
    );
    toWorld([(field.cols * field.cellSize) / 2, (field.rows * field.cellSize) / 2], mesh.position).y = y;
    scene.add(mesh);
    return mesh;
  };
  const burn = overlay(burnFragmentShader, 0.1);
  burn.renderOrder = 1;
  // Layer 0 sits under the ceiling, the last one about half-way down.
  const smokeLayers = [];
  for (let index = 0; index < SMOKE_LAYERS; index += 1) {
    const level = index / (SMOKE_LAYERS - 1);
    const layer = overlay(smokeFragmentShader, wallHeight * (0.97 - 0.5 * level), { uLevel: { value: level } });
    layer.renderOrder = 2;
    smokeLayers.push(layer);
  }
  // Walls and doors read the same texture (see surfaces.js).
  const origin = toWorld([0, 0]);
  hazardUniforms.uHazard.value = densityTexture;
  hazardUniforms.uHazardRect.value.set(origin.x, origin.z, width, depth);
  hazardUniforms.uHazardOn.value = 1;
  const cellCount = field.cols * field.rows;
  fireVisual = {
    effect,
    light,
    smokeLayers,
    burn,
    uniforms,
    data,
    densityTexture,
    spread: new Uint8Array(cellCount * 2),
    smokyCells: new Int32Array(cellCount),
    smokyCount: 0,
    lightTimer: 0,
  };
  applySmokeLayerQuality();
  // Pre-warm the particles so a newly placed fire is already burning.
  for (let step = 0; step < 20; step += 1) animateFire(0.05);
  updateSmokeOverlay();
}

function disposeFireVisual() {
  if (!fireVisual) return;
  fireVisual.effect.dispose();
  scene.remove(fireVisual.effect.group);
  hazardUniforms.uHazardOn.value = 0;
  hazardUniforms.uHazard.value = null;
  for (const mesh of [...fireVisual.smokeLayers, fireVisual.burn]) {
    mesh.geometry.dispose();
    mesh.material.dispose();
    scene.remove(mesh);
  }
  fireVisual.densityTexture.dispose();
  fireVisual = null;
}

function updateSmokeOverlay() {
  hazardDirty = false;
  lastHazardUpload = performance.now();
  if (!fireVisual || !fireScenario) return;
  const { data, spread, smokyCells } = fireVisual;
  const { cols, rows } = fireScenario.field;
  const { ksMax, burnDuration } = fireScenario.params;
  const time = fireTime();
  const { ignition } = fireScenario;
  let smokyCount = 0;
  // Texture row 0 is the far (-z) edge of the plane, i.e. pixel row 0 is the
  // last texture row.
  fireScenario.densityField(time, (index, ks) => {
    const x = index % cols;
    const y = (index - x) / cols;
    const offset = ((rows - 1 - y) * cols + x) * 4;
    data[offset] = Math.round((ks / ksMax) * 255);
    const burning = time - ignition[index];
    data[offset + 2] = !(burning >= 0) ? 0 : burning < burnDuration ? 255 : 140;
    if (ks > ksMax * 0.05) smokyCells[smokyCount++] = index;
  });
  fireVisual.smokyCount = smokyCount;
  // Spread smoke (R -> G) and fire (B -> A) WALL_SPREAD_CELLS into the walls
  // with a separable maximum filter, so wall faces pick them up.
  const radius = WALL_SPREAD_CELLS;
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      let smoke = 0;
      let fire = 0;
      for (let other = Math.max(0, col - radius); other <= Math.min(cols - 1, col + radius); other += 1) {
        const offset = (row * cols + other) * 4;
        if (data[offset] > smoke) smoke = data[offset];
        if (data[offset + 2] > fire) fire = data[offset + 2];
      }
      spread[(row * cols + col) * 2] = smoke;
      spread[(row * cols + col) * 2 + 1] = fire;
    }
  }
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      let smoke = 0;
      let fire = 0;
      for (let other = Math.max(0, row - radius); other <= Math.min(rows - 1, row + radius); other += 1) {
        const index = (other * cols + col) * 2;
        if (spread[index] > smoke) smoke = spread[index];
        if (spread[index + 1] > fire) fire = spread[index + 1];
      }
      const offset = (row * cols + col) * 4;
      data[offset + 1] = smoke;
      data[offset + 3] = fire;
    }
  }
  fireVisual.densityTexture.needsUpdate = true;
  requestRender();
}

/** Put a drifting smoke puff on a random smoke-filled cell. */
function placeHazeParticle(particle) {
  const { smokyCells, smokyCount } = fireVisual;
  const { field, params } = fireScenario;
  const cell = smokyCells[Math.floor(Math.random() * smokyCount)];
  const x = cell % field.cols;
  firePixelScratch[0] = (x + Math.random()) * field.cellSize;
  firePixelScratch[1] = ((cell - x) / field.cols + Math.random()) * field.cellSize;
  toWorld(firePixelScratch, fireWorldScratch);
  const density = Math.min(1, fireScenario.densityAt(firePixelScratch, fireTime()) / params.ksMax);
  particle.x = fireWorldScratch.x;
  particle.z = fireWorldScratch.z;
  // Denser smoke hangs lower (effect group sits at y = 0.08).
  particle.y = mapState.wallHeight * (0.9 - 0.45 * density * Math.random()) - 0.08;
  particle.density = density;
}

/** Move the fire light to the middle of the most recently ignited cells. */
function placeFireLight() {
  const [start, end] = fireScenario.flamingRange(fireTime());
  if (end <= start) return;
  const { cols, cellSize } = fireScenario.field;
  const from = Math.max(start, end - Math.max(40, Math.floor((end - start) * 0.25)));
  const stride = Math.max(1, Math.floor((end - from) / 64));
  let sumX = 0;
  let sumY = 0;
  let count = 0;
  for (let rank = from; rank < end; rank += stride) {
    const index = fireScenario.burnOrder[rank];
    const x = index % cols;
    sumX += (x + 0.5) * cellSize;
    sumY += ((index - x) / cols + 0.5) * cellSize;
    count += 1;
  }
  firePixelScratch[0] = sumX / count;
  firePixelScratch[1] = sumY / count;
  const { light } = fireVisual;
  const y = light.position.y;
  toWorld(firePixelScratch, light.position).y = y;
}

/**
 * Flame size from Heskestad's correlation, L = 0.235 Q^0.4 - 1.02 D. Before
 * flashover the whole fire is one flame that grows taller with Q (up to the
 * ceiling), so a growing fire is visible even while its floor area is small.
 * After flashover the floor is drawn as many ~800 kW patches.
 */
function flameDimensions(hrrKw, preFlashover) {
  const patchKw = preFlashover ? hrrKw : Math.min(hrrKw, 800);
  const diameter = Math.max(0.6, Math.min(2.2, Math.sqrt((4 * patchKw) / (Math.PI * fireScenario.params.hrrPerArea))));
  const height = Math.max(1, 0.235 * patchKw ** 0.4 - 1.02 * diameter);
  return { diameter, height };
}

const fireWorldScratch = new THREE.Vector3();
const firePixelScratch = [0, 0];
const SMOKE_LAYERS = 5;
const WALL_SPREAD_CELLS = 2;

/** Place a particle on a random flaming cell, favouring newly ignited ones. */
function placeFireParticle(particle) {
  const [start, end] = fireScenario.flamingRange(fireTime());
  if (end <= start) {
    toWorld(fireScenario.originPoint, fireWorldScratch);
    particle.x = fireWorldScratch.x;
    particle.z = fireWorldScratch.z;
    return;
  }
  const rank = start + Math.min(end - start - 1, Math.floor((end - start) * (1 - Math.random() ** 2)));
  const index = fireScenario.burnOrder[rank];
  const { cols, cellSize } = fireScenario.field;
  const x = index % cols;
  firePixelScratch[0] = (x + Math.random()) * cellSize;
  firePixelScratch[1] = ((index - x) / cols + Math.random()) * cellSize;
  toWorld(firePixelScratch, fireWorldScratch);
  particle.x = fireWorldScratch.x;
  particle.z = fireWorldScratch.z;
}

/** Advance the fire particles by `delta` real seconds. */
function animateFire(delta) {
  if (!fireVisual) return;
  const time = fireTime();
  const hrr = fireScenario.hrr(time);
  const preFlashover = time < fireScenario.flashover;
  const { diameter, height } = flameDimensions(hrr, preFlashover);
  const worldPerMeter = mapState.scale / metersPerPixel();
  const growth = Math.min(1, hrr / fireScenario.params.flashoverKw);
  // Before flashover the hot smoke under the ceiling glows more and more
  // orange around the fire ("rollover" just before the room flashes over).
  const rollover = preFlashover ? THREE.MathUtils.smoothstep(growth, 0.35, 1) : 0;
  fireVisual.uniforms.uGlow.value.z = rollover;
  fireVisual.effect.update(delta, {
    place: placeFireParticle,
    radius: (diameter / 2) * worldPerMeter,
    height: Math.min(mapState.wallHeight * 0.95, height * worldPerMeter),
    ceiling: mapState.wallHeight * 0.95,
    intensity: Math.min(1, Math.max(fireScenario.flamingArea(time) / 60, growth * 0.35)),
    // Roughly one flame per 2-3 m2 of burning floor; a few for a single fire.
    flameCount: 8 + Math.min(160, fireScenario.flamingArea(time) * 0.7) + growth * 6,
    smoke: time >= fireScenario.onset * 0.5,
    placeHaze: fireVisual.smokyCount ? placeHazeParticle : null,
    haze: fireVisual.smokyCount / fireScenario.field.arrival.length,
  });
  fireVisual.uniforms.uTime.value += delta;
  hazardUniforms.uFireTime.value = fireVisual.uniforms.uTime.value;
  fireVisual.lightTimer -= delta;
  if (fireVisual.lightTimer <= 0) {
    fireVisual.lightTimer = 0.5;
    placeFireLight();
  }
  fireVisual.light.intensity = Math.min(25, 3 + hrr / 60) * (0.9 + 0.2 * Math.random());
  requestRender();
}

function rebuildFireScenario(originPoint, originRegionId) {
  const startTime = fireScenario?.startTime ?? simulationElapsed;
  fireScenario = createFireScenario({
    matrix: mapState.semanticMatrix,
    regions: currentModel.navmesh.regions,
    originRegionId,
    originPoint,
    metersPerPixel: metersPerPixel(),
    growth: fireGrowth,
    initialHrrKw: fireInitialKw,
  });
  fireScenario.startTime = startTime;
  // Keep the clock running until smoke has saturated and the last cell has
  // burnt out: an unattended fire burns the whole reachable floor.
  const smokeSettled = Number.isFinite(fireScenario.smokeClearanceTime)
    ? fireScenario.smokeClearanceTime
    : fireScenario.lastSmokeArrival + fireScenario.params.tau * 3;
  const burntOut = fireScenario.lastIgnition + fireScenario.params.burnDuration;
  fireScenario.settledTime = Math.max(smokeSettled, burntOut);
  lastFireUpdate = -Infinity;
  for (const agent of agents) {
    if (agent.status === 'evacuated' || agent.status === 'trapped') continue;
    // The new fire timeline starts now; do not charge an agent for time before
    // this ignition or for the old scenario when its settings are rebuilt.
    agent.lastHazardTime = simulationElapsed;
    agent.lastRouteAttemptTime = -Infinity;
  }
}

function placeFire(point) {
  const region = walkableRegionAt(point);
  if (!region || region.kind === 'exit') {
    setStatus('Place the fire on a floor or door region.', true);
    return false;
  }
  fireScenario = null;
  rebuildFireScenario(point, region.id);
  buildFireVisual();
  updateFireReadout();
  const spill = fireScenario.onset + fireScenario.fillDelay;
  const transition = Number(fireScenario.growthSpreadTransition ?? fireScenario.spreadTransition ?? fireScenario.growthTransition ?? fireScenario.flashover);
  const transitionText = Number.isFinite(transition) ? `growth/spread transition at ${transition.toFixed(0)} s` : 'growth/spread transition is not reached';
  setStatus(`Fire placed: ${fireInitialKw} kW, ${FIRE_GROWTH[fireGrowth].label} growth. Smoke leaves the fire area after about ${spill.toFixed(0)} s; ${transitionText}.`);
  return true;
}

function clearFire({ announce = false } = {}) {
  if (firePlacementMode) setFirePlacementMode(false);
  fireScenario = null;
  disposeFireVisual();
  for (const agent of agents) {
    agent.smokeFactor = 1;
    agent.smokeVisibilityExposure = 0;
    agent.heat = 0;
    agent.lastHazardTime = simulationElapsed;
    agent.lastRouteAttemptTime = -Infinity;
    if (agent.status !== 'trapped') {
      agent.heatDose = 0;
      agent.dose = 0;
      agent.incapacitatedTime = null;
    }
    if (agent.status === 'no_route') {
      agent.route = null;
      agent.routePolylinePx = [];
      agent.routeResult = { status: 'unreachable', polyline_px: [] };
      rerouteAgent(agent);
    }
  }
  updateFireReadout();
  requestRender();
  if (announce) setStatus('Fire removed.');
}

function setFirePlacementMode(active) {
  firePlacementMode = active;
  if (active && personPlacementMode) setPersonPlacementMode(false);
  if (active) finishSelectionMode();
  controls.enabled = !active && !personPlacementMode && !personDragActive && !selectionMode;
  viewport.classList.toggle('person-placement', active || personPlacementMode);
  toolbarFireButton?.setAttribute('aria-pressed', String(active));
  if (active) {
    setStatus('Click a floor region to start a fire. Press Escape to cancel.');
    renderer.domElement.focus();
  }
}

function setPersonPlacementMode(active) {
  personPlacementMode = active;
  if (active && firePlacementMode) setFirePlacementMode(false);
  controls.enabled = !active && !personDragActive && !selectionMode;
  viewport.classList.toggle('person-placement', active);
  placementHintNode.hidden = !active;
  personSourceButton?.setAttribute('aria-pressed', String(active));
  toolbarPersonButton?.setAttribute('aria-pressed', String(active));
  if (active) {
    finishSelectionMode();
    controls.enabled = false;
    setStatus('Placement mode active. Click a walkable floor to place one person. Press Escape to cancel.');
    renderer.domElement.focus();
  }
}

function handlePersonPlacement(event) {
  const point = pointFromPointer(event);
  if (!point) {
    setStatus('Could not read that placement point. Try the visible floor surface.', true);
    return;
  }
  const agent = spawnAgent(point);
  if (agent) setPersonPlacementMode(false);
}

function ownerRegions(point) {
  const [x, y] = point;
  return (currentModel?.navmesh?.regions ?? []).filter((region) => {
    const [x0, y0, x1, y1] = region.bounds_px;
    return x0 <= x && x < x1 && y0 <= y && y < y1;
  });
}

function pointDistance(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

function directWalkableRoute(start, goal, mesh, reason = 'direct-walkable-fallback') {
  const validation = isWalkableSegment(mapState?.semanticMatrix, start, goal);
  if (!validation.ok) return null;
  const lengthPx = pointDistance(start, goal);
  const scale = mesh?.meters_per_pixel;
  let costPx = lengthPx;
  let edgeHazards = [];
  let escapedFromHazard = false;
  if (fireScenario) {
    const hazard = sampleHazardSegment(start, goal);
    const penalty = hazardRoutePenalty(hazard);
    if (Number.isFinite(penalty)) {
      costPx = lengthPx * penalty;
    } else {
      const startSeverity = hazardSeverity(startHazard(start));
      const monotonic = startSeverity > 0
        && hazard.samples.every((sample, index) => index === 0 || hazardSeverity(sample) <= hazardSeverity(hazard.samples[index - 1]) + 1e-6)
        && hazard.endSeverity <= startSeverity + 1e-6;
      if (!monotonic) return null;
      escapedFromHazard = true;
      edgeHazards = [hazard];
    }
    if (!edgeHazards.length) edgeHazards = [hazard];
  }
  return {
    status: 'ok',
    algorithm: 'direct-walkable-fallback',
    reason,
    polyline_px: lengthPx === 0 ? [start] : [start, goal],
    region_ids: [],
    length_px: lengthPx,
    cost_px: costPx,
    edge_hazards: edgeHazards,
    escapedFromHazard,
    length_m: scale == null ? null : lengthPx * scale,
  };
}

/**
 * The routing graph is immutable per model, so build its lookup tables once.
 * Each query only adds its two endpoints as an overlay.
 */
function routingGraph() {
  if (routingCache?.model === currentModel) return routingCache;
  const mesh = currentModel.navmesh;
  const graph = currentModel.routing_graph;
  const positions = new Map(graph.nodes.map((node) => [node.id, node.position_px]));
  const adjacency = new Map(graph.nodes.map((node) => [node.id, []]));
  const membership = new Map(mesh.regions.map((region) => [region.id, []]));
  for (const node of graph.nodes) {
    for (const regionId of node.region_ids) membership.get(regionId)?.push(node.id);
  }
  for (const edge of graph.edges) {
    if (!adjacency.has(edge.source)) adjacency.set(edge.source, []);
    if (!adjacency.has(edge.target)) adjacency.set(edge.target, []);
    const source = positions.get(edge.source);
    const target = positions.get(edge.target);
    // Some generated graphs contain a boundary shortcut whose endpoints are
    // in the same region but whose straight segment crosses a solid wall.
    // Keep the graph topology, but reject that geometry before hazard costs.
    if (!source || !target || !isWalkableSegment(mapState?.semanticMatrix, source, target).ok) continue;
    adjacency.get(edge.source).push({ node: edge.target, length: edge.length_px, regionId: edge.region_id });
    adjacency.get(edge.target).push({ node: edge.source, length: edge.length_px, regionId: edge.region_id });
  }
  routingCache = { model: currentModel, positions, adjacency, membership };
  return routingCache;
}

function computeRoute(start, goal, { blockedRegions = null } = {}) {
  const mesh = currentModel?.navmesh;
  const graph = currentModel?.routing_graph;
  const startOwners = ownerRegions(start);
  const goalOwners = ownerRegions(goal);
  const startInExit = startOwners.some((region) => region.kind === 'exit');
  if (startInExit) {
    const scale = mesh?.meters_per_pixel;
    return {
      status: 'ok',
      algorithm: 'semantic-exit',
      reason: 'already-in-exit',
      polyline_px: [start],
      region_ids: [],
      length_px: 0,
      cost_px: 0,
      length_m: scale == null ? null : 0,
    };
  }

  // Even the direct fallback samples the geometric segment while a fire is
  // active; it cannot bypass a flame or high-heat bottleneck.
  const fallback = () => (!blockedRegions?.size ? directWalkableRoute(start, goal, mesh) : null);
  const graphUsable = Array.isArray(mesh?.regions) && mesh.regions.length > 0
    && Array.isArray(graph?.nodes) && Array.isArray(graph?.edges);
  if (!mapState?.semanticMatrix) return { status: 'invalid_graph', polyline_px: [] };
  if (!graphUsable) return fallback() ?? { status: 'invalid_graph', polyline_px: [] };
  if (!startOwners.length || !goalOwners.length) return fallback() ?? { status: 'outside_navmesh', polyline_px: [] };

  const base = routingGraph();
  const endpointPositions = new Map();
  const extraEdges = new Map();
  const extraMembership = new Map();
  const positionOf = (id) => endpointPositions.get(id) ?? base.positions.get(id);
  const connect = (a, b, regionId, length) => {
    if (!isWalkableSegment(mapState?.semanticMatrix, positionOf(a), positionOf(b)).ok) return;
    if (!extraEdges.has(a)) extraEdges.set(a, []);
    if (!extraEdges.has(b)) extraEdges.set(b, []);
    extraEdges.get(a).push({ node: b, length, regionId });
    extraEdges.get(b).push({ node: a, length, regionId });
  };
  const attachEndpoint = (id, point, owners) => {
    endpointPositions.set(id, point);
    for (const region of owners) {
      const extra = extraMembership.get(region.id) ?? [];
      for (const other of [...(base.membership.get(region.id) ?? []), ...extra]) {
        connect(id, other, region.id, pointDistance(point, positionOf(other)));
      }
      extra.push(id);
      extraMembership.set(region.id, extra);
    }
  };
  attachEndpoint('__start', start, startOwners);
  attachEndpoint('__goal', goal, goalOwners);

  const adjacency = new Map([...base.adjacency.entries()].map(([id, edges]) => [id, [...edges]]));
  for (const [id, edges] of extraEdges) adjacency.set(id, [...(adjacency.get(id) ?? []), ...edges]);
  if (blockedRegions?.size) {
    for (const [id, edges] of adjacency) adjacency.set(id, edges.filter((edge) => !blockedRegions.has(edge.regionId)));
  }
  const queryTime = fireTime();
  const timeKey = Math.round(queryTime / FIRE_UPDATE_INTERVAL);
  if (routingHazardCache.model !== currentModel || routingHazardCache.scenario !== fireScenario || routingHazardCache.timeKey !== timeKey) {
    routingHazardCache = { model: currentModel, scenario: fireScenario, timeKey, values: new Map() };
  }
  const sampleEdge = (from, to) => {
    if (!fireScenario) return null;
    const key = `${from[0]},${from[1]}:${to[0]},${to[1]}`;
    if (!routingHazardCache.values.has(key)) routingHazardCache.values.set(key, sampleHazardSegment(from, to, queryTime));
    return routingHazardCache.values.get(key);
  };
  const shortest = hazardAwareShortestPath({
    startId: '__start',
    goalId: '__goal',
    adjacency,
    positionOf,
    startHazard: fireScenario ? startHazard(start) : null,
    sampleEdge,
    edgePenalty: hazardEdgePenalty,
    edgePenaltyOptions: {
      hardHeatFlux: HEAT_AVOID_FLUX,
      smokePenalty: fireScenario ? ROUTE_SMOKE_PENALTY : 0,
      smokeReferenceDensity: fireScenario?.params?.ksLimit ?? 0.5,
    },
    allowEscapeFromHazard: Boolean(fireScenario),
  });
  if (shortest.status !== 'ok') return fireScenario ? shortestRouteFailure(shortest) : fallback() ?? { status: 'unreachable', polyline_px: [] };
  const path = shortest.path;
  const regionIds = (shortest.edges ?? []).map((edge) => edge.regionId).filter((id) => id != null);
  const lengthPx = shortest.lengthPx;
  const scale = mesh.meters_per_pixel;
  return {
    status: 'ok',
    algorithm: fireScenario ? 'hazard-aware-dijkstra' : 'dijkstra',
    polyline_px: path.map(positionOf),
    region_ids: regionIds,
    length_px: lengthPx,
    length_m: scale == null ? null : lengthPx * scale,
    cost_px: shortest.cost,
    edge_hazards: shortest.edgeHazards,
    escapedFromHazard: shortest.escapedFromHazard,
  };
}

function shortestRouteFailure(shortest) {
  return {
    status: shortest?.status === 'invalid_graph' ? 'invalid_graph' : 'unreachable',
    polyline_px: [],
    length_px: Infinity,
    cost_px: Infinity,
  };
}

function exitQueue(exitId, except = null) {
  let count = 0;
  for (const agent of agents) {
    if (agent !== except && agent.exitId === exitId && (agent.status === 'ready' || agent.status === 'moving')) count += 1;
  }
  return count;
}

/**
 * Pick the exit with the shortest expected time: walking time plus the time
 * for the people already heading there to pass through it. Crowds therefore
 * spread over several exits instead of all taking the nearest one.
 */
function nearestExitRoute(point, blockedRegions = null, agent = null) {
  const scale = metersPerPixel();
  let best = null;
  let bestCost = Infinity;
  for (const region of currentModel?.navmesh?.regions ?? []) {
    if (region.kind !== 'exit' || !Array.isArray(region.center_px)) continue;
    const route = computeRoute(point, region.center_px.map(Number), { blockedRegions, agent });
    if (route.status !== 'ok' || !Number.isFinite(route.length_px)) continue;
    const [x0, y0, x1, y1] = region.bounds_px.map(Number);
    const widthM = Math.max(x1 - x0, y1 - y0) * scale;
    const geometricTime = ((route.length_px * scale) / WALK_SPEED_MPS);
    const hazardTime = Number.isFinite(route.cost_px)
      ? (route.cost_px * scale) / WALK_SPEED_MPS
      : geometricTime;
    const cost = hazardTime + exitQueue(region.id, agent) / (EXIT_FLOW_PER_METER * widthM);
    if (cost < bestCost) {
      bestCost = cost;
      best = route;
      best.exitId = region.id;
      best.routingCost = cost;
    }
  }
  return best ?? { status: 'unreachable', polyline_px: [] };
}

function formatPoint(point) {
  return point ? `${point[0].toFixed(1)}, ${point[1].toFixed(1)} px` : 'Not selected';
}

function finishSelectionMode() {
  selectionMode = null;
  controls.enabled = !personPlacementMode && !personDragActive;
  viewport.classList.remove('picking');
  pickStartButton.setAttribute('aria-pressed', 'false');
  pickGoalButton.setAttribute('aria-pressed', 'false');
  cancelPickButton.hidden = true;
}

function beginSelectionMode(mode) {
  if (!currentModel) return;
  if (personPlacementMode) setPersonPlacementMode(false);
  selectionMode = mode;
  controls.enabled = false;
  viewport.classList.add('picking');
  pickStartButton.setAttribute('aria-pressed', String(mode === 'start'));
  pickGoalButton.setAttribute('aria-pressed', String(mode === 'goal'));
  cancelPickButton.hidden = false;
  const message = mode === 'start'
    ? 'Click a walkable floor, door, or exit to set the start.'
    : 'Click a green exit to set the destination.';
  routeHint.textContent = `${message} Press Escape to cancel.`;
  setStatus(message);
  renderer.domElement.focus();
}

function updateRoute() {
  routeStartNode.textContent = formatPoint(selectedStart);
  routeGoalNode.textContent = selectedGoal ? (selectedGoal.label ?? formatPoint(selectedGoal.point)) : 'Not selected';
  if (!selectedStart || !selectedGoal) {
    routeLengthNode.textContent = '-';
    drawRoute(null);
    return;
  }
  const route = computeRoute(selectedStart, selectedGoal.point);
  drawRoute(route);
  if (route.status !== 'ok') {
    routeLengthNode.textContent = 'No route';
    setStatus('No connected route exists between the selected start and exit.', true);
    return;
  }
  const distance = route.length_m == null
    ? `${route.length_px.toFixed(1)} px`
    : `${route.length_m.toFixed(2)} m`;
  routeLengthNode.textContent = distance;
  routeHint.textContent = route.algorithm === 'direct-walkable-fallback'
    ? 'Custom route uses a direct walkable-segment fallback because graph routing was unavailable.'
    : route.algorithm === 'semantic-exit'
      ? 'Start is already inside an exit region.'
      : 'Custom route calculated with Dijkstra on the JSON routing graph.';
  setStatus(`Route ready: ${distance} to ${selectedGoal.label}.`);
}

function resetRoutePlanner({ restorePreset = false } = {}) {
  finishSelectionMode();
  selectedStart = null;
  selectedGoal = null;
  exitSelect.value = '';
  routeStartNode.textContent = 'Not selected';
  routeGoalNode.textContent = 'Not selected';
  routeLengthNode.textContent = '-';
  routeHint.textContent = 'Pick a point on the map, then choose an exit or pick a destination on the map.';
  drawRoute(restorePreset ? currentModel?.route : null, { showMarkers: false });
}

function populateExits() {
  exitSelect.replaceChildren(new Option('Choose an exit...', ''));
  const exitRegions = (currentModel?.navmesh?.regions ?? []).filter((region) => region.kind === 'exit');
  for (const [index, region] of exitRegions.entries()) {
    const option = new Option(`Exit ${index + 1}`, String(region.id));
    exitSelect.add(option);
  }
  exitSelect.disabled = exitRegions.length === 0;
}

function selectExitRegion(region) {
  const exitRegions = (currentModel?.navmesh?.regions ?? []).filter((item) => item.kind === 'exit');
  const index = exitRegions.findIndex((item) => item.id === region.id);
  selectedGoal = { point: region.center_px.map(Number), label: `Exit ${index + 1}` };
  exitSelect.value = String(region.id);
  updateRoute();
}

function selectBestExit() {
  const exitRegions = (currentModel?.navmesh?.regions ?? []).filter((region) => (
    region.kind === 'exit' && Array.isArray(region.center_px) && region.center_px.length >= 2
  ));
  const reachable = exitRegions.map((region, index) => ({
    region,
    index,
    route: computeRoute(selectedStart, region.center_px.map(Number)),
  })).filter(({ route }) => route.status === 'ok' && Number.isFinite(route.length_px));
  const best = reachable.reduce((shortest, candidate) => (
    !shortest || candidate.route.length_px < shortest.route.length_px ? candidate : shortest
  ), null);

  if (!best) {
    selectedGoal = null;
    exitSelect.value = '';
    updateRoute();
    routeHint.textContent = 'No reachable exit from this start. Pick another point or choose another map.';
    setStatus('No reachable exit exists from the selected start.', true);
    return;
  }

  selectedGoal = { point: best.region.center_px.map(Number), label: `Exit ${best.index + 1}` };
  exitSelect.value = String(best.region.id);
  updateRoute();
  routeHint.textContent = `Nearest reachable exit selected automatically. Choose another exit to override.`;
  setStatus(`Route ready: ${routeLengthNode.textContent} to ${selectedGoal.label} (selected automatically).`);
}

function pointFromPointer(event) {
  if (!selectionSurface || !mapState) return null;
  const bounds = renderer.domElement.getBoundingClientRect();
  pointer.x = ((event.clientX - bounds.left) / bounds.width) * 2 - 1;
  pointer.y = -((event.clientY - bounds.top) / bounds.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  const hit = raycaster.intersectObject(selectionSurface, false)[0];
  if (!hit) return null;
  const x = hit.point.x / mapState.scale + mapState.cols / 2;
  const y = hit.point.z / mapState.scale + mapState.rows / 2;
  return [x, y];
}

function handleMapSelection(event) {
  if (firePlacementMode) {
    const point = pointFromPointer(event);
    if (point && placeFire(point)) setFirePlacementMode(false);
    return;
  }
  if (personPlacementMode) {
    handlePersonPlacement(event);
    return;
  }
  if (!selectionMode) return;
  const point = pointFromPointer(event);
  if (!point) return;
  const owners = ownerRegions(point);
  if (selectionMode === 'start') {
    if (!owners.length) {
      setStatus('Choose a point inside the walkable navmesh.', true);
      return;
    }
    selectedStart = point;
    finishSelectionMode();
    selectBestExit();
    return;
  }
  const exitRegion = owners.find((region) => region.kind === 'exit');
  if (!exitRegion) {
    setStatus('The destination must be on a green exit region.', true);
    return;
  }
  selectExitRegion(exitRegion);
  finishSelectionMode();
}

function disposeGroup(group) {
  group.traverse((object) => {
    object.geometry?.dispose();
    if (Array.isArray(object.material)) object.material.forEach((item) => item.dispose());
    else if (object.material && !Object.values(materials).includes(object.material)) object.material.dispose();
  });
  scene.remove(group);
}

function resetView(top = false) {
  const { target, distance } = currentFrame;
  controls.target.copy(target);
  if (top) camera.position.set(target.x, distance * 1.45, target.z + 0.001);
  else camera.position.set(target.x + distance * 0.78, distance * 0.68, target.z + distance * 0.82);
  camera.lookAt(target);
  controls.update();
}

function renderModel(model, displayName) {
  const layer = model?.layers?.semantic;
  const matrix = decodeRle(layer);
  const rows = matrix.length;
  const cols = matrix[0].length;
  const scale = 22 / Math.max(rows, cols);
  const wallHeight = Math.max(0.8, Math.min(1.8, 62 * scale));
  const personHeight = wallHeight * 0.95;

  clearSimulation();
  clearFire();
  if (mapGroup) disposeGroup(mapGroup);
  routeGroup = null;
  mapGroup = new THREE.Group();
  scene.add(mapGroup);
  currentModel = model;
  mapState = {
    rows,
    cols,
    scale,
    wallHeight,
    semanticMatrix: matrix,
    personHeight,
    personBaseRadiusPx: 0,
  };
  refreshAgentRadius();
  agentSpatialHash.clear();

  const base = new THREE.Mesh(new THREE.BoxGeometry(cols * scale + 0.6, 0.12, rows * scale + 0.6), materials.ground);
  base.position.y = -0.08;
  base.receiveShadow = true;
  base.userData.selectionSurface = true;
  selectionSurface = base;
  mapGroup.add(base);

  addRectangles(mapGroup, rectanglesForLabel(matrix, 0), rows, cols, scale, 0.08, materials.floor, 0);
  const wallRectangles = rectanglesForLabel(matrix, 1);
  addRectangles(mapGroup, wallRectangles, rows, cols, scale, wallHeight, materials.wall, 0);
  addRectangles(mapGroup, rectanglesForLabel(matrix, 2), rows, cols, scale, 0.08, materials.threshold, 0);
  addRectangles(mapGroup, rectanglesForLabel(matrix, 3), rows, cols, scale, 0.1, materials.exit, 0);
  doors = (model.navmesh?.regions ?? [])
    .filter((region) => (region.kind === 'door' || region.kind === 'exit') && Array.isArray(region.bounds_px))
    .map((region) => doorLayout(region, metersPerPixel(), egressSide(region)));
  mapGroup.add(createDoorMeshes(doors, { toWorld, scale, wallHeight, materials }));
  hazardUniforms.uWallHeight.value = wallHeight;
  fitKeyShadow(cols * scale, rows * scale);
  addRectangles(mapGroup, rectanglesForLabel(matrix, 4), rows, cols, scale, Math.max(0.35, wallHeight * 0.55), materials.obstacle, 0);
  selectedStart = null;
  selectedGoal = null;
  populateExits();
  resetRoutePlanner({ restorePreset: false });

  currentFrame = { target: new THREE.Vector3(0, 0, 0), distance: Math.max(11, Math.hypot(rows * scale, cols * scale) * 0.72) };
  controls.minDistance = Math.max(2.5, currentFrame.distance * 0.14);
  controls.maxDistance = currentFrame.distance * 4;
  resetView(false);

  titleNode.textContent = displayName || model?.source?.file || 'Loaded floor map';
  viewportMapNameNode.textContent = displayName || model?.source?.file || 'Loaded floor map';
  sizeNode.textContent = `${cols} × ${rows} px`;
  zoneNode.textContent = model.zones?.length ?? 0;
  doorNode.textContent = model.doors?.length ?? 0;
  exitNode.textContent = model.exits?.length ?? 0;
  renderValidationHealth(model);
  agentsDirty = true;
  requestRender();
  setStatus(`Rendered ${wallRectangles.length} wall sections. Pick a start and exit to calculate another route.`);
}

async function loadFile(file) {
  if (!file) return;
  try {
    setStatus(`Loading ${file.name}...`);
    renderModel(JSON.parse(await file.text()), file.name);
  } catch (error) {
    console.error(error);
    setStatus(error instanceof Error ? error.message : 'Could not load this JSON file.', true);
  }
}

function syncModeIndicator({ animate = true } = {}) {
  if (!modeNav || !modeIndicator) return;
  const activeButton = document.body.dataset.mode === 'simulate' ? simulateModeButton : inspectModeButton;
  if (!activeButton) return;
  const navBounds = modeNav.getBoundingClientRect();
  const buttonBounds = activeButton.getBoundingClientRect();
  if (!buttonBounds.width) return;
  const x = buttonBounds.left - navBounds.left;
  gsap.killTweensOf(modeIndicator);
  gsap.set(modeIndicator, { width: buttonBounds.width });
  if (!animate || reducedMotion) {
    gsap.set(modeIndicator, { x });
    return;
  }
  gsap.to(modeIndicator, { x, duration: 0.16, ease: 'power2.out', overwrite: 'auto' });
}

function switchMode(mode) {
  const simulate = mode === 'simulate';
  if (personPlacementMode) setPersonPlacementMode(false);
  document.body.dataset.mode = simulate ? 'simulate' : 'inspect';
  inspectModeButton.classList.toggle('is-active', !simulate);
  simulateModeButton.classList.toggle('is-active', simulate);
  inspectModeButton.setAttribute('aria-selected', String(!simulate));
  simulateModeButton.setAttribute('aria-selected', String(simulate));
  inspectPanel.hidden = simulate;
  simulatePanel.hidden = !simulate;
  setDrawerOpen(inspectPanel, false, inspectDrawerToggle, { animate: false });
  setDrawerOpen(simulatePanel, false, simulationMoreButton, { animate: false });
  syncModeIndicator();
  updateRouteVisibility();
  const activeDrawer = simulate ? simulatePanel : inspectPanel;
  if (activeDrawer) activeDrawer.scrollTop = 0;
  if (simulate) setStatus(agents.length ? 'Simulation ready. Press Play when you are ready.' : 'Simulation ready. Place a person or populate rooms.');
  else setStatus('Inspect mode active. Pick a start and exit to calculate a custom route.');
  requestAnimationFrame(resize);
}

function setDrawerOpen(drawer, open, trigger = null, { animate = true } = {}) {
  if (!drawer) return;
  trigger?.setAttribute('aria-expanded', String(open));
  drawer.setAttribute('aria-hidden', String(!open));
  gsap.killTweensOf(drawer);
  const offset = drawer.classList.contains('sim-drawer') ? 14 : -14;
  gsap.set(drawer, { transformOrigin: drawer.classList.contains('sim-drawer') ? 'right top' : 'left top' });

  if (open) {
    drawer.hidden = false;
    drawer.classList.remove('is-closed');
    if (!animate || reducedMotion) {
      gsap.set(drawer, { x: 0, autoAlpha: 1 });
      return;
    }
    gsap.set(drawer, { x: offset, autoAlpha: 0 });
    gsap.to(drawer, { x: 0, autoAlpha: 1, duration: 0.16, ease: 'power2.out', overwrite: 'auto' });
    return;
  }

  if (!animate || reducedMotion || drawer.hidden || drawer.classList.contains('is-closed')) {
    drawer.classList.add('is-closed');
    gsap.set(drawer, { x: 0, autoAlpha: 0 });
    return;
  }
  drawer.classList.remove('is-closed');
  gsap.to(drawer, {
    x: offset,
    autoAlpha: 0,
    duration: 0.12,
    ease: 'power2.in',
    overwrite: 'auto',
    onComplete: () => {
      drawer.classList.add('is-closed');
      gsap.set(drawer, { x: 0 });
    },
  });
}

function bindPersonDragSource(button) {
  if (!button) return;
  button.addEventListener('dragstart', (event) => {
    event.dataTransfer?.setData('application/x-sentinel-person', 'person');
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'copy';
    personDragActive = true;
    controls.enabled = false;
    viewport.classList.add('dragging');
    placementHintNode.hidden = false;
  });
  button.addEventListener('dragend', () => {
    personDragActive = false;
    viewport.classList.remove('dragging');
    placementHintNode.hidden = !personPlacementMode;
    controls.enabled = !personPlacementMode && !selectionMode;
  });
}

fileInput.addEventListener('change', () => loadFile(fileInput.files?.[0]));
inspectModeButton.addEventListener('click', () => switchMode('inspect'));
simulateModeButton.addEventListener('click', () => switchMode('simulate'));
inspectDrawerToggle?.addEventListener('click', () => {
  const open = inspectDrawerToggle.getAttribute('aria-expanded') !== 'true';
  setDrawerOpen(inspectPanel, open, inspectDrawerToggle);
});
inspectDrawerClose?.addEventListener('click', () => setDrawerOpen(inspectPanel, false, inspectDrawerToggle));
simulationMoreButton?.addEventListener('click', () => {
  const open = simulationMoreButton.getAttribute('aria-expanded') !== 'true';
  setDrawerOpen(simulatePanel, open, simulationMoreButton);
});
simulationMoreClose?.addEventListener('click', () => setDrawerOpen(simulatePanel, false, simulationMoreButton));
document.querySelector('#reset-view').addEventListener('click', () => resetView(false));
document.querySelector('#top-view').addEventListener('click', () => resetView(true));
pickStartButton.addEventListener('click', () => beginSelectionMode('start'));
pickGoalButton.addEventListener('click', () => beginSelectionMode('goal'));
cancelPickButton.addEventListener('click', () => {
  finishSelectionMode();
  routeHint.textContent = 'Selection cancelled.';
  setStatus('Selection cancelled.');
});
clearRouteButton.addEventListener('click', () => {
  resetRoutePlanner({ restorePreset: false });
  setStatus('Custom route cleared.');
});
exitSelect.addEventListener('change', () => {
  const region = (currentModel?.navmesh?.regions ?? []).find((item) => String(item.id) === exitSelect.value && item.kind === 'exit');
  if (region) selectExitRegion(region);
  else {
    selectedGoal = null;
    updateRoute();
  }
});

personSourceButton?.addEventListener('click', () => setPersonPlacementMode(!personPlacementMode));
toolbarPersonButton?.addEventListener('click', () => setPersonPlacementMode(!personPlacementMode));
populateRoomsButton.addEventListener('click', populateRooms);
crowdPerRoomSelect.addEventListener('change', () => {
  crowdPerRoom = Number(crowdPerRoomSelect.value) || 3;
  setStatus(`Population set to ${crowdPerRoom} people per room.`);
});
personSizeInput?.addEventListener('input', () => updatePersonSize(personSizeInput.value));
showSimulationRoutesInput?.addEventListener('change', () => {
  showSimulationRoutes = showSimulationRoutesInput.checked;
  updateRouteVisibility();
  setStatus(showSimulationRoutes ? 'Debug routes shown in simulation.' : 'Debug routes hidden in simulation.');
});
simulationPlayButton?.addEventListener('click', () => setSimulationRunning(!simulationRunning));
toolbarPlayButton?.addEventListener('click', () => setSimulationRunning(!simulationRunning));
simulationResetButton?.addEventListener('click', () => clearSimulation({ announce: true }));
toolbarResetButton?.addEventListener('click', () => clearSimulation({ announce: true }));
speedButtons.forEach((button) => button.addEventListener('click', () => {
  simulationSpeed = Number(button.dataset.speed) || 1;
  speedButtons.forEach((item) => item.classList.toggle('is-selected', item === button));
  setStatus(`Playback speed set to ${simulationSpeed}×.`);
}));
toolbarFireButton?.addEventListener('click', () => setFirePlacementMode(!firePlacementMode));
clearFireButton?.addEventListener('click', () => clearFire({ announce: true }));
fireInitialSelect?.addEventListener('change', () => {
  fireInitialKw = Number(fireInitialSelect.value) || 500;
  if (fireScenario) {
    rebuildFireScenario(fireScenario.originPoint, fireScenario.originRegionId);
    updateSmokeOverlay();
    updateFireReadout();
  }
  setStatus(`Initial fire size set to ${fireInitialKw} kW.`);
});
fireGrowthSelect?.addEventListener('change', () => {
  fireGrowth = FIRE_GROWTH[fireGrowthSelect.value] ? fireGrowthSelect.value : 'medium';
  if (fireScenario) {
    rebuildFireScenario(fireScenario.originPoint, fireScenario.originRegionId);
    updateSmokeOverlay();
    updateFireReadout();
  }
  setStatus(`Fire growth set to ${FIRE_GROWTH[fireGrowth].label}.`);
});
bindPersonDragSource(personSourceButton);
bindPersonDragSource(toolbarPersonButton);
updatePersonSize();
syncModeIndicator({ animate: false });
window.addEventListener('resize', () => syncModeIndicator({ animate: false }));

renderer.domElement.addEventListener('pointerdown', (event) => {
  pointerDown = [event.clientX, event.clientY];
});
renderer.domElement.addEventListener('pointerup', (event) => {
  if (!pointerDown) return;
  const moved = Math.hypot(event.clientX - pointerDown[0], event.clientY - pointerDown[1]);
  pointerDown = null;
  if (moved <= 5) handleMapSelection(event);
});
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && firePlacementMode) {
    setFirePlacementMode(false);
    setStatus('Fire placement cancelled.');
    return;
  }
  if (event.key === 'Escape' && personPlacementMode) {
    setPersonPlacementMode(false);
    setStatus('Person placement cancelled.');
    return;
  }
  if (event.key === 'Escape' && selectionMode) {
    finishSelectionMode();
    routeHint.textContent = 'Selection cancelled.';
    setStatus('Selection cancelled.');
  }
});

for (const eventName of ['dragenter', 'dragover']) {
  viewport.addEventListener(eventName, (event) => {
    event.preventDefault();
    viewport.classList.add('dragging');
    if (event.dataTransfer?.types.includes('application/x-sentinel-person')) {
      event.dataTransfer.dropEffect = 'copy';
      placementHintNode.hidden = false;
      dropHintLabelNode.textContent = 'Drop person on walkable floor';
    } else if (event.dataTransfer?.types.includes('Files')) {
      dropHintLabelNode.textContent = 'Drop floor-map JSON to load';
    }
  });
}
viewport.addEventListener('dragleave', (event) => {
  if (event.relatedTarget && viewport.contains(event.relatedTarget)) return;
  viewport.classList.remove('dragging');
  placementHintNode.hidden = !personPlacementMode;
  dropHintLabelNode.textContent = 'Drop person on walkable floor';
});
for (const eventName of ['drop']) {
  viewport.addEventListener(eventName, (event) => {
    event.preventDefault();
    viewport.classList.remove('dragging');
    dropHintLabelNode.textContent = 'Drop person on walkable floor';
  });
}
viewport.addEventListener('drop', (event) => {
  const isPerson = event.dataTransfer?.types.includes('application/x-sentinel-person');
  personDragActive = false;
  placementHintNode.hidden = !personPlacementMode;
  controls.enabled = !personPlacementMode && !selectionMode;
  if (isPerson) {
    const point = pointFromPointer(event);
    if (!point) {
      setStatus('Could not place the person there. Drop on the visible floor surface.', true);
      return;
    }
    spawnAgent(point, 'drag');
    return;
  }
  loadFile(event.dataTransfer?.files?.[0]);
});

function resize() {
  const width = Math.max(1, viewport.clientWidth);
  const height = Math.max(1, viewport.clientHeight);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  renderer.setSize(width, height, false);
  composer.setPixelRatio(renderer.getPixelRatio());
  composer.setSize(width, height);
  fireVisual?.effect.setPixelScale(particlePixelScale());
  requestRender();
}
new ResizeObserver(resize).observe(viewport);
resize();

// Most UI actions change the scene; render once after any of them instead of
// tracking every call site. The canvas is idle otherwise.
for (const eventName of ['click', 'change', 'input', 'keydown', 'drop', 'pointerup']) {
  document.addEventListener(eventName, requestRender, { capture: true });
}

function applyQuality() {
  const level = QUALITY_LEVELS[quality.level];
  renderer.setPixelRatio(level.pixelRatio);
  fireVisual?.effect.setBudget(level.particles);
  keyLight.castShadow = level.keyShadow;
  if (fireVisual) fireVisual.light.castShadow = level.fireShadow;
  applySmokeLayerQuality();
  resize();
}

/** Show every smoke layer, or every other one on slower machines. */
function applySmokeLayerQuality() {
  if (!fireVisual) return;
  const step = QUALITY_LEVELS[quality.level].smokeLayerStep;
  fireVisual.smokeLayers.forEach((layer, index) => { layer.visible = index % step === 0; });
}

/**
 * Step the render quality down after about a second below ~40 fps, and back
 * up after a few seconds above ~55 fps. Only continuous animation counts.
 */
function updateQuality(frameSeconds) {
  if (fixedQuality >= 0) return;
  quality.average += (frameSeconds - quality.average) * 0.1;
  if (quality.average > 1 / 40) {
    quality.slowFor += frameSeconds;
    quality.fastFor = 0;
  } else if (quality.average < 1 / 55) {
    quality.fastFor += frameSeconds;
    quality.slowFor = 0;
  }
  if (quality.slowFor > 1 && quality.level < QUALITY_LEVELS.length - 1) {
    quality.level += 1;
    quality.slowFor = 0;
    applyQuality();
  } else if (quality.fastFor > 4 && quality.level > 0) {
    quality.level -= 1;
    quality.fastFor = 0;
    applyQuality();
  }
}

function renderFrame(timestamp) {
  simulationTimer.update(timestamp);
  const rawDelta = simulationTimer.getDelta();
  const delta = Math.min(rawDelta, 0.1);
  if (simulationRunning) updateQuality(rawDelta);
  // Fast playback runs several fixed steps so people cannot skip past each
  // other or through thin walls.
  for (let remaining = delta * simulationSpeed; simulationRunning && remaining > 1e-6; remaining -= SIMULATION_STEP) {
    updateSimulation(Math.min(SIMULATION_STEP, remaining));
  }
  if (simulationRunning && fireVisual) animateFire(delta);
  // Doors still close after the simulation has stopped or been paused.
  if (!simulationRunning) updateDoors(delta);
  if (hazardDirty && timestamp - lastHazardUpload >= 100) updateSmokeOverlay();
  if (agentsDirty) syncAgentInstances();
  if (controls.update()) renderRequested = true;
  if (!renderRequested) return;
  renderRequested = false;
  // Bloom makes flames and signs glow; it is only worth its cost with a fire.
  if (fireVisual && QUALITY_LEVELS[quality.level].bloom) composer.render();
  else renderer.render(scene, camera);
}

function handleVisibilityChange() {
  if (document.hidden) {
    renderer.setAnimationLoop(null);
  } else {
    renderer.setAnimationLoop(renderFrame);
  }
}

document.addEventListener('visibilitychange', handleVisibilityChange);

// Test hook for the development server only (not in production builds).
if (import.meta.env.DEV) {
  window.sentinelDebug = {
    camera,
    controls,
    toWorld,
    placeFire,
    get agents() { return agents; },
    get doors() { return doors; },
    get fireScenario() { return fireScenario; },
    get elapsed() { return simulationElapsed; },
    get quality() { return quality.level; },
  };
}
renderer.setAnimationLoop(renderFrame);

fetch('/sample.json')
  .then((response) => {
    if (!response.ok) throw new Error('Sample JSON is unavailable.');
    return response.json();
  })
  .then((model) => renderModel(model, 'floor_plan_02_rooms_corridor'))
  .catch((error) => setStatus(`${error.message} Open a generated floor-map JSON to continue.`, true));
