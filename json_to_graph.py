"""Build an exact rectangular 2D NavMesh from semantic floor-map JSON.

Pixels are unit squares [x,x+1] x [y,y+1]. Nonoverlapping rectangles cover
every floor/door/exit pixel. Positive-length shared boundaries are portals.
No resizing, skeletonization, route selection, or external geometry library.
Space/door topology is separate from the portal graph used by Dijkstra.
All portal pairs in each convex region are linked. Midpoint sampling is NOT
guaranteed to give continuous shortest-path distances. This models a point agent;
body clearance, hazard costs and crowd capacity are not estimated here.

python -B json_to_graph.py floor_map.json -o graph_preview.png
"""
from __future__ import annotations

import argparse
import heapq
import json
import math
from pathlib import Path
from typing import Any

import cv2
import numpy as np
from image_to_json import (
    FLOOR,
    DOOR,
    EXIT,
    decode_rle_layer,
    find_zones,
    resolve_layer,
)

COLORS = {0: (255, 255, 255), 1: (25, 25, 25), 2: (230, 120, 40),
          3: (80, 190, 40), 4: (50, 60, 220), 255: (235, 235, 235)}


def _labels(model: dict[str, Any]) -> tuple[np.ndarray, np.ndarray, dict]:
    """Preserve zone and connector boundaries during rectangle merging."""
    try:
        semantic = resolve_layer(
            model["layers"]["semantic"],
            name="layers.semantic",
        )
    except KeyError as error:
        raise ValueError("JSON must contain layers.semantic") from error
    if not np.isin(semantic, list(COLORS)).all():
        raise ValueError("Unsupported semantic label")
    layer = model["layers"].get("zone_id")
    zones = (resolve_layer(layer, name="layers.zone_id")
             if layer is not None else find_zones(semantic, None)[0])
    if (zones.shape != semantic.shape or np.any(zones < 0)
            or not np.array_equal(zones > 0, semantic == FLOOR)):
        raise ValueError("zone_id must label exactly the floor pixels")
    labels = np.zeros(semantic.shape, np.int32)
    metadata = {}
    for zid in np.unique(zones[zones > 0]):
        key = len(metadata) + 1
        labels[zones == zid] = key
        metadata[key] = {"kind": "floor", "zone_id": int(zid), "object_id": None}
    for label, kind, collection in ((DOOR, "door", "doors"), (EXIT, "exit", "exits")):
        count, components = cv2.connectedComponents((semantic == label).astype(np.uint8), connectivity=4)
        names = {}
        for item in model.get(collection, []):
            center = item.get("centroid_px", [])
            if len(center) != 2 or not all(isinstance(v, (int, float)) and math.isfinite(v) for v in center):
                raise ValueError(f"Invalid {kind} centroid")
            x, y = map(round, center)
            if 0 <= y < semantic.shape[0] and 0 <= x < semantic.shape[1] and components[y, x]:
                names[int(components[y, x])] = str(item["id"])
        offset = len(metadata)
        labels[components > 0] = components[components > 0] + offset
        for component in range(1, count):
            metadata[offset+component] = {"kind": kind, "zone_id": None,
                                          "object_id": names.get(component, f"{kind}_{component}")}
    return semantic, labels, metadata


def _rectangles(labels: np.ndarray) -> list[list[int]]:
    """Merge identical horizontal runs across consecutive rows.

    Returns [x0,y0,x1,y1,label], right/bottom exclusive. Deterministic exact
    partition, not a globally minimum-rectangle optimization.
    """
    rectangles, active = [], {}
    for y, row in enumerate(labels):
        changes = np.flatnonzero(row[1:] != row[:-1]) + 1
        starts, ends = np.r_[0, changes], np.r_[changes, len(row)]
        following = {}
        for x0, x1 in zip(starts.tolist(), ends.tolist()):
            label = int(row[x0])
            if not label:
                continue
            key = (x0, x1, label)
            index = active.get(key)
            if index is None:
                index = len(rectangles)
                rectangles.append([x0, y, x1, y+1, label])
            else:
                rectangles[index][3] = y+1
            following[key] = index
        active = following
    return rectangles


def _portals(region_ids: np.ndarray) -> list[tuple]:
    """Group boundary contacts without scanning every pair of regions."""
    portals = []
    for axis, a, b in ((0, region_ids[:, :-1], region_ids[:, 1:]),
                       (1, region_ids[:-1, :], region_ids[1:, :])):
        ys, xs = np.nonzero((a > 0) & (b > 0) & (a != b))
        if not len(xs):
            continue
        first, second = a[ys, xs], b[ys, xs]
        lo, hi = np.minimum(first, second), np.maximum(first, second)
        fixed, along = (xs+1, ys) if axis == 0 else (ys+1, xs)
        order = np.lexsort((along, fixed, hi, lo))
        records = np.column_stack((lo, hi, fixed, along))[order].tolist()
        current = None
        for source, target, coordinate, position in records:
            key = (source, target, coordinate)
            if current is not None and (key != current or position != end):
                portals.append((*current, axis, start, end))
                current = None
            if current is None:
                current, start = key, position
            end = position+1
        if current is not None:
            portals.append((*current, axis, start, end))
    return sorted(portals)


def build_navmesh(model: dict[str, Any]) -> dict[str, Any]:
    semantic, labels, metadata = _labels(model)
    scale = model.get("grid", {}).get("meters_per_pixel")
    if scale is not None and (isinstance(scale, bool) or not isinstance(scale, (int, float))
                              or not math.isfinite(scale) or scale <= 0):
        raise ValueError("meters_per_pixel must be finite and positive")
    horizontal = _rectangles(labels)
    vertical = [[y0, x0, y1, x1, label]
                for x0, y0, x1, y1, label in _rectangles(labels.T)]
    axis = "horizontal" if len(horizontal) <= len(vertical) else "vertical"
    rectangles = sorted(horizontal if axis == "horizontal" else vertical,
                        key=lambda r: (r[1], r[0], r[3], r[2]))
    region_ids = np.zeros(labels.shape, np.int32)
    regions = []
    for rid, (x0, y0, x1, y1, label) in enumerate(rectangles, 1):
        region_ids[y0:y1, x0:x1] = rid
        area = (x1-x0)*(y1-y0)
        regions.append({"id": rid, **metadata[label], "bounds_px": [x0, y0, x1, y1],
                        "polygon_px": [[x0, y0], [x1, y0], [x1, y1], [x0, y1]],
                        "center_px": [(x0+x1)/2, (y0+y1)/2], "area_px": area,
                        "area_m2": None if scale is None else area*scale**2, "neighbours": []})
    edges = []
    for source, target, coordinate, direction, start, end in _portals(region_ids):
        portal = ([[coordinate, start], [coordinate, end]] if direction == 0
                  else [[start, coordinate], [end, coordinate]])
        a, b = regions[source-1], regions[target-1]
        edges.append({"id": len(edges)+1, "source": source, "target": target,
                      "portal_px": portal, "width_px": end-start,
                      "width_m": None if scale is None else (end-start)*scale})
        a["neighbours"].append(target)
        b["neighbours"].append(source)
    for region in regions:
        region["neighbours"] = sorted(set(region["neighbours"]))
    return {"schema_version": "navmesh-2", "type": "rectangular_navmesh_2d",
            "directed": False, "coordinate_system": "pixel_corners_top_left",
            "source_shape": list(semantic.shape), "meters_per_pixel": scale,
            "partition_axis": axis, "regions": regions, "edges": edges,
            "walkable_area_px": int(np.count_nonzero(labels)),
            "agent_model": "point"}


def build_graph(model: dict[str, Any]) -> dict[str, Any]:
    """Build the routing graph; build_navmesh() exposes the region geometry."""
    return build_routing_graph(build_navmesh(model))


def build_space_graph(model: dict[str, Any]) -> dict[str, Any]:
    """Semantic topology: floor components are spaces, doors connect spaces."""
    nodes = [{"id": f"space_{z['id']}", "kind": "space", "zone_id": z["id"]}
             for z in model.get("zones", [])]
    known = {n["id"] for n in nodes}
    edges = []
    for collection, kind in (("doors", "door"), ("exits", "exit")):
        for item in model.get(collection, []):
            neighbours = sorted(set(item["neighbour_zones"]))
            spaces = [f"space_{z}" for z in neighbours]
            if any(s not in known for s in spaces):
                raise ValueError(f"{item['id']} refers to an unknown space")
            if len(spaces) == 2 and kind == "door":
                pairs = [(spaces[0], spaces[1])]
            else:
                # Outside endpoints and unusual multi-space connectors are
                # explicit, rather than inventing a room-to-room connection.
                endpoint = f"connector_{item['id']}"
                nodes.append({"id": endpoint, "kind": kind, "object_id": item["id"]})
                pairs = [(s, endpoint) for s in spaces]
            for a, b in pairs:
                edges.append({"source": a, "target": b, "object_id": item["id"], "kind": kind})
    return {"directed": False, "nodes": nodes, "edges": edges}


def build_routing_graph(mesh: dict[str, Any]) -> dict[str, Any]:
    """Portal midpoints are nodes; all pairs in a convex region are linked.

    Every local alternative is retained. No path is forced through a region
    center. Midpoint sampling is an approximation of continuous geometry.
    """
    nodes, edges = [], []
    incident = {r["id"]: [] for r in mesh["regions"]}
    for portal in mesh["edges"]:
        a, b = portal["portal_px"]
        node = {"id": portal["id"], "position_px": [(a[0]+b[0])/2, (a[1]+b[1])/2],
                "region_ids": [portal["source"], portal["target"]]}
        nodes.append(node)
        for rid in node["region_ids"]:
            incident[rid].append(node)
    for rid, local in incident.items():
        for i, a in enumerate(local):
            for b in local[i+1:]:
                edges.append({"source": a["id"], "target": b["id"], "region_id": rid,
                              "length_px": math.dist(a["position_px"], b["position_px"])})
    return {"directed": False, "representation": "portal_midpoints",
            "optimality": "shortest_on_portal_graph_not_continuous_space",
            "nodes": nodes, "edges": edges}


def find_path(mesh: dict[str, Any], start, goals, *, blocked_regions=(),
              region_costs=None, graph=None) -> dict[str, Any]:
    """Dijkstra for a static nonnegative cost snapshot; multiple goals allowed.

    region_costs contains per-pixel cost multipliers, not hazard estimates.
    Blocked regions remove their local edges; other routes remain available.
    Endpoints use pixel-corner coordinates, matching mesh polygons.
    """
    graph = graph if graph is not None else build_routing_graph(mesh)
    regions = {r["id"]: r for r in mesh["regions"]}
    blocked, costs = set(blocked_regions), dict(region_costs or {})
    if not blocked <= regions.keys() or not costs.keys() <= regions.keys():
        raise ValueError("Unknown region in routing constraints")
    if any(isinstance(v, bool) or not isinstance(v, (int, float))
           or not math.isfinite(v) or v < 0 for v in costs.values()):
        raise ValueError("Region costs must be finite and nonnegative")
    positions = {n["id"]: n["position_px"] for n in graph["nodes"]}
    membership = {rid: [] for rid in regions}
    for node in graph["nodes"]:
        for rid in node["region_ids"]:
            membership[rid].append(node["id"])
    adjacency = {nid: [] for nid in positions}

    def connect(a, b, rid, length):
        if rid not in blocked:
            weighted = length*costs.get(rid, 1.0)
            adjacency[a].append((b, weighted, length, rid))
            adjacency[b].append((a, weighted, length, rid))

    for edge in graph["edges"]:
        connect(edge["source"], edge["target"], edge["region_id"], edge["length_px"])
    goals = list(goals)
    if not goals:
        raise ValueError("At least one destination is required")
    for nid, value in zip(range(-1, -len(goals)-2, -1), [start, *goals]):
        if (len(value) != 2 or any(isinstance(v, bool) or not isinstance(v, (int, float))
                                  or not math.isfinite(v) for v in value)):
            raise ValueError("Route endpoints must contain two finite coordinates")
        x, y = map(float, value)
        # Half-open bounds give each endpoint one unambiguous owner. Portals
        # themselves already link both adjacent regions in the static graph.
        owners = [rid for rid, r in regions.items()
                  if r["bounds_px"][0] <= x < r["bounds_px"][2]
                  and r["bounds_px"][1] <= y < r["bounds_px"][3]]
        if not owners:
            raise ValueError(f"Endpoint {(x, y)} is outside walkable space")
        positions[nid], adjacency[nid] = [x, y], []
        for rid in owners:
            for other in membership[rid]:
                connect(nid, other, rid, math.dist(positions[nid], positions[other]))
            membership[rid].append(nid)
    targets = set(range(-2, -len(goals)-2, -1))
    distance, previous, queue = {-1: 0.0}, {}, [(0.0, -1)]
    reached = None
    while queue:
        cost, node = heapq.heappop(queue)
        if cost != distance[node]:
            continue
        if node in targets:
            reached = node
            break
        for other, weight, length, rid in adjacency[node]:
            candidate = cost+weight
            if candidate < distance.get(other, math.inf):
                distance[other] = candidate
                previous[other] = (node, length, rid)
                heapq.heappush(queue, (candidate, other))
    if reached is None:
        return {"status": "unreachable", "algorithm": "dijkstra", "polyline_px": []}
    path, traversed, length = [reached], [], 0.0
    while path[-1] != -1:
        parent, segment_length, rid = previous[path[-1]]
        path.append(parent)
        traversed.append(rid)
        length += segment_length
    scale = mesh["meters_per_pixel"]
    return {"status": "ok", "algorithm": "dijkstra", "goal_index": -reached-2,
            "polyline_px": [positions[n] for n in reversed(path)],
            "region_ids": traversed[::-1], "length_px": length,
            "length_m": None if scale is None else length*scale,
            "cost": distance[reached], "optimality": graph["optimality"]}


def prepare_navigation(model: dict[str, Any], start=None, goal=None) -> None:
    """Attach semantic topology, reusable routing graph and a sample route."""
    mesh = model.get("navmesh") or build_navmesh(model)
    model["navmesh"] = mesh
    model["space_graph"] = build_space_graph(model)
    graph = build_routing_graph(mesh)
    model["routing_graph"] = graph
    if start is None:
        candidates = [r for r in mesh["regions"] if r["kind"] == "door"]
        candidates = candidates or [r for r in mesh["regions"] if r["kind"] == "floor"]
        if not candidates:
            model["route"] = {"status": "no_start", "polyline_px": []}
            return
        start = candidates[0]["center_px"]
    goals = [goal] if goal is not None else [r["center_px"] for r in mesh["regions"] if r["kind"] == "exit"]
    model["route"] = (find_path(mesh, start, goals, graph=graph) if goals else
                      {"status": "no_exit", "polyline_px": []})


def render_navmesh(model: dict[str, Any], mesh: dict[str, Any], show_graph: bool = False) -> np.ndarray:
    semantic = resolve_layer(model["layers"]["semantic"], name="layers.semantic")
    palette = np.full((256, 3), COLORS[255], np.uint8)
    for label, color in COLORS.items():
        palette[label] = color
    base = palette[semantic]
    canvas = base.copy()
    fills = [(244, 228, 206), (221, 241, 223), (218, 231, 249),
             (239, 222, 241), (211, 244, 247), (246, 233, 224)]
    def point(value):
        return tuple(round(v-0.5) for v in value)
    for region in mesh["regions"]:
        x0, y0, x1, y1 = region["bounds_px"]
        if region["kind"] == "floor":
            canvas[y0:y1, x0:x1] = fills[(region["id"]-1) % len(fills)]
        cv2.rectangle(canvas, (x0, y0), (x1-1, y1-1), (170, 170, 150), 1)
    for edge in mesh["edges"]:
        cv2.line(canvas, point(edge["portal_px"][0]), point(edge["portal_px"][1]),
                 (190, 150, 60), 2, cv2.LINE_AA)
    if show_graph:
        graph = model.get("routing_graph") or build_routing_graph(mesh)
        positions = {n["id"]: n["position_px"] for n in graph["nodes"]}
        for edge in graph["edges"]:
            cv2.line(canvas, point(positions[edge["source"]]), point(positions[edge["target"]]),
                     (190, 160, 185), 1, cv2.LINE_AA)
        for position in positions.values():
            cv2.circle(canvas, point(position), 2, (120, 60, 100), -1)
    for region in mesh["regions"]:
        x, y = point(region["center_px"])
        x0, y0, x1, y1 = region["bounds_px"]
        text = f"R{region['id']}"
        (tw, th), _ = cv2.getTextSize(text, cv2.FONT_HERSHEY_SIMPLEX, .4, 1)
        if x1-x0 >= tw+10 and y1-y0 >= th+16:
            origin = (min(max(x0+4, x+7), x1-tw-3), max(y0+th+3, y-5))
            cv2.putText(canvas, text, origin, cv2.FONT_HERSHEY_SIMPLEX, .4,
                        (60, 50, 45), 1, cv2.LINE_AA)
    route = model.get("route", {})
    if route.get("status") == "ok":
        points = np.array([point(p) for p in route["polyline_px"]], np.int32)
        cv2.polylines(canvas, [points], False, (20, 100, 240), 3, cv2.LINE_AA)
        for xy in (points[0], points[-1]):
            cv2.circle(canvas, tuple(xy), 5, (20, 100, 240), -1, cv2.LINE_AA)
    blocked = ~np.isin(semantic, (FLOOR, DOOR, EXIT))
    canvas[blocked] = base[blocked]
    footer = np.full((52, canvas.shape[1], 3), 248, np.uint8)
    for y, text in ((20, f"NAVMESH | {len(mesh['regions'])} regions | {len(mesh['edges'])} portals"),
                    (41, (f"Dijkstra: {route['length_px']:.1f} px | Orange: route | Blue: portal"
                          if route.get("status") == "ok" else
                          f"Route: {route.get('status', 'not requested')} | Blue: portal | Fill: region"))):
        cv2.putText(footer, text, (12, y), cv2.FONT_HERSHEY_SIMPLEX, .43, (70, 60, 50), 1, cv2.LINE_AA)
    return np.vstack((canvas, footer))


def render_graph(model: dict[str, Any]) -> tuple[np.ndarray, int]:
    mesh = build_navmesh(model)
    return render_navmesh(model, mesh), len(mesh["edges"])


def save_preview(path: Path, canvas: np.ndarray) -> None:
    success, encoded = cv2.imencode(path.suffix or ".png", canvas)
    if not success:
        raise OSError(f"Could not encode {path}")
    encoded.tofile(path)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("json_file", nargs="?", type=Path, default=Path("floor_map.json"))
    parser.add_argument("-o", "--output", type=Path, default=Path("graph_preview.png"))
    parser.add_argument("--start", type=float, nargs=2, metavar=("X", "Y"))
    parser.add_argument("--goal", type=float, nargs=2, metavar=("X", "Y"))
    parser.add_argument("--show-graph", action="store_true")
    args = parser.parse_args()
    if args.json_file.resolve() == args.output.resolve():
        raise ValueError("Preview must not overwrite the source JSON")
    model = json.loads(args.json_file.read_text(encoding="utf-8-sig"))
    model["navmesh"] = build_navmesh(model)
    prepare_navigation(model, args.start, args.goal)
    mesh = model["navmesh"]
    save_preview(args.output, render_navmesh(model, mesh, args.show_graph))
    print(f"Wrote {args.output}: {len(mesh['regions'])} regions, {len(mesh['edges'])} portals")


if __name__ == "__main__":
    main()
