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


A capture session: the photos of one object together with the description of the setup.

Everything is stored in a single directory: the photos, an optional reference photo of the
empty turntable and a "session.json" file describing the geometry of the setup.
"""

import datetime
import json
import os

from pycam.errors import LoadFileError
from pycam.Photogrammetry.camera import CameraIntrinsics, turntable_cameras
from pycam.Photogrammetry.images import list_images

SESSION_FILENAME = "session.json"
SESSION_FORMAT = "pycam-photogrammetry-session"
SESSION_VERSION = 1

# a reasonable setup for a small object on a desk (all lengths are given in millimeters)
DEFAULT_RIG = {"distance": 300.0, "height": 150.0, "target_z": None, "clockwise": False}
DEFAULT_FIELD_OF_VIEW = 60.0


class Shot:
    """ a single photo together with the rotation angle of the turntable """

    def __init__(self, filename, angle=0.0):
        self.filename = str(filename)
        self.angle = float(angle)

    def as_dict(self):
        return {"file": self.filename, "angle": self.angle}

    @classmethod
    def from_dict(cls, data):
        return cls(data["file"], data.get("angle", 0.0))

    def __repr__(self):
        return "Shot({}, {:.1f} degrees)".format(self.filename, self.angle)


class TurntableRig:
    """ the geometry of the capture setup (all lengths in the same unit, usually millimeters) """

    def __init__(self, distance=None, height=None, target_z=None, clockwise=False,
                 object_diameter=120.0, object_height=120.0):
        """ @param target_z: the height that the camera is aimed at (defaults to the middle
            of the object, which is what one does intuitively while setting up the camera)
        """
        self.distance = float(DEFAULT_RIG["distance"] if distance is None else distance)
        self.height = float(DEFAULT_RIG["height"] if height is None else height)
        self.target_z = None if target_z is None else float(target_z)
        self.clockwise = bool(clockwise)
        self.object_diameter = float(object_diameter)
        self.object_height = float(object_height)

    @property
    def effective_target_z(self):
        """ the height that the camera is aimed at

        Without an explicit value the middle of the object is assumed - that is where one
        aims a camera without thinking about it.
        """
        if self.target_z is not None:
            return self.target_z
        return self.object_height / 2.0

    @property
    def bounds(self):
        """ the box that is searched for the object """
        radius = self.object_diameter / 2.0
        return ((-radius, -radius, 0.0), (radius, radius, self.object_height))

    def as_dict(self):
        return {"distance": self.distance, "height": self.height, "target_z": self.target_z,
                "clockwise": self.clockwise, "object_diameter": self.object_diameter,
                "object_height": self.object_height}

    @classmethod
    def from_dict(cls, data):
        return cls(**{key: value for key, value in (data or {}).items()})

    def __repr__(self):
        return ("TurntableRig(distance={:.1f}, height={:.1f}, object {:.1f} x {:.1f})"
                .format(self.distance, self.height, self.object_diameter, self.object_height))


class CaptureSession:
    """ all photos of one object plus the description of the capture setup """

    def __init__(self, directory, rig=None, shots=None, background=None,
                 field_of_view=DEFAULT_FIELD_OF_VIEW, intrinsics=None, created=None):
        self.directory = os.path.expanduser(str(directory))
        self.rig = rig or TurntableRig()
        self.shots = list(shots or [])
        self.background = background
        self.field_of_view = float(field_of_view)
        self.intrinsics = intrinsics
        self.created = created or datetime.datetime.now().isoformat(timespec="seconds")

    def __len__(self):
        return len(self.shots)

    def __repr__(self):
        return "CaptureSession({}, {} shots)".format(self.directory, len(self.shots))

    @property
    def angles(self):
        return [shot.angle for shot in self.shots]

    @property
    def image_paths(self):
        return [os.path.join(self.directory, shot.filename) for shot in self.shots]

    @property
    def background_path(self):
        if not self.background:
            return None
        return os.path.join(self.directory, self.background)

    def add_shot(self, filename, angle):
        """ register a photo that is stored inside of the session directory """
        shot = Shot(os.path.basename(str(filename)), angle)
        self.shots.append(shot)
        return shot

    def sorted_by_angle(self):
        """ return a copy with the shots ordered by their turntable angle """
        clone = CaptureSession(self.directory, self.rig, sorted(self.shots,
                                                                key=lambda shot: shot.angle),
                               self.background, self.field_of_view, self.intrinsics, self.created)
        return clone

    def get_intrinsics(self, width, height):
        """ return the camera parameters matching the given image size """
        if self.intrinsics is not None:
            return self.intrinsics.resized(width, height)
        return CameraIntrinsics.from_fov(width, height, self.field_of_view)

    def get_cameras(self, width, height):
        """ return one camera per shot, matching the given image size """
        return turntable_cameras(self.get_intrinsics(width, height), self.angles,
                                 distance=self.rig.distance, height=self.rig.height,
                                 target_z=self.rig.effective_target_z,
                                 clockwise=self.rig.clockwise)

    def as_dict(self):
        data = {"format": SESSION_FORMAT,
                "version": SESSION_VERSION,
                "created": self.created,
                "rig": self.rig.as_dict(),
                "field_of_view": self.field_of_view,
                "background": self.background,
                "shots": [shot.as_dict() for shot in self.shots]}
        if self.intrinsics is not None:
            data["intrinsics"] = self.intrinsics.as_dict()
        return data

    def save(self, directory=None):
        """ write the session description into its directory """
        directory = os.path.expanduser(str(directory or self.directory))
        os.makedirs(directory, exist_ok=True)
        filename = os.path.join(directory, SESSION_FILENAME)
        with open(filename, "w") as out_file:
            json.dump(self.as_dict(), out_file, indent=2, sort_keys=True)
            out_file.write("\n")
        return filename

    @classmethod
    def from_dict(cls, directory, data):
        if data.get("format") != SESSION_FORMAT:
            raise LoadFileError("not a PyCAM capture session: {}".format(directory))
        if data.get("version", 1) > SESSION_VERSION:
            raise LoadFileError("the capture session was written by a newer version of PyCAM: {}"
                                .format(directory))
        intrinsics = (CameraIntrinsics.from_dict(data["intrinsics"])
                      if data.get("intrinsics") else None)
        return cls(directory,
                   rig=TurntableRig.from_dict(data.get("rig")),
                   shots=[Shot.from_dict(item) for item in data.get("shots", ())],
                   background=data.get("background"),
                   field_of_view=data.get("field_of_view", DEFAULT_FIELD_OF_VIEW),
                   intrinsics=intrinsics,
                   created=data.get("created"))


def load_session(directory):
    """ load a session from a directory that contains a "session.json" file """
    directory = os.path.expanduser(str(directory))
    filename = os.path.join(directory, SESSION_FILENAME)
    if not os.path.isfile(filename):
        raise LoadFileError("no capture session found in '{}' (missing {})"
                            .format(directory, SESSION_FILENAME))
    try:
        with open(filename, "r") as in_file:
            data = json.load(in_file)
    except ValueError as exc:
        raise LoadFileError("failed to parse {}: {}".format(filename, exc))
    return CaptureSession.from_dict(directory, data)


def session_from_directory(directory, sweep=360.0, start_angle=0.0, background=None, rig=None,
                           field_of_view=DEFAULT_FIELD_OF_VIEW):
    """ build a session from a directory of photos that were taken in even steps

    The photos are sorted by their filename and distributed over the given sweep.  This is the
    quickest way of using photos that were taken with a phone or a system camera.
    """
    directory = os.path.expanduser(str(directory))
    background = os.path.basename(background) if background else None
    paths = list_images(directory, exclude=[background] if background else ())
    if not paths:
        raise LoadFileError("no images found in '{}'".format(directory))
    session = CaptureSession(directory, rig=rig, background=background,
                             field_of_view=field_of_view)
    count = len(paths)
    if abs(sweep % 360.0) < 1e-9 and count > 1:
        step = sweep / count
    else:
        step = sweep / max(count - 1, 1)
    for index, path in enumerate(paths):
        session.add_shot(path, start_angle + index * step)
    return session
