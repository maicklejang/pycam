[EXAMPLES]
.nf
.B pycam\-photo3d demo \-\-output pawn.stl

.fi
Reconstruct a virtual object without using a camera. This is the quickest way of checking
whether everything is installed correctly.

.nf
.B pycam\-photo3d capture ~/scans/cup \-\-count 24 \-\-distance 300 \-\-height 150

.fi
Take 24 photos of an object on a turntable with a connected camera. The camera is located
300 mm away from the rotation axis and 150 mm above the turntable.

.nf
.B pycam\-photo3d reconstruct ~/scans/cup \-\-output cup.stl \-\-resolution 200

.fi
Build a 3D model from the photos of a capture session and store it as an STL file.

[NOTES]
The reconstruction is based on the outlines (silhouettes) of the object. Concave details that
never show up in an outline (e.g. the inside of a cup) are filled up in the resulting model.

An evenly colored background and a photo of the empty turntable improve the result
considerably.

[SEE ALSO]
.BR pycam (1)

The documentation of the capture setup: http://pycam.sourceforge.net/photogrammetry/

The website of the PyCAM project: http://pycam.sourceforge.net
