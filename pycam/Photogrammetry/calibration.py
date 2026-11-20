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


Optional calibration of the camera with a printed chessboard.

The reconstruction works with an estimated field of view, but a real calibration improves the
accuracy of the result noticeably.  Print a chessboard, take 10 to 20 photos of it from
different angles and run "pycam-photo3d calibrate".
"""

import numpy as np

from pycam.errors import InvalidDataError, MissingDependencyError
from pycam.Photogrammetry.camera import CameraIntrinsics
from pycam.Photogrammetry.images import load_image, to_gray

DEFAULT_PATTERN = (9, 6)
_MISSING_OPENCV = "the chessboard calibration requires OpenCV ('python3-opencv')"


def _get_opencv():
    try:
        import cv2
    except ImportError:
        raise MissingDependencyError(_MISSING_OPENCV)
    return cv2


def _chessboard_points(pattern, square_size):
    """ the coordinates of the chessboard corners in the plane of the board """
    columns, rows = pattern
    points = np.zeros((columns * rows, 3), dtype=np.float32)
    points[:, :2] = np.mgrid[0:columns, 0:rows].T.reshape(-1, 2)
    return points * float(square_size)


def calibrate_from_images(filenames, pattern=DEFAULT_PATTERN, square_size=1.0):
    """ estimate the camera parameters from photos of a chessboard

    @param filenames: the photos of the chessboard
    @param pattern: the number of inner corners (columns, rows) of the chessboard
    @param square_size: the edge length of a single square (only affects the reported distances)
    @returns: a tuple of CameraIntrinsics, the reprojection error and the number of used photos
    """
    cv2 = _get_opencv()
    reference = _chessboard_points(pattern, square_size)
    object_points = []
    image_points = []
    size = None
    for filename in filenames:
        image = load_image(filename)
        gray = to_gray(image)
        if size is None:
            size = (gray.shape[1], gray.shape[0])
        elif (gray.shape[1], gray.shape[0]) != size:
            raise InvalidDataError("all calibration photos must have the same size")
        found, corners = cv2.findChessboardCorners(
            gray, tuple(pattern),
            flags=cv2.CALIB_CB_ADAPTIVE_THRESH | cv2.CALIB_CB_NORMALIZE_IMAGE)
        if not found:
            continue
        criteria = (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 30, 0.001)
        corners = cv2.cornerSubPix(gray, corners, (11, 11), (-1, -1), criteria)
        object_points.append(reference)
        image_points.append(corners)
    if len(object_points) < 3:
        raise InvalidDataError("the chessboard was found in only {} of {} photos - at least 3 "
                               "are required".format(len(object_points), len(filenames)))
    error, matrix, _, _, _ = cv2.calibrateCamera(object_points, image_points, size, None, None)
    intrinsics = CameraIntrinsics(size[0], size[1], matrix[0][0], matrix[1][1],
                                  matrix[0][2], matrix[1][2])
    return intrinsics, float(error), len(object_points)
