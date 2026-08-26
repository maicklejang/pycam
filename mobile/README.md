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

For GitHub Pages, set **Settings → Pages → Source** to *GitHub Actions*: the
`.github/workflows/pages.yml` workflow publishes this directory alone, and the app then lives
at `https://<user>.github.io/<repo>/`.

Do not publish the whole repository from a branch.  Both Pages modes walk the entire tree and
fail on it - the Jekyll build cannot resolve `debian/pycam.mime`, a dangling symlink, and the
static upload step dereferences symlinks and fails the same way.  (`.nojekyll` in the
repository root is still there to keep Jekyll out of the way.)

> Service workers (offline mode, share target, home screen install) need `localhost` or
> **HTTPS**. Over plain `http://192.168.x.x` the viewer still works, it just is not
> installable.

## What it does

| | |
|---|---|
| **Open** | file picker, drag & drop, `?url=…`, "share to app" from another app, OS file association |
| **View** | orbit / pan / pinch zoom, isometric + 6 standard views, perspective or orthographic |
| **Inspect** | bounding box dimensions, triangle / face / entity counts, units, DXF layers with visibility toggles |
| **Measure** | tap two points for the distance and its X/Y/Z components, snapping to corners and edges |
| **Section** | slice the model on X, Y or Z with a slider; the cut is capped, so it reads as a real section |
| **Display** | solid, solid + edges, wireframe, grid, axes, bounding box, light or dark viewport |
| **Parts** | a STEP file with several solids gets one colour per part, switchable in the view tab |
| **Share** | export the current view as a PNG (Web Share or download) |
| **Remember** | the last 5 files (up to 32 MB each) are kept in IndexedDB for one-tap reopening |

Gestures: one finger rotates (pans for 2D drawings), two fingers pinch to zoom and drag to
pan, double tap fits the model. On a desktop: left drag rotates, right/middle drag pans,
the wheel zooms, and `F` / `0` / `1` / `2` / `3` / `O` are shortcuts for fit, isometric,
front, right, top and open.

## Measuring

The ruler button turns the canvas into a measuring surface: tap two points and the bar
above the info panel shows the distance between them plus the ΔX / ΔY / ΔZ components, in
the drawing's own units when the file states them.  Rotating, panning and zooming keep
working while measuring; only a tap (a press that does not turn into a drag) picks a point.

Taps snap, in this order:

1. **Corners** - end points of model edges, or of the triangle under the finger, within
   26 px of the tap.  This is what makes a measurement repeatable.
2. **Edges** - the closest point along a model edge, with the projection undone so that a
   point picked half way across the screen is not reported half way along in space.
3. **Faces** - wherever the ray meets the surface, when nothing sharper is nearby.

An edge only wins over a face when it is not hidden behind it, so a tap picks what is
actually visible.  The picked points are drawn as markers that stay on top of the model.

## Section view

The section button cuts the model with a plane: pick the axis, drag the slider to move the
plane through the model, and use the flip button to keep the other half.  The value next to
the slider is the plane's position in model coordinates.

The cut is **capped**: without a cap a clipped solid looks hollow, because you end up staring
at the inside of its far wall.  The cap is produced with the usual stencil trick - draw the
clipped mesh counting front and back faces per pixel, then fill a quad on the plane wherever
that count says the plane passes through solid material.  It needs a closed mesh to be exact;
an open shell (a surface model, or a STEP file with faces the tessellator had to skip) may cap
partially.

Clipping runs in the fragment shader, so it costs nothing to drag the slider around, and the
grid, axes and measurement markers deliberately stay unclipped.

## Part colours

A STEP file that contains more than one solid is coloured per part: every item of a shape
representation - which is what a person means by "a part" - gets its own hue, spread with the
golden ratio so that neighbouring parts never land on the same colour, and kept at low
saturation so shading still reads.  Single-part files, STL and DXF keep the plain material,
and the switch in the **View** tab turns the colouring off.

The colours ride along as one byte per channel per vertex, which costs a quarter of what a
float colour would and keeps a large assembly inside a phone's memory.  STEP presentation
styles (the colours a CAD system stored in the file) are still not read - these are the
viewer's own, assigned so that parts can be told apart.

## Background

The viewport is a light grey gradient by default, which is what CAD viewers use and what
survives being looked at outdoors.  The **View** tab switches between the light and the dark
palette - model, edges, grid, axes and the whole UI follow along, and the choice is
remembered.  DXF layer colours are pulled back from white when the background is light, so a
drawing on layer colour 7 stays visible either way.

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

## Opening files from the system

| | |
|---|---|
| **Desktop Chrome / Edge** | install the app, then `.stl`/`.step`/`.dxf` open on a double click (`file_handlers` in the manifest) |
| **Android** | share a file into the installed app (`share_target`).  For a real *Open with* entry, install the APK wrapper in [`../android`](../android) - the manifest's `file_handlers` are desktop only |
| **iOS** | neither file handlers nor share targets exist for web apps; open files with the in-app picker |

## Notes and limits

* Large files are parsed in a Web Worker; the mesh is capped at 4 M triangles and the
  wireframe overlay at 400 k triangles to stay within phone memory.
* STEP presentation styles are not read; multi-solid files are coloured by the viewer
  instead.  Back faces are shaded almost like front faces on purpose: real assemblies
  contain parts wound the other way round, and a contrasting back face only turned those
  into a differently coloured blob.
* The service worker serves from the network first and keeps its cache as the offline
  copy, so a new release shows up on the next start rather than the one after it.
* iOS Safari supports installation and offline use, but not the Web Share Target, so on iOS
  open files through the picker rather than sharing them into the app.
