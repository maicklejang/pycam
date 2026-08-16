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

import math
import os
import shutil
import tempfile
import unittest

import pycam.Test

try:
    import numpy as np
except ImportError:
    np = None

if np is not None:
    from pycam.Photogrammetry.camera import (Camera, CameraIntrinsics, turntable_angles,
                                             turntable_cameras)
    from pycam.Photogrammetry.carving import carve, carve_refined
    from pycam.Photogrammetry.images import available_backends, save_image
    from pycam.Photogrammetry.mesh import Mesh
    from pycam.Photogrammetry.pipeline import (ReconstructionConfig, reconstruct,
                                               reconstruct_from_masks)
    from pycam.Photogrammetry import preview, synthetic
    from pycam.Photogrammetry.session import (CaptureSession, TurntableRig, load_session,
                                              session_from_directory)
    from pycam.Photogrammetry.silhouette import (SilhouetteConfig, _label_components_numpy,
                                                 extract_mask, fill_holes,
                                                 keep_largest_component, otsu_threshold)
    from pycam.Photogrammetry.surfacenets import extract_surface

requires_numpy = unittest.skipIf(np is None, "numpy is not available")


def _sphere_field(samples=40, radius=1.0, extent=1.6):
    axis = np.linspace(-extent, extent, samples)
    x, y, z = np.meshgrid(axis, axis, axis, indexing="ij")
    spacing = 2 * extent / (samples - 1)
    return radius ** 2 - (x ** 2 + y ** 2 + z ** 2), spacing


@requires_numpy
class TestCamera(pycam.Test.PycamTestCase):

    def test_intrinsics_from_field_of_view(self):
        intrinsics = CameraIntrinsics.from_fov(640, 480, 60.0)
        self.assertAlmostEqual(intrinsics.horizontal_fov, 60.0, places=6)
        self.assertAlmostEqual(intrinsics.fx, 320.0 / math.tan(math.radians(30.0)), places=6)
        self.assertAlmostEqual(intrinsics.cx, 320.0)
        self.assertAlmostEqual(intrinsics.cy, 240.0)

    def test_intrinsics_resized(self):
        half = CameraIntrinsics.from_fov(640, 480, 60.0).resized(320, 240)
        self.assertEqual((half.width, half.height), (320, 240))
        self.assertAlmostEqual(half.horizontal_fov, 60.0, places=6)

    def test_intrinsics_rejects_invalid_values(self):
        self.assertRaises(ValueError, CameraIntrinsics.from_fov, 640, 480, 0.0)
        self.assertRaises(ValueError, CameraIntrinsics, 0, 480, 100.0)

    def test_projection_of_the_target(self):
        intrinsics = CameraIntrinsics.from_fov(640, 480, 60.0)
        camera = Camera.look_at(intrinsics, (300.0, 0.0, 50.0), (0.0, 0.0, 50.0))
        pixels, depth = camera.project([(0.0, 0.0, 50.0)])
        self.assertAlmostEqual(pixels[0][0], intrinsics.cx, places=6)
        self.assertAlmostEqual(pixels[0][1], intrinsics.cy, places=6)
        self.assertAlmostEqual(depth[0], 300.0, places=6)

    def test_image_orientation(self):
        """ the image has to be upright and not mirrored """
        intrinsics = CameraIntrinsics.from_fov(640, 480, 60.0)
        camera = Camera.look_at(intrinsics, (300.0, 0.0, 0.0), (0.0, 0.0, 0.0))
        pixels, _ = camera.project([(0.0, 0.0, 10.0), (0.0, 10.0, 0.0)])
        # a point above the target appears in the upper half of the image
        self.assertLess(pixels[0][1], intrinsics.cy)
        # a point to the left of the camera appears in the right half of the image
        self.assertGreater(pixels[1][0], intrinsics.cx)

    def test_turntable_angles(self):
        self.assertEqual(turntable_angles(4), [0.0, 90.0, 180.0, 270.0])
        self.assertEqual(turntable_angles(3, sweep=180.0), [0.0, 90.0, 180.0])

    def test_turntable_geometry(self):
        intrinsics = CameraIntrinsics.from_fov(320, 240, 55.0)
        cameras = turntable_cameras(intrinsics, turntable_angles(8), distance=400.0,
                                    height=200.0, target_z=50.0)
        self.assertEqual(len(cameras), 8)
        for camera in cameras:
            self.assertAlmostEqual(math.hypot(camera.center[0], camera.center[1]), 400.0,
                                   places=6)
            self.assertAlmostEqual(camera.center[2], 200.0, places=6)
            pixels, depth = camera.project([(0.0, 0.0, 50.0)])
            self.assertGreater(depth[0], 0.0)
            self.assertAlmostEqual(pixels[0][0], intrinsics.cx, places=6)
            self.assertAlmostEqual(pixels[0][1], intrinsics.cy, places=6)

    def test_rotating_the_object_matches_the_camera_positions(self):
        """ turning the object by an angle must be the same as orbiting the camera """
        intrinsics = CameraIntrinsics.from_fov(320, 240, 55.0)
        angles = turntable_angles(6)
        cameras = turntable_cameras(intrinsics, angles, distance=350.0, height=120.0,
                                    target_z=40.0)
        point = np.array((30.0, -12.0, 65.0))
        for angle, camera in zip(angles, cameras):
            theta = math.radians(angle)
            rotated = np.array((point[0] * math.cos(theta) - point[1] * math.sin(theta),
                                point[0] * math.sin(theta) + point[1] * math.cos(theta),
                                point[2]))
            direct, _ = camera.project([point])
            via_rotation, _ = cameras[0].project([rotated])
            self.assertAlmostEqual(direct[0][0], via_rotation[0][0], places=6)
            self.assertAlmostEqual(direct[0][1], via_rotation[0][1], places=6)


@requires_numpy
class TestSurfaceExtraction(pycam.Test.PycamTestCase):

    def test_sphere(self):
        field, spacing = _sphere_field(samples=40, radius=1.0, extent=1.6)
        mesh = extract_surface(field, iso=0.0, origin=(-1.6, -1.6, -1.6), spacing=spacing)
        self.assertFalse(mesh.is_empty)
        self.assertTrue(mesh.is_watertight())
        # a positive volume proves that all triangles are oriented outwards
        self.assertGreater(mesh.volume, 0)
        self.assertAlmostEqual(mesh.volume, 4 * math.pi / 3, delta=0.15)
        low, high = mesh.bounds
        for axis in range(3):
            self.assertAlmostEqual(low[axis], -1.0, delta=0.1)
            self.assertAlmostEqual(high[axis], 1.0, delta=0.1)

    def test_normals_point_away_from_the_center(self):
        field, spacing = _sphere_field(samples=30)
        mesh = extract_surface(field, iso=0.0, origin=(-1.6, -1.6, -1.6), spacing=spacing)
        centers = mesh.triangle_corners.mean(axis=1)
        outwards = np.einsum("ij,ij->i", mesh.face_normals(), centers)
        self.assertTrue((outwards > 0).all())

    def test_vertex_normals(self):
        field, spacing = _sphere_field(samples=30)
        mesh = extract_surface(field, iso=0.0, origin=(-1.6, -1.6, -1.6), spacing=spacing)
        for smoothing in (0, 2):
            normals = mesh.vertex_normals(smoothing=smoothing)
            self.assertEqual(normals.shape, mesh.vertices.shape)
            self.assertTrue(np.allclose(np.linalg.norm(normals, axis=1), 1.0))
            # on a sphere every normal points away from the center
            outwards = np.einsum("ij,ij->i", normals, mesh.vertices)
            self.assertTrue((outwards > 0).all())

    def test_empty_volumes(self):
        self.assertTrue(extract_surface(np.zeros((5, 5, 5)), iso=0.5).is_empty)
        self.assertTrue(extract_surface(np.ones((5, 5, 5)), iso=0.5).is_empty)


@requires_numpy
class TestMesh(pycam.Test.PycamTestCase):

    def _tetrahedron(self):
        vertices = np.array(((0.0, 0.0, 0.0), (10.0, 0.0, 0.0), (0.0, 10.0, 0.0),
                             (0.0, 0.0, 10.0)))
        faces = np.array(((0, 2, 1), (0, 1, 3), (0, 3, 2), (1, 2, 3)))
        return Mesh(vertices, faces)

    def test_properties(self):
        mesh = self._tetrahedron()
        self.assertEqual(len(mesh), 4)
        self.assertTrue(mesh.is_watertight())
        self.assertAlmostEqual(mesh.volume, 1000.0 / 6.0, places=6)
        self.assertAlmostEqual(mesh.flipped().volume, -1000.0 / 6.0, places=6)
        self.assert_vector_equal(tuple(mesh.size), (10.0, 10.0, 10.0))

    def test_broken_faces_are_rejected(self):
        self.assertRaises(ValueError, Mesh, np.zeros((3, 3)), np.array(((0, 1, 5),)))

    def test_scaling_and_centering(self):
        mesh = self._tetrahedron().scaled_to_size(50.0, axes=(0, 1))
        self.assertAlmostEqual(mesh.size[0], 50.0, places=6)
        self.assertAlmostEqual(mesh.size[2], 50.0, places=6)
        centered = mesh.centered_on_origin()
        low, high = centered.bounds
        self.assertAlmostEqual(low[2], 0.0, places=6)
        self.assertAlmostEqual(low[0] + high[0], 0.0, places=6)
        self.assertAlmostEqual(low[1] + high[1], 0.0, places=6)

    def test_smoothing_keeps_the_mesh_closed(self):
        field, spacing = _sphere_field(samples=26)
        mesh = extract_surface(field, iso=0.0, origin=(-1.6, -1.6, -1.6), spacing=spacing)
        smoothed = mesh.smoothed(iterations=3)
        self.assertEqual(len(smoothed.faces), len(mesh.faces))
        self.assertTrue(smoothed.is_watertight())
        # Taubin smoothing must not shrink the model noticeably
        self.assertAlmostEqual(smoothed.volume / mesh.volume, 1.0, delta=0.1)

    def test_remove_small_components(self):
        mesh = self._tetrahedron()
        speckle = self._tetrahedron().scaled(0.05).translated((100.0, 0.0, 0.0))
        combined = Mesh(np.vstack((mesh.vertices, speckle.vertices)),
                        np.vstack((mesh.faces, speckle.faces + len(mesh.vertices))))
        self.assertEqual(len(combined.faces), 8)
        cleaned = combined.remove_small_components(keep=1)
        self.assertEqual(len(cleaned.faces), 4)
        self.assertAlmostEqual(cleaned.volume, mesh.volume, places=6)

    def test_stl_export_can_be_imported_by_pycam(self):
        from pycam.Importers.STLImporter import import_model
        mesh = self._tetrahedron()
        directory = tempfile.mkdtemp(prefix="pycam-photo3d-")
        try:
            for binary in (True, False):
                filename = os.path.join(directory, "binary-{}.stl".format(binary))
                mesh.write_stl(filename, binary=binary)
                model = import_model(filename)
                self.assertEqual(len(model.triangles()), 4)
                self.assertAlmostEqual(model.maxz, 10.0, places=4)
        finally:
            shutil.rmtree(directory)

    def test_conversion_to_a_pycam_model(self):
        model = self._tetrahedron().to_pycam_model()
        self.assertEqual(len(model.triangles()), 4)
        self.assertAlmostEqual(model.maxx, 10.0, places=6)
        self.assertAlmostEqual(model.minz, 0.0, places=6)


@requires_numpy
class TestSilhouette(pycam.Test.PycamTestCase):

    def _photo_with_disk(self, size=(120, 160), center=(60, 80), radius=30):
        rows, columns = np.ogrid[:size[0], :size[1]]
        mask = ((rows - center[0]) ** 2 + (columns - center[1]) ** 2) <= radius ** 2
        image = np.zeros(size + (3,), dtype=np.uint8)
        image[:] = (230, 230, 225)
        image[mask] = (40, 90, 200)
        return image, mask

    def test_background_method(self):
        image, expected = self._photo_with_disk()
        background = np.zeros_like(image)
        background[:] = (230, 230, 225)
        mask = extract_mask(image, background=background,
                            config=SilhouetteConfig(method="background"))
        self.assertGreater((mask == expected).mean(), 0.99)

    def test_chroma_method(self):
        image, expected = self._photo_with_disk()
        mask = extract_mask(image, config=SilhouetteConfig(method="chroma"))
        self.assertGreater((mask == expected).mean(), 0.99)

    def test_threshold_method_finds_dark_and_bright_objects(self):
        image, expected = self._photo_with_disk()
        mask = extract_mask(image, config=SilhouetteConfig(method="threshold"))
        self.assertGreater((mask == expected).mean(), 0.99)
        inverted = 255 - image
        mask = extract_mask(inverted, config=SilhouetteConfig(method="threshold"))
        self.assertGreater((mask == expected).mean(), 0.99)

    def test_background_method_requires_a_reference(self):
        image, _ = self._photo_with_disk()
        self.assertRaises(ValueError, extract_mask, image, None,
                          SilhouetteConfig(method="background"))

    def test_speckles_are_removed(self):
        image, expected = self._photo_with_disk()
        image[5, 5] = (0, 0, 0)
        image[100:102, 150:152] = (0, 0, 0)
        mask = extract_mask(image, config=SilhouetteConfig(method="chroma"))
        self.assertFalse(mask[5, 5])
        self.assertGreater((mask == expected).mean(), 0.99)

    def test_connected_components(self):
        mask = np.zeros((20, 20), dtype=bool)
        mask[2:5, 2:5] = True
        mask[10:18, 10:18] = True
        labels, count = _label_components_numpy(mask)
        self.assertEqual(count, 2)
        self.assertEqual(len(set(labels[mask].tolist())), 2)
        self.assertEqual(labels[0, 0], 0)
        biggest = keep_largest_component(mask)
        self.assertEqual(int(biggest.sum()), 64)

    def test_fill_holes(self):
        mask = np.zeros((20, 20), dtype=bool)
        mask[4:16, 4:16] = True
        mask[8:12, 8:12] = False
        self.assertEqual(int(fill_holes(mask).sum()), 144)

    def test_otsu_threshold(self):
        values = np.concatenate((np.full(500, 30, dtype=np.uint8),
                                 np.full(500, 200, dtype=np.uint8)))
        threshold = otsu_threshold(values)
        self.assertTrue(30 <= threshold < 200)
        # the threshold has to separate the two groups of values
        self.assertEqual(int((values > threshold).sum()), 500)


@requires_numpy
class TestCarving(pycam.Test.PycamTestCase):

    def _setup(self, count=16, width=200, height=160):
        intrinsics = CameraIntrinsics.from_fov(width, height, 50.0)
        return turntable_cameras(intrinsics, turntable_angles(count), distance=420.0,
                                 height=260.0, target_z=45.0)

    def test_carving_a_sphere(self):
        cameras = self._setup()
        points = synthetic.sample_solid(synthetic.sphere(radius=35.0, center=(0.0, 0.0, 45.0)),
                                        (-60.0, -60.0, 0.0), (60.0, 60.0, 100.0), resolution=60)
        masks = synthetic.render_masks(cameras, points)
        grid = carve(cameras, masks, (-60.0, -60.0, 0.0), (60.0, 60.0, 100.0), resolution=48)
        self.assertGreater(grid.count, 0)
        low, high = grid.occupied_bounds(margin=0)
        self.assertAlmostEqual(high[0] - low[0], 70.0, delta=6.0)
        self.assertAlmostEqual(high[1] - low[1], 70.0, delta=6.0)
        self.assertAlmostEqual((low[2] + high[2]) / 2, 45.0, delta=6.0)
        # all cameras are located around the object, thus its top and its bottom are not seen
        # from a steep angle: the visual hull is a bit longer along the rotation axis
        self.assertGreater(high[2] - low[2], 68.0)
        self.assertLess(high[2] - low[2], 95.0)
        # the visual hull always contains the object itself
        self.assertGreater(grid.volume, 0.9 * 4 * math.pi * 35.0 ** 3 / 3)

    def test_missing_silhouette_removes_everything(self):
        cameras = self._setup(count=8)
        masks = [np.zeros((160, 200), dtype=bool) for _ in cameras]
        grid = carve(cameras, masks, (-60.0, -60.0, 0.0), (60.0, 60.0, 100.0), resolution=24)
        self.assertEqual(grid.count, 0)

    def test_a_wrong_silhouette_can_be_outvoted(self):
        cameras = self._setup(count=12)
        points = synthetic.sample_solid(synthetic.sphere(radius=30.0, center=(0.0, 0.0, 45.0)),
                                        (-60.0, -60.0, 0.0), (60.0, 60.0, 100.0), resolution=50)
        masks = synthetic.render_masks(cameras, points)
        masks[3] = np.zeros_like(masks[3])
        strict = carve(cameras, masks, (-60.0, -60.0, 0.0), (60.0, 60.0, 100.0), resolution=32)
        self.assertEqual(strict.count, 0)
        tolerant = carve(cameras, masks, (-60.0, -60.0, 0.0), (60.0, 60.0, 100.0),
                         resolution=32, max_missing_views=1)
        self.assertGreater(tolerant.count, 0)

    def test_refined_carving_matches_the_object(self):
        cameras = self._setup(count=18)
        shape = synthetic.demo_object(height=90.0, base_radius=30.0)
        points = synthetic.sample_solid(shape, (-60.0, -60.0, 0.0), (60.0, 60.0, 120.0),
                                        resolution=70)
        masks = synthetic.render_masks(cameras, points)
        grid = carve_refined(cameras, masks, (-60.0, -60.0, 0.0), (60.0, 60.0, 120.0),
                             resolution=90, coarse_resolution=36)
        low, high = grid.occupied_bounds(margin=0)
        self.assertAlmostEqual(high[0] - low[0], 60.0, delta=6.0)
        self.assertAlmostEqual(high[2] - low[2], 90.0, delta=6.0)
        self.assertAlmostEqual(low[2], 0.0, delta=3.0)


@requires_numpy
class TestPipeline(pycam.Test.PycamTestCase):

    def test_reconstruction_from_silhouettes(self):
        intrinsics = CameraIntrinsics.from_fov(220, 180, 50.0)
        cameras = turntable_cameras(intrinsics, turntable_angles(18), distance=420.0,
                                    height=260.0, target_z=45.0)
        shape = synthetic.demo_object(height=90.0, base_radius=30.0)
        points = synthetic.sample_solid(shape, (-60.0, -60.0, 0.0), (60.0, 60.0, 120.0),
                                        resolution=70)
        masks = synthetic.render_masks(cameras, points)
        config = ReconstructionConfig(resolution=80, coarse_resolution=32, center_model=False)
        result = reconstruct_from_masks(cameras, masks, (-60.0, -60.0, 0.0),
                                        (60.0, 60.0, 120.0), config=config)
        mesh = result.mesh
        self.assertTrue(mesh.is_watertight())
        self.assertGreater(mesh.volume, 0)
        self.assertAlmostEqual(mesh.size[0], 60.0, delta=5.0)
        self.assertAlmostEqual(mesh.size[2], 90.0, delta=6.0)
        self.assertEqual(result.statistics["views"], 18)

    def test_the_target_size_is_applied(self):
        intrinsics = CameraIntrinsics.from_fov(200, 160, 50.0)
        cameras = turntable_cameras(intrinsics, turntable_angles(12), distance=420.0,
                                    height=260.0, target_z=45.0)
        points = synthetic.sample_solid(synthetic.sphere(radius=30.0, center=(0.0, 0.0, 45.0)),
                                        (-60.0, -60.0, 0.0), (60.0, 60.0, 100.0), resolution=50)
        masks = synthetic.render_masks(cameras, points)
        config = ReconstructionConfig(resolution=60, coarse_resolution=30, object_size=25.0)
        result = reconstruct_from_masks(cameras, masks, (-60.0, -60.0, 0.0),
                                        (60.0, 60.0, 100.0), config=config)
        self.assertAlmostEqual(max(result.mesh.size[0], result.mesh.size[1]), 25.0, places=4)

    def test_a_too_small_search_volume_is_reported(self):
        intrinsics = CameraIntrinsics.from_fov(200, 160, 50.0)
        cameras = turntable_cameras(intrinsics, turntable_angles(12), distance=420.0,
                                    height=260.0, target_z=45.0)
        points = synthetic.sample_solid(synthetic.sphere(radius=40.0, center=(0.0, 0.0, 45.0)),
                                        (-60.0, -60.0, 0.0), (60.0, 60.0, 100.0), resolution=50)
        masks = synthetic.render_masks(cameras, points)
        config = ReconstructionConfig(resolution=48, coarse_resolution=24)
        result = reconstruct_from_masks(cameras, masks, (-25.0, -25.0, 0.0), (25.0, 25.0, 90.0),
                                        config=config)
        self.assertTrue(any("search volume" in warning for warning in result.warnings))


@requires_numpy
class TestSession(pycam.Test.PycamTestCase):

    def setUp(self):
        self.directory = tempfile.mkdtemp(prefix="pycam-photo3d-")

    def tearDown(self):
        shutil.rmtree(self.directory, ignore_errors=True)

    def test_save_and_load(self):
        session = CaptureSession(self.directory, rig=TurntableRig(distance=250.0, height=90.0),
                                 field_of_view=55.0)
        session.add_shot("shot_000.png", 0.0)
        session.add_shot("shot_001.png", 180.0)
        session.background = "background.png"
        session.save()
        loaded = load_session(self.directory)
        self.assertEqual(len(loaded), 2)
        self.assertEqual(loaded.angles, [0.0, 180.0])
        self.assertAlmostEqual(loaded.rig.distance, 250.0)
        self.assertAlmostEqual(loaded.field_of_view, 55.0)
        self.assertEqual(os.path.basename(loaded.background_path), "background.png")
        self.assertEqual(len(loaded.get_cameras(320, 240)), 2)

    def test_import_of_a_photo_directory(self):
        if not available_backends():
            self.skipTest("no image backend (opencv or pillow) is available")
        image = np.zeros((20, 24, 3), dtype=np.uint8)
        for index in range(4):
            save_image(os.path.join(self.directory, "img_{}.png".format(index)), image)
        session = session_from_directory(self.directory)
        self.assertEqual(len(session), 4)
        self.assertEqual(session.angles, [0.0, 90.0, 180.0, 270.0])

    def test_reconstruction_of_stored_photos(self):
        if not available_backends():
            self.skipTest("no image backend (opencv or pillow) is available")
        intrinsics = CameraIntrinsics.from_fov(200, 160, 50.0)
        angles = turntable_angles(12)
        rig = TurntableRig(distance=420.0, height=260.0, target_z=45.0, object_diameter=120.0,
                           object_height=120.0)
        cameras = turntable_cameras(intrinsics, angles, distance=rig.distance,
                                    height=rig.height, target_z=rig.target_z)
        points = synthetic.sample_solid(synthetic.sphere(radius=30.0, center=(0.0, 0.0, 45.0)),
                                        *rig.bounds, resolution=50)
        masks = synthetic.render_masks(cameras, points)
        session = CaptureSession(self.directory, rig=rig, field_of_view=50.0)
        for index, (photo, angle) in enumerate(zip(synthetic.render_photos(masks), angles)):
            name = "shot_{:03d}.png".format(index)
            save_image(os.path.join(self.directory, name), photo)
            session.add_shot(name, angle)
        session.save()
        config = ReconstructionConfig(resolution=60, coarse_resolution=30, max_image_size=None,
                                      center_model=False)
        result = reconstruct(load_session(self.directory), config=config)
        self.assertTrue(result.mesh.is_watertight())
        self.assertAlmostEqual(result.mesh.size[0], 60.0, delta=6.0)
        # the sphere is only seen from the side, thus the hull is longer along the rotation axis
        self.assertGreater(result.mesh.size[2], 58.0)
        self.assertLess(result.mesh.size[2], 85.0)


@requires_numpy
class TestPreview(pycam.Test.PycamTestCase):

    def test_rendering_a_mesh(self):
        field, spacing = _sphere_field(samples=24)
        mesh = extract_surface(field, iso=0.0, origin=(-1.6, -1.6, -1.6), spacing=spacing)
        image = preview.render_mesh(mesh, size=(80, 60))
        self.assertEqual(image.shape, (60, 80, 3))
        self.assertEqual(image.dtype, np.uint8)
        # the object has to be visible in front of the background
        self.assertGreater((image != np.array(preview.BACKGROUND_COLOR)).any(axis=2).mean(), 0.1)

    def test_rendering_an_empty_model(self):
        image = preview.render_points(np.zeros((0, 3)), size=(20, 20))
        self.assertEqual(image.shape, (20, 20, 3))


if __name__ == "__main__":
    pycam.Test.main()
