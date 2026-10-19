/* PyCAM Viewer - DXF parser.
 *
 * Reads the ASCII DXF flavour (R12 up to current releases) and turns the drawing
 * into line segments grouped per layer.  Supported entities:
 *   LINE, POINT, CIRCLE, ARC, ELLIPSE, LWPOLYLINE (incl. bulges), POLYLINE/VERTEX
 *   (2D + 3D, incl. bulges), SPLINE (NURBS + fit points), SOLID, TRACE, 3DFACE,
 *   LEADER, INSERT (nested blocks, arrays, OCS/extrusion aware).
 *
 * Copyright 2026 The PyCAM contributors
 * Licensed under the GNU General Public License v3 or later (see COPYING.TXT).
 */
(function (root) {
    "use strict";

    var P = root.PVX = root.PVX || {};

    var UNIT_NAMES = {
        0: "unitless", 1: "inch", 2: "foot", 3: "mile", 4: "mm", 5: "cm", 6: "m",
        7: "km", 8: "microinch", 9: "mil", 10: "yard", 11: "angstrom", 12: "nm",
        13: "micron", 14: "dm", 15: "dam", 16: "hm", 17: "Gm", 18: "au",
        19: "light year", 20: "parsec"
    };

    /* --- tag stream ------------------------------------------------------ */

    function readTags(text) {
        var lines = text.split(/\r\n|\r|\n/);
        var tags = [];
        for (var i = 0; i + 1 < lines.length; i += 2) {
            var code = parseInt(lines[i], 10);
            if (isNaN(code)) {
                // Skip a stray line and try to resynchronise on the next one.
                i--;
                continue;
            }
            var raw = lines[i + 1];
            var value;
            if ((code >= 10 && code <= 59) || (code >= 110 && code <= 149)
                    || (code >= 210 && code <= 239) || (code >= 460 && code <= 469)
                    || (code >= 1010 && code <= 1059)) {
                value = parseFloat(raw);
                if (isNaN(value)) {
                    value = 0;
                }
            } else if ((code >= 60 && code <= 99) || (code >= 160 && code <= 179)
                    || (code >= 270 && code <= 289) || (code >= 370 && code <= 389)
                    || (code >= 400 && code <= 409) || (code >= 420 && code <= 429)
                    || (code >= 440 && code <= 459) || (code >= 1060 && code <= 1071)) {
                value = parseInt(raw, 10);
                if (isNaN(value)) {
                    value = 0;
                }
            } else {
                value = raw === undefined ? "" : raw.trim();
            }
            tags.push([code, value]);
        }
        return tags;
    }

    function Entity(type) {
        this.type = type;
        this.tags = [];
    }

    Entity.prototype.get = function (code, fallback) {
        for (var i = 0; i < this.tags.length; i++) {
            if (this.tags[i][0] === code) {
                return this.tags[i][1];
            }
        }
        return fallback;
    };

    Entity.prototype.all = function (code) {
        var out = [];
        for (var i = 0; i < this.tags.length; i++) {
            if (this.tags[i][0] === code) {
                out.push(this.tags[i][1]);
            }
        }
        return out;
    };

    /* --- linear algebra used for block placement and OCS ------------------ */

    function identity() {
        return [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];  // 3x3 row major + translation
    }

    function apply(m, p) {
        return [
            m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[9],
            m[3] * p[0] + m[4] * p[1] + m[5] * p[2] + m[10],
            m[6] * p[0] + m[7] * p[1] + m[8] * p[2] + m[11]
        ];
    }

    function compose(a, b) {
        // returns a * b (apply b first, then a)
        var out = new Array(12);
        for (var r = 0; r < 3; r++) {
            for (var c = 0; c < 3; c++) {
                out[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
            }
            out[9 + r] = a[r * 3] * b[9] + a[r * 3 + 1] * b[10] + a[r * 3 + 2] * b[11] + a[9 + r];
        }
        return out;
    }

    /* "Arbitrary axis algorithm": object coordinate system -> world. */
    function ocsMatrix(nx, ny, nz) {
        var len = Math.sqrt(nx * nx + ny * ny + nz * nz);
        if (len < 1e-12) {
            return identity();
        }
        nx /= len; ny /= len; nz /= len;
        if (Math.abs(nx) < 1 / 64 && Math.abs(ny) < 1 / 64) {
            if (nz > 0.9999 && Math.abs(nx) < 1e-12 && Math.abs(ny) < 1e-12) {
                return identity();
            }
        }
        var ax, ay, az;
        if (Math.abs(nx) < 1 / 64 && Math.abs(ny) < 1 / 64) {
            // Ax = WorldY x N
            ax = 1 * nz - 0 * ny;
            ay = 0 * nx - 0 * nz;
            az = 0 * ny - 1 * nx;
        } else {
            // Ax = WorldZ x N
            ax = 0 * nz - 1 * ny;
            ay = 1 * nx - 0 * nz;
            az = 0 * ny - 0 * nx;
        }
        var al = Math.sqrt(ax * ax + ay * ay + az * az) || 1;
        ax /= al; ay /= al; az /= al;
        var bx = ny * az - nz * ay;
        var by = nz * ax - nx * az;
        var bz = nx * ay - ny * ax;
        return [ax, bx, nx, ay, by, ny, az, bz, nz, 0, 0, 0];
    }

    function entityOcs(ent) {
        var nx = ent.get(210, 0), ny = ent.get(220, 0), nz = ent.get(230, 1);
        if (nx === 0 && ny === 0 && (nz === 1 || nz === 0)) {
            return null;
        }
        return ocsMatrix(nx, ny, nz);
    }

    /* --- curve helpers ---------------------------------------------------- */

    function arcPoints(cx, cy, z, radius, startAngle, endAngle) {
        var sweep = endAngle - startAngle;
        while (sweep <= 0) {
            sweep += Math.PI * 2;
        }
        var n = P.arcSegments(radius, sweep);
        var pts = [];
        for (var i = 0; i <= n; i++) {
            var a = startAngle + sweep * (i / n);
            pts.push([cx + radius * Math.cos(a), cy + radius * Math.sin(a), z]);
        }
        return pts;
    }

    /* Convert a polyline bulge (tangent of a quarter of the included angle)
     * between two points into intermediate arc points. */
    function bulgeArc(p1, p2, bulge) {
        var dx = p2[0] - p1[0], dy = p2[1] - p1[1];
        var chord = Math.sqrt(dx * dx + dy * dy);
        if (chord < 1e-12 || Math.abs(bulge) < 1e-12) {
            return [];
        }
        var included = 4 * Math.atan(bulge);           // signed sweep angle
        var radius = chord / (2 * Math.sin(Math.abs(included) / 2));
        var mx = (p1[0] + p2[0]) / 2, my = (p1[1] + p2[1]) / 2;
        var h = Math.sqrt(Math.max(radius * radius - (chord / 2) * (chord / 2), 0));
        var sign = (included > 0 ? 1 : -1) * (Math.abs(included) > Math.PI ? -1 : 1);
        var ux = -dy / chord, uy = dx / chord;
        var cx = mx + sign * h * ux, cy = my + sign * h * uy;
        var a1 = Math.atan2(p1[1] - cy, p1[0] - cx);
        var n = P.arcSegments(radius, Math.abs(included));
        var pts = [];
        for (var i = 1; i < n; i++) {
            var a = a1 + included * (i / n);
            pts.push([cx + radius * Math.cos(a), cy + radius * Math.sin(a),
                      p1[2] + (p2[2] - p1[2]) * (i / n)]);
        }
        return pts;
    }

    function expandBulges(points, bulges, closed) {
        var out = [];
        var count = points.length;
        if (!count) {
            return out;
        }
        var last = closed ? count : count - 1;
        for (var i = 0; i < last; i++) {
            var a = points[i];
            var b = points[(i + 1) % count];
            out.push(a);
            var bulge = bulges[i] || 0;
            if (bulge) {
                out = out.concat(bulgeArc(a, b, bulge));
            }
        }
        out.push(closed ? points[0] : points[count - 1]);
        return out;
    }

    /* NURBS evaluation (Cox-de Boor) for SPLINE entities. */
    function evalNurbs(ctrl, weights, knots, degree, samples) {
        var n = ctrl.length - 1;
        var pts = [];
        var t0 = knots[degree];
        var t1 = knots[n + 1];
        if (!(t1 > t0)) {
            return ctrl.slice();
        }
        for (var s = 0; s <= samples; s++) {
            var t = t0 + (t1 - t0) * (s / samples);
            if (s === samples) {
                t = t1 - 1e-12;
            }
            // find knot span
            var span = degree;
            for (var i = degree; i <= n; i++) {
                if (t >= knots[i] && t < knots[i + 1]) {
                    span = i;
                    break;
                }
                span = i;
            }
            // de Boor
            var d = [];
            for (var j = 0; j <= degree; j++) {
                var idx = span - degree + j;
                var w = weights ? weights[idx] : 1;
                d.push([ctrl[idx][0] * w, ctrl[idx][1] * w, ctrl[idx][2] * w, w]);
            }
            for (var r = 1; r <= degree; r++) {
                for (var k = degree; k >= r; k--) {
                    var i2 = span - degree + k;
                    var den = knots[i2 + degree - r + 1] - knots[i2];
                    var alpha = den > 1e-12 ? (t - knots[i2]) / den : 0;
                    for (var c = 0; c < 4; c++) {
                        d[k][c] = (1 - alpha) * d[k - 1][c] + alpha * d[k][c];
                    }
                }
            }
            var res = d[degree];
            var wf = Math.abs(res[3]) > 1e-12 ? res[3] : 1;
            pts.push([res[0] / wf, res[1] / wf, res[2] / wf]);
        }
        return pts;
    }

    /* Centripetal Catmull-Rom through fit points (splines without control points). */
    function throughPoints(pts, closed) {
        if (pts.length < 3) {
            return pts.slice();
        }
        var out = [];
        var n = pts.length;
        var count = closed ? n : n - 1;
        for (var i = 0; i < count; i++) {
            var p0 = pts[(i - 1 + n) % n];
            var p1 = pts[i];
            var p2 = pts[(i + 1) % n];
            var p3 = pts[(i + 2) % n];
            if (!closed) {
                if (i === 0) { p0 = p1; }
                if (i + 2 >= n) { p3 = p2; }
            }
            for (var s = 0; s < 12; s++) {
                var t = s / 12, t2 = t * t, t3 = t2 * t;
                var p = [0, 0, 0];
                for (var c = 0; c < 3; c++) {
                    p[c] = 0.5 * ((2 * p1[c])
                        + (-p0[c] + p2[c]) * t
                        + (2 * p0[c] - 5 * p1[c] + 4 * p2[c] - p3[c]) * t2
                        + (-p0[c] + 3 * p1[c] - 3 * p2[c] + p3[c]) * t3);
                }
                out.push(p);
            }
        }
        out.push(closed ? pts[0] : pts[n - 1]);
        return out;
    }

    /* --- main parser ------------------------------------------------------ */

    P.parseDXF = function (buffer) {
        var text = P.decodeText(buffer);
        if (/^\s*AutoCAD Binary DXF/.test(text.substring(0, 40))) {
            throw new Error("binary DXF files are not supported - please save as ASCII DXF");
        }
        var tags = readTags(text);
        if (!tags.length) {
            throw new Error("no DXF tags found - this does not look like a DXF file");
        }

        var header = {};
        var layerDefs = {};
        var blocks = {};
        var entities = [];
        var warnings = [];

        var i = 0;
        while (i < tags.length) {
            var tag = tags[i];
            if (tag[0] === 0 && tag[1] === "SECTION") {
                var name = (tags[i + 1] && tags[i + 1][0] === 2) ? tags[i + 1][1] : "";
                i += 2;
                if (name === "HEADER") {
                    i = readHeader(tags, i, header);
                } else if (name === "TABLES") {
                    i = readTables(tags, i, layerDefs);
                } else if (name === "BLOCKS") {
                    i = readBlocks(tags, i, blocks);
                } else if (name === "ENTITIES") {
                    i = readEntities(tags, i, entities);
                } else {
                    i = skipSection(tags, i);
                }
            } else {
                i++;
            }
        }

        var ctx = {
            layers: {},
            layerDefs: layerDefs,
            blocks: blocks,
            bbox: P.emptyBBox(),
            skipped: {},
            warnings: warnings,
            segments: 0
        };
        emitEntities(entities, identity(), ctx, null, 0);

        var layerList = [];
        Object.keys(ctx.layers).forEach(function (key) {
            var layer = ctx.layers[key];
            if (!layer.data.length) {
                return;
            }
            layerList.push({
                name: layer.name,
                color: layer.color,
                visible: layer.visible,
                positions: new Float32Array(layer.data),
                segments: layer.data.length / 6
            });
        });
        layerList.sort(function (a, b) {
            return a.name.localeCompare(b.name);
        });

        if (!layerList.length) {
            throw new Error("the DXF file contains no drawable geometry");
        }

        var skippedNames = Object.keys(ctx.skipped);
        if (skippedNames.length) {
            warnings.push("not rendered: " + skippedNames.map(function (k) {
                return k + " x" + ctx.skipped[k];
            }).join(", "));
        }

        var stats = [["Layers", layerList.length], ["Line segments", ctx.segments]];
        if (header.$INSUNITS !== undefined) {
            stats.push(["Units", UNIT_NAMES[header.$INSUNITS] || ("code " + header.$INSUNITS)]);
        }
        if (header.$ACADVER) {
            stats.push(["DXF version", header.$ACADVER]);
        }

        var flat = layerList.every(function (layer) {
            for (var k = 2; k < layer.positions.length; k += 3) {
                if (Math.abs(layer.positions[k]) > 1e-9) {
                    return false;
                }
            }
            return true;
        });

        return {
            format: "DXF",
            flavour: header.$ACADVER || "ASCII",
            kind: flat ? "2d" : "3d",
            mesh: null,
            edges: layerList,
            bbox: ctx.bbox,
            stats: stats,
            warnings: warnings
        };
    };

    function skipSection(tags, i) {
        while (i < tags.length) {
            if (tags[i][0] === 0 && tags[i][1] === "ENDSEC") {
                return i + 1;
            }
            i++;
        }
        return i;
    }

    function readHeader(tags, i, header) {
        var current = null;
        while (i < tags.length) {
            var tag = tags[i];
            if (tag[0] === 0 && tag[1] === "ENDSEC") {
                return i + 1;
            }
            if (tag[0] === 9) {
                current = tag[1];
            } else if (current && header[current] === undefined) {
                header[current] = tag[1];
            }
            i++;
        }
        return i;
    }

    function readTables(tags, i, layerDefs) {
        var current = null;
        while (i < tags.length) {
            var tag = tags[i];
            if (tag[0] === 0) {
                if (tag[1] === "ENDSEC") {
                    return i + 1;
                }
                if (tag[1] === "LAYER") {
                    current = {name: "", color: 7, off: false};
                    layerDefs[""] = layerDefs[""] || null;
                } else {
                    if (current && current.name) {
                        layerDefs[current.name] = current;
                    }
                    current = null;
                }
            } else if (current) {
                if (tag[0] === 2) {
                    current.name = tag[1];
                } else if (tag[0] === 62) {
                    current.off = tag[1] < 0;
                    current.color = Math.abs(tag[1]);
                }
            }
            i++;
        }
        if (current && current.name) {
            layerDefs[current.name] = current;
        }
        return i;
    }

    function readBlocks(tags, i, blocks) {
        var block = null;
        var entity = null;
        while (i < tags.length) {
            var tag = tags[i];
            if (tag[0] === 0) {
                if (tag[1] === "ENDSEC") {
                    return i + 1;
                }
                if (tag[1] === "BLOCK") {
                    block = {name: "", base: [0, 0, 0], entities: []};
                    entity = new Entity("BLOCK");
                } else if (tag[1] === "ENDBLK") {
                    if (block && block.name) {
                        blocks[block.name] = block;
                    }
                    block = null;
                    entity = null;
                } else if (block) {
                    entity = new Entity(tag[1]);
                    block.entities.push(entity);
                }
            } else if (entity) {
                if (entity.type === "BLOCK" && block) {
                    if (tag[0] === 2 && !block.name) {
                        block.name = tag[1];
                    } else if (tag[0] === 10) {
                        block.base[0] = tag[1];
                    } else if (tag[0] === 20) {
                        block.base[1] = tag[1];
                    } else if (tag[0] === 30) {
                        block.base[2] = tag[1];
                    }
                } else {
                    entity.tags.push(tag);
                }
            }
            i++;
        }
        return i;
    }

    function readEntitiesRaw(tags, i, entities) {
        var entity = null;
        while (i < tags.length) {
            var tag = tags[i];
            if (tag[0] === 0) {
                if (tag[1] === "ENDSEC") {
                    return i + 1;
                }
                entity = new Entity(tag[1]);
                entities.push(entity);
            } else if (entity) {
                entity.tags.push(tag);
            }
            i++;
        }
        return i;
    }

    /* --- entity -> line segments ------------------------------------------ */

    function layerFor(ctx, name, colorIndex) {
        var key = name + " " + colorIndex;
        var layer = ctx.layers[key];
        if (!layer) {
            var def = ctx.layerDefs[name];
            layer = {
                name: name || "0",
                color: P.aciColor(colorIndex === 256 || colorIndex === undefined
                    ? (def ? def.color : 7) : colorIndex),
                visible: !(def && def.off),
                data: []
            };
            ctx.layers[key] = layer;
        }
        return layer;
    }

    function emitPolyline(ctx, layer, points, matrix, closed) {
        if (points.length < 2) {
            return;
        }
        var data = layer.data;
        var prev = apply(matrix, points[0]);
        for (var i = 1; i < points.length; i++) {
            var cur = apply(matrix, points[i]);
            data.push(prev[0], prev[1], prev[2], cur[0], cur[1], cur[2]);
            P.growBBox(ctx.bbox, prev[0], prev[1], prev[2]);
            P.growBBox(ctx.bbox, cur[0], cur[1], cur[2]);
            ctx.segments++;
            prev = cur;
        }
        if (closed) {
            var first = apply(matrix, points[0]);
            data.push(prev[0], prev[1], prev[2], first[0], first[1], first[2]);
            ctx.segments++;
        }
    }

    function collectVertices(ent) {
        // Ordered walk over the tag list so that 10/20/30/42 stay associated.
        var pts = [];
        var bulges = [];
        var cur = null;
        for (var i = 0; i < ent.tags.length; i++) {
            var code = ent.tags[i][0];
            var value = ent.tags[i][1];
            if (code === 10) {
                if (cur) {
                    pts.push(cur);
                    bulges.push(cur[3] || 0);
                }
                cur = [value, 0, 0, 0];
            } else if (cur) {
                if (code === 20) {
                    cur[1] = value;
                } else if (code === 30) {
                    cur[2] = value;
                } else if (code === 42) {
                    cur[3] = value;
                }
            }
        }
        if (cur) {
            pts.push(cur);
            bulges.push(cur[3] || 0);
        }
        return {points: pts.map(function (p) {
            return [p[0], p[1], p[2]];
        }), bulges: bulges};
    }

    function emitEntities(entities, matrix, ctx, overrideLayer, depth) {
        if (depth > 16) {
            ctx.warnings.push("block nesting deeper than 16 levels was cut off");
            return;
        }
        for (var e = 0; e < entities.length; e++) {
            var ent = entities[e];
            var layerName = overrideLayer && (ent.get(8, "0") === "0")
                ? overrideLayer : ent.get(8, "0");
            var colorIndex = ent.get(62, 256);
            var layer = layerFor(ctx, layerName, colorIndex);
            var ocs = entityOcs(ent);
            var mat = ocs ? compose(matrix, ocs) : matrix;
            try {
                emitEntity(ent, mat, matrix, ctx, layer, layerName, depth);
            } catch (err) {
                ctx.skipped[ent.type + " (error)"] = (ctx.skipped[ent.type + " (error)"] || 0) + 1;
            }
        }
    }

    function emitEntity(ent, mat, rawMatrix, ctx, layer, layerName, depth) {
        var type = ent.type;
        var pts;
        switch (type) {
        case "LINE":
            emitPolyline(ctx, layer, [
                [ent.get(10, 0), ent.get(20, 0), ent.get(30, 0)],
                [ent.get(11, 0), ent.get(21, 0), ent.get(31, 0)]
            ], mat, false);
            break;
        case "POINT":
            // Zero length segment: invisible as a line, but it keeps the point
            // inside the drawing extents.
            var px = ent.get(10, 0), py = ent.get(20, 0), pz = ent.get(30, 0);
            emitPolyline(ctx, layer, [[px, py, pz], [px, py, pz]], mat, false);
            break;
        case "CIRCLE":
            emitPolyline(ctx, layer, arcPoints(ent.get(10, 0), ent.get(20, 0), ent.get(30, 0),
                                               ent.get(40, 1), 0, Math.PI * 2), mat, false);
            break;
        case "ARC":
            emitPolyline(ctx, layer, arcPoints(ent.get(10, 0), ent.get(20, 0), ent.get(30, 0),
                                               ent.get(40, 1),
                                               ent.get(50, 0) * Math.PI / 180,
                                               ent.get(51, 360) * Math.PI / 180), mat, false);
            break;
        case "ELLIPSE":
            emitPolyline(ctx, layer, ellipsePoints(ent), mat, false);
            break;
        case "LWPOLYLINE":
            var lw = collectVertices(ent);
            var lwClosed = (ent.get(70, 0) & 1) === 1;
            var elev = ent.get(38, 0);
            var lwPts = lw.points.map(function (p) {
                return [p[0], p[1], elev];
            });
            emitPolyline(ctx, layer, expandBulges(lwPts, lw.bulges, lwClosed), mat, false);
            break;
        case "POLYLINE":
            // Already merged with its VERTEX entities while reading the section.
            break;
        case "SPLINE":
            emitPolyline(ctx, layer, splinePoints(ent), mat, false);
            break;
        case "SOLID":
        case "TRACE":
            pts = [
                [ent.get(10, 0), ent.get(20, 0), ent.get(30, 0)],
                [ent.get(11, 0), ent.get(21, 0), ent.get(31, 0)],
                [ent.get(13, ent.get(11, 0)), ent.get(23, ent.get(21, 0)), ent.get(33, ent.get(31, 0))],
                [ent.get(12, 0), ent.get(22, 0), ent.get(32, 0)]
            ];
            emitPolyline(ctx, layer, pts, mat, true);
            break;
        case "3DFACE":
            pts = [
                [ent.get(10, 0), ent.get(20, 0), ent.get(30, 0)],
                [ent.get(11, 0), ent.get(21, 0), ent.get(31, 0)],
                [ent.get(12, 0), ent.get(22, 0), ent.get(32, 0)],
                [ent.get(13, ent.get(12, 0)), ent.get(23, ent.get(22, 0)), ent.get(33, ent.get(32, 0))]
            ];
            emitPolyline(ctx, layer, pts, rawMatrix, true);
            break;
        case "LEADER":
            pts = [];
            var xs = ent.all(10), ys = ent.all(20), zs = ent.all(30);
            for (var i = 0; i < xs.length; i++) {
                pts.push([xs[i], ys[i] || 0, zs[i] || 0]);
            }
            emitPolyline(ctx, layer, pts, rawMatrix, false);
            break;
        case "INSERT":
            emitInsert(ent, rawMatrix, ctx, layerName, depth);
            break;
        case "SEQEND":
        case "VERTEX":
        case "ENDBLK":
        case "BLOCK":
            break;
        default:
            ctx.skipped[type] = (ctx.skipped[type] || 0) + 1;
        }
    }

    function ellipsePoints(ent) {
        var cx = ent.get(10, 0), cy = ent.get(20, 0), cz = ent.get(30, 0);
        var mx = ent.get(11, 1), my = ent.get(21, 0), mz = ent.get(31, 0);
        var ratio = ent.get(40, 1);
        var start = ent.get(41, 0);
        var end = ent.get(42, Math.PI * 2);
        var major = Math.sqrt(mx * mx + my * my + mz * mz);
        var minor = major * ratio;
        var sweep = end - start;
        while (sweep <= 1e-12) {
            sweep += Math.PI * 2;
        }
        var n = P.arcSegments(major, sweep);
        var rot = Math.atan2(my, mx);
        var cos = Math.cos(rot), sin = Math.sin(rot);
        var pts = [];
        for (var i = 0; i <= n; i++) {
            var t = start + sweep * (i / n);
            var x = major * Math.cos(t);
            var y = minor * Math.sin(t);
            pts.push([cx + x * cos - y * sin, cy + x * sin + y * cos, cz]);
        }
        return pts;
    }

    function splinePoints(ent) {
        var flags = ent.get(70, 0);
        var degree = ent.get(71, 3);
        var knots = ent.all(40);
        var weights = ent.all(41);
        var ctrl = [];
        var cx = ent.all(10), cy = ent.all(20), cz = ent.all(30);
        for (var i = 0; i < cx.length; i++) {
            ctrl.push([cx[i], cy[i] || 0, cz[i] || 0]);
        }
        var closed = (flags & 1) === 1;
        if (ctrl.length > degree && knots.length === ctrl.length + degree + 1) {
            var samples = Math.min(1024, Math.max(24, ctrl.length * 12));
            return evalNurbs(ctrl, weights.length === ctrl.length ? weights : null,
                             knots, degree, samples);
        }
        var fit = [];
        var fx = ent.all(11), fy = ent.all(21), fz = ent.all(31);
        for (var j = 0; j < fx.length; j++) {
            fit.push([fx[j], fy[j] || 0, fz[j] || 0]);
        }
        if (fit.length >= 2) {
            return throughPoints(fit, closed);
        }
        return ctrl;
    }

    function emitInsert(ent, matrix, ctx, layerName, depth) {
        var name = ent.get(2, "");
        var block = ctx.blocks[name];
        if (!block) {
            ctx.skipped["INSERT " + name] = (ctx.skipped["INSERT " + name] || 0) + 1;
            return;
        }
        var sx = ent.get(41, 1) || 1;
        var sy = ent.get(42, 1) || 1;
        var sz = ent.get(43, 1) || 1;
        var rot = (ent.get(50, 0) || 0) * Math.PI / 180;
        var cols = Math.max(1, ent.get(70, 1) || 1);
        var rows = Math.max(1, ent.get(71, 1) || 1);
        var colSpace = ent.get(44, 0);
        var rowSpace = ent.get(45, 0);
        var ix = ent.get(10, 0), iy = ent.get(20, 0), iz = ent.get(30, 0);
        var ocs = entityOcs(ent);
        var base = ocs ? compose(matrix, ocs) : matrix;
        var cos = Math.cos(rot), sin = Math.sin(rot);
        var total = cols * rows;
        if (total > 4096) {
            ctx.warnings.push("INSERT array of " + total + " copies was limited to 4096");
        }
        var drawn = 0;
        for (var c = 0; c < cols; c++) {
            for (var r = 0; r < rows; r++) {
                if (++drawn > 4096) {
                    return;
                }
                var tx = ix + c * colSpace;
                var ty = iy + r * rowSpace;
                var local = [
                    cos * sx, -sin * sy, 0,
                    sin * sx, cos * sy, 0,
                    0, 0, sz,
                    tx - (cos * sx * block.base[0] - sin * sy * block.base[1]),
                    ty - (sin * sx * block.base[0] + cos * sy * block.base[1]),
                    iz - sz * block.base[2]
                ];
                emitEntities(block.entities, compose(base, local), ctx,
                             layerName === "0" ? null : layerName, depth + 1);
            }
        }
    }

    /* POLYLINE/VERTEX pairs need document order, so they are stitched together
     * into a single polyline entity before the generic emit pass runs. */
    function readEntities(tags, i, entities) {
        var raw = [];
        var end = readEntitiesRaw(tags, i, raw);
        var out = [];
        var polyline = null;
        var vertices = null;
        for (var k = 0; k < raw.length; k++) {
            var ent = raw[k];
            if (ent.type === "POLYLINE") {
                flushPolyline();
                polyline = ent;
                vertices = [];
            } else if (ent.type === "VERTEX" && polyline) {
                vertices.push(ent);
            } else if (ent.type === "SEQEND") {
                flushPolyline();
            } else {
                flushPolyline();
                out.push(ent);
            }
        }
        flushPolyline();
        for (var m = 0; m < out.length; m++) {
            entities.push(out[m]);
        }
        return end;

        function flushPolyline() {
            if (!polyline) {
                return;
            }
            var flags = polyline.get(70, 0);
            var closed = (flags & 1) === 1;
            var pts = [];
            var bulges = [];
            var isMesh = (flags & 16) === 16 || (flags & 64) === 64;
            for (var v = 0; v < vertices.length; v++) {
                var vertexFlags = vertices[v].get(70, 0);
                if (isMesh && (vertexFlags & 128) && !(vertexFlags & 64)) {
                    continue;  // face record of a polyface mesh - no coordinates
                }
                pts.push([vertices[v].get(10, 0), vertices[v].get(20, 0), vertices[v].get(30, 0)]);
                bulges.push(vertices[v].get(42, 0));
            }
            if (pts.length >= 2) {
                var merged = new Entity("LWPOLYLINE");
                var expanded = expandBulges(pts, bulges, closed);
                for (var p = 0; p < expanded.length; p++) {
                    merged.tags.push([10, expanded[p][0]]);
                    merged.tags.push([20, expanded[p][1]]);
                    merged.tags.push([30, expanded[p][2]]);
                }
                merged.tags.push([8, polyline.get(8, "0")]);
                merged.tags.push([62, polyline.get(62, 256)]);
                merged.tags.push([70, 0]);
                merged.tags.push([210, polyline.get(210, 0)]);
                merged.tags.push([220, polyline.get(220, 0)]);
                merged.tags.push([230, polyline.get(230, 1)]);
                out.push(merged);
            }
            polyline = null;
            vertices = null;
        }
    }
})(typeof self !== "undefined" ? self : this);
