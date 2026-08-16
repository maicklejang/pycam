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


"pycam.Photogrammetry" turns a series of photos of a real object into a 3D model.

The object is placed on a turntable and photographed from all sides.  Every photo is reduced
to a silhouette (the outline of the object) and all silhouettes are intersected in 3D.  The
resulting "visual hull" is converted into a triangle mesh, which can be saved as an STL file
or handed over to the toolpath generator of PyCAM.

The typical usage looks like this:

    from pycam.Photogrammetry import reconstruct_session, load_session

    session = load_session("~/scans/my-object")
    result = reconstruct(session)
    result.mesh.write_stl("my-object.stl")
"""

from pycam.Photogrammetry.camera import Camera, CameraIntrinsics, turntable_cameras
from pycam.Photogrammetry.carving import VoxelGrid, carve
from pycam.Photogrammetry.mesh import Mesh
from pycam.Photogrammetry.pipeline import (ReconstructionConfig, ReconstructionResult,
                                           reconstruct, reconstruct_session)
from pycam.Photogrammetry.session import CaptureSession, Shot, load_session
from pycam.Photogrammetry.silhouette import SilhouetteConfig, extract_mask

__all__ = ("Camera", "CameraIntrinsics", "CaptureSession", "Mesh", "ReconstructionConfig",
           "ReconstructionResult", "Shot", "SilhouetteConfig", "VoxelGrid", "carve",
           "extract_mask", "load_session", "reconstruct", "reconstruct_session",
           "turntable_cameras")
