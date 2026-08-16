# 3D scanning with a camera

PyCAM can build a 3D model from a series of photos of a real object.  Put the object onto a
turntable, take a photo after every step of the rotation and let PyCAM intersect the outlines
("silhouettes") of all photos.  The result is a watertight STL file that can be loaded into
PyCAM for toolpath generation.

This method is called *shape from silhouette*.  It needs no special hardware, it works with
objects that have no texture at all and it is fast - but it cannot see dents and holes that
never show up in an outline (see [limitations](#limitations)).


## Quick start without a camera

The following command reconstructs a virtual object.  It verifies that everything is installed
correctly and it shows what the result looks like:

```
pycam-photo3d demo --output pawn.stl
```


## The capture setup

```
        camera                        rotation axis
          [O]                              |
            \  distance                    |
             \--------------------------[object]
                                        =========  turntable
```

* Place the object in the middle of a turntable (a lazy susan, a potter's wheel or a cake
  stand will do).
* Use an evenly colored background: a sheet of white or colored paper behind and below the
  object works very well.  The bigger the contrast between object and background, the better.
* Fix the camera on a tripod so that it does not move between the photos.  Everything has to
  stay identical: position, zoom, focus, exposure and white balance.
* Aim the camera slightly downwards (about 20 to 40 degrees).  Otherwise the top of the object
  is never seen from above and the result will be too high.
* Keep the object completely inside the frame in every photo.
* 24 to 36 photos per full turn are a good compromise between accuracy and processing time.
* Take one additional photo of the *empty* turntable before you place the object.  This
  reference photo makes the separation of object and background much more reliable.
* Measure the distance between camera and rotation axis as well as the height of the camera
  above the turntable surface.  These two numbers define the scale of the model.


## Taking the photos

### with a camera that is connected to the computer

```
pycam-photo3d capture ~/scans/pawn --count 24 --distance 300 --height 150
```

The program asks you to turn the table between the photos.  Use `pycam-photo3d devices` to list
the available cameras and `--device` to select one of them.

### with a phone or a system camera

Copy the photos of one full turn into a directory (the alphabetical order of the file names has
to match the order of the rotation) and describe the setup:

```
pycam-photo3d prepare ~/scans/pawn --distance 300 --height 150 \
    --object-diameter 90 --object-height 120 --background empty.jpg
```

This writes a `session.json` file into the directory.  It can be edited with any text editor -
for example to correct a single angle of a photo.


## Building the model

```
pycam-photo3d reconstruct ~/scans/pawn --output pawn.stl --resolution 200
```

The most important options:

| Option | Meaning |
| --- | --- |
| `--resolution` | number of voxels along the longest axis - more detail, but slower |
| `--object-diameter` / `--object-height` | the volume that is searched for the object |
| `--method` | how the object is separated from the background (`background`, `chroma`, `threshold`) |
| `--object-size` | scale the result until its largest horizontal extent matches a measured value |
| `--max-missing-views` | tolerate a few photos in which the object was not detected properly |
| `--debug-directory` | write the detected silhouettes as images - the first thing to look at when a result is wrong |

The reconstruction reports warnings whenever something looks suspicious, e.g. when the object
touches the border of a photo or when it does not fit into the search volume.


## The graphical application

```
pycam-photo3d gui
```

The window guides through the whole process: live camera image with the detected silhouette,
one button per photo, the parameters of the setup and a preview of the finished model, which
can then be saved as STL or OBJ.

The graphical application needs `python3-tk`; the direct camera access needs `python3-opencv`.


## Calibrating the camera (optional)

The reconstruction uses the field of view of the camera (`--fov`, 60 degrees by default).  A
real calibration is more accurate: print a chessboard, take 10 to 20 photos of it from
different angles and run:

```
pycam-photo3d calibrate ~/scans/chessboard --pattern 9x6 --session ~/scans/pawn
```


## Using the model in PyCAM

The resulting STL file can be opened by PyCAM like any other model.  Inside of your own scripts
the detour via a file is not necessary:

```python
from pycam.Photogrammetry import reconstruct_session

result = reconstruct_session("~/scans/pawn")
model = result.mesh.to_pycam_model()
```


## Limitations

* Only the *visual hull* of the object is reconstructed.  Concave details that never appear in
  an outline - the inside of a cup, a drilled hole, a groove in the top surface - are filled up.
  For machining a mold or a relief this is often exactly what you want.
* The bottom of the object (the side that stands on the turntable) is not visible and is closed
  with a flat face.
* Transparent, mirroring and very dark objects are hard to separate from the background.
* The scale of the model depends on the values of `--distance` and `--height`.  If you did not
  measure them, use `--object-size` with a value that you measured on the real object.


## Requirements

| Package | Needed for |
| --- | --- |
| `python3-numpy` | everything (required) |
| `python3-opencv` | camera access, calibration, faster image processing |
| `python3-pil` | reading and writing image files (alternative to OpenCV) |
| `python3-tk` | the graphical application |
