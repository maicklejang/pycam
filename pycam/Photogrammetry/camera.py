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


Pinhole camera model and the turntable rig used for capturing an object.

Coordinate conventions:
  * world coordinates: X/Y describe the turntable plane, Z points upwards
    (this matches the coordinate system used by PyCAM for machining)
  * the object is centered on the rotation axis (X=0, Y=0) and stands on Z=0
  * camera coordinates: X points right, Y points down, Z points towards the scene
    (the usual computer vision convention)
"""

import math

import numpy as np


class CameraIntrinsics:
    """ the internal parameters of a pinhole camera (in pixels) """

    def __init__(self, width, height, fx, fy=None, cx=None, cy=None):
        if (width <= 0) or (height <= 0):
            raise ValueError("image size must be positive: {}x{}".format(width, height))
        self.width = int(width)
        self.height = int(height)
        self.fx = float(fx)
        self.fy = float(fx if fy is None else fy)
        self.cx = float(self.width / 2.0 if cx is None else cx)
        self.cy = float(self.height / 2.0 if cy is None else cy)
        if (self.fx <= 0) or (self.fy <= 0):
            raise ValueError("focal length must be positive: {}/{}".format(self.fx, self.fy))

    @classmethod
    def from_fov(cls, width, height, horizontal_fov=60.0):
        """ derive the focal length from the horizontal field of view (in degrees)

        This is the usual way of guessing the parameters of a webcam or phone camera without
        running a real calibration.  Most webcams are somewhere between 55 and 70 degrees.
        """
        if not 0.0 < horizontal_fov < 180.0:
            raise ValueError("the field of view must be between 0 and 180 degrees: {}"
                             .format(horizontal_fov))
        fx = (width / 2.0) / math.tan(math.radians(horizontal_fov) / 2.0)
        return cls(width, height, fx)

    @property
    def horizontal_fov(self):
        return math.degrees(2.0 * math.atan((self.width / 2.0) / self.fx))

    @property
    def matrix(self):
        return np.array(((self.fx, 0.0, self.cx),
                         (0.0, self.fy, self.cy),
                         (0.0, 0.0, 1.0)), dtype=float)

    def resized(self, width, height):
        """ return the intrinsics belonging to a scaled version of the same image """
        scale_x = width / self.width
        scale_y = height / self.height
        return CameraIntrinsics(width, height, self.fx * scale_x, self.fy * scale_y,
                                self.cx * scale_x, self.cy * scale_y)

    def as_dict(self):
        return {"width": self.width, "height": self.height, "fx": self.fx, "fy": self.fy,
                "cx": self.cx, "cy": self.cy}

    @classmethod
    def from_dict(cls, data):
        return cls(data["width"], data["height"], data["fx"], data.get("fy"),
                   data.get("cx"), data.get("cy"))

    def __repr__(self):
        return ("CameraIntrinsics({}x{}, fx={:.1f}, fy={:.1f}, cx={:.1f}, cy={:.1f})"
                .format(self.width, self.height, self.fx, self.fy, self.cx, self.cy))


class Camera:
    """ a pinhole camera with a known position and orientation """

    def __init__(self, intrinsics, rotation, center):
        """ the rotation matrix transforms world coordinates into camera coordinates

        Its rows are the "right", "down" and "forward" axis of the camera (in world
        coordinates).  The center is the position of the camera in world coordinates.
        """
        self.intrinsics = intrinsics
        self.rotation = np.asarray(rotation, dtype=float).reshape(3, 3)
        self.center = np.asarray(center, dtype=float).reshape(3)

    @classmethod
    def look_at(cls, intrinsics, position, target=(0.0, 0.0, 0.0), up=(0.0, 0.0, 1.0)):
        """ create a camera at "position" that is aimed at "target" """
        position = np.asarray(position, dtype=float).reshape(3)
        target = np.asarray(target, dtype=float).reshape(3)
        up = np.asarray(up, dtype=float).reshape(3)
        forward = target - position
        norm = np.linalg.norm(forward)
        if norm < 1e-12:
            raise ValueError("the camera position must differ from its target")
        forward /= norm
        right = np.cross(forward, up)
        if np.linalg.norm(right) < 1e-9:
            # the camera looks straight along the "up" axis - pick a different reference
            right = np.cross(forward, (0.0, 1.0, 0.0))
            if np.linalg.norm(right) < 1e-9:
                right = np.cross(forward, (1.0, 0.0, 0.0))
        right /= np.linalg.norm(right)
        down = np.cross(forward, right)
        return cls(intrinsics, np.vstack((right, down, forward)), position)

    @property
    def forward(self):
        """ the viewing direction of the camera in world coordinates """
        return self.rotation[2]

    def to_camera_space(self, points):
        points = np.asarray(points, dtype=float).reshape(-1, 3)
        return (points - self.center) @ self.rotation.T

    def project(self, points):
        """ project world coordinates onto the image plane

        Returns a tuple of pixel coordinates (shape: Nx2) and the distances in front of the
        camera (shape: N).  Points with a non-positive distance are behind the camera and their
        pixel coordinates are meaningless.
        """
        local = self.to_camera_space(points)
        depth = local[:, 2]
        # avoid a division by zero - such points are rejected via their depth anyway
        divisor = np.where(np.abs(depth) < 1e-12, 1e-12, depth)
        pixels = np.empty((local.shape[0], 2), dtype=float)
        pixels[:, 0] = self.intrinsics.fx * local[:, 0] / divisor + self.intrinsics.cx
        pixels[:, 1] = self.intrinsics.fy * local[:, 1] / divisor + self.intrinsics.cy
        return pixels, depth

    def as_dict(self):
        return {"intrinsics": self.intrinsics.as_dict(),
                "rotation": self.rotation.tolist(),
                "center": self.center.tolist()}

    @classmethod
    def from_dict(cls, data):
        return cls(CameraIntrinsics.from_dict(data["intrinsics"]), data["rotation"],
                   data["center"])

    def __repr__(self):
        return "Camera(center=({:.1f}, {:.1f}, {:.1f}))".format(*self.center)


def turntable_angles(count, start=0.0, sweep=360.0):
    """ return "count" evenly distributed rotation angles (in degrees) """
    if count < 1:
        raise ValueError("at least one angle is required: {}".format(count))
    if abs(sweep % 360.0) < 1e-9 and count > 1:
        # a full turn: the last position would be identical to the first one
        step = sweep / count
    else:
        step = sweep / max(count - 1, 1)
    return [start + index * step for index in range(count)]


def turntable_cameras(intrinsics, angles, distance, height, target_z=None, clockwise=False):
    """ describe a fixed camera that observes an object on a rotating turntable

    Rotating the object by a given angle is equivalent to moving the camera around the object
    by the same angle in the opposite direction.  The latter view is used here, since it keeps
    the object in a fixed coordinate system.

    @param intrinsics: the internal camera parameters
    @param angles: the turntable angles (in degrees) belonging to the photos
    @param distance: the horizontal distance between the camera and the rotation axis
    @param height: the height of the camera above the turntable surface
    @param target_z: the height of the point that the camera is aimed at (defaults to half of
        the camera height, which keeps a small object nicely centered)
    @param clockwise: set this to True if the turntable turns clockwise (seen from above)
    """
    if distance <= 0:
        raise ValueError("the camera distance must be positive: {}".format(distance))
    if target_z is None:
        target_z = height / 2.0
    orientation = -1.0 if clockwise else 1.0
    cameras = []
    for angle in angles:
        theta = math.radians(float(angle)) * orientation
        position = (distance * math.cos(theta), -distance * math.sin(theta), height)
        cameras.append(Camera.look_at(intrinsics, position, (0.0, 0.0, target_z)))
    return cameras
