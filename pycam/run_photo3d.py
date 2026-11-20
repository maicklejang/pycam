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
"""

import os
import sys

try:
    import pycam  # noqa: F401 (just a check for a usable import path)
except ImportError:
    # running locally (without a proper PYTHONPATH) requires manual intervention
    sys.path.insert(0, os.path.realpath(os.path.join(os.path.dirname(os.path.realpath(__file__)),
                                                     os.pardir)))

from pycam.Photogrammetry.cli import main_func  # noqa: E402 (the path fix has to come first)


if __name__ == "__main__":
    sys.exit(main_func())
