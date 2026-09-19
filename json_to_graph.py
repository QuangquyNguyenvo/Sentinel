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


# These are deliberately kept as plain strings instead of enum objects.  The
# validator is part of the exported JSON contract and callers should be able
# to inspect a report without importing Sentinel.
_WALKABLE_KINDS = frozenset(("floor", "door", "exit"))
_SEVERITY_ORDER = {"error": 0, "warning": 1, "info": 2}


def _validation_value(value: Any) -> Any:
    """Convert small NumPy/Python values used in reports to JSON values."""
    if isinstance(value, np.generic):
        return value.item()
    if isinstance(value, tuple):
        return [_validation_value(item) for item in value]
    if isinstance(value, list):
        return [_validation_value(item) for item in value]
    if isinstance(value, dict):
        return {str(key): _validation_value(item) for key, item in value.items()}
    return value


def _validation_sort_key(value: Any) -> str:
    """Provide deterministic ordering even when ids have mixed JSON types."""
    return json.dumps(_validation_value(value), ensure_ascii=False, sort_keys=True,
                      separators=(",", ":"), default=str)


def _finite_number(value: Any) -> bool:
    return (not isinstance(value, bool) and isinstance(value, (int, float))
            and math.isfinite(value))


def _is_hashable(value: Any) -> bool:
    try:
        hash(value)
    except TypeError:
        return False
    return True


def _normalise_id_list(value: Any) -> tuple[list[Any], list[Any]]:
    """Return unique ids and ids which are not usable as graph identifiers."""
    if not isinstance(value, (list, tuple)):
        return [], [value]
    unique, invalid = [], []
    seen = set()
    for item in value:
        if isinstance(item, bool) or not isinstance(item, (int, str)):
            invalid.append(item)
            continue
        key = (type(item).__name__, item)
        if key not in seen:
            seen.add(key)
            unique.append(item)
    return unique, invalid


def _region_bounds(region: dict[str, Any]) -> tuple[int, int, int, int] | None:
    """Return integer half-open bounds, or ``None`` for malformed geometry."""
    bounds = region.get("bounds_px")
    if not isinstance(bounds, (list, tuple)) or len(bounds) != 4:
        return None
    if any(isinstance(value, bool) or not isinstance(value, (int, float))
           or not math.isfinite(value) for value in bounds):
        return None
    if any(float(value) != int(value) for value in bounds):
        return None
    x0, y0, x1, y1 = map(int, bounds)
    if x1 <= x0 or y1 <= y0:
        return None
    return x0, y0, x1, y1


def _portal_signature(edge: dict[str, Any]) -> str:
    """Canonical geometry used to distinguish duplicate undirected portals."""
    source, target = edge.get("source"), edge.get("target")
    if _validation_sort_key(source) > _validation_sort_key(target):
        source, target = target, source
    portal = edge.get("portal_px")
    if isinstance(portal, (list, tuple)) and len(portal) == 2:
        points = list(portal)
        if _validation_sort_key(points[0]) > _validation_sort_key(points[1]):
            points.reverse()
        portal = points
    payload = {
        "source": source,
        "target": target,
        "portal_px": portal,
        "width_px": edge.get("width_px"),
    }
    return _validation_sort_key(payload)


def validate_graph(
    model: dict[str, Any],
    *,
    mesh: dict[str, Any] | None = None,
    space_graph: dict[str, Any] | None = None,
    routing_graph: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Validate the generated topology and geometry without mutating ``model``.

    The report intentionally separates *structural* errors (which make a
    graph unsafe to route on) from reachability warnings (which can be valid
    for a partial floor plan, but should be visible to an operator).  All
    output is composed of ordinary Python values so it can be exported by
    :func:`image_to_json.to_json_model` without a custom encoder.

    ``mesh``, ``space_graph`` and ``routing_graph`` are optional to make the
    function useful to callers validating an older in-memory model.  Existing
    graphs are inspected as-is; they are never silently rebuilt over a graph
    supplied by the caller.
    """
    issues: list[dict[str, Any]] = []

    def add_issue(code: str, severity: str, message: str, **details: Any) -> None:
        issue = {"code": code, "severity": severity, "message": message}
        for key, value in details.items():
            issue[key] = _validation_value(value)
        issues.append(issue)

    if not isinstance(model, dict):
        add_issue("invalid_model", "error", "The model must be a JSON object.")
        summary = {"region_count": 0, "portal_count": 0,
                   "connected_component_count": 0, "reachable_exit_count": 0,
                   "isolated_region_count": 0}
        return {"schema_version": "graph-validation-1", "status": "error",
                "summary": summary, "issues": issues}

    # Do not regenerate a supplied graph here.  Validation should tell the
    # caller that the supplied artifact is broken, not hide that fact by
    # replacing it with a fresh graph.
    if mesh is None:
        mesh = model.get("navmesh")
    if routing_graph is None:
        routing_graph = model.get("routing_graph")
    if space_graph is None:
        space_graph = model.get("space_graph")
    space_graph_available = isinstance(space_graph, dict) and "edges" in space_graph

    if not isinstance(mesh, dict):
        add_issue("missing_navmesh", "error", "The model has no navmesh to validate.")
        mesh = {}
    if not isinstance(routing_graph, dict):
        add_issue("missing_routing_graph", "error",
                  "The model has no routing graph to validate.")
        routing_graph = {}
    if not isinstance(space_graph, dict):
        # Space graph is used as corroborating topology.  Object-level checks
        # below still run when an old JSON has no space_graph field.
        space_graph = {}

    raw_regions = mesh.get("regions", [])
    if not isinstance(raw_regions, list):
        add_issue("invalid_navmesh_regions", "error",
                  "navmesh.regions must be an array.")
        raw_regions = []
    regions: list[dict[str, Any]] = []
    region_by_id: dict[Any, dict[str, Any]] = {}
    duplicate_region_ids: list[Any] = []
    for index, candidate in enumerate(raw_regions):
        if not isinstance(candidate, dict):
            add_issue("invalid_navmesh_region", "error",
                      f"Navmesh region {index} is not an object.", index=index)
            continue
        region_id = candidate.get("id")
        try:
            hash(region_id)
        except TypeError:
            add_issue("invalid_navmesh_region_id", "error",
                      f"Navmesh region {index} has an unusable id.", index=index)
            continue
        if region_id in region_by_id:
            duplicate_region_ids.append(region_id)
            continue
        region_by_id[region_id] = candidate
        regions.append(candidate)
        if _region_bounds(candidate) is None:
            add_issue("invalid_region_bounds", "error",
                      f"Navmesh region {region_id!r} has invalid bounds.",
                      region_ids=[region_id])
    if duplicate_region_ids:
        add_issue("duplicate_region_id", "error",
                  "Navmesh contains duplicate region identifiers.",
                  region_ids=sorted(set(duplicate_region_ids), key=_validation_sort_key),
                  count=len(duplicate_region_ids))

    region_ids = set(region_by_id)
    region_kind = {region_id: region.get("kind") for region_id, region in region_by_id.items()}
    walkable_region_ids = {region_id for region_id, kind in region_kind.items()
                           if kind in _WALKABLE_KINDS}

    # Navmesh portal validation and adjacency construction.
    raw_portals = mesh.get("edges", [])
    if not isinstance(raw_portals, list):
        add_issue("invalid_navmesh_edges", "error", "navmesh.edges must be an array.")
        raw_portals = []
    adjacency: dict[Any, set[Any]] = {region_id: set() for region_id in region_ids}
    portal_edges: list[tuple[dict[str, Any], Any, Any]] = []
    portal_pairs_by_id: dict[Any, frozenset[Any]] = {}
    duplicate_portals: list[dict[str, Any]] = []
    duplicate_signatures: dict[str, dict[str, Any]] = {}
    portal_ids_seen: dict[Any, int] = {}
    for index, candidate in enumerate(raw_portals):
        if not isinstance(candidate, dict):
            add_issue("invalid_navmesh_edge", "error",
                      f"Navmesh edge {index} is not an object.", index=index)
            continue
        source, target = candidate.get("source"), candidate.get("target")
        edge_id = candidate.get("id", index + 1)
        try:
            hash(edge_id)
        except TypeError:
            edge_id = index + 1
        if edge_id in portal_ids_seen:
            duplicate_portals.append({"id": edge_id,
                                      "indices": [portal_ids_seen[edge_id], index]})
        else:
            portal_ids_seen[edge_id] = index
        try:
            endpoint_key = (source, target) if source <= target else (target, source)
            hash(endpoint_key)
        except (TypeError, ValueError):
            endpoint_key = None
        if source == target and source is not None:
            add_issue("self_loop_portal", "error",
                      f"Portal {edge_id!r} connects a region to itself.",
                      portal_ids=[edge_id], region_ids=[source])
        source_known = _is_hashable(source) and source in region_ids
        target_known = _is_hashable(target) and target in region_ids
        if not source_known or not target_known:
            add_issue("portal_unknown_region", "error",
                      f"Portal {edge_id!r} references an unknown region.",
                      portal_ids=[edge_id], region_ids=[source, target])
        else:
            portal_edges.append((candidate, source, target))
            if source != target:
                adjacency[source].add(target)
                adjacency[target].add(source)
                if _is_hashable(edge_id):
                    portal_pairs_by_id[edge_id] = frozenset((source, target))

        width = candidate.get("width_px")
        portal = candidate.get("portal_px")
        endpoint_width = None
        if isinstance(portal, (list, tuple)) and len(portal) == 2 \
                and all(isinstance(point, (list, tuple)) and len(point) == 2
                        and all(_finite_number(value) for value in point)
                        for point in portal):
            endpoint_width = max(abs(float(portal[1][0]) - float(portal[0][0])),
                                 abs(float(portal[1][1]) - float(portal[0][1])))
            if (float(portal[0][0]) != float(portal[1][0])
                    and float(portal[0][1]) != float(portal[1][1])):
                add_issue("malformed_portal_geometry", "error",
                          f"Portal {edge_id!r} is not axis-aligned.",
                          portal_ids=[edge_id], portal_px=portal)
        else:
            add_issue("malformed_portal_geometry", "error",
                      f"Portal {edge_id!r} has invalid endpoint geometry.",
                      portal_ids=[edge_id], portal_px=portal)
        if (not _finite_number(width) or float(width) <= 0
                or (endpoint_width is not None and endpoint_width <= 0)):
            add_issue("zero_width_portal", "error",
                      f"Portal {edge_id!r} has no positive opening width.",
                      portal_ids=[edge_id], width_px=width)
        if endpoint_key is not None:
            signature = _portal_signature(candidate)
            if signature in duplicate_signatures:
                duplicate_portals.append({
                    "id": edge_id,
                    "duplicate_of": duplicate_signatures[signature].get("id", index),
                })
            else:
                duplicate_signatures[signature] = candidate

    if duplicate_portals:
        add_issue("duplicate_portal_edge", "error",
                  "Navmesh contains duplicate portal edges.",
                  duplicates=duplicate_portals, count=len(duplicate_portals))

    # Region bounds must be a true partition of semantic walkable pixels.
    overlap_pairs: list[list[Any]] = []
    valid_bounds: dict[Any, tuple[int, int, int, int]] = {}
    for region_id, region in region_by_id.items():
        bounds = _region_bounds(region)
        if bounds is not None:
            valid_bounds[region_id] = bounds
    sorted_region_ids = sorted(valid_bounds, key=_validation_sort_key)
    for index, first_id in enumerate(sorted_region_ids):
        ax0, ay0, ax1, ay1 = valid_bounds[first_id]
        for second_id in sorted_region_ids[index + 1:]:
            bx0, by0, bx1, by1 = valid_bounds[second_id]
            if min(ax1, bx1) > max(ax0, bx0) and min(ay1, by1) > max(ay0, by0):
                overlap_pairs.append([first_id, second_id])
    if overlap_pairs:
        add_issue("overlapping_regions", "error",
                  "Navmesh region bounds overlap with positive area.",
                  region_pairs=overlap_pairs, count=len(overlap_pairs))

    semantic = None
    try:
        semantic_layer = model.get("layers", {}).get("semantic")
        semantic = resolve_layer(semantic_layer, name="layers.semantic")
    except (AttributeError, KeyError, TypeError, ValueError):
        add_issue("semantic_layer_unavailable", "error",
                  "Semantic pixels are unavailable, so navmesh coverage cannot be verified.")
    if semantic is not None:
        rows, cols = semantic.shape
        out_of_bounds = [
            region_id for region_id, (x0, y0, x1, y1) in valid_bounds.items()
            if x0 < 0 or y0 < 0 or x1 > cols or y1 > rows
        ]
        if out_of_bounds:
            add_issue("region_bounds_out_of_bounds", "error",
                      "Navmesh region bounds extend outside the semantic image.",
                      region_ids=sorted(out_of_bounds, key=_validation_sort_key),
                      image_shape=[int(rows), int(cols)])
        coverage = np.zeros(semantic.shape, dtype=np.uint32)
        for bounds in valid_bounds.values():
            x0, y0, x1, y1 = bounds
            clipped_x0, clipped_x1 = max(0, x0), min(semantic.shape[1], x1)
            clipped_y0, clipped_y1 = max(0, y0), min(semantic.shape[0], y1)
            if clipped_x0 < clipped_x1 and clipped_y0 < clipped_y1:
                coverage[clipped_y0:clipped_y1, clipped_x0:clipped_x1] += 1
        walkable_pixels = np.isin(semantic, (FLOOR, DOOR, EXIT))
        uncovered = walkable_pixels & (coverage == 0)
        overcovered = walkable_pixels & (coverage > 1)
        if np.any(uncovered):
            positions = np.argwhere(uncovered)[:10]
            add_issue("walkable_pixel_uncovered", "error",
                      "Walkable semantic pixels are not covered by navmesh regions.",
                      count=int(np.count_nonzero(uncovered)),
                      sample_pixels=[[int(x), int(y)] for y, x in positions])
        if np.any(overcovered):
            positions = np.argwhere(overcovered)[:10]
            add_issue("walkable_pixel_overcovered", "error",
                      "Walkable semantic pixels are covered by multiple regions.",
                      count=int(np.count_nonzero(overcovered)),
                      sample_pixels=[[int(x), int(y)] for y, x in positions])

    # Connected components of the undirected navmesh graph.
    components: list[set[Any]] = []
    unseen = set(region_ids)
    while unseen:
        root = min(unseen, key=_validation_sort_key)
        component, stack = set(), [root]
        unseen.remove(root)
        while stack:
            current = stack.pop()
            component.add(current)
            for neighbour in sorted(adjacency.get(current, set()), key=_validation_sort_key):
                if neighbour in unseen:
                    unseen.remove(neighbour)
                    stack.append(neighbour)
        components.append(component)
    component_by_region = {region_id: index for index, component in enumerate(components)
                           for region_id in component}
    isolated_regions = sorted([region_id for region_id in region_ids
                               if not adjacency.get(region_id)], key=_validation_sort_key)
    if isolated_regions:
        add_issue("isolated_navmesh_region", "warning",
                  "Navmesh regions have no portal connection to another region.",
                  region_ids=isolated_regions, count=len(isolated_regions))

    exit_region_ids = {region_id for region_id, kind in region_kind.items() if kind == "exit"}
    floor_region_ids = {region_id for region_id, kind in region_kind.items() if kind == "floor"}
    reachable_exit_region_ids = {
        region_id for region_id in exit_region_ids
        if any(region_id in component and floor_region_ids.intersection(component)
               for component in components)
    }
    no_exit_floor_regions = sorted([
        region_id for region_id in floor_region_ids
        if region_id not in component_by_region
        or not any(exit_region_ids.intersection(component)
                   for component in components
                   if region_id in component)
    ], key=_validation_sort_key)
    if no_exit_floor_regions:
        add_issue("floor_region_no_reachable_exit", "warning",
                  "Floor regions cannot reach any connected exit.",
                  region_ids=no_exit_floor_regions, count=len(no_exit_floor_regions))

    # Check source semantic objects.  These checks intentionally use
    # neighbour_zones rather than navmesh rectangle count: a wide door can be
    # split into several rectangles but still connects exactly two zones.
    zone_ids: set[Any] = set()
    raw_zones = model.get("zones", [])
    if isinstance(raw_zones, list):
        for zone in raw_zones:
            if isinstance(zone, dict) and isinstance(zone.get("id"), (int, str)) \
                    and not isinstance(zone.get("id"), bool):
                zone_ids.add(zone["id"])
    space_edges = space_graph.get("edges", []) if isinstance(space_graph, dict) else []
    if not isinstance(space_edges, list):
        space_edges = []
    raw_doors = model.get("doors", [])
    if not isinstance(raw_doors, list):
        raw_doors = []
    for item in raw_doors:
        if not isinstance(item, dict):
            add_issue("door_not_two_floor_zones", "error",
                      "A door object is not a valid object.")
            continue
        object_id = item.get("id")
        neighbours, invalid_neighbours = _normalise_id_list(item.get("neighbour_zones"))
        bad_ids = [value for value in neighbours if value not in zone_ids]
        if len(neighbours) != 2 or invalid_neighbours or bad_ids:
            add_issue("door_not_two_floor_zones", "error",
                      f"Door {object_id!r} must connect exactly two floor zones.",
                      object_id=object_id, neighbour_zones=neighbours,
                      invalid_neighbours=invalid_neighbours, unknown_zones=bad_ids,
                      count=len(neighbours))
        matching_space_edges = [edge for edge in space_edges
                                if isinstance(edge, dict)
                                and edge.get("object_id") == object_id
                                and edge.get("kind") == "door"]
        if len(neighbours) == 2 and space_graph_available and len(matching_space_edges) != 1:
            add_issue("door_space_graph_mismatch", "error",
                      f"Door {object_id!r} is not represented by one space-graph edge.",
                      object_id=object_id, edge_count=len(matching_space_edges))

    # Exit validation combines source object adjacency with actual navmesh
    # adjacency.  A source exit with one zone can still be invalid when its
    # generated exit rectangle is floating or disconnected.
    raw_exits = model.get("exits", [])
    if not isinstance(raw_exits, list):
        raw_exits = []
    exit_objects_by_id: dict[Any, dict[str, Any]] = {}
    for item in raw_exits:
        if not isinstance(item, dict):
            add_issue("exit_not_connected_to_walkable", "error",
                      "An exit object is not a valid object.")
            continue
        object_id = item.get("id")
        if _is_hashable(object_id):
            exit_objects_by_id[object_id] = item
        neighbours, invalid_neighbours = _normalise_id_list(item.get("neighbour_zones"))
        bad_ids = [value for value in neighbours if value not in zone_ids]
        associated = [region_id for region_id, region in region_by_id.items()
                      if region.get("kind") == "exit" and region.get("object_id") == object_id]
        connected = [region_id for region_id in associated
                     if adjacency.get(region_id, set()) & walkable_region_ids]
        if not neighbours or invalid_neighbours or bad_ids or not connected:
            add_issue("exit_not_connected_to_walkable", "error",
                      f"Exit {object_id!r} is not connected to a walkable region.",
                      object_id=object_id, neighbour_zones=neighbours,
                      invalid_neighbours=invalid_neighbours, unknown_zones=bad_ids,
                      region_ids=associated)

    # Also inspect generated exit regions when source objects are absent or
    # stale, which is common in hand-edited/older JSON files.
    for region_id in sorted(exit_region_ids, key=_validation_sort_key):
        region = region_by_id[region_id]
        object_id = region.get("object_id")
        if (not _is_hashable(object_id) or object_id not in exit_objects_by_id) \
                and not (adjacency.get(region_id, set()) & walkable_region_ids):
            add_issue("exit_not_connected_to_walkable", "error",
                      f"Exit region {region_id!r} is not connected to a walkable region.",
                      region_ids=[region_id], object_id=object_id)

    # Routing graph node and edge checks, including participation of every
    # walkable navmesh region.
    raw_nodes = routing_graph.get("nodes", [])
    if not isinstance(raw_nodes, list):
        add_issue("invalid_routing_nodes", "error", "routing_graph.nodes must be an array.")
        raw_nodes = []
    routing_node_ids: set[Any] = set()
    routing_node_degree: dict[Any, int] = {}
    routing_node_regions: dict[Any, list[Any]] = {}
    participating_regions: set[Any] = set()
    for index, node in enumerate(raw_nodes):
        if not isinstance(node, dict):
            add_issue("invalid_routing_node", "error",
                      f"Routing node {index} is not an object.", index=index)
            continue
        node_id = node.get("id")
        try:
            hash(node_id)
        except TypeError:
            add_issue("invalid_routing_node_id", "error",
                      f"Routing node {index} has an unusable id.", index=index)
            continue
        if node_id in routing_node_ids:
            add_issue("duplicate_routing_node_id", "error",
                      f"Routing node id {node_id!r} is repeated.", node_ids=[node_id])
            continue
        routing_node_ids.add(node_id)
        routing_node_degree[node_id] = 0
        node_regions, invalid_node_regions = _normalise_id_list(node.get("region_ids"))
        routing_node_regions[node_id] = [region_id for region_id in node_regions
                                         if region_id in region_ids]
        unknown_node_regions = [region_id for region_id in node_regions
                                if region_id not in region_ids]
        if invalid_node_regions or unknown_node_regions:
            add_issue("routing_node_unknown_region", "error",
                      f"Routing node {node_id!r} references an unknown region.",
                      node_ids=[node_id], region_ids=node_regions,
                      invalid_regions=invalid_node_regions,
                      unknown_regions=unknown_node_regions)
        participating_regions.update(region_id for region_id in node_regions
                                      if region_id in region_ids)
    raw_routing_edges = routing_graph.get("edges", [])
    if not isinstance(raw_routing_edges, list):
        add_issue("invalid_routing_edges", "error", "routing_graph.edges must be an array.")
        raw_routing_edges = []
    routing_edge_signatures: set[str] = set()
    duplicate_routing_edges: list[Any] = []
    self_loop_routing_nodes: list[Any] = []
    for index, edge in enumerate(raw_routing_edges):
        if not isinstance(edge, dict):
            add_issue("invalid_routing_edge", "error",
                      f"Routing edge {index} is not an object.", index=index)
            continue
        source, target = edge.get("source"), edge.get("target")
        region_id = edge.get("region_id")
        edge_key = (_validation_sort_key(source), _validation_sort_key(target))
        edge_key = tuple(sorted(edge_key))
        signature = _validation_sort_key({"endpoints": edge_key, "region_id": region_id})
        if signature in routing_edge_signatures:
            duplicate_routing_edges.append(edge.get("id", index))
        routing_edge_signatures.add(signature)
        if source == target:
            self_loop_routing_nodes.append(source)
            continue
        source_known = _is_hashable(source) and source in routing_node_ids
        target_known = _is_hashable(target) and target in routing_node_ids
        if not source_known or not target_known:
            add_issue("routing_edge_unknown_node", "error",
                      f"Routing edge {edge.get('id', index)!r} references an unknown node.",
                      edge_ids=[edge.get("id", index)], node_ids=[source, target])
            continue
        if not _is_hashable(region_id) or region_id not in region_ids:
            add_issue("routing_edge_unknown_region", "error",
                      f"Routing edge {edge.get('id', index)!r} references an unknown region.",
                      edge_ids=[edge.get("id", index)], region_ids=[region_id])
        routing_node_degree[source] += 1
        routing_node_degree[target] += 1
    if self_loop_routing_nodes:
        add_issue("self_loop_routing_edge", "error",
                  "Routing graph contains self-loop edges.",
                  node_ids=sorted({node for node in self_loop_routing_nodes
                                   if _is_hashable(node)}, key=_validation_sort_key),
                  count=len(self_loop_routing_nodes))
    if duplicate_routing_edges:
        add_issue("duplicate_routing_edge", "error",
                  "Routing graph contains duplicate edges.",
                  edge_ids=duplicate_routing_edges, count=len(duplicate_routing_edges))
    # A one-floor/one-exit map has exactly one portal midpoint.  It has no
    # static routing edge because both regions contain only that midpoint,
    # yet dynamic start/goal endpoints attach to it and routing is valid.
    # Exempt only this precise direct floor-to-exit topology; a disconnected
    # midpoint elsewhere remains a useful warning.
    legitimate_isolated_nodes = set()
    for node_id, node_regions in routing_node_regions.items():
        if routing_node_degree.get(node_id) != 0 or len(node_regions) != 2:
            continue
        kinds = {region_kind.get(region_id) for region_id in node_regions}
        if kinds != {"floor", "exit"}:
            continue
        if portal_pairs_by_id.get(node_id) == frozenset(node_regions):
            legitimate_isolated_nodes.add(node_id)
    isolated_routing_nodes = sorted([
        node_id for node_id, degree in routing_node_degree.items()
        if degree == 0 and node_id not in legitimate_isolated_nodes
    ], key=_validation_sort_key)
    if isolated_routing_nodes:
        add_issue("isolated_routing_node", "warning",
                  "Routing graph nodes have no incident edges.",
                  node_ids=isolated_routing_nodes, count=len(isolated_routing_nodes))
    missing_participation = sorted(walkable_region_ids - participating_regions,
                                   key=_validation_sort_key)
    if missing_participation:
        add_issue("region_missing_routing_participation", "warning",
                  "Walkable navmesh regions do not participate in the routing graph.",
                  region_ids=missing_participation, count=len(missing_participation))

    # One source exit object normally maps to one rectangular exit region.  If
    # a hand-edited map splits one exit into multiple regions, report the
    # number of logical exits rather than inflating the user-facing metric.
    reachable_exit_object_ids = set()
    for region_id in reachable_exit_region_ids:
        object_id = region_by_id[region_id].get("object_id")
        if object_id is not None and _is_hashable(object_id):
            reachable_exit_object_ids.add(object_id)
    if exit_objects_by_id:
        reachable_exit_count = len(reachable_exit_object_ids)
    else:
        reachable_exit_count = len(reachable_exit_region_ids)

    summary = {
        "region_count": len(regions),
        "portal_count": len(raw_portals),
        "connected_component_count": len(components),
        "reachable_exit_count": int(reachable_exit_count),
        "isolated_region_count": len(isolated_regions),
    }
    status = ("error" if any(issue["severity"] == "error" for issue in issues)
              else "warning" if issues else "valid")
    # Canonical issue order makes exported JSON diffs meaningful and gives UI
    # consumers a stable first issue to announce in an aria-live region.
    issues.sort(key=lambda issue: (_SEVERITY_ORDER.get(issue["severity"], 9),
                                   issue["code"],
                                   _validation_sort_key(issue.get("region_ids", [])),
                                   _validation_sort_key(issue.get("object_id", "")),
                                   _validation_sort_key(issue.get("node_ids", []))))
    return {"schema_version": "graph-validation-1", "status": status,
            "summary": summary, "issues": issues}


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
    """Attach topology, validation, reusable routing graph and a sample route."""
    mesh = model.get("navmesh") or build_navmesh(model)
    model["navmesh"] = mesh
    model["space_graph"] = build_space_graph(model)
    graph = build_routing_graph(mesh)
    model["routing_graph"] = graph
    # Keep validation beside the generated artifacts so both the CLI export
    # and the browser can explain whether this particular graph is trustworthy.
    model["graph_validation"] = validate_graph(
        model, mesh=mesh, space_graph=model["space_graph"], routing_graph=graph,
    )
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
