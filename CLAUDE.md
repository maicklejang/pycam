# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

PyCAM is a toolpath (GCode) generator for 3-axis CNC machining based on 2D or 3D models.
Python 3 only, GPL v3. There are two frontends:

- GTK3 GUI: `pycam/run_gui.py` (installed as `pycam`)
- Headless CLI: `pycam/run_cli.py FLOW_SPEC.yml` (installed as `pycam-cli`), driven by YAML
  "flow" description files

Both entry scripts insert the repository root into `sys.path` when needed, so the repo runs
in-place without installation.

## Commands

Runtime dependencies: `requirements.txt` (PyOpenGL, PyYAML, svg.path). The GUI additionally
needs PyGObject/GTK3 (`python3-gi`, `gir1.2-gtk-3.0`) — see `INSTALL.md`.

```sh
# full check suite: spelling + flake8 + pytest + yaml-flow smoke test
make test

# unit tests only (Makefile's "make pytest" uses the legacy /usr/bin/py.test-3 name)
python3 -m pytest pycam/Test

# a single test file / single test
python3 -m pytest pycam/Test/test_polygon.py
python3 -m pytest pycam/Test/test_polygon.py -k <pattern>

# lint (flake8; config in setup.cfg: max-line-length=99 plus several ignores)
make check-style

# spelling (codespell with .codespell.exclude)
make check-spelling

# end-to-end smoke test: runs run_cli.py on yaml_flow_working.yml and checks the
# generated test.ngc
make check-yaml-flow

# optional deeper linting
make pylint-relaxed
make pylint-strict

# docs website (mkdocs from docs/) and man pages
make docs
make man
```

CI (`.github/workflows/ci.yml`) runs in a `debian:bullseye` container: it checks
`--help`/`--version` of both entry points, then builds and installs the Debian package
(`dpkg-buildpackage`).

## Architecture

### Toolpath generation pipeline

The core data flow is:

Importers → `Geometry.Model` → PathGenerators (using a Cutter + `Toolpath.MotionGrid`)
→ Toolpath → Exporters (GCode)

- `pycam/Geometry/` — geometric primitives and math (Triangle, Line, Polygon, Plane,
  kd-trees, intersection code) plus the `Model` containers (triangle meshes and 2D
  contour models).
- `pycam/Importers/` — model loaders: STL, DXF, SVG, PS, CXF (engraving fonts).
- `pycam/Cutters/` — tool shape models (cylindrical, spherical, toroidal); they implement
  the collision/height calculations the path generators rely on.
- `pycam/PathGenerators/` — machining strategies: `DropCutter` (drops the tool vertically
  onto the model along a grid — surfacing), `PushCutter` (pushes the tool horizontally
  through Z-slices — roughing/contouring), `EngraveCutter`, `ContourFollow`.
  `technical_details.txt` has a short prose description of these algorithms.
- `pycam/PathProcessors/` — convert the generators' scanline hits into path patterns
  (e.g. `PolygonCutter`, `ContourCutter`).
- `pycam/Toolpath/` — toolpath representation, `MotionGrid` (grid/spiral movement
  patterns), filters (`Filters.py`, e.g. safety height, step conversion), support grids.
- `pycam/Exporters/` — GCode (LinuxCNC dialect, in `Exporters/GCode/`), STL, SVG.

### Declarative workspace layer (the YAML flow schema)

- `pycam/workspace/data_models.py` is the central data model. It defines collections of
  `Tool`, `Process`, `Boundary`, `Task`, `Model`, `Toolpath`, `ExportSettings` and
  `Export` items. Each is a `BaseCollectionItemDataContainer` with declared, validated
  attributes; these classes *are* the schema of the YAML flow files and encapsulate how
  a Task turns tools/processes/bounds into a toolpath.
- `pycam/Flow/parser.py` (`parse_yaml`/`dump_yaml`) maps YAML sections (`tools`,
  `processes`, `bounds`, `tasks`, `models`, `toolpaths`, `export_settings`, `exports`)
  onto those collections. `yaml_flow_working.yml` is a minimal working example;
  `yaml_flow_example.yml` documents more options (not all implemented).
- Both the GUI and the CLI operate on these same collections, so functional changes
  should normally go into the workspace/flow layer, not into a frontend.

### Plugins and events

- Almost all application functionality (model transformations, tool/process/task
  parameter handling, OpenGL view, export dialogs, …) lives in `pycam/Plugins/` — one
  class per file, GUI and non-GUI plugins mixed. `pycam/Plugins/__init__.py` contains
  `PluginBase` and the `PluginManager` that discovers and loads them.
- Plugins do not call each other directly: they communicate through the event/settings
  system (`pycam/Utils/events.py`, `EventCore` with `register_event`/`emit_event`, plus
  shared settings values). GUI plugins declare `UI_FILE` referencing GTK builder XML in
  `share/ui/`.
- The GUI (`pycam/Gui/`) uses GTK3 via PyGObject and renders the 3D view with legacy
  fixed-function OpenGL (`GDK_GL=legacy` is forced in `Plugins/__init__.py`).

### Tests

Unit tests live in `pycam/Test/` (pytest style) with input files in
`pycam/Test/assets/`; sample models for manual testing are in `samples/`.

## Conventions

- flake8 line length is 99 (`setup.cfg`); run `make check-style` before committing.
- Source files carry the GPL v3 license header.
- `pycam/Version.py` is generated by `make update-version` (and removed by
  `make clean`); do not commit it.
