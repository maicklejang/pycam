[![Build Status](https://travis-ci.org/SebKuzminsky/pycam.svg?branch=master)](https://travis-ci.org/SebKuzminsky/pycam)

# PyCAM: a toolpath generator

PyCAM generates toolpaths (GCode) based on 2D or 3D models for 3-axis CNC machining.


## Running

Extract the archive or clone the repository.

Graphical Interface: `pycam/run_gui.py`

Scripted Toolpath Processing: `pycam/run_cli.py FLOW_SPECIFICATION_FILE`

3D Scanning from Photos: `pycam/run_photo3d.py`


## 3D scanning with a camera

PyCAM can build a 3D model from a series of photos of a real object.  Put the object onto a
turntable, take a photo after every step of the rotation and let PyCAM intersect the outlines
of all photos.  The result is a watertight STL file that is ready for toolpath generation.

    pycam/run_photo3d.py demo --output pawn.stl                 # try it without a camera
    pycam/run_photo3d.py capture ~/scans/cup --count 24         # take photos with a webcam
    pycam/run_photo3d.py reconstruct ~/scans/cup --output cup.stl
    pycam/run_photo3d.py gui                                    # the graphical scanner

See the [documentation](docs/photogrammetry.md) for the description of the capture setup.


## Resources

See the [documentation](http://pycam.sourceforge.net/introduction/) for a short introduction.

* [Website / Documentation](http://pycam.sf.net/)
* [Getting started](http://pycam.sf.net/getting-started.md)
* [FAQ](http://pycam.sf.net/faq.md)
* [Video tutorials](http://vimeo.com/channels/pycam)
* [Screenshots](http://pycam.sourceforge.net/screenshots/)
* [Mailing lists](https://sourceforge.net/p/pycam/mailman/)


## Development

* [Code Repository](https://github.com/SebKuzminsky/pycam)
* [Issue Tracker](https://github.com/SebKuzminsky/pycam/issues)


## Contributors

* Lode Leroy: initiated the project; developed the toolpath generation,
  collision detection, geometry, Tk interface, ...
* Lars Kruse: GTK interface and many features
* Paul: GCode stepping precision
* Arthur Magill: distutils packaging
* Sebastian Kuzminsky: debian packaging
* Nicholas Humfrey: documentation, recovery of old sourceforge-wiki
* Piers Titus van der Torren: documentation
* Reuben Rissler: gtk3 migration
