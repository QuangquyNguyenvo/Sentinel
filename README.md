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
