/* PyCAM Viewer - parser test suite (run with: node mobile/tests/run_tests.js).
 *
 * The parsers are plain browser scripts that attach themselves to `self`, so the
 * test simply provides that global and requires them.
 *
 * Copyright 2026 The PyCAM contributors
 * Licensed under the GNU General Public License v3 or later (see COPYING.TXT).
 */
"use strict";

var fs = require("fs");
var path = require("path");

globalThis.self = globalThis;
require("../js/parsers/common.js");
require("../js/parsers/triangulate.js");
require("../js/parsers/stl.js");
require("../js/parsers/dxf.js");
require("../js/parsers/step.js");
require("../js/parsers/index.js");

var P = globalThis.PVX;
var HERE = __dirname;
var REPO = path.resolve(HERE, "..", "..");

var failures = 0;
var checks = 0;
var currentTest = "";

function test(name, fn) {
    currentTest = name;
    try {
        fn();
        console.log("  ✓ " + name);
    } catch (err) {
        failures++;
        console.log("  ✗ " + name + "\n      " + err.message);
    }
}

function assert(condition, message) {
    checks++;
    if (!condition) {
        throw new Error(message || "assertion failed");
    }
}

function assertClose(actual, expected, tolerance, message) {
    checks++;
    if (!(Math.abs(actual - expected) <= tolerance)) {
        throw new Error((message || "value mismatch") + ": expected " + expected
            + " +/- " + tolerance + ", got " + actual);
    }
}

function load(relative) {
    var buffer = fs.readFileSync(path.resolve(HERE, relative));
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

function meshArea(mesh) {
    var total = 0;
    var p = mesh.positions;
    for (var i = 0; i + 8 < p.length; i += 9) {
        var ux = p[i + 3] - p[i], uy = p[i + 4] - p[i + 1], uz = p[i + 5] - p[i + 2];
        var vx = p[i + 6] - p[i], vy = p[i + 7] - p[i + 1], vz = p[i + 8] - p[i + 2];
        var cx = uy * vz - uz * vy;
        var cy = uz * vx - ux * vz;
        var cz = ux * vy - uy * vx;
        total += Math.sqrt(cx * cx + cy * cy + cz * cz) / 2;
    }
    return total;
}

/* Signed volume via the divergence theorem - also proves the winding is consistent. */
function meshVolume(mesh) {
    var total = 0;
    var p = mesh.positions;
    for (var i = 0; i + 8 < p.length; i += 9) {
        total += (p[i] * (p[i + 4] * p[i + 8] - p[i + 5] * p[i + 7])
            - p[i + 1] * (p[i + 3] * p[i + 8] - p[i + 5] * p[i + 6])
            + p[i + 2] * (p[i + 3] * p[i + 7] - p[i + 4] * p[i + 6])) / 6;
    }
    return total;
}

function outwardNormals(mesh, center) {
    var p = mesh.positions;
    var n = mesh.normals;
    var bad = 0;
    for (var i = 0; i + 8 < p.length; i += 9) {
        var cx = (p[i] + p[i + 3] + p[i + 6]) / 3 - center[0];
        var cy = (p[i + 1] + p[i + 4] + p[i + 7]) / 3 - center[1];
        var cz = (p[i + 2] + p[i + 5] + p[i + 8]) / 3 - center[2];
        if (cx * n[i] + cy * n[i + 1] + cz * n[i + 2] < 0) {
            bad++;
        }
    }
    return bad;
}

console.log("\nSTL");

test("ASCII STL (tetrahedron)", function () {
    var result = P.parseFile(load("fixtures/tetra.stl"), "tetra.stl");
    assert(result.format === "STL", "format is STL");
    assert(result.flavour === "ASCII", "detected as ASCII, got " + result.flavour);
    assert(result.mesh.positions.length === 4 * 9, "4 triangles");
    assertClose(result.bbox.max[0], 20, 1e-6, "bbox x");
    assertClose(result.bbox.max[2], 15, 1e-6, "bbox z");
    for (var i = 0; i < result.mesh.normals.length; i += 3) {
        var n = result.mesh.normals;
        assertClose(Math.hypot(n[i], n[i + 1], n[i + 2]), 1, 1e-5, "unit normal");
    }
});

test("binary STL (sample Box0.stl)", function () {
    var result = P.parseFile(load("../../samples/Box0.stl"), "Box0.stl");
    assert(result.flavour === "binary" || result.flavour === "ASCII", "known encoding");
    assert(result.mesh.positions.length >= 12 * 9, "at least 12 triangles, got "
        + result.mesh.positions.length / 9);
    assert(P.isFiniteBBox(result.bbox), "finite bbox");
});

test("binary STL (sample TestModel.stl)", function () {
    var result = P.parseFile(load("../../samples/TestModel.stl"), "TestModel.stl");
    assert(result.mesh.positions.length > 0, "has triangles");
    assert(meshArea(result.mesh) > 0, "positive surface area");
});

test("STL without a usable extension is sniffed", function () {
    var result = P.parseFile(load("fixtures/tetra.stl"), "model.bin");
    assert(result.format === "STL", "sniffed as STL");
});

console.log("\nDXF");

test("entities, layers and blocks", function () {
    var result = P.parseFile(load("fixtures/drawing.dxf"), "drawing.dxf");
    assert(result.format === "DXF", "format is DXF");
    assert(result.kind === "2d", "flat drawing detected as 2d");
    var names = result.edges.map(function (layer) {
        return layer.name;
    }).sort();
    assert(names.indexOf("outline") >= 0, "outline layer present: " + names.join(","));
    assert(names.indexOf("engrave") >= 0, "engrave layer present: " + names.join(","));
    var segments = result.edges.reduce(function (sum, layer) {
        return sum + layer.segments;
    }, 0);
    assert(segments > 100, "arcs and circles were flattened, got " + segments);
    assertClose(result.bbox.min[0], 0, 0.01, "bbox min x");
    assertClose(result.bbox.max[0], 100, 0.5, "bbox max x");
    assertClose(result.bbox.max[1], 62, 2.5, "bbox max y");
});

test("INSERT arrays are expanded", function () {
    var result = P.parseFile(load("fixtures/drawing.dxf"), "drawing.dxf");
    // The block holds one r=2 circle, inserted twice (2 columns, 10 apart) at x=80/90.
    var engrave = result.edges.filter(function (layer) {
        return layer.name === "engrave";
    });
    var maxX = -Infinity;
    engrave.forEach(function (layer) {
        for (var i = 0; i < layer.positions.length; i += 3) {
            maxX = Math.max(maxX, layer.positions[i]);
        }
    });
    assertClose(maxX, 92, 0.2, "second block copy reaches x=92");
});

test("units are reported", function () {
    var result = P.parseFile(load("fixtures/drawing.dxf"), "drawing.dxf");
    var units = result.stats.filter(function (entry) {
        return entry[0] === "Units";
    });
    assert(units.length === 1 && units[0][1] === "mm", "millimetre units");
});

console.log("\nSTEP");

test("box B-rep: topology, area, volume and normals", function () {
    var result = P.parseFile(load("fixtures/box.step"), "box.step");
    assert(result.format === "STEP", "format is STEP");
    var faces = result.stats.filter(function (e) {
        return e[0] === "Faces";
    })[0][1];
    assert(faces === 6, "six faces, got " + faces);
    assert(result.mesh.positions.length >= 12 * 9, "at least 12 triangles");
    assertClose(result.bbox.min[0], 0, 1e-4, "bbox min x");
    assertClose(result.bbox.max[0], 30, 1e-4, "bbox max x");
    assertClose(result.bbox.max[1], 20, 1e-4, "bbox max y");
    assertClose(result.bbox.max[2], 10, 1e-4, "bbox max z");
    assertClose(meshArea(result.mesh), 2 * (30 * 20 + 30 * 10 + 20 * 10), 1e-3, "surface area");
    assertClose(meshVolume(result.mesh), 30 * 20 * 10, 1e-2, "signed volume (outward faces)");
    assert(outwardNormals(result.mesh, [15, 10, 5]) === 0, "all normals point outwards");
    assert(result.edges.length === 1 && result.edges[0].segments === 12,
           "12 wireframe edges, got " + (result.edges[0] && result.edges[0].segments));
});

test("cylinder B-rep: seam handling and curved surface", function () {
    var result = P.parseFile(load("fixtures/cylinder.step"), "cylinder.step");
    var radius = 8, height = 25;
    assertClose(result.bbox.min[0], -radius, 0.05, "bbox min x");
    assertClose(result.bbox.max[0], radius, 0.05, "bbox max x");
    assertClose(result.bbox.max[2], height, 1e-4, "bbox max z");
    var expectedArea = 2 * Math.PI * radius * radius + 2 * Math.PI * radius * height;
    // The tessellation is inscribed, so it stays slightly below the analytic area.
    var area = meshArea(result.mesh);
    assert(area > expectedArea * 0.98 && area <= expectedArea * 1.001,
           "surface area " + area.toFixed(2) + " close to " + expectedArea.toFixed(2));
    var volume = Math.abs(meshVolume(result.mesh));
    var expectedVolume = Math.PI * radius * radius * height;
    assert(volume > expectedVolume * 0.97 && volume <= expectedVolume * 1.001,
           "volume " + volume.toFixed(2) + " close to " + expectedVolume.toFixed(2));
    assert(outwardNormals(result.mesh, [0, 0, height / 2]) === 0, "normals point outwards");
    var unit = result.stats.filter(function (e) {
        return e[0] === "Units";
    });
    assert(unit.length && unit[0][1] === "mm", "millimetre units");
});

test("plate with a through hole: inner loops and inverted faces", function () {
    var result = P.parseFile(load("fixtures/plate_hole.step"), "plate_hole.step");
    var width = 40, depth = 30, thickness = 5, radius = 6;
    var faces = result.stats.filter(function (e) {
        return e[0] === "Faces";
    })[0][1];
    assert(faces === 7, "seven faces, got " + faces);
    var expectedVolume = (width * depth - Math.PI * radius * radius) * thickness;
    var volume = meshVolume(result.mesh);
    // The bore is inscribed, so the remaining material comes out marginally larger.
    assert(volume > expectedVolume * 0.999 && volume < expectedVolume * 1.002,
           "signed volume " + volume.toFixed(2) + " close to " + expectedVolume.toFixed(2)
           + " (positive proves the outward orientation)");
    var expectedArea = 2 * (width * depth - Math.PI * radius * radius)
        + 2 * (width + depth) * thickness + 2 * Math.PI * radius * thickness;
    assertClose(meshArea(result.mesh), expectedArea, expectedArea * 0.002, "surface area");
    assert(result.warnings.length === 0, "no warnings: " + result.warnings.join("; "));
});

test("STEP without extension is sniffed", function () {
    var result = P.parseFile(load("fixtures/box.step"), "unknown");
    assert(result.format === "STEP", "sniffed as STEP");
});

console.log("\ntriangulation");

test("square with a square hole", function () {
    var square = [0, 0, 10, 0, 10, 10, 0, 10];
    var hole = [3, 3, 3, 7, 7, 7, 7, 3];
    var data = square.concat(hole);
    var indices = P.triangulate(data, [4]);
    assert(indices.length % 3 === 0, "triangle triples");
    var area = 0;
    for (var i = 0; i + 2 < indices.length; i += 3) {
        var ax = data[indices[i] * 2], ay = data[indices[i] * 2 + 1];
        var bx = data[indices[i + 1] * 2], by = data[indices[i + 1] * 2 + 1];
        var cx = data[indices[i + 2] * 2], cy = data[indices[i + 2] * 2 + 1];
        area += Math.abs((bx - ax) * (cy - ay) - (cx - ax) * (by - ay)) / 2;
    }
    assertClose(area, 100 - 16, 1e-6, "area minus hole");
});

test("concave polygon", function () {
    var poly = [0, 0, 10, 0, 10, 10, 5, 4, 0, 10];
    var indices = P.triangulate(poly, []);
    var area = 0;
    for (var i = 0; i + 2 < indices.length; i += 3) {
        var ax = poly[indices[i] * 2], ay = poly[indices[i] * 2 + 1];
        var bx = poly[indices[i + 1] * 2], by = poly[indices[i + 1] * 2 + 1];
        var cx = poly[indices[i + 2] * 2], cy = poly[indices[i + 2] * 2 + 1];
        area += Math.abs((bx - ax) * (cy - ay) - (cx - ax) * (by - ay)) / 2;
    }
    assertClose(area, 70, 1e-6, "shoelace area");
});

console.log("\nerrors");

test("unknown format is rejected", function () {
    var buffer = new TextEncoder().encode("hello world, not a cad file").buffer;
    var threw = false;
    try {
        P.parseFile(buffer, "notes.txt");
    } catch (err) {
        threw = /unknown file format/.test(err.message);
    }
    assert(threw, "throws a helpful error");
});

test("empty file is rejected", function () {
    var threw = false;
    try {
        P.parseFile(new ArrayBuffer(0), "empty.stl");
    } catch (err) {
        threw = true;
    }
    assert(threw, "throws");
});

console.log("\n" + (failures ? "✗ " + failures + " test(s) failed"
    : "✓ all tests passed") + " (" + checks + " assertions)\n");
process.exit(failures ? 1 : 0);
