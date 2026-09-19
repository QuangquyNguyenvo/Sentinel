import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
  Box,
  Building2,
  ChartLine,
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

createIcons({
  icons: {
    Box,
    Building2,
    ChartLine,
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
const inspectPanel = document.querySelector('#inspect-panel');
const simulatePanel = document.querySelector('#simulate-panel');
const personSourceButton = document.querySelector('#person-source');
const toolbarPersonButton = document.querySelector('#toolbar-person');
const populateRoomsButton = document.querySelector('#populate-rooms');
const crowdPerRoomSelect = document.querySelector('#crowd-per-room');
const personSizeInput = document.querySelector('#person-size');
const personSizeOutput = document.querySelector('#person-size-output');
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
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
renderer.shadowMap.enabled = false;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.domElement.tabIndex = 0;
renderer.domElement.setAttribute('role', 'img');
renderer.domElement.setAttribute('aria-label', 'Interactive 3D floor map. Drag to rotate, scroll to zoom, and right drag to pan.');
viewport.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.075;
controls.maxPolarAngle = Math.PI / 2.03;
controls.minDistance = 4;
controls.maxDistance = 80;

scene.add(new THREE.HemisphereLight(0xbfd8ff, 0x17202d, 1.65));
const keyLight = new THREE.DirectionalLight(0xffffff, 2.15);
keyLight.position.set(-8, 15, 7);
keyLight.castShadow = false;
scene.add(keyLight);

const materials = {
  floor: new THREE.MeshStandardMaterial({ color: 0x738398, roughness: 0.88, metalness: 0.04 }),
  wall: new THREE.MeshStandardMaterial({ color: 0xdde3ec, roughness: 0.72, metalness: 0.02 }),
  door: new THREE.MeshStandardMaterial({ color: 0x2563eb, roughness: 0.62, metalness: 0.08 }),
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
let agentGroup = null;
let agents = [];
let agentSequence = 0;
const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
const simulationClock = new THREE.Clock();
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();

function setStatus(message, isError = false) {
  statusNode.textContent = message;
  statusNode.classList.toggle('error', isError);
}

function formatSimulationTime(seconds) {
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds - minutes * 60;
  return `${String(minutes).padStart(2, '0')}:${remainder.toFixed(1).padStart(4, '0')}`;
}

function simulationCounts() {
  const total = agents.length;
  const evacuated = agents.filter((agent) => agent.status === 'evacuated').length;
  const noRoute = agents.filter((agent) => agent.status === 'no_route').length;
  const moving = total - evacuated - noRoute;
  return { total, moving, evacuated, noRoute };
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

function updateSimulationMetrics() {
  const counts = simulationCounts();
  const values = [
    [simTotalNode, counts.total], [simMovingNode, counts.moving], [simEvacuatedNode, counts.evacuated], [simNoRouteNode, counts.noRoute],
    [hudTotalNode, counts.total], [hudMovingNode, counts.moving], [hudEvacuatedNode, counts.evacuated], [hudNoRouteNode, counts.noRoute],
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

function toWorld([x, y]) {
  const { rows, cols, scale } = mapState;
  return new THREE.Vector3((x - cols / 2) * scale, 0.15, (y - rows / 2) * scale);
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

function disposeAgentGroup() {
  if (!agentGroup) return;
  agentGroup.traverse((object) => {
    object.geometry?.dispose();
    if (Array.isArray(object.material)) object.material.forEach((item) => item.dispose());
    else object.material?.dispose();
  });
  mapGroup?.remove(agentGroup);
  agentGroup = null;
}

function markerColor(status) {
  if (status === 'evacuated') return 0x34d399;
  if (status === 'no_route') return 0xfb7185;
  if (status === 'moving') return 0xfbbf24;
  return 0x63e1ed;
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
  for (const agent of agents) agent.marker?.scale.setScalar(personSize);
}

function createAgentMarker(agent) {
  const group = new THREE.Group();
  const radius = Math.max(0.07, mapState.scale * 3.8);
  const color = markerColor(agent.status);
  const material = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.34, roughness: 0.48, metalness: 0.05 });
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(radius * 0.42, radius * 1.22, 5, 10), material);
  body.position.y = radius * 1.05;
  body.castShadow = true;
  body.userData.agentBody = true;
  const head = new THREE.Mesh(new THREE.SphereGeometry(radius * 0.38, 12, 8), material.clone());
  head.position.y = radius * 2.22;
  head.castShadow = true;
  head.userData.agentHead = true;
  const halo = new THREE.Mesh(new THREE.TorusGeometry(radius * 1.03, Math.max(radius * 0.1, 0.018), 8, 20), material.clone());
  halo.rotation.x = Math.PI / 2;
  halo.position.y = radius * 0.12;
  halo.userData.agentHalo = true;
  group.add(body, head, halo);
  const world = toWorld(agent.point);
  group.position.set(world.x, 0.13, world.z);
  group.scale.setScalar(personSize);
  group.userData.agentId = agent.id;
  agent.marker = group;
  agent.materials = [body.material, head.material, halo.material];
  agentGroup.add(group);
}

function updateAgentMarker(agent) {
  if (!agent.marker) return;
  const color = markerColor(agent.status);
  agent.materials?.forEach((material) => {
    material.color.setHex(color);
    material.emissive.setHex(color);
  });
}

function updateAgentPosition(agent, point) {
  agent.point = point;
  if (!agent.marker) return;
  const world = toWorld(point);
  agent.marker.position.set(world.x, 0.13, world.z);
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
  return { points, lengths, total };
}

function pointAlongAgentRoute(agent) {
  const route = agent.route;
  if (!route) return agent.point;
  if (agent.segmentIndex >= route.lengths.length) return route.points.at(-1);
  const start = route.points[agent.segmentIndex];
  const end = route.points[agent.segmentIndex + 1];
  const length = route.lengths[agent.segmentIndex] || 1;
  const t = Math.min(1, Math.max(0, agent.segmentOffset / length));
  return [start[0] + (end[0] - start[0]) * t, start[1] + (end[1] - start[1]) * t];
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
  agents = [];
  agentSequence = 0;
  disposeAgentGroup();
  updatePlayControls();
  setSimulationState('ready');
  updateSimulationMetrics();
  if (announce) setStatus('Simulation reset. Place people or populate rooms to begin.');
}

function ensureAgentGroup() {
  if (agentGroup || !mapGroup) return;
  agentGroup = new THREE.Group();
  agentGroup.name = 'simulation-agents';
  mapGroup.add(agentGroup);
}

function spawnAgent(point, source = 'manual') {
  if (!mapState || !currentModel) {
    setStatus('Load a floor-map JSON before placing a person.', true);
    return null;
  }
  const owners = ownerRegions(point);
  if (!owners.length || !owners.some((region) => ['floor', 'door', 'exit'].includes(region.kind))) {
    setStatus('Invalid placement. Choose a point inside the walkable navmesh.', true);
    return null;
  }
  const exitRegions = (currentModel.navmesh?.regions ?? []).filter((region) => region.kind === 'exit' && Array.isArray(region.center_px));
  const candidates = exitRegions.map((region) => ({ region, route: computeRoute(point, region.center_px.map(Number)) }))
    .filter(({ route }) => route.status === 'ok' && Number.isFinite(route.length_px));
  const nearest = candidates.reduce((best, candidate) => (!best || candidate.route.length_px < best.route.length_px ? candidate : best), null);
  const route = nearest?.route ?? { status: 'unreachable', polyline_px: [] };
  const agent = { id: `person_${++agentSequence}`, point: [Number(point[0]), Number(point[1])], route: makeAgentRoute(route), routePolylinePx: route.polyline_px ?? [], routeResult: route, routeLengthPx: Number.isFinite(route.length_px) ? route.length_px : null, routeLengthM: Number.isFinite(route.length_m) ? route.length_m : null, status: route.status === 'ok' ? 'ready' : 'no_route', segmentIndex: 0, segmentOffset: 0, speedPx: 88 };
  ensureAgentGroup();
  agents.push(agent);
  createAgentMarker(agent);
  if (simulationRunning) simulationRunning = false;
  updatePlayControls();
  setSimulationState('ready');
  setStatus(agent.status === 'no_route' ? 'Person placed, but no reachable exit was found.' : `Person placed with a ${route.length_px.toFixed(1)} px route to the nearest exit.`);
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
  if (running && !agents.length) {
    setStatus('Place at least one person before starting the simulation.', true);
    setSimulationState('ready');
    return;
  }
  const counts = simulationCounts();
  if (running && counts.moving === 0) {
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

function updateSimulation(delta) {
  if (!simulationRunning || !agents.length) return;
  simulationElapsed += delta * simulationSpeed;
  const distancePerFrame = 88 * delta * simulationSpeed;
  for (const agent of agents) {
    if (agent.status === 'evacuated' || agent.status === 'no_route' || !agent.route) continue;
    agent.status = 'moving';
    let remaining = distancePerFrame;
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
    if (agent.segmentIndex >= agent.route.lengths.length) {
      agent.status = 'evacuated';
      updateAgentPosition(agent, agent.route.points.at(-1));
    } else updateAgentPosition(agent, pointAlongAgentRoute(agent));
    updateAgentMarker(agent);
  }
  updateSimulationMetrics();
  const counts = simulationCounts();
  if (counts.moving === 0) {
    simulationRunning = false;
    updatePlayControls();
    setSimulationState('complete');
    setStatus(`Simulation complete. ${counts.evacuated} evacuated; ${counts.noRoute} without a route.`);
  }
}

function setPersonPlacementMode(active) {
  personPlacementMode = active;
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

function computeRoute(start, goal) {
  const mesh = currentModel?.navmesh;
  const graph = currentModel?.routing_graph;
  if (!mesh?.regions?.length || !graph?.nodes || !graph?.edges) {
    return { status: 'invalid_graph', polyline_px: [] };
  }
  const startOwners = ownerRegions(start);
  const goalOwners = ownerRegions(goal);
  if (!startOwners.length || !goalOwners.length) return { status: 'outside_navmesh', polyline_px: [] };

  const positions = new Map(graph.nodes.map((node) => [node.id, node.position_px]));
  const adjacency = new Map(graph.nodes.map((node) => [node.id, []]));
  const membership = new Map(mesh.regions.map((region) => [region.id, []]));
  for (const node of graph.nodes) {
    for (const regionId of node.region_ids) membership.get(regionId)?.push(node.id);
  }
  const connect = (a, b, regionId, length) => {
    if (!adjacency.has(a)) adjacency.set(a, []);
    if (!adjacency.has(b)) adjacency.set(b, []);
    adjacency.get(a).push({ node: b, length, regionId });
    adjacency.get(b).push({ node: a, length, regionId });
  };
  for (const edge of graph.edges) connect(edge.source, edge.target, edge.region_id, edge.length_px);

  const attachEndpoint = (id, point, owners) => {
    positions.set(id, point);
    adjacency.set(id, []);
    for (const region of owners) {
      const local = membership.get(region.id) ?? [];
      for (const other of local) connect(id, other, region.id, pointDistance(point, positions.get(other)));
      local.push(id);
      membership.set(region.id, local);
    }
  };
  attachEndpoint('__start', start, startOwners);
  attachEndpoint('__goal', goal, goalOwners);

  const distances = new Map([['__start', 0]]);
  const previous = new Map();
  const queue = [[0, '__start']];
  const pushQueue = (entry) => {
    queue.push(entry);
    let index = queue.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (queue[parent][0] <= entry[0]) break;
      queue[index] = queue[parent];
      index = parent;
    }
    queue[index] = entry;
  };
  const popQueue = () => {
    const first = queue[0];
    const last = queue.pop();
    if (queue.length && last) {
      let index = 0;
      while (true) {
        const left = index * 2 + 1;
        const right = left + 1;
        if (left >= queue.length) break;
        const child = right < queue.length && queue[right][0] < queue[left][0] ? right : left;
        if (queue[child][0] >= last[0]) break;
        queue[index] = queue[child];
        index = child;
      }
      queue[index] = last;
    }
    return first;
  };
  while (queue.length) {
    const [best, current] = popQueue();
    if (best !== distances.get(current)) continue;
    if (current === '__goal') break;
    for (const edge of adjacency.get(current) ?? []) {
      const candidate = best + edge.length;
      if (candidate < (distances.get(edge.node) ?? Infinity)) {
        distances.set(edge.node, candidate);
        previous.set(edge.node, { node: current, regionId: edge.regionId });
        pushQueue([candidate, edge.node]);
      }
    }
  }
  if (!distances.has('__goal')) return { status: 'unreachable', polyline_px: [] };

  const path = ['__goal'];
  const regionIds = [];
  while (path.at(-1) !== '__start') {
    const step = previous.get(path.at(-1));
    if (!step) return { status: 'unreachable', polyline_px: [] };
    regionIds.push(step.regionId);
    path.push(step.node);
  }
  path.reverse();
  regionIds.reverse();
  const lengthPx = distances.get('__goal');
  const scale = mesh.meters_per_pixel;
  return {
    status: 'ok',
    algorithm: 'dijkstra',
    polyline_px: path.map((id) => positions.get(id)),
    region_ids: regionIds,
    length_px: lengthPx,
    length_m: scale == null ? null : lengthPx * scale,
  };
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
  routeHint.textContent = 'Custom route calculated with Dijkstra on the JSON routing graph.';
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

  clearSimulation();
  if (mapGroup) disposeGroup(mapGroup);
  routeGroup = null;
  mapGroup = new THREE.Group();
  scene.add(mapGroup);
  currentModel = model;
  mapState = { rows, cols, scale };

  const base = new THREE.Mesh(
    new THREE.BoxGeometry(cols * scale + 0.6, 0.12, rows * scale + 0.6),
    new THREE.MeshStandardMaterial({ color: 0x182435, roughness: 0.95 }),
  );
  base.position.y = -0.08;
  base.receiveShadow = true;
  base.userData.selectionSurface = true;
  selectionSurface = base;
  mapGroup.add(base);

  addRectangles(mapGroup, rectanglesForLabel(matrix, 0), rows, cols, scale, 0.08, materials.floor, 0);
  addRectangles(mapGroup, rectanglesForLabel(matrix, 1), rows, cols, scale, wallHeight, materials.wall, 0);
  addRectangles(mapGroup, rectanglesForLabel(matrix, 2), rows, cols, scale, 0.18, materials.door, 0);
  addRectangles(mapGroup, rectanglesForLabel(matrix, 3), rows, cols, scale, 0.22, materials.exit, 0);
  addRectangles(mapGroup, rectanglesForLabel(matrix, 4), rows, cols, scale, Math.max(0.35, wallHeight * 0.55), materials.obstacle, 0);
  selectedStart = null;
  selectedGoal = null;
  populateExits();
  resetRoutePlanner({ restorePreset: true });

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
  setStatus(`Rendered ${rectanglesForLabel(matrix, 1).length} wall sections. Pick a start and exit to calculate another route.`);
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
  setDrawerOpen(inspectPanel, false, inspectDrawerToggle);
  setDrawerOpen(simulatePanel, false, simulationMoreButton);
  const activeDrawer = simulate ? simulatePanel : inspectPanel;
  if (activeDrawer) activeDrawer.scrollTop = 0;
  if (simulate) setStatus(agents.length ? 'Simulation ready. Press Play when you are ready.' : 'Simulation ready. Place a person or populate rooms.');
  else setStatus('Inspect mode active. Pick a start and exit to calculate a custom route.');
  requestAnimationFrame(resize);
}

function setDrawerOpen(drawer, open, trigger = null) {
  if (!drawer) return;
  drawer.classList.toggle('is-closed', !open);
  trigger?.setAttribute('aria-expanded', String(open));
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
  const open = inspectPanel.classList.contains('is-closed');
  setDrawerOpen(inspectPanel, open, inspectDrawerToggle);
});
inspectDrawerClose?.addEventListener('click', () => setDrawerOpen(inspectPanel, false, inspectDrawerToggle));
simulationMoreButton?.addEventListener('click', () => {
  const open = simulatePanel.classList.contains('is-closed');
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
simulationPlayButton?.addEventListener('click', () => setSimulationRunning(!simulationRunning));
toolbarPlayButton?.addEventListener('click', () => setSimulationRunning(!simulationRunning));
simulationResetButton?.addEventListener('click', () => clearSimulation({ announce: true }));
toolbarResetButton?.addEventListener('click', () => clearSimulation({ announce: true }));
speedButtons.forEach((button) => button.addEventListener('click', () => {
  simulationSpeed = Number(button.dataset.speed) || 1;
  speedButtons.forEach((item) => item.classList.toggle('is-selected', item === button));
  setStatus(`Playback speed set to ${simulationSpeed}×.`);
}));
bindPersonDragSource(personSourceButton);
bindPersonDragSource(toolbarPersonButton);
updatePersonSize();

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
}
new ResizeObserver(resize).observe(viewport);
resize();

renderer.setAnimationLoop(() => {
  const delta = Math.min(simulationClock.getDelta(), 0.1);
  updateSimulation(delta);
  controls.update();
  renderer.render(scene, camera);
});

fetch('/sample.json')
  .then((response) => {
    if (!response.ok) throw new Error('Sample JSON is unavailable.');
    return response.json();
  })
  .then((model) => renderModel(model, 'floor_plan_02_rooms_corridor'))
  .catch((error) => setStatus(`${error.message} Open a generated floor-map JSON to continue.`, true));
