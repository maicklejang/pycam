#!/usr/bin/env python3
"""
Copyright 2026 PyCAM contributors

This file is part of PyCAM.

PyCAM is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

PyCAM is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with PyCAM.  If not, see <http://www.gnu.org/licenses/>.


The entry point of the Android application ("PyCAM 3D scanner").

The same file starts the application on a desktop computer, which is the easiest way of
trying it out:

    python3 android/main.py            # uses a connected camera
    python3 android/main.py --demo     # uses a virtual test object
"""

import os
import sys

BASE_DIR = os.path.dirname(os.path.realpath(__file__))
if BASE_DIR not in sys.path:
    sys.path.insert(0, BASE_DIR)


def _add_pycam_to_path():
    """ find the "pycam" package

    Inside of the APK it is stored next to this file (see "prepare_package.py").  In a source
    checkout it lives in the parent directory.
    """
    import importlib.util
    if importlib.util.find_spec("pycam") is not None:
        return
    parent = os.path.dirname(BASE_DIR)
    if os.path.isdir(os.path.join(parent, "pycam")):
        sys.path.insert(0, parent)


def main():
    os.environ.setdefault("KIVY_NO_ARGS", "1")
    _add_pycam_to_path()
    from photo3d.app import run
    run(camera_mode="demo" if "--demo" in sys.argv else None)


if __name__ == "__main__":
    main()
