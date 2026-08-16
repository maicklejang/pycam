# Mobile Viewer (STL / STEP / DXF)

PyCAM ships a small companion web app that opens **STL**, **STEP/STP** and **DXF** files
directly on a phone or tablet.  It is a Progressive Web App: install it once from the
browser and it launches full screen and works offline.  Parsing and rendering happen on the
device - no file is uploaded anywhere.

## Starting it

```sh
python3 mobile/serve.py
```

The command prints two addresses.  Open the LAN address on your phone (both devices on the
same Wi-Fi) and choose *Add to home screen* in the browser menu.  The `mobile/` directory is
plain static HTML/JS, so it can equally be published on any web server or on GitHub Pages.

Offline mode and installation require `localhost` or an HTTPS origin, because service
workers are not available over plain HTTP.

To publish it on GitHub Pages, set *Settings → Pages → Source* to **GitHub Actions**.  The
`Deploy mobile viewer` workflow uploads the `mobile/` directory on its own, and the viewer is
then reachable at `https://<user>.github.io/<repo>/`.  Publishing the whole repository from a
branch does not work: both Pages build modes walk the entire tree and stop at
`debian/pycam.mime`, which is a dangling symlink.

## Using it

* One finger rotates the model (pans on 2D drawings), two fingers pinch to zoom and drag to
  pan, a double tap fits the model to the screen.
* The side buttons cover fit, standard views, display mode (solid / solid + edges /
  wireframe), the grid, and exporting the current view as a PNG.
* The bottom sheet shows the bounding box dimensions, triangle, face and entity counts,
  the drawing units, and - for DXF - the layer list with per-layer visibility.
* The ruler button measures: tap two points and the readout gives the distance and its
  X/Y/Z components.  Taps snap to corners first, then to edges, then to the surface, so a
  measurement between two features is repeatable.  Rotating and zooming still work while
  measuring - only a tap picks a point.

## Opening files from the file manager

On the desktop, installing the app registers it for `.stl`, `.step` and `.dxf`, so a
double click opens the viewer.  On Android a web app cannot register itself that way: share
the file into the installed app instead, or install the small APK wrapper built from
`android/`, which does appear in the *Open with* list.  iOS supports neither, so files have
to be picked from inside the app.

## What is supported

* **STL** - binary and ASCII.
* **DXF** - lines, arcs, circles, ellipses, polylines with bulges, splines, solids, faces
  and block inserts, with layer colours and extrusion directions.  Text, dimensions and
  hatch fills are not drawn.
* **STEP** - AP203 / AP214 / AP242 boundary representations.  Planes, cylinders, cones,
  spheres and tori are tessellated analytically; other surfaces are approximated by a
  planar fit of their boundary and always remain visible as wireframe.

Anything the viewer could not draw is listed in the info panel rather than silently
dropped.  See `mobile/README.md` in the source tree for the full details.
