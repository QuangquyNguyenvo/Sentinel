"""Convert a color-coded floor-plan image into a semantic JSON model.

MVP assumptions
---------------
* The input is a top-down 2D image.
* The floor plan uses stable colors:
    white       = floor
    dark gray   = wall
    blue        = door
    green       = exit
    red         = obstacle
* White floor connected to the image border is outside; crop with walls or
  background margins intact. Other unrecognized colors remain unknown.

Run:
    python image_to_json.py
    python image_to_json.py tests/floor_plans/floor_plan_01_basic.png
    python image_to_json.py input.png -o output.json --meters-per-pixel 0.01

The semantic and zone layers are stored as run-length encoded rows in JSON.
For example, ``[[255, 120], [1, 30], [0, 80]]`` means 120 unknown cells,
then 30 wall cells, then 80 floor cells. This keeps the original pixel
resolution without writing one verbose JSON number per pixel.

The HSV thresholds below are intentionally easy to edit. They are the first
thing to calibrate for real floor-plan images.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

import cv2
import numpy as np


# Semantic labels written to the output matrix.
FLOOR = 0
WALL = 1
DOOR = 2
EXIT = 3
OBSTACLE = 4
UNKNOWN = 255


# OpenCV HSV uses H in [0, 179], S and V in [0, 255].
# These ranges fit the deterministic fixtures and are starting points for
# real images, not universal values.
HSV_RANGES = {
    "floor": ((0, 0, 245), (179, 35, 255)),
    "wall": ((0, 0, 0), (179, 100, 120)),
    "door": ((90, 70, 50), (135, 255, 255)),
    "exit": ((35, 70, 50), (85, 255, 255)),
}


def hsv_mask(
    hsv_image: np.ndarray,
    lower: tuple[int, int, int],
    upper: tuple[int, int, int],
) -> np.ndarray:
    """Return a binary 0/255 mask for pixels inside an HSV range."""

    lower_array = np.array(lower, dtype=np.uint8)
    upper_array = np.array(upper, dtype=np.uint8)
    return cv2.inRange(hsv_image, lower_array, upper_array)


def red_mask(hsv_image: np.ndarray) -> np.ndarray:
    """Detect red, whose hue wraps around the HSV scale."""

    lower_red = hsv_mask(
        hsv_image,
        (0, 70, 50),
        (10, 255, 255),
    )
    upper_red = hsv_mask(
        hsv_image,
        (170, 70, 50),
        (179, 255, 255),
    )
    return cv2.bitwise_or(lower_red, upper_red)


def clean_mask(
    mask: np.ndarray,
    operation: int,
    kernel: np.ndarray,
) -> np.ndarray:
    """Apply one morphology operation to a binary mask."""

    return cv2.morphologyEx(mask, operation, kernel)


def crop_image(
    image: np.ndarray,
    crop: tuple[int, int, int, int] | None,
) -> np.ndarray:
    """Crop to x, y, width, height when a manual ROI is supplied."""

    if crop is None:
        return image

    x, y, width, height = crop
    if width <= 0 or height <= 0:
        raise ValueError("Crop width and height must be positive")

    image_height, image_width = image.shape[:2]
    if x < 0 or y < 0 or x + width > image_width or y + height > image_height:
        raise ValueError("Crop must stay inside the image")

    return image[y : y + height, x : x + width]


def encode_rle_rows(matrix: np.ndarray) -> list[list[list[int]]]:
    """Encode a 2D integer matrix as ``[[value, run_length], ...]`` per row."""

    if matrix.ndim != 2:
        raise ValueError("RLE only supports 2D matrices")

    encoded_rows: list[list[list[int]]] = []

    for row in matrix:
        if row.size == 0:
            encoded_rows.append([])
            continue

        # Find where the value changes. NumPy does the scan in native code;
        # Python only iterates over the much shorter list of runs.
        change_positions = np.flatnonzero(row[1:] != row[:-1]) + 1
        starts = np.concatenate(([0], change_positions))
        ends = np.concatenate((change_positions, [row.size]))

        encoded_rows.append([
            [value, count]
            for value, count in zip(row[starts].tolist(), (ends - starts).tolist())
        ])

    return encoded_rows


def encode_rle_layer(matrix: np.ndarray) -> dict[str, Any]:
    """Return a self-describing, lossless RLE layer for JSON storage."""

    if matrix.ndim != 2:
        raise ValueError("RLE only supports 2D matrices")

    return {
        "encoding": "rle_rows",
        "shape": [
            int(matrix.shape[0]),
            int(matrix.shape[1]),
        ],
        "dtype": matrix.dtype.name,
        "data": encode_rle_rows(matrix),
    }


def decode_rle_layer(layer: dict[str, Any]) -> np.ndarray:
    """Decode and validate a layer produced by :func:`encode_rle_layer`."""

    if layer.get("encoding") != "rle_rows":
        raise ValueError(f"Unsupported encoding: {layer.get('encoding')!r}")

    shape = layer.get("shape")
    if not isinstance(shape, list) or len(shape) != 2:
        raise ValueError("RLE layer must contain shape [rows, cols]")

    rows, cols = shape
    if (
        isinstance(rows, bool)
        or isinstance(cols, bool)
        or not isinstance(rows, int)
        or not isinstance(cols, int)
        or rows <= 0
        or cols <= 0
    ):
        raise ValueError("RLE shape values must be positive integers")

    try:
        dtype = np.dtype(layer["dtype"])
    except (KeyError, TypeError, ValueError) as error:
        raise ValueError("RLE layer contains an invalid dtype") from error

    if dtype.kind not in "iu":
        raise ValueError("RLE layers must use an integer dtype")
    limits = np.iinfo(dtype)

    encoded_rows = layer.get("data")
    if not isinstance(encoded_rows, list) or len(encoded_rows) != rows:
        raise ValueError(f"RLE layer must contain exactly {rows} rows")

    matrix = np.empty((rows, cols), dtype=dtype)

    for row_index, runs in enumerate(encoded_rows):
        if not isinstance(runs, list):
            raise ValueError(f"RLE row {row_index} must be a list")

        column = 0

        for run_index, run in enumerate(runs):
            if not isinstance(run, list) or len(run) != 2:
                raise ValueError(
                    f"Invalid run at row {row_index}, index {run_index}"
                )

            value, count = run
            if (isinstance(value, bool) or not isinstance(value, int)
                    or not limits.min <= value <= limits.max):
                raise ValueError(
                    f"Invalid integer value at row {row_index}, index {run_index}"
                )
            if isinstance(count, bool) or not isinstance(count, int) or count <= 0:
                raise ValueError(
                    f"Invalid run length at row {row_index}, index {run_index}"
                )

            next_column = column + count
            if next_column > cols:
                raise ValueError(f"RLE row {row_index} exceeds {cols} columns")

            try:
                matrix[row_index, column:next_column] = value
            except (OverflowError, TypeError, ValueError) as error:
                raise ValueError(
                    f"Invalid value at row {row_index}, index {run_index}"
                ) from error

            column = next_column

        if column != cols:
            raise ValueError(
                f"RLE row {row_index} expands to {column} columns, expected {cols}"
            )

    return matrix


def resolve_layer(
    layer: np.ndarray | dict[str, Any],
    *,
    name: str = "layer",
    expected_shape: tuple[int, int] | None = None,
) -> np.ndarray:
    """Return a validated raw matrix from an in-memory or JSON layer.

    Runtime models keep layers as integer NumPy matrices. JSON models keep the
    same matrices as RLE dictionaries. Both representations use the same
    two-dimensional, positive shape and integer-dtype requirements.
    """

    if isinstance(layer, np.ndarray):
        matrix = layer
        if matrix.ndim != 2:
            raise ValueError(f"{name} must be a 2D matrix")
        if matrix.shape[0] <= 0 or matrix.shape[1] <= 0:
            raise ValueError(f"{name} must have a positive shape")
        if matrix.dtype.kind not in "iu":
            raise ValueError(f"{name} must use an integer dtype")
    elif isinstance(layer, dict):
        matrix = decode_rle_layer(layer)
    else:
        raise ValueError(f"{name} must be a 2D integer matrix or RLE layer")

    if expected_shape is not None and tuple(matrix.shape) != tuple(expected_shape):
        raise ValueError(
            f"{name} shape {tuple(matrix.shape)} does not match "
            f"expected {tuple(expected_shape)}"
        )

    return matrix


def to_json_model(model: dict[str, Any]) -> dict[str, Any]:
    """Return a copy with all matrix layers RLE-encoded for JSON output.

    Runtime models may contain raw NumPy layers. The input model is not
    mutated while those layers are replaced in the returned copy.
    """

    layers = model.get("layers")
    if not isinstance(layers, dict):
        raise ValueError("Model must contain a layers mapping")

    exported_layers = {}
    for name, layer in layers.items():
        if isinstance(layer, np.ndarray):
            exported_layers[name] = encode_rle_layer(
                resolve_layer(layer, name=f"layers.{name}")
            )
        elif isinstance(layer, dict):
            # Already-serialized callers do not need a decode/encode round-trip.
            exported_layers[name] = dict(layer)
        else:
            raise ValueError(f"layers.{name} must be a matrix or RLE layer")

    exported = dict(model)
    exported["layers"] = exported_layers
    return exported


def decode_json_layer(
    json_path: str | Path,
    layer_name: str = "semantic",
) -> np.ndarray:
    """Load a floor-map JSON file and decode one named matrix layer."""

    model = json.loads(Path(json_path).read_text(encoding="utf-8"))

    try:
        layer = model["layers"][layer_name]
    except KeyError as error:
        raise ValueError(f"JSON does not contain layer {layer_name!r}") from error

    return decode_rle_layer(layer)


def make_semantic_matrix(image: np.ndarray) -> np.ndarray:
    """Segment the image and return one semantic label per pixel."""

    if (image.dtype != np.uint8 or image.ndim != 3 or image.shape[2] != 3
            or image.shape[0] == 0 or image.shape[1] == 0):
        raise ValueError("Expected a non-empty uint8 BGR image")

    hsv = cv2.cvtColor(image, cv2.COLOR_BGR2HSV)

    floor_mask = hsv_mask(hsv, *HSV_RANGES["floor"])
    wall_mask = hsv_mask(hsv, *HSV_RANGES["wall"])
    door_mask = hsv_mask(hsv, *HSV_RANGES["door"])
    exit_mask = hsv_mask(hsv, *HSV_RANGES["exit"])
    obstacle_mask = red_mask(hsv)

    kernel = cv2.getStructuringElement(
        cv2.MORPH_RECT,
        (3, 3),
    )

    # Repair small wall breaks. Preserve narrow connectors: opening their
    # masks erases valid one-/two-pixel doors and exits.
    wall_mask = clean_mask(
        wall_mask,
        cv2.MORPH_CLOSE,
        kernel,
    )

    semantic = np.full(
        image.shape[:2],
        UNKNOWN,
        dtype=np.uint8,
    )

    # Later assignments have higher priority if masks overlap.
    semantic[floor_mask > 0] = FLOOR
    semantic[wall_mask > 0] = WALL
    semantic[obstacle_mask > 0] = OBSTACLE
    semantic[door_mask > 0] = DOOR
    semantic[exit_mask > 0] = EXIT

    # White exterior must not become a room. Only floor is flood-connected;
    # doors/exits on the building boundary still separate inside and outside.
    if not any(np.any(border == FLOOR) for border in (
        semantic[0], semantic[-1], semantic[:, 0], semantic[:, -1],
    )):
        return semantic
    count, floor_ids = cv2.connectedComponents(
        (semantic == FLOOR).astype(np.uint8), connectivity=4,
    )
    border_ids = np.unique(np.concatenate((
        floor_ids[0], floor_ids[-1], floor_ids[:, 0], floor_ids[:, -1],
    )))
    exterior = np.zeros(count, dtype=bool)
    exterior[border_ids] = True
    exterior[0] = False
    semantic[exterior[floor_ids]] = UNKNOWN

    return semantic


def find_zones(
    semantic: np.ndarray,
    meters_per_pixel: float | None,
) -> tuple[np.ndarray, list[dict[str, Any]]]:
    """Find floor components while keeping doors as zone boundaries."""

    if meters_per_pixel is not None and (
        not np.isfinite(meters_per_pixel) or meters_per_pixel <= 0
    ):
        raise ValueError("meters_per_pixel must be finite and positive")

    # Door pixels are deliberately excluded. This keeps two rooms on opposite
    # sides of a door as two separate zones.
    zone_mask = (semantic == FLOOR).astype(np.uint8)

    zone_count, zone_ids, stats, centroids = \
        cv2.connectedComponentsWithStats(
            zone_mask,
            connectivity=4,
        )

    zones: list[dict[str, Any]] = []

    for zone_id in range(1, zone_count):
        x, y, zone_width, zone_height, area_px = stats[zone_id]
        center_x, center_y = centroids[zone_id]

        area_m2 = None
        if meters_per_pixel is not None:
            area_m2 = float(area_px * meters_per_pixel**2)

        zones.append(
            {
                "id": int(zone_id),
                "type": "unclassified",
                "bbox_px": {
                    "x": int(x),
                    "y": int(y),
                    "width": int(zone_width),
                    "height": int(zone_height),
                },
                "area_px": int(area_px),
                "area_m2": area_m2,
                "centroid_px": [
                    float(center_x),
                    float(center_y),
                ],
            }
        )

    return zone_ids, zones


def find_objects(
    semantic: np.ndarray,
    label: int,
    prefix: str,
    zone_ids: np.ndarray,
) -> list[dict[str, Any]]:
    """Find connected door/exit/obstacle components and nearby zones."""

    object_mask = (semantic == label).astype(np.uint8)

    object_count, object_ids, stats, centroids = \
        cv2.connectedComponentsWithStats(
            object_mask,
            connectivity=4,
        )

    neighbour_kernel = cv2.getStructuringElement(
        cv2.MORPH_CROSS,
        (3, 3),
    )

    objects: list[dict[str, Any]] = []

    for object_id in range(1, object_count):
        x, y, object_width, object_height, area_px = stats[object_id]
        center_x, center_y = centroids[object_id]

        # Work only inside the component's bounding box plus one pixel.
        # Previously every object allocated and scanned another full image.
        left, top = max(0, int(x) - 1), max(0, int(y) - 1)
        right = min(semantic.shape[1], int(x + object_width) + 1)
        bottom = min(semantic.shape[0], int(y + object_height) + 1)
        component = (object_ids[top:bottom, left:right] == object_id).astype(np.uint8)
        expanded = cv2.dilate(
            component,
            neighbour_kernel,
            iterations=1,
        )

        neighbour_zone_ids = np.unique(zone_ids[top:bottom, left:right][expanded > 0])
        neighbour_zone_ids = [
            int(value)
            for value in neighbour_zone_ids
            if value > 0
        ]

        objects.append(
            {
                "id": f"{prefix}_{object_id}",
                "bbox_px": {
                    "x": int(x),
                    "y": int(y),
                    "width": int(object_width),
                    "height": int(object_height),
                },
                "area_px": int(area_px),
                "centroid_px": [
                    float(center_x),
                    float(center_y),
                ],
                "neighbour_zones": neighbour_zone_ids,
            }
        )

    return objects


def build_json_model(
    input_path: Path,
    image: np.ndarray,
    semantic: np.ndarray,
    zone_ids: np.ndarray,
    zones: list[dict[str, Any]],
    doors: list[dict[str, Any]],
    exits: list[dict[str, Any]],
    obstacles: list[dict[str, Any]],
    meters_per_pixel: float | None,
    *,
    encode_layers: bool = True,
) -> dict[str, Any]:
    """Build a floor-map model, serialized by default for compatibility.

    Set ``encode_layers=False`` for an in-memory runtime model. Call
    :func:`to_json_model` before JSON serialization in that mode.
    """

    unknown_pixels = int(np.sum(semantic == UNKNOWN))
    total_pixels = int(semantic.size)

    layers = {
        "semantic": (
            encode_rle_layer(semantic)
            if encode_layers else resolve_layer(semantic, name="layers.semantic")
        ),
        "zone_id": (
            encode_rle_layer(zone_ids)
            if encode_layers else resolve_layer(zone_ids, name="layers.zone_id")
        ),
    }

    return {
        "schema_version": "0.1",
        "source": {
            "file": input_path.as_posix(),
            "width_px": int(image.shape[1]),
            "height_px": int(image.shape[0]),
        },
        "grid": {
            "rows": int(semantic.shape[0]),
            "cols": int(semantic.shape[1]),
            "meters_per_pixel": meters_per_pixel,
            "origin": "top_left",
            "connectivity": 4,
        },
        "legend": {
            "0": "floor",
            "1": "wall",
            "2": "door",
            "3": "exit",
            "4": "obstacle",
            "255": "unknown",
        },
        "layers": layers,
        "zones": zones,
        "doors": doors,
        "exits": exits,
        "obstacles": obstacles,
        "quality": {
            "unknown_pixels": unknown_pixels,
            "unknown_ratio": unknown_pixels / total_pixels,
        },
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Convert a floor-plan image into semantic JSON."
    )
    parser.add_argument(
        "image",
        nargs="?",
        type=Path,
        help="Input floor-plan image; prompts when omitted",
    )
    parser.add_argument(
        "-o",
        "--output",
        type=Path,
        help="Output JSON path; defaults to <image>.json",
    )
    parser.add_argument(
        "--meters-per-pixel",
        type=float,
        default=None,
        help="Known real-world scale, for example 0.01",
    )
    parser.add_argument(
        "--crop",
        type=int,
        nargs=4,
        metavar=("X", "Y", "WIDTH", "HEIGHT"),
        help="Optional manual crop rectangle",
    )
    return parser.parse_args()


def prompt_image_path() -> Path:
    """Ask for an image path when none was supplied on the command line."""

    raw_path = input("Floor-plan image path: ").strip()
    if not raw_path:
        raise ValueError("Image path cannot be empty")

    # Explorer/terminal paste may include matching quotes around the path.
    if len(raw_path) >= 2 and raw_path[0] == raw_path[-1] \
            and raw_path[0] in {'"', "'"}:
        raw_path = raw_path[1:-1].strip()

    return Path(raw_path)


def main() -> None:
    args = parse_args()
    image_path = args.image or prompt_image_path()

    if not image_path.exists():
        raise FileNotFoundError(f"Input image does not exist: {image_path}")

    if args.meters_per_pixel is not None and (
        not np.isfinite(args.meters_per_pixel) or args.meters_per_pixel <= 0
    ):
        raise ValueError("--meters-per-pixel must be finite and positive")

    # imdecode also supports paths containing Vietnamese characters on Windows.
    image = cv2.imdecode(np.fromfile(image_path, dtype=np.uint8), cv2.IMREAD_COLOR)

    if image is None:
        raise ValueError(f"OpenCV could not decode: {image_path}")

    crop = tuple(args.crop) if args.crop is not None else None
    image = crop_image(image, crop)

    semantic = make_semantic_matrix(image)
    zone_ids, zones = find_zones(
        semantic,
        args.meters_per_pixel,
    )

    doors = find_objects(
        semantic,
        DOOR,
        "door",
        zone_ids,
    )
    exits = find_objects(
        semantic,
        EXIT,
        "exit",
        zone_ids,
    )
    obstacles = find_objects(
        semantic,
        OBSTACLE,
        "obstacle",
        zone_ids,
    )

    output_path = args.output or image_path.with_suffix(".json")
    model = build_json_model(
        image_path,
        image,
        semantic,
        zone_ids,
        zones,
        doors,
        exits,
        obstacles,
        args.meters_per_pixel,
    )

    output_path.write_text(
        json.dumps(
            model,
            ensure_ascii=False,
            separators=(",", ":"),
        ),
        encoding="utf-8",
    )

    print(f"Wrote {output_path}")
    print(f"Image size: {image.shape[1]} x {image.shape[0]}")
    print(f"Zones: {len(zones)}")
    print(f"Doors: {len(doors)}")
    print(f"Exits: {len(exits)}")
    print(f"Obstacles: {len(obstacles)}")


if __name__ == "__main__":
    main()
