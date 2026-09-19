import copy
import json
from pathlib import Path
import unittest

import image_to_json as converter
import numpy as np
from json_to_graph import prepare_navigation, validate_graph
from run import convert


FIXTURE = Path(__file__).with_name("floor_plans") / "floor_plan_01_basic.png"


class GraphValidatorTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.model = convert(FIXTURE)
        prepare_navigation(cls.model)

    def checked_copy(self):
        return copy.deepcopy(self.model)

    def report_for(self, mutate):
        model = self.checked_copy()
        mutate(model)
        return validate_graph(model)

    @staticmethod
    def codes(report):
        return {issue["code"] for issue in report["issues"]}

    def test_clean_fixture_is_valid_and_json_serializable(self):
        report = validate_graph(self.model)
        self.assertEqual(report["status"], "valid")
        self.assertEqual(report["summary"], {
            "region_count": 4,
            "portal_count": 3,
            "connected_component_count": 1,
            "reachable_exit_count": 1,
            "isolated_region_count": 0,
        })
        json.dumps(report, allow_nan=False)

    def test_clean_fixtures_have_valid_reports(self):
        for filename in (
            "floor_plan_01_basic.png",
            "floor_plan_02_rooms_corridor.png",
            "floor_plan_05_noisy_walls.png",
        ):
            with self.subTest(fixture=filename):
                model = convert(FIXTURE.with_name(filename))
                prepare_navigation(model)
                self.assertEqual(model["graph_validation"]["status"], "valid")

    def test_prepare_navigation_attaches_report_to_export(self):
        model = self.checked_copy()
        prepare_navigation(model)
        exported = converter.to_json_model(model)
        self.assertEqual(exported["graph_validation"], model["graph_validation"])
        self.assertEqual(exported["graph_validation"]["status"], "valid")

    def test_floor_region_without_exit_is_reported_as_warning(self):
        report = self.report_for(
            lambda model: model["navmesh"]["edges"].pop(0)
        )
        codes = self.codes(report)
        self.assertIn("floor_region_no_reachable_exit", codes)
        self.assertEqual(report["status"], "warning")

    def test_door_must_connect_two_source_zones(self):
        report = self.report_for(
            lambda model: model["doors"][0].update({"neighbour_zones": [1]})
        )
        self.assertIn("door_not_two_floor_zones", self.codes(report))
        self.assertEqual(report["status"], "error")

    def test_exit_must_touch_walkable_region(self):
        report = self.report_for(
            lambda model: model["exits"][0].update({"neighbour_zones": []})
        )
        self.assertIn("exit_not_connected_to_walkable", self.codes(report))

    def test_isolated_navmesh_and_routing_nodes_are_reported(self):
        def isolate(model):
            model["navmesh"]["edges"].clear()
            model["routing_graph"]["edges"].clear()

        report = self.report_for(isolate)
        codes = self.codes(report)
        self.assertIn("isolated_navmesh_region", codes)
        self.assertIn("isolated_routing_node", codes)
        self.assertGreater(report["summary"]["isolated_region_count"], 0)

    def test_duplicate_and_self_loop_portals_are_structural_errors(self):
        def mutate(model):
            duplicate = copy.deepcopy(model["navmesh"]["edges"][0])
            duplicate["id"] = 99
            duplicate["source"], duplicate["target"] = (
                duplicate["target"], duplicate["source"]
            )
            duplicate["portal_px"] = list(reversed(duplicate["portal_px"]))
            model["navmesh"]["edges"].append(duplicate)
            loop = copy.deepcopy(model["navmesh"]["edges"][0])
            loop["id"] = 100
            loop["source"] = loop["target"] = 1
            model["navmesh"]["edges"].append(loop)

        codes = self.codes(self.report_for(mutate))
        self.assertIn("duplicate_portal_edge", codes)
        self.assertIn("self_loop_portal", codes)

    def test_zero_width_portal_is_invalid(self):
        report = self.report_for(
            lambda model: model["navmesh"]["edges"][0].update({"width_px": 0})
        )
        self.assertIn("zero_width_portal", self.codes(report))

    def test_malformed_portal_geometry_is_invalid(self):
        report = self.report_for(
            lambda model: model["navmesh"]["edges"][0].update({
                "portal_px": [[474, 285], [475, 286]],
            })
        )
        self.assertIn("malformed_portal_geometry", self.codes(report))

    def test_region_bounds_outside_image_are_invalid(self):
        report = self.report_for(
            lambda model: model["navmesh"]["regions"][0].update({
                "bounds_px": [-1, 0, 474, 568],
            })
        )
        self.assertIn("region_bounds_out_of_bounds", self.codes(report))

    def test_overlap_and_pixel_coverage_are_detected(self):
        def overlap(model):
            model["navmesh"]["regions"][1]["bounds_px"] = list(
                model["navmesh"]["regions"][0]["bounds_px"]
            )

        codes = self.codes(self.report_for(overlap))
        self.assertIn("overlapping_regions", codes)
        self.assertIn("walkable_pixel_overcovered", codes)
        self.assertIn("walkable_pixel_uncovered", codes)

    def test_region_without_routing_participation_is_reported(self):
        def remove_region_participation(model):
            target = model["navmesh"]["regions"][0]["id"]
            model["routing_graph"]["nodes"] = [
                node for node in model["routing_graph"]["nodes"]
                if target not in node.get("region_ids", [])
            ]
            model["routing_graph"]["edges"] = [
                edge for edge in model["routing_graph"]["edges"]
                if edge["source"] < 0 or edge["target"] < 0
            ]

        report = self.report_for(remove_region_participation)
        self.assertIn("region_missing_routing_participation", self.codes(report))

    def test_single_direct_floor_exit_portal_node_is_valid(self):
        model = {
            "layers": {
                "semantic": np.array([[0, 0, 3, 3]], dtype=np.uint8),
                "zone_id": np.array([[1, 1, 0, 0]], dtype=np.int32),
            },
            "grid": {"meters_per_pixel": None},
            "zones": [{"id": 1, "type": "unclassified"}],
            "doors": [],
            "exits": [{
                "id": "exit_1",
                "centroid_px": [2, 0],
                "neighbour_zones": [1],
            }],
            "obstacles": [],
        }
        prepare_navigation(model)
        self.assertEqual(len(model["routing_graph"]["nodes"]), 1)
        self.assertEqual(model["routing_graph"]["edges"], [])
        self.assertEqual(model["route"]["status"], "ok")
        self.assertEqual(model["graph_validation"]["status"], "valid")
        self.assertNotIn(
            "isolated_routing_node",
            self.codes(model["graph_validation"]),
        )


if __name__ == "__main__":
    unittest.main()
