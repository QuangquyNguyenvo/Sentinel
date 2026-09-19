# Sentinel

Sentinel converts color coded floor plan images into semantic maps, rectangular navigation meshes, routing graphs, and preview images.

The project applies Discrete Mathematics and Graph Theory to floor plan representation and pathfinding.

## Requirements

- Python 3.10 or newer
- NumPy
- OpenCV

Install the dependencies:

```bash
pip install numpy opencv-python
```

## Usage

Run the application and select a floor plan image:

```bash
python run.py
```

The generated files are saved beside the selected image:

- `<name>.floor-map.json`
- `<name>.graph-preview.png`

Specify an output directory:

```bash
python run.py floor-plan.png --output-dir output
```

## Floor Plan Colors

- White: floor
- Dark gray: wall
- Blue: door
- Green: exit
- Red: obstacle

## Tests

```bash
python -B -m unittest discover -s tests -v
```

## 3D Viewer

Run the interactive Three.js prototype:

```bash
cd viewer
npm install
npm test
npm run build
npm run dev
```

The viewer loads the included sample or a generated `floor-map.json` file. Pick a start point and an exit to calculate a new route in the browser.

## Fire, smoke, and evacuation simulation

The viewer's hazard mode is a visualization and route-ranking aid. Its assumptions and limits are:

- There is no fixed universal flashover threshold. The fixed 1,055 kW value is a fire-growth reference only, not a flashover prediction.
- Each semantic cell has uniform fuel and a finite burn duration. Spread is accelerated for visualization, so ignition, smoke-arrival, and burn-out times remain heuristic.
- Fire propagation follows semantic pixel topology with a simplified radiant line-of-sight check; it does not simulate full heat transfer, compartment fire dynamics, or fluid flow.
- The default scenario keeps doors open for hazard propagation. Animated door positions affect pedestrian motion but are not coupled to hazard propagation.
- Smoke is represented as a breathing-height layer with a configurable clearance heuristic. This is not a ventilation or tenability simulation; smoke reduces visibility and movement speed in the viewer.
- Routes can include hazard weights and blocked regions, but they are graph routes and provide no safe-route guarantee.
- Thermal exposure can incapacitate a person in the model. Optical smoke affects visibility and movement speed only; toxic gases are not modeled, and a collapsed state is not a death prediction.
- Maps without a real-world scale use 5 cm/px. Use a calibrated scale and obtain independent fire, smoke, and evacuation validation before using the viewer for safety decisions.

## Graph validation

Every generated JSON file includes a `graph_validation` report. It is computed
after the semantic map, navmesh, space graph, and routing graph have been
assembled, and is also shown in the 3D viewer's **Graph health** card.

The validator checks that:

- floor regions can reach an exit through the navmesh;
- each source door connects exactly two known floor zones;
- exits touch a walkable region;
- navmesh regions and routing nodes are not isolated unexpectedly;
- portals and routing edges contain no duplicates or self-loops;
- portals have positive width;
- region bounds do not overlap, and every walkable semantic pixel is covered
  exactly once;
- every walkable navmesh region participates in the routing graph.

The report contains five summary metrics: `region_count`, `portal_count`,
`connected_component_count`, `reachable_exit_count`, and
`isolated_region_count`. `status` is `valid` when no issue is present,
`warning` when the graph is structurally valid but has reachability/topology
anomalies, and `error` when a structural invariant is broken. Each issue has
a stable machine-readable `code`, a `severity`, a message, and relevant
object/region/node ids or counts. Older JSON files without this report remain
loadable; the viewer labels their graph health as unavailable.
