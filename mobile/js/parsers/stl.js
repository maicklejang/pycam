/* PyCAM Viewer - STL parser (binary + ASCII).
 *
 * Copyright 2026 The PyCAM contributors
 * Licensed under the GNU General Public License v3 or later (see COPYING.TXT).
 */
(function (root) {
    "use strict";

    var P = root.PVX = root.PVX || {};

    function isBinarySTL(buffer) {
        if (buffer.byteLength < 84) {
            return false;
        }
        var view = new DataView(buffer);
        var count = view.getUint32(80, true);
        // The only trustworthy check: does the announced triangle count match the file size?
        // Many binary files start with "solid", so the magic word tells us nothing.
        return 84 + count * 50 === buffer.byteLength;
    }

    function faceNormal(ax, ay, az, bx, by, bz, cx, cy, cz) {
        var ux = bx - ax, uy = by - ay, uz = bz - az;
        var vx = cx - ax, vy = cy - ay, vz = cz - az;
        var nx = uy * vz - uz * vy;
        var ny = uz * vx - ux * vz;
        var nz = ux * vy - uy * vx;
        var len = Math.sqrt(nx * nx + ny * ny + nz * nz);
        if (len < 1e-20) {
            return null;
        }
        return [nx / len, ny / len, nz / len];
    }

    function parseBinary(buffer, warnings) {
        var view = new DataView(buffer);
        var count = view.getUint32(80, true);
        var positions = new Float32Array(count * 9);
        var normals = new Float32Array(count * 9);
        var offset = 84;
        var degenerate = 0;
        var withColor = 0;
        for (var i = 0; i < count; i++) {
            var sn = [view.getFloat32(offset, true),
                      view.getFloat32(offset + 4, true),
                      view.getFloat32(offset + 8, true)];
            offset += 12;
            var v = new Array(9);
            for (var k = 0; k < 9; k++) {
                v[k] = view.getFloat32(offset, true);
                offset += 4;
            }
            var attr = view.getUint16(offset, true);
            offset += 2;
            if (attr & 0x8000) {
                withColor++;
            }
            // Stored normals are unreliable in the wild - prefer the geometric one.
            var n = faceNormal(v[0], v[1], v[2], v[3], v[4], v[5], v[6], v[7], v[8]);
            if (!n) {
                degenerate++;
                var sl = Math.sqrt(sn[0] * sn[0] + sn[1] * sn[1] + sn[2] * sn[2]);
                n = sl > 1e-12 ? [sn[0] / sl, sn[1] / sl, sn[2] / sl] : [0, 0, 1];
            }
            var pi = i * 9;
            for (var j = 0; j < 9; j++) {
                positions[pi + j] = v[j];
            }
            for (var c = 0; c < 3; c++) {
                normals[pi + c * 3] = n[0];
                normals[pi + c * 3 + 1] = n[1];
                normals[pi + c * 3 + 2] = n[2];
            }
        }
        if (degenerate) {
            warnings.push(degenerate + " degenerate (zero-area) triangle(s) found");
        }
        if (withColor) {
            warnings.push("file carries per-facet colour attributes - these are not displayed");
        }
        return {positions: positions, normals: normals, count: count};
    }

    function parseAscii(text, warnings) {
        // Hand-rolled scanner: much faster than a regex sweep over a large file.
        var verts = [];
        var len = text.length;
        var i = 0;
        var degenerate = 0;

        function skipSpace() {
            while (i < len) {
                var c = text.charCodeAt(i);
                if (c === 32 || c === 9 || c === 10 || c === 13) {
                    i++;
                } else {
                    break;
                }
            }
        }

        function readToken() {
            skipSpace();
            var start = i;
            while (i < len) {
                var c = text.charCodeAt(i);
                if (c === 32 || c === 9 || c === 10 || c === 13) {
                    break;
                }
                i++;
            }
            return start === i ? null : text.substring(start, i);
        }

        for (;;) {
            var tok = readToken();
            if (tok === null) {
                break;
            }
            if (tok === "vertex") {
                var x = parseFloat(readToken());
                var y = parseFloat(readToken());
                var z = parseFloat(readToken());
                if (isNaN(x) || isNaN(y) || isNaN(z)) {
                    warnings.push("malformed vertex found - parsing stopped early");
                    break;
                }
                verts.push(x, y, z);
            }
        }
        if (verts.length % 9 !== 0) {
            warnings.push("vertex count is not a multiple of three - trailing data ignored");
        }
        var count = Math.floor(verts.length / 9);
        var positions = new Float32Array(count * 9);
        var normals = new Float32Array(count * 9);
        for (var t = 0; t < count; t++) {
            var o = t * 9;
            for (var j = 0; j < 9; j++) {
                positions[o + j] = verts[o + j];
            }
            var n = faceNormal(verts[o], verts[o + 1], verts[o + 2],
                               verts[o + 3], verts[o + 4], verts[o + 5],
                               verts[o + 6], verts[o + 7], verts[o + 8]);
            if (!n) {
                degenerate++;
                n = [0, 0, 1];
            }
            for (var c = 0; c < 3; c++) {
                normals[o + c * 3] = n[0];
                normals[o + c * 3 + 1] = n[1];
                normals[o + c * 3 + 2] = n[2];
            }
        }
        if (degenerate) {
            warnings.push(degenerate + " degenerate (zero-area) triangle(s) found");
        }
        return {positions: positions, normals: normals, count: count};
    }

    /* buffer: ArrayBuffer with the raw file content. */
    P.parseSTL = function (buffer) {
        var warnings = [];
        var binary = isBinarySTL(buffer);
        var mesh;
        if (binary) {
            mesh = parseBinary(buffer, warnings);
        } else {
            var text = P.decodeText(buffer);
            mesh = parseAscii(text, warnings);
        }
        if (!mesh.count) {
            throw new Error("no triangles found - this does not look like an STL file");
        }
        return {
            format: "STL",
            flavour: binary ? "binary" : "ASCII",
            kind: "3d",
            mesh: {positions: mesh.positions, normals: mesh.normals},
            edges: [],
            bbox: P.bboxOf(mesh.positions),
            stats: [["Encoding", binary ? "binary" : "ASCII"],
                    ["Triangles", mesh.count]],
            warnings: warnings
        };
    };
})(typeof self !== "undefined" ? self : this);
