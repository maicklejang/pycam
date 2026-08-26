#!/usr/bin/env python3
"""Generate small STEP / DXF / STL fixtures used by the viewer test suite.

The STEP files are written as plain ISO-10303-21 part 21 B-reps (a box built
from six planar faces with shared edges, and a cylinder with a proper seam
edge), which is exactly the topology the viewer has to walk.

Usage:  python3 mobile/tests/make_fixtures.py
"""

import math
import os


class StepWriter:
    def __init__(self, name):
        self.name = name
        self.lines = []
        self.counter = 0

    def add(self, text):
        self.counter += 1
        self.lines.append("#%d = %s;" % (self.counter, text))
        return self.counter

    def point(self, xyz):
        return self.add("CARTESIAN_POINT('',(%s))" % ",".join("%.6f" % v for v in xyz))

    def direction(self, xyz):
        return self.add("DIRECTION('',(%s))" % ",".join("%.6f" % v for v in xyz))

    def placement(self, origin, axis, ref):
        return self.add("AXIS2_PLACEMENT_3D('',#%d,#%d,#%d)"
                        % (self.point(origin), self.direction(axis), self.direction(ref)))

    def dump(self, path, shell_id):
        self.dump_solids(path, [shell_id])

    def dump_solids(self, path, shell_ids):
        context = self.add("(GEOMETRIC_REPRESENTATION_CONTEXT(3)"
                           "GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((#%d))"
                           "GLOBAL_UNIT_ASSIGNED_CONTEXT((#%d,#%d,#%d))"
                           "REPRESENTATION_CONTEXT('',''))"
                           % (self.counter + 4, self.counter + 1,
                              self.counter + 2, self.counter + 3))
        self.add("(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.))")
        self.add("(NAMED_UNIT(*)PLANE_ANGLE_UNIT()SI_UNIT($,.RADIAN.))")
        self.add("(NAMED_UNIT(*)SI_UNIT($,.STERADIAN.)SOLID_ANGLE_UNIT())")
        self.add("UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.E-07),#%d,"
                 "'distance_accuracy_value','')" % (self.counter - 2))
        solids = [self.add("MANIFOLD_SOLID_BREP('%s_%d',#%d)" % (self.name, index, shell))
                  for index, shell in enumerate(shell_ids)]
        self.add("ADVANCED_BREP_SHAPE_REPRESENTATION('%s',(%s),#%d)"
                 % (self.name, ",".join("#%d" % s for s in solids), context))

        header = [
            "ISO-10303-21;",
            "HEADER;",
            "FILE_DESCRIPTION((''),'2;1');",
            "FILE_NAME('%s','2026-01-01T00:00:00',(''),(''),'pycam-fixture','','');" % self.name,
            "FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));",
            "ENDSEC;",
            "DATA;",
        ]
        with open(path, "w") as handle:
            handle.write("\n".join(header + self.lines + ["ENDSEC;", "END-ISO-10303-21;", ""]))


def normalize(v):
    length = math.sqrt(sum(c * c for c in v))
    return tuple(c / length for c in v)


def make_box(path, size=(30.0, 20.0, 10.0)):
    writer = StepWriter("box")
    sx, sy, sz = size
    corners = [
        (0, 0, 0), (sx, 0, 0), (sx, sy, 0), (0, sy, 0),
        (0, 0, sz), (sx, 0, sz), (sx, sy, sz), (0, sy, sz),
    ]
    points = [writer.point(c) for c in corners]
    vertices = [writer.add("VERTEX_POINT('',#%d)" % pid) for pid in points]

    edges = {}

    def edge(a, b):
        if (a, b) in edges:
            return edges[(a, b)], True
        if (b, a) in edges:
            return edges[(b, a)], False
        pa, pb = corners[a], corners[b]
        direction = normalize(tuple(pb[i] - pa[i] for i in range(3)))
        length = math.dist(pa, pb)
        vector = writer.add("VECTOR('',#%d,%.6f)" % (writer.direction(direction), length))
        line = writer.add("LINE('',#%d,#%d)" % (writer.point(pa), vector))
        curve = writer.add("EDGE_CURVE('',#%d,#%d,#%d,.T.)"
                           % (vertices[a], vertices[b], line))
        edges[(a, b)] = curve
        return curve, True

    faces = [
        ((0, 3, 2, 1), (0, 0, -1)),   # bottom
        ((4, 5, 6, 7), (0, 0, 1)),    # top
        ((0, 1, 5, 4), (0, -1, 0)),
        ((1, 2, 6, 5), (1, 0, 0)),
        ((2, 3, 7, 6), (0, 1, 0)),
        ((3, 0, 4, 7), (-1, 0, 0)),
    ]
    face_ids = []
    for loop_indices, normal in faces:
        oriented = []
        for k in range(4):
            a = loop_indices[k]
            b = loop_indices[(k + 1) % 4]
            curve, forward = edge(a, b)
            oriented.append(writer.add("ORIENTED_EDGE('',*,*,#%d,%s)"
                                       % (curve, ".T." if forward else ".F.")))
        loop = writer.add("EDGE_LOOP('',(%s))" % ",".join("#%d" % o for o in oriented))
        bound = writer.add("FACE_OUTER_BOUND('',#%d,.T.)" % loop)
        origin = corners[loop_indices[0]]
        ref = normalize(tuple(corners[loop_indices[1]][i] - origin[i] for i in range(3)))
        placement = writer.placement(origin, normal, ref)
        plane = writer.add("PLANE('',#%d)" % placement)
        face_ids.append(writer.add("ADVANCED_FACE('',(#%d),#%d,.T.)" % (bound, plane)))

    shell = writer.add("CLOSED_SHELL('',(%s))" % ",".join("#%d" % f for f in face_ids))
    writer.dump(path, shell)
    print("wrote", path)


def make_cylinder(path, radius=8.0, height=25.0):
    writer = StepWriter("cylinder")
    bottom_seam = writer.add("VERTEX_POINT('',#%d)" % writer.point((radius, 0, 0)))
    top_seam = writer.add("VERTEX_POINT('',#%d)" % writer.point((radius, 0, height)))

    bottom_frame = writer.placement((0, 0, 0), (0, 0, 1), (1, 0, 0))
    top_frame = writer.placement((0, 0, height), (0, 0, 1), (1, 0, 0))
    bottom_circle = writer.add("CIRCLE('',#%d,%.6f)" % (bottom_frame, radius))
    top_circle = writer.add("CIRCLE('',#%d,%.6f)" % (top_frame, radius))

    seam_vector = writer.add("VECTOR('',#%d,%.6f)" % (writer.direction((0, 0, 1)), height))
    seam_line = writer.add("LINE('',#%d,#%d)"
                           % (writer.point((radius, 0, 0)), seam_vector))

    bottom_edge = writer.add("EDGE_CURVE('',#%d,#%d,#%d,.T.)"
                             % (bottom_seam, bottom_seam, bottom_circle))
    top_edge = writer.add("EDGE_CURVE('',#%d,#%d,#%d,.T.)"
                          % (top_seam, top_seam, top_circle))
    seam_edge = writer.add("EDGE_CURVE('',#%d,#%d,#%d,.T.)"
                           % (bottom_seam, top_seam, seam_line))

    def oriented(edge_id, forward):
        return writer.add("ORIENTED_EDGE('',*,*,#%d,%s)"
                          % (edge_id, ".T." if forward else ".F."))

    # lateral face: bottom circle -> seam up -> top circle backwards -> seam down
    lateral_loop = writer.add("EDGE_LOOP('',(#%d,#%d,#%d,#%d))"
                              % (oriented(bottom_edge, True), oriented(seam_edge, True),
                                 oriented(top_edge, False), oriented(seam_edge, False)))
    lateral_bound = writer.add("FACE_OUTER_BOUND('',#%d,.T.)" % lateral_loop)
    surface = writer.add("CYLINDRICAL_SURFACE('',#%d,%.6f)"
                         % (writer.placement((0, 0, 0), (0, 0, 1), (1, 0, 0)), radius))
    lateral = writer.add("ADVANCED_FACE('',(#%d),#%d,.T.)" % (lateral_bound, surface))

    bottom_loop = writer.add("EDGE_LOOP('',(#%d))" % oriented(bottom_edge, False))
    bottom_bound = writer.add("FACE_OUTER_BOUND('',#%d,.T.)" % bottom_loop)
    bottom_plane = writer.add("PLANE('',#%d)"
                              % writer.placement((0, 0, 0), (0, 0, -1), (1, 0, 0)))
    bottom_face = writer.add("ADVANCED_FACE('',(#%d),#%d,.T.)" % (bottom_bound, bottom_plane))

    top_loop = writer.add("EDGE_LOOP('',(#%d))" % oriented(top_edge, True))
    top_bound = writer.add("FACE_OUTER_BOUND('',#%d,.T.)" % top_loop)
    top_plane = writer.add("PLANE('',#%d)"
                           % writer.placement((0, 0, height), (0, 0, 1), (1, 0, 0)))
    top_face = writer.add("ADVANCED_FACE('',(#%d),#%d,.T.)" % (top_bound, top_plane))

    shell = writer.add("CLOSED_SHELL('',(#%d,#%d,#%d))" % (lateral, bottom_face, top_face))
    writer.dump(path, shell)
    print("wrote", path)


def make_plate_with_hole(path, width=40.0, depth=30.0, thickness=5.0, radius=6.0):
    """A plate with a through hole: exercises inner loops and inverted faces."""
    writer = StepWriter("plate")
    cx, cy = width / 2, depth / 2
    corners = [
        (0, 0, 0), (width, 0, 0), (width, depth, 0), (0, depth, 0),
        (0, 0, thickness), (width, 0, thickness), (width, depth, thickness),
        (0, depth, thickness),
    ]
    vertices = [writer.add("VERTEX_POINT('',#%d)" % writer.point(c)) for c in corners]
    edges = {}

    def edge(a, b):
        if (a, b) in edges:
            return edges[(a, b)], True
        if (b, a) in edges:
            return edges[(b, a)], False
        pa, pb = corners[a], corners[b]
        direction = normalize(tuple(pb[i] - pa[i] for i in range(3)))
        vector = writer.add("VECTOR('',#%d,%.6f)"
                            % (writer.direction(direction), math.dist(pa, pb)))
        line = writer.add("LINE('',#%d,#%d)" % (writer.point(pa), vector))
        curve = writer.add("EDGE_CURVE('',#%d,#%d,#%d,.T.)" % (vertices[a], vertices[b], line))
        edges[(a, b)] = curve
        return curve, True

    def oriented(edge_id, forward):
        return writer.add("ORIENTED_EDGE('',*,*,#%d,%s)"
                          % (edge_id, ".T." if forward else ".F."))

    def rect_loop(indices):
        parts = []
        for k in range(4):
            curve, forward = edge(indices[k], indices[(k + 1) % 4])
            parts.append(oriented(curve, forward))
        return writer.add("EDGE_LOOP('',(%s))" % ",".join("#%d" % p for p in parts))

    # hole geometry
    hole_bottom_vertex = writer.add("VERTEX_POINT('',#%d)" % writer.point((cx + radius, cy, 0)))
    hole_top_vertex = writer.add("VERTEX_POINT('',#%d)"
                                 % writer.point((cx + radius, cy, thickness)))
    circle_bottom = writer.add("CIRCLE('',#%d,%.6f)"
                               % (writer.placement((cx, cy, 0), (0, 0, 1), (1, 0, 0)), radius))
    circle_top = writer.add("CIRCLE('',#%d,%.6f)"
                            % (writer.placement((cx, cy, thickness), (0, 0, 1), (1, 0, 0)),
                               radius))
    hole_bottom_edge = writer.add("EDGE_CURVE('',#%d,#%d,#%d,.T.)"
                                  % (hole_bottom_vertex, hole_bottom_vertex, circle_bottom))
    hole_top_edge = writer.add("EDGE_CURVE('',#%d,#%d,#%d,.T.)"
                               % (hole_top_vertex, hole_top_vertex, circle_top))
    seam_vector = writer.add("VECTOR('',#%d,%.6f)"
                             % (writer.direction((0, 0, 1)), thickness))
    seam_line = writer.add("LINE('',#%d,#%d)"
                           % (writer.point((cx + radius, cy, 0)), seam_vector))
    hole_seam_edge = writer.add("EDGE_CURVE('',#%d,#%d,#%d,.T.)"
                                % (hole_bottom_vertex, hole_top_vertex, seam_line))

    faces = []
    # bottom and top, each with the hole as an inner bound
    for indices, normal, hole_edge, z in (((0, 3, 2, 1), (0, 0, -1), hole_bottom_edge, 0),
                                          ((4, 5, 6, 7), (0, 0, 1), hole_top_edge, thickness)):
        outer = writer.add("FACE_OUTER_BOUND('',#%d,.T.)" % rect_loop(indices))
        inner_loop = writer.add("EDGE_LOOP('',(#%d))" % oriented(hole_edge, False))
        inner = writer.add("FACE_BOUND('',#%d,.T.)" % inner_loop)
        plane = writer.add("PLANE('',#%d)"
                           % writer.placement((0, 0, z), normal, (1, 0, 0)))
        faces.append(writer.add("ADVANCED_FACE('',(#%d,#%d),#%d,.T.)" % (outer, inner, plane)))

    side_faces = [
        ((0, 1, 5, 4), (0, -1, 0)),
        ((1, 2, 6, 5), (1, 0, 0)),
        ((2, 3, 7, 6), (0, 1, 0)),
        ((3, 0, 4, 7), (-1, 0, 0)),
    ]
    for indices, normal in side_faces:
        bound = writer.add("FACE_OUTER_BOUND('',#%d,.T.)" % rect_loop(indices))
        origin = corners[indices[0]]
        ref = normalize(tuple(corners[indices[1]][i] - origin[i] for i in range(3)))
        plane = writer.add("PLANE('',#%d)" % writer.placement(origin, normal, ref))
        faces.append(writer.add("ADVANCED_FACE('',(#%d),#%d,.T.)" % (bound, plane)))

    # the bore: same_sense is .F. so the solid's normal points towards the axis
    bore_loop = writer.add("EDGE_LOOP('',(#%d,#%d,#%d,#%d))"
                           % (oriented(hole_bottom_edge, True), oriented(hole_seam_edge, True),
                              oriented(hole_top_edge, False), oriented(hole_seam_edge, False)))
    bore_bound = writer.add("FACE_OUTER_BOUND('',#%d,.T.)" % bore_loop)
    bore_surface = writer.add("CYLINDRICAL_SURFACE('',#%d,%.6f)"
                              % (writer.placement((cx, cy, 0), (0, 0, 1), (1, 0, 0)), radius))
    faces.append(writer.add("ADVANCED_FACE('',(#%d),#%d,.F.)" % (bore_bound, bore_surface)))

    shell = writer.add("CLOSED_SHELL('',(%s))" % ",".join("#%d" % f for f in faces))
    writer.dump(path, shell)
    print("wrote", path)


def make_two_parts(path):
    """Two solids in one representation - the "parts" a person means in an assembly."""
    writer = StepWriter("two_parts")

    def box_shell(origin, size):
        ox, oy, oz = origin
        sx, sy, sz = size
        corners = [
            (ox, oy, oz), (ox + sx, oy, oz), (ox + sx, oy + sy, oz), (ox, oy + sy, oz),
            (ox, oy, oz + sz), (ox + sx, oy, oz + sz), (ox + sx, oy + sy, oz + sz),
            (ox, oy + sy, oz + sz),
        ]
        vertices = [writer.add("VERTEX_POINT('',#%d)" % writer.point(c)) for c in corners]
        edges = {}

        def edge(a, b):
            if (a, b) in edges:
                return edges[(a, b)], True
            if (b, a) in edges:
                return edges[(b, a)], False
            pa, pb = corners[a], corners[b]
            direction = normalize(tuple(pb[i] - pa[i] for i in range(3)))
            vector = writer.add("VECTOR('',#%d,%.6f)"
                                % (writer.direction(direction), math.dist(pa, pb)))
            line = writer.add("LINE('',#%d,#%d)" % (writer.point(pa), vector))
            curve = writer.add("EDGE_CURVE('',#%d,#%d,#%d,.T.)"
                               % (vertices[a], vertices[b], line))
            edges[(a, b)] = curve
            return curve, True

        faces = [
            ((0, 3, 2, 1), (0, 0, -1)), ((4, 5, 6, 7), (0, 0, 1)),
            ((0, 1, 5, 4), (0, -1, 0)), ((1, 2, 6, 5), (1, 0, 0)),
            ((2, 3, 7, 6), (0, 1, 0)), ((3, 0, 4, 7), (-1, 0, 0)),
        ]
        face_ids = []
        for loop_indices, normal in faces:
            oriented = []
            for k in range(4):
                curve, forward = edge(loop_indices[k], loop_indices[(k + 1) % 4])
                oriented.append(writer.add("ORIENTED_EDGE('',*,*,#%d,%s)"
                                           % (curve, ".T." if forward else ".F.")))
            loop = writer.add("EDGE_LOOP('',(%s))" % ",".join("#%d" % o for o in oriented))
            bound = writer.add("FACE_OUTER_BOUND('',#%d,.T.)" % loop)
            start = corners[loop_indices[0]]
            ref = normalize(tuple(corners[loop_indices[1]][i] - start[i] for i in range(3)))
            plane = writer.add("PLANE('',#%d)" % writer.placement(start, normal, ref))
            face_ids.append(writer.add("ADVANCED_FACE('',(#%d),#%d,.T.)" % (bound, plane)))
        return writer.add("CLOSED_SHELL('',(%s))" % ",".join("#%d" % f for f in face_ids))

    first = box_shell((0, 0, 0), (20, 20, 10))
    second = box_shell((30, 0, 0), (20, 20, 10))
    writer.dump_solids(path, [first, second])
    print("wrote", path)


DXF_TEMPLATE = """0
SECTION
2
HEADER
9
$ACADVER
1
AC1015
9
$INSUNITS
70
4
0
ENDSEC
0
SECTION
2
TABLES
0
TABLE
2
LAYER
0
LAYER
2
outline
62
5
0
LAYER
2
engrave
62
1
0
ENDTAB
0
ENDSEC
0
SECTION
2
BLOCKS
0
BLOCK
2
marker
10
0.0
20
0.0
30
0.0
0
CIRCLE
8
engrave
10
0.0
20
0.0
30
0.0
40
2.0
0
ENDBLK
0
ENDSEC
0
SECTION
2
ENTITIES
0
LINE
8
outline
10
0.0
20
0.0
30
0.0
11
100.0
21
0.0
31
0.0
0
LINE
8
outline
10
100.0
20
0.0
30
0.0
11
100.0
21
60.0
31
0.0
0
CIRCLE
8
engrave
10
50.0
20
30.0
30
0.0
40
12.0
0
ARC
8
outline
10
0.0
20
60.0
30
0.0
40
20.0
50
270.0
51
0.0
0
LWPOLYLINE
8
outline
90
4
70
1
10
10.0
20
10.0
42
0.5
10
30.0
20
10.0
10
30.0
20
25.0
10
10.0
20
25.0
0
ELLIPSE
8
engrave
10
75.0
20
45.0
30
0.0
11
15.0
21
0.0
31
0.0
40
0.5
41
0.0
42
6.283185307179586
0
POLYLINE
8
outline
66
1
70
0
0
VERTEX
8
outline
10
5.0
20
50.0
30
0.0
0
VERTEX
8
outline
10
25.0
20
55.0
30
0.0
0
VERTEX
8
outline
10
40.0
20
50.0
30
0.0
0
SEQEND
0
INSERT
8
outline
2
marker
10
80.0
20
15.0
30
0.0
41
1.0
42
1.0
43
1.0
50
0.0
70
2
71
1
44
10.0
45
0.0
0
ENDSEC
0
EOF
"""


def make_dxf(path):
    with open(path, "w") as handle:
        handle.write(DXF_TEMPLATE)
    print("wrote", path)


def make_ascii_stl(path):
    """A tetrahedron, written as ASCII STL."""
    corners = [(0, 0, 0), (20, 0, 0), (0, 20, 0), (0, 0, 15)]
    faces = [(0, 2, 1), (0, 1, 3), (1, 2, 3), (2, 0, 3)]
    lines = ["solid tetra"]
    for face in faces:
        lines.append("  facet normal 0 0 0")
        lines.append("    outer loop")
        for index in face:
            lines.append("      vertex %f %f %f" % corners[index])
        lines.append("    endloop")
        lines.append("  endfacet")
    lines.append("endsolid tetra")
    with open(path, "w") as handle:
        handle.write("\n".join(lines) + "\n")
    print("wrote", path)


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    fixtures = os.path.join(here, "fixtures")
    os.makedirs(fixtures, exist_ok=True)
    make_box(os.path.join(fixtures, "box.step"))
    make_cylinder(os.path.join(fixtures, "cylinder.step"))
    make_plate_with_hole(os.path.join(fixtures, "plate_hole.step"))
    make_two_parts(os.path.join(fixtures, "two_parts.step"))
    make_dxf(os.path.join(fixtures, "drawing.dxf"))
    make_ascii_stl(os.path.join(fixtures, "tetra.stl"))


if __name__ == "__main__":
    main()
