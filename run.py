"""Run image -> semantic JSON -> NavMesh -> preview with one command.

python run.py                         # choose an image with a native picker
python run.py path/to/floorplan.png   # another image
python run.py path/to/floorplan.png --output-dir out
python run.py path/to/floorplan.png --meters-per-pixel 0.01
python run.py path/to/floorplan.png --start 100 300 --goal 850 320
python run.py path/to/floorplan.png --show-graph  # display every routing link

By default, outputs are written beside the selected image as
``<stem>.floor-map.json`` and ``<stem>.graph-preview.png``. Use ``--output-dir``
to redirect defaults, or ``--json-output`` and ``-o``/``--output`` for explicit
paths. The JSON includes semantic layers, navmesh, space_graph, routing_graph,
graph_validation and route. With no endpoints, routing starts at the first door (or floor
region) and chooses the cheapest reachable exit. CLI coordinates refer to
pixel corners.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import sys
from time import perf_counter
from typing import Sequence

sys.dont_write_bytecode = True

import cv2
import numpy as np
import image_to_json as converter
from json_to_graph import build_navmesh, prepare_navigation, render_navmesh, save_preview


def select_image() -> Path | None:
    """Open a native image picker and return the selected path, if any.

    Importing and creating Tk can fail on headless systems, so picker failures
    are treated like cancellation. The command then exits cleanly without
    selecting a bundled fixture implicitly.
    """
    try:
        import tkinter as tk
        from tkinter import filedialog
    except Exception:
        return None

    root = None
    try:
        root = tk.Tk()
        root.withdraw()
        root.update_idletasks()
        selected = filedialog.askopenfilename(
            title="Select a floor-plan image",
            parent=root,
            filetypes=[
                ("Image files", "*.png *.jpg *.jpeg *.bmp *.tif *.tiff"),
                ("All files", "*.*"),
            ],
        )
    except Exception:
        return None
    finally:
        if root is not None:
            try:
                root.destroy()
            except Exception:
                pass

    return Path(selected) if selected else None


def _path_key(path: Path) -> str:
    """Return a normalized absolute key for safe output collision checks."""
    return os.path.normcase(str(path.expanduser().resolve(strict=False)))


def derive_output_paths(
    image_path: Path,
    json_output: Path | None = None,
    preview_output: Path | None = None,
    output_dir: Path | None = None,
) -> tuple[Path, Path]:
    """Resolve JSON and preview paths from an input image and CLI overrides.

    Missing output paths use the input image's directory, or ``output_dir``
    when supplied. Explicit paths always take precedence. The returned paths
    are validated so neither output can overwrite the input or the other
    output.
    """
    image_path = Path(image_path)
    target_dir = Path(output_dir) if output_dir is not None else image_path.parent
    json_path = (Path(json_output) if json_output is not None
                 else target_dir / f"{image_path.stem}.floor-map.json")
    preview_path = (Path(preview_output) if preview_output is not None
                    else target_dir / f"{image_path.stem}.graph-preview.png")

    image_key = _path_key(image_path)
    json_key = _path_key(json_path)
    preview_key = _path_key(preview_path)
    if json_key == image_key or preview_key == image_key:
        raise ValueError("Output paths must not overwrite the input image")
    if json_key == preview_key:
        raise ValueError("JSON output and preview must use different paths")
    if json_path.suffix.lower() != ".json":
        raise ValueError("Use .json for JSON output")
    if preview_path.suffix.lower() != ".png":
        raise ValueError("Use .png for the preview")
    return json_path, preview_path


def convert(image_path: Path, meters_per_pixel: float | None = None,
            crop: tuple[int, int, int, int] | None = None) -> dict:
    """Build a runtime model with semantic and zone matrices in memory.

    The returned model keeps both layers as raw NumPy arrays so navmesh,
    routing, and preview work without an RLE round-trip. Call
    ``image_to_json.to_json_model`` at the JSON serialization boundary.
    """
    image = cv2.imdecode(np.fromfile(image_path, dtype=np.uint8), cv2.IMREAD_COLOR)
    if image is None:
        raise ValueError(f"Could not decode image: {image_path}")
    image = converter.crop_image(image, crop)
    semantic = converter.make_semantic_matrix(image)
    zone_ids, zones = converter.find_zones(semantic, meters_per_pixel)
    objects = [converter.find_objects(semantic, label, prefix, zone_ids)
               for label, prefix in ((converter.DOOR, "door"), (converter.EXIT, "exit"),
                                     (converter.OBSTACLE, "obstacle"))]
    model = converter.build_json_model(image_path, image, semantic, zone_ids, zones,
                                       *objects, meters_per_pixel,
                                       encode_layers=False)
    model["navmesh"] = build_navmesh(model)
    return model


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("image", nargs="?", type=Path,
                        help="Input floor-plan image; open a picker when omitted")
    parser.add_argument("--json-output", type=Path,
                        help="JSON output path (default: beside the input image)")
    parser.add_argument("-o", "--output", type=Path,
                        help="Preview output path (default: beside the input image)")
    parser.add_argument("--output-dir", type=Path,
                        help="Directory for default JSON and preview outputs")
    parser.add_argument("--meters-per-pixel", type=float)
    parser.add_argument("--crop", type=int, nargs=4, metavar=("X", "Y", "WIDTH", "HEIGHT"))
    parser.add_argument("--start", type=float, nargs=2, metavar=("X", "Y"), help="Start in cropped-image pixel coordinates")
    parser.add_argument("--goal", type=float, nargs=2, metavar=("X", "Y"), help="Destination; otherwise choose a reachable exit")
    parser.add_argument("--show-graph", action="store_true", help="Show all portal graph links for debugging")
    args = parser.parse_args(argv)

    image_path = args.image if args.image is not None else select_image()
    if image_path is None:
        print("No image selected; exiting.", file=sys.stderr)
        return 0
    image_path = Path(image_path)

    try:
        json_output, preview_output = derive_output_paths(
            image_path,
            json_output=args.json_output,
            preview_output=args.output,
            output_dir=args.output_dir,
        )
    except ValueError as error:
        parser.error(str(error))

    for output_path in (json_output, preview_output):
        output_path.parent.mkdir(parents=True, exist_ok=True)

    started = perf_counter()
    model = convert(image_path, args.meters_per_pixel, tuple(args.crop) if args.crop else None)
    mesh = model["navmesh"]
    prepare_navigation(model, args.start, args.goal)
    preview = render_navmesh(model, mesh, args.show_graph)
    payload = json.dumps(converter.to_json_model(model), ensure_ascii=False,
                         separators=(",", ":"), allow_nan=False)
    json_output.write_text(payload, encoding="utf-8")
    save_preview(preview_output, preview)
    print(f"Input: {image_path}")
    print(f"NavMesh: {len(mesh['regions'])} regions, {len(mesh['edges'])} portals")
    validation = model["graph_validation"]
    summary = validation["summary"]
    print(
        "Graph validation: "
        f"{validation['status']} | "
        f"{summary['connected_component_count']} component(s), "
        f"{summary['reachable_exit_count']} reachable exit(s), "
        f"{summary['isolated_region_count']} isolated region(s)"
    )
    route = model["route"]
    print(f"Route: {route['status']}" + (f"; length {route['length_px']:.2f}px" if route['status'] == 'ok' else ''))
    print(f"JSON: {json_output}")
    print(f"Preview: {preview_output}")
    print(f"Done in {perf_counter()-started:.3f}s")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
