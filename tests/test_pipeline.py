import json
from pathlib import Path
import unittest
from unittest.mock import patch

import numpy as np

import image_to_json as converter
from json_to_graph import build_navmesh, prepare_navigation, render_navmesh
from run import convert


FIXTURES = sorted(Path(__file__).with_name("floor_plans").glob("*.png"))


class PipelineTests(unittest.TestCase):
    def test_raw_and_serialized_pipeline_match_for_every_fixture(self):
        for image_path in FIXTURES:
            with self.subTest(image=image_path.name):
                raw = convert(image_path)
                prepare_navigation(raw)
                raw_mesh = raw["navmesh"]
                raw_route = raw["route"]
                raw_preview = render_navmesh(raw, raw_mesh)

                loaded = json.loads(json.dumps(converter.to_json_model(raw)))
                loaded_mesh = build_navmesh(loaded)
                prepare_navigation(loaded)
                loaded_preview = render_navmesh(loaded, loaded_mesh)

                self.assertEqual(raw_mesh, loaded_mesh)
                self.assertEqual(raw_route, loaded["route"])
                np.testing.assert_array_equal(raw_preview, loaded_preview)

    def test_raw_pipeline_does_not_call_rle_helpers(self):
        image_path = FIXTURES[0]
        fail = AssertionError("RLE helper called during raw pipeline")
        with patch.object(converter, "encode_rle_layer", side_effect=fail), \
             patch.object(converter, "decode_rle_layer", side_effect=fail):
            model = convert(image_path)
            prepare_navigation(model)
            render_navmesh(model, model["navmesh"])

        self.assertIsInstance(model["layers"]["semantic"], np.ndarray)
        self.assertIsInstance(model["layers"]["zone_id"], np.ndarray)

    def test_export_preserves_runtime_layers(self):
        model = convert(FIXTURES[0])
        semantic = model["layers"]["semantic"].copy()
        zone_ids = model["layers"]["zone_id"].copy()

        exported = converter.to_json_model(model)

        np.testing.assert_array_equal(model["layers"]["semantic"], semantic)
        np.testing.assert_array_equal(model["layers"]["zone_id"], zone_ids)
        self.assertEqual(exported["layers"]["semantic"]["encoding"], "rle_rows")
        self.assertEqual(exported["layers"]["zone_id"]["encoding"], "rle_rows")

    def test_raw_and_loaded_layer_validation(self):
        model = convert(FIXTURES[0])
        loaded = json.loads(json.dumps(converter.to_json_model(model)))
        self.assertEqual(build_navmesh(model), build_navmesh(loaded))

        for bad_layer in (
            np.zeros((2, 2), dtype=np.float32),
            np.zeros((2,), dtype=np.uint8),
            np.zeros((0, 2), dtype=np.uint8),
        ):
            invalid = dict(model)
            invalid["layers"] = dict(model["layers"])
            invalid["layers"]["semantic"] = bad_layer
            with self.subTest(dtype=bad_layer.dtype, shape=bad_layer.shape):
                with self.assertRaises(ValueError):
                    build_navmesh(invalid)


if __name__ == "__main__":
    unittest.main()
