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


A minimal triangle mesh with the operations needed for turning a scan into a machinable model.
"""

import os
import struct

import numpy as np


class Mesh:
    """ an indexed triangle mesh

    The vertices are stored as an Nx3 array of coordinates, the faces as an Mx3 array of vertex
    indices.  The triangles are wound counterclockwise when seen from outside of the model (the
    common convention of STL files).
    """

    def __init__(self, vertices, faces):
        self.vertices = np.asarray(vertices, dtype=np.float64).reshape(-1, 3)
        self.faces = np.asarray(faces, dtype=np.int64).reshape(-1, 3)
        if len(self.faces) > 0:
            if self.faces.min() < 0 or self.faces.max() >= len(self.vertices):
                raise ValueError("the mesh contains face indices outside of the vertex list")

    def __len__(self):
        return len(self.faces)

    def __repr__(self):
        return "Mesh({} vertices, {} triangles)".format(len(self.vertices), len(self.faces))

    def copy(self):
        return Mesh(self.vertices.copy(), self.faces.copy())

    @property
    def is_empty(self):
        return len(self.faces) == 0

    @property
    def bounds(self):
        """ return the lower and the upper corner of the bounding box """
        if len(self.vertices) == 0:
            return np.zeros(3), np.zeros(3)
        return self.vertices.min(axis=0), self.vertices.max(axis=0)

    @property
    def size(self):
        low, high = self.bounds
        return high - low

    @property
    def triangle_corners(self):
        """ return the corners of all triangles (shape: Mx3x3) """
        return self.vertices[self.faces]

    def face_normals(self, normalize=True):
        corners = self.triangle_corners
        normals = np.cross(corners[:, 1] - corners[:, 0], corners[:, 2] - corners[:, 0])
        if normalize:
            lengths = np.linalg.norm(normals, axis=1)
            lengths[lengths < 1e-20] = 1.0
            normals = normals / lengths[:, None]
        return normals

    def vertex_normals(self, smoothing=0):
        """ return the area weighted average of the normals around every vertex

        These normals describe the surface much better than the normal of a single triangle,
        which is why they are used for shading the preview.

        @param smoothing: number of additional averaging passes over the neighboring vertices
        """
        weighted = self.face_normals(normalize=False)
        result = np.zeros_like(self.vertices)
        indices = self.faces.reshape(-1)
        for axis in range(3):
            result[:, axis] = np.bincount(indices, weights=np.repeat(weighted[:, axis], 3),
                                          minlength=len(self.vertices))
        result = self._normalized(result)
        for _ in range(max(int(smoothing), 0)):
            edges = self.edges(unique=True)
            both = np.vstack((edges, edges[:, ::-1]))
            averaged = np.zeros_like(result)
            for axis in range(3):
                averaged[:, axis] = np.bincount(both[:, 0], weights=result[both[:, 1], axis],
                                                minlength=len(self.vertices))
            result = self._normalized(result + averaged)
        return result

    @staticmethod
    def _normalized(vectors):
        lengths = np.linalg.norm(vectors, axis=1)
        lengths[lengths < 1e-20] = 1.0
        return vectors / lengths[:, None]

    @property
    def area(self):
        return float(np.linalg.norm(self.face_normals(normalize=False), axis=1).sum() / 2.0)

    @property
    def volume(self):
        """ the signed volume of the mesh

        A positive value indicates that the triangles are oriented outwards.
        """
        if self.is_empty:
            return 0.0
        corners = self.triangle_corners
        products = np.einsum("ij,ij->i", corners[:, 0],
                             np.cross(corners[:, 1], corners[:, 2]))
        return float(products.sum() / 6.0)

    def edges(self, unique=True):
        """ return all edges as pairs of vertex indices """
        faces = self.faces
        edges = np.vstack((faces[:, (0, 1)], faces[:, (1, 2)], faces[:, (2, 0)]))
        if unique:
            edges = np.unique(np.sort(edges, axis=1), axis=0)
        return edges

    def is_watertight(self):
        """ check whether every edge is shared by exactly two consistently oriented triangles """
        if self.is_empty:
            return False
        faces = self.faces
        directed = np.vstack((faces[:, (0, 1)], faces[:, (1, 2)], faces[:, (2, 0)]))
        # every directed edge has to show up exactly once ...
        _, directed_counts = np.unique(directed, axis=0, return_counts=True)
        if directed_counts.max() > 1:
            return False
        # ... and every undirected edge exactly twice
        _, counts = np.unique(np.sort(directed, axis=1), axis=0, return_counts=True)
        return bool(counts.min() == 2 and counts.max() == 2)

    def flipped(self):
        """ return a copy with inverted triangle orientation """
        return Mesh(self.vertices.copy(), self.faces[:, ::-1].copy())

    def translated(self, offset):
        return Mesh(self.vertices + np.asarray(offset, dtype=float).reshape(3), self.faces)

    def scaled(self, factor):
        return Mesh(self.vertices * float(factor), self.faces)

    def centered_on_origin(self, keep_bottom=True):
        """ move the model to the center of the X/Y plane

        The bottom of the model is placed on Z=0 unless "keep_bottom" is disabled.
        """
        low, high = self.bounds
        offset = -(low + high) / 2.0
        if keep_bottom:
            offset[2] = -low[2]
        return self.translated(offset)

    def scaled_to_size(self, target, axes=(0, 1)):
        """ scale the model uniformly until its largest extent along "axes" matches "target" """
        extents = self.size[list(axes)]
        current = float(extents.max())
        if current < 1e-12:
            raise ValueError("cannot scale a model without extent")
        return self.scaled(float(target) / current)

    def smoothed(self, iterations=2, shrink=0.5, inflate=-0.53):
        """ apply Taubin smoothing

        A plain Laplacian filter shrinks the model with every iteration.  Taubin's approach
        alternates a shrinking and an inflating pass, which keeps the volume nearly constant.
        """
        if self.is_empty or iterations < 1:
            return self.copy()
        edges = self.edges(unique=True)
        both = np.vstack((edges, edges[:, ::-1]))
        sources = both[:, 0]
        targets = both[:, 1]
        counts = np.bincount(sources, minlength=len(self.vertices)).astype(float)
        counts[counts == 0] = 1.0
        vertices = self.vertices.copy()
        for index in range(2 * iterations):
            weight = shrink if (index % 2 == 0) else inflate
            neighbors = np.empty_like(vertices)
            for axis in range(3):
                neighbors[:, axis] = np.bincount(sources, weights=vertices[targets, axis],
                                                 minlength=len(vertices))
            neighbors /= counts[:, None]
            vertices += weight * (neighbors - vertices)
        return Mesh(vertices, self.faces)

    def remove_small_components(self, keep=1):
        """ keep only the "keep" biggest connected components (removes scanning artifacts)

        The components are ranked by their surface area, since a small blob may well consist of
        more triangles than a big one.
        """
        if self.is_empty:
            return self.copy()
        parents = list(range(len(self.vertices)))

        def find(item):
            root = item
            while parents[root] != root:
                root = parents[root]
            while parents[item] != root:
                parents[item], item = root, parents[item]
            return root

        for first, second in self.edges(unique=True):
            root_a, root_b = find(int(first)), find(int(second))
            if root_a != root_b:
                parents[root_b] = root_a
        labels = np.array([find(index) for index in range(len(self.vertices))])
        face_labels = labels[self.faces[:, 0]]
        unique_labels, compact = np.unique(face_labels, return_inverse=True)
        areas = np.linalg.norm(self.face_normals(normalize=False), axis=1) / 2.0
        total_areas = np.bincount(compact, weights=areas, minlength=len(unique_labels))
        biggest = unique_labels[np.argsort(total_areas)[::-1][:max(keep, 1)]]
        selection = np.isin(face_labels, biggest)
        return self.select_faces(selection)

    def select_faces(self, selection):
        """ return a mesh containing only the selected faces (unused vertices are dropped) """
        faces = self.faces[selection]
        if len(faces) == 0:
            return Mesh(np.zeros((0, 3)), np.zeros((0, 3), dtype=np.int64))
        used = np.unique(faces)
        remap = np.full(len(self.vertices), -1, dtype=np.int64)
        remap[used] = np.arange(len(used))
        return Mesh(self.vertices[used], remap[faces])

    def write_stl(self, filename, binary=True, name="pycam-scan"):
        """ store the mesh as an STL file (the input format of most CAM and slicer tools) """
        filename = os.path.expanduser(str(filename))
        if binary:
            with open(filename, "wb") as out_file:
                out_file.write(struct.pack("<80sI", name.encode("ascii", "replace")[:80],
                                           len(self.faces)))
                out_file.write(self._binary_facet_data().tobytes())
        else:
            with open(filename, "w") as out_file:
                out_file.write(self.as_ascii_stl(name=name))
        return filename

    def _binary_facet_data(self):
        record = np.dtype([("normal", "<f4", 3), ("corners", "<f4", (3, 3)),
                           ("attributes", "<u2")])
        data = np.zeros(len(self.faces), dtype=record)
        data["normal"] = self.face_normals()
        data["corners"] = self.triangle_corners
        return data

    def as_ascii_stl(self, name="pycam-scan"):
        normals = self.face_normals()
        corners = self.triangle_corners
        lines = ["solid {}".format(name)]
        for normal, triangle in zip(normals, corners):
            lines.append("  facet normal {:e} {:e} {:e}".format(*normal))
            lines.append("    outer loop")
            for corner in triangle:
                lines.append("      vertex {:e} {:e} {:e}".format(*corner))
            lines.append("    endloop")
            lines.append("  endfacet")
        lines.append("endsolid {}".format(name))
        lines.append("")
        return os.linesep.join(lines)

    def write_obj(self, filename):
        filename = os.path.expanduser(str(filename))
        with open(filename, "w") as out_file:
            out_file.write("# generated by PyCAM (pycam.Photogrammetry)\n")
            for vertex in self.vertices:
                out_file.write("v {:.6f} {:.6f} {:.6f}\n".format(*vertex))
            for face in self.faces + 1:
                out_file.write("f {} {} {}\n".format(*face))
        return filename

    def to_pycam_model(self):
        """ convert the mesh into a PyCAM model that can be used for toolpath generation """
        # the import is delayed, since it pulls in a considerable part of PyCAM
        from pycam.Geometry.Model import Model
        from pycam.Geometry.Triangle import Triangle
        model = Model()
        normals = self.face_normals()
        for triangle, normal in zip(self.triangle_corners, normals):
            points = [(float(corner[0]), float(corner[1]), float(corner[2]), "v")
                      for corner in triangle]
            model.append(Triangle(points[0], points[1], points[2],
                                  (float(normal[0]), float(normal[1]), float(normal[2]), "v")))
        return model

    def describe(self):
        """ return a human readable summary of the mesh """
        low, high = self.bounds
        return ("{} triangles, {} vertices, size {:.2f} x {:.2f} x {:.2f}, "
                "volume {:.2f}, watertight: {}"
                .format(len(self.faces), len(self.vertices), *(high - low),
                        self.volume, "yes" if self.is_watertight() else "no"))
