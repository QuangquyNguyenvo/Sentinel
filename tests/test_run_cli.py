import contextlib
import io
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import patch

from run import derive_output_paths, main


FIXTURE = Path(__file__).with_name("floor_plans") / "floor_plan_01_basic.png"


class RunCliTests(unittest.TestCase):
    def test_defaults_follow_input_stem_and_directory(self):
        image = Path("plans") / "office.png"

        json_path, preview_path = derive_output_paths(image)

        self.assertEqual(json_path, Path("plans/office.floor-map.json"))
        self.assertEqual(preview_path, Path("plans/office.graph-preview.png"))

    def test_output_dir_redirects_defaults_but_explicit_paths_win(self):
        image = Path("plans") / "office.png"
        output_dir = Path("exports")
        explicit_json = Path("custom") / "map.json"

        json_path, preview_path = derive_output_paths(
            image,
            json_output=explicit_json,
            output_dir=output_dir,
        )

        self.assertEqual(json_path, explicit_json)
        self.assertEqual(preview_path, output_dir / "office.graph-preview.png")

    def test_output_paths_reject_input_and_each_other(self):
        image = Path("plans") / "office.png"

        with self.assertRaisesRegex(ValueError, "overwrite the input"):
            derive_output_paths(image, preview_output=image)
        with self.assertRaisesRegex(ValueError, "different paths"):
            derive_output_paths(image, json_output=Path("same.json"),
                                preview_output=Path("same.json"))

    def test_cancelled_picker_exits_without_running_pipeline(self):
        output = io.StringIO()
        with patch("run.select_image", return_value=None) as picker, \
                patch("run.convert") as convert, \
                contextlib.redirect_stderr(output):
            result = main([])

        self.assertEqual(result, 0)
        picker.assert_called_once_with()
        convert.assert_not_called()
        self.assertIn("No image selected", output.getvalue())

    def test_picker_selection_uses_derived_outputs_and_creates_parents(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            image = root / "selected.png"
            shutil.copy2(FIXTURE, image)
            output_dir = root / "nested" / "exports"
            stdout = io.StringIO()

            with patch("run.select_image", return_value=image) as picker, \
                    contextlib.redirect_stdout(stdout):
                result = main(["--output-dir", str(output_dir)])

            self.assertEqual(result, 0)
            picker.assert_called_once_with()
            self.assertTrue((output_dir / "selected.floor-map.json").is_file())
            self.assertTrue((output_dir / "selected.graph-preview.png").is_file())
            self.assertIn(str(output_dir / "selected.floor-map.json"), stdout.getvalue())
            self.assertIn(str(output_dir / "selected.graph-preview.png"), stdout.getvalue())


if __name__ == "__main__":
    unittest.main()
