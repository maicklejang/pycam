# PyCAM Viewer - STL / STEP / DXF on your phone

A self-contained, installable web app (PWA) that opens **STL**, **STEP/STP** and **DXF**
files directly on a phone. Everything - parsing, tessellation and rendering - runs on the
device: no upload, no server, no account, and no third party libraries.

<!-- 스마트폰에서 STL, STEP, DXF 파일을 바로 열어보는 설치형 웹앱입니다.
     파일은 기기 밖으로 나가지 않으며, 홈 화면에 추가하면 오프라인에서도 앱처럼 동작합니다. -->

## Quick start

```sh
python3 mobile/serve.py            # serves mobile/ on port 8000
```

Open the printed address on your phone (same Wi-Fi), then use the browser menu →
**Add to home screen**. After that it launches full screen and works offline.

You can also host the `mobile/` directory on any static web server or on GitHub Pages -
it is plain HTML/CSS/JS with no build step.

For GitHub Pages, point the publishing source at a branch with the `/ (root)` folder and
open `https://<user>.github.io/<repo>/mobile/`.  The `.nojekyll` file in the repository root
is required: Pages otherwise runs a Jekyll build, which fails on this repository because
`debian/pycam.mime` is a dangling symlink.

> Service workers (offline mode, share target, home screen install) need `localhost` or
> **HTTPS**. Over plain `http://192.168.x.x` the viewer still works, it just is not
> installable.

## What it does

| | |
|---|---|
| **Open** | file picker, drag & drop, `?url=…`, "share to app" from another app, OS file association |
| **View** | orbit / pan / pinch zoom, isometric + 6 standard views, perspective or orthographic |
| **Inspect** | bounding box dimensions, triangle / face / entity counts, units, DXF layers with visibility toggles |
| **Display** | solid, solid + edges, wireframe, grid, axes, bounding box |
| **Share** | export the current view as a PNG (Web Share or download) |
| **Remember** | the last 5 files (up to 32 MB each) are kept in IndexedDB for one-tap reopening |

Gestures: one finger rotates (pans for 2D drawings), two fingers pinch to zoom and drag to
pan, double tap fits the model. On a desktop: left drag rotates, right/middle drag pans,
the wheel zooms, and `F` / `0` / `1` / `2` / `3` / `O` are shortcuts for fit, isometric,
front, right, top and open.

## Format support

### STL
Binary and ASCII, with geometric face normals (stored normals are ignored because they are
unreliable in practice). Degenerate triangles and per-facet colour attributes are reported
in the info panel.

### DXF
ASCII DXF (R12 through current releases):
`LINE`, `POINT`, `CIRCLE`, `ARC`, `ELLIPSE`, `LWPOLYLINE` (including bulges), `POLYLINE` /
`VERTEX` (2D and 3D), `SPLINE` (NURBS with knots and weights, or fit points), `SOLID`,
`TRACE`, `3DFACE`, `LEADER` and `INSERT` (nested blocks, row/column arrays, rotation,
scaling). Layers keep their ACI colours and can be switched on and off individually,
extrusion directions (OCS) are honoured, and `$INSUNITS` is reported.

Not drawn: text, dimensions, hatch fills and binary DXF - the info panel lists whatever was
skipped instead of silently dropping it.

### STEP (ISO 10303-21, AP203 / AP214 / AP242)
The file is parsed into an entity table and the B-rep is walked
(solid → shell → face → loop → edge → curve). Every face is trimmed and tessellated in its
surface parameter space:

* **Surfaces**: plane, cylinder, cone, sphere and torus are evaluated analytically, so
  vertex normals are exact and curved faces shade smoothly. Other surface types
  (B-spline, extrusion, revolution) fall back to a planar fit of their boundary.
* **Curves**: line, circle, ellipse, B-spline (rational included), polyline, trimmed,
  surface/seam and composite curves.
* **Quality**: ear clipping produces the initial triangulation, Delaunay edge flips remove
  the long chords it likes to create, and triangles are then subdivided until they stay
  within 0.4 % of the true surface. Verified against analytic volume and surface area in
  the test suite.
* **Assemblies**: `MAPPED_ITEM` placements and
  `REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION` links are applied. Placement for deeply
  nested assemblies is best effort - if the graph cannot be resolved, parts are drawn in
  their own coordinate system.

Faces that cannot be tessellated are still shown as wireframe and counted in the info
panel, so nothing disappears without a note.

## Layout

```
mobile/
  index.html                 app shell
  css/app.css                dark, mobile first UI
  js/viewer.js               WebGL renderer, orbit camera, touch handling
  js/app.js                  file intake, worker orchestration, UI state
  js/i18n.js                 Korean / English strings
  js/worker.js               runs the parsers off the main thread
  js/parsers/                stl.js, dxf.js, step.js, triangulate.js, common.js, index.js
  sw.js                      offline cache + Web Share Target
  manifest.webmanifest       PWA metadata, share target, file handlers
  serve.py                   local development server
  tools/make_icons.py        regenerates the PNG icons
  tests/                     fixture generator + parser test suite
```

## Tests

```sh
node mobile/tests/run_tests.js          # parser + geometry test suite
python3 mobile/tests/make_fixtures.py   # regenerate the STEP/DXF/STL fixtures
```

The STEP tests check tessellated surface area, signed volume and normal orientation against
the analytic values of the generated solids, which is what catches winding, seam and
trimming mistakes.

## Notes and limits

* Large files are parsed in a Web Worker; the mesh is capped at 4 M triangles and the
  wireframe overlay at 400 k triangles to stay within phone memory.
* Assembly colours and STEP presentation styles are not read - everything renders in a
  single material.
* iOS Safari supports installation and offline use, but not the Web Share Target, so on iOS
  open files through the picker rather than sharing them into the app.
