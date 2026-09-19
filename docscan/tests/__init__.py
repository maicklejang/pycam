"""Test helpers for docscan.

The document scanner needs OpenCV and numpy, which are not required by the
rest of this repository.  The tests therefore skip themselves when those
libraries are missing instead of failing the whole test run.
"""

import unittest

try:
    import cv2  # noqa: F401
    import numpy  # noqa: F401
    HAVE_OPENCV = True
except ImportError:
    HAVE_OPENCV = False

requires_opencv = unittest.skipUnless(HAVE_OPENCV, "OpenCV and numpy are required")
