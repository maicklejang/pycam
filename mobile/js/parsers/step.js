/* PyCAM Viewer - STEP (ISO 10303-21) reader with B-rep tessellation.
 *
 * The file is parsed into an entity table, the boundary representation is walked
 * (solids -> shells -> faces -> loops -> edges -> curves) and every face is
 * tessellated in its surface parameter space.  Analytic surfaces (plane,
 * cylinder, cone, sphere, torus) get exact vertex normals; anything else falls
 * back to a planar fit of its boundary, and faces that cannot be meshed are
 * still shown as wireframe.
 *
 * Copyright 2026 The PyCAM contributors
 * Licensed under the GNU General Public License v3 or later (see COPYING.TXT).
 */
(function (root) {
    "use strict";

    var P = root.PVX = root.PVX || {};

    var MAX_TRIANGLES = 4000000;

    /* --- vector / placement helpers --------------------------------------- */

    function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
    function add(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
    function scale(a, s) { return [a[0] * s, a[1] * s, a[2] * s]; }
    function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
    function cross(a, b) {
        return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    }
    function length(a) { return Math.sqrt(dot(a, a)); }
    function normalize(a) {
        var l = length(a);
        return l > 1e-15 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
    }

    function identityXf() {
        return {m: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0]};
    }

    function xfPoint(xf, p) {
        var m = xf.m;
        return [
            m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + xf.t[0],
            m[3] * p[0] + m[4] * p[1] + m[5] * p[2] + xf.t[1],
            m[6] * p[0] + m[7] * p[1] + m[8] * p[2] + xf.t[2]
        ];
    }

    function xfDir(xf, d) {
        var m = xf.m;
        return [
            m[0] * d[0] + m[1] * d[1] + m[2] * d[2],
            m[3] * d[0] + m[4] * d[1] + m[5] * d[2],
            m[6] * d[0] + m[7] * d[1] + m[8] * d[2]
        ];
    }

    function xfCompose(a, b) {
        var out = {m: new Array(9), t: [0, 0, 0]};
        for (var r = 0; r < 3; r++) {
            for (var c = 0; c < 3; c++) {
                out.m[r * 3 + c] = a.m[r * 3] * b.m[c] + a.m[r * 3 + 1] * b.m[3 + c]
                    + a.m[r * 3 + 2] * b.m[6 + c];
            }
        }
        var t = xfPoint(a, b.t);
        out.t = t;
        return out;
    }

    /* Placements are orthonormal, so the inverse is the transpose. */
    function xfInvert(xf) {
        var m = xf.m;
        var inv = [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
        var t = [
            -(inv[0] * xf.t[0] + inv[1] * xf.t[1] + inv[2] * xf.t[2]),
            -(inv[3] * xf.t[0] + inv[4] * xf.t[1] + inv[5] * xf.t[2]),
            -(inv[6] * xf.t[0] + inv[7] * xf.t[1] + inv[8] * xf.t[2])
        ];
        return {m: inv, t: t};
    }

    /* --- ISO 10303-21 tokenizer ------------------------------------------- */

    function Parser(text) {
        this.s = text;
        this.i = 0;
        this.n = text.length;
    }

    Parser.prototype.skipWs = function () {
        var s = this.s;
        while (this.i < this.n) {
            var c = s.charCodeAt(this.i);
            if (c === 32 || c === 9 || c === 10 || c === 13) {
                this.i++;
            } else if (c === 47 && s.charCodeAt(this.i + 1) === 42) {   // "/*"
                var end = s.indexOf("*/", this.i + 2);
                this.i = end < 0 ? this.n : end + 2;
            } else {
                break;
            }
        }
    };

    Parser.prototype.parseValue = function () {
        this.skipWs();
        var s = this.s;
        var c = s.charAt(this.i);
        if (c === "#") {
            var start = ++this.i;
            while (this.i < this.n && s.charCodeAt(this.i) >= 48 && s.charCodeAt(this.i) <= 57) {
                this.i++;
            }
            return {ref: parseInt(s.substring(start, this.i), 10)};
        }
        if (c === "'") {
            this.i++;
            var out = "";
            while (this.i < this.n) {
                var ch = s.charAt(this.i);
                if (ch === "'") {
                    if (s.charAt(this.i + 1) === "'") {
                        out += "'";
                        this.i += 2;
                        continue;
                    }
                    this.i++;
                    break;
                }
                out += ch;
                this.i++;
            }
            return out;
        }
        if (c === "(") {
            this.i++;
            var list = [];
            for (;;) {
                this.skipWs();
                var nc = this.s.charAt(this.i);
                if (nc === ")") {
                    this.i++;
                    break;
                }
                if (nc === ",") {
                    this.i++;
                    continue;
                }
                if (this.i >= this.n) {
                    break;
                }
                list.push(this.parseValue());
            }
            return list;
        }
        if (c === ".") {
            var e0 = ++this.i;
            while (this.i < this.n && s.charAt(this.i) !== ".") {
                this.i++;
            }
            var name = s.substring(e0, this.i);
            this.i++;
            return {enum: name};
        }
        if (c === "$") {
            this.i++;
            return null;
        }
        if (c === "*") {
            this.i++;
            return {derived: true};
        }
        if ((c >= "0" && c <= "9") || c === "-" || c === "+") {
            var ns = this.i;
            this.i++;
            while (this.i < this.n) {
                var cc = s.charAt(this.i);
                if ((cc >= "0" && cc <= "9") || cc === "." || cc === "e" || cc === "E"
                        || cc === "-" || cc === "+") {
                    this.i++;
                } else {
                    break;
                }
            }
            return parseFloat(s.substring(ns, this.i));
        }
        // keyword: either a typed value NAME(...) or a bare token
        var ks = this.i;
        while (this.i < this.n) {
            var kc = s.charAt(this.i);
            if (/[A-Za-z0-9_!]/.test(kc)) {
                this.i++;
            } else {
                break;
            }
        }
        var keyword = s.substring(ks, this.i).toUpperCase();
        this.skipWs();
        if (this.s.charAt(this.i) === "(") {
            var args = this.parseValue();
            return {type: keyword, args: args};
        }
        if (!keyword) {
            this.i++;   // unknown character - do not stall
            return null;
        }
        return {token: keyword};
    };

    function parseFile(text) {
        var parser = new Parser(text);
        var entities = new Map();
        var headers = [];
        var s = text;
        var dataStart = s.indexOf("DATA;");
        var headerEnd = dataStart < 0 ? s.length : dataStart;

        // header entities (FILE_NAME, FILE_SCHEMA, ...)
        var headParser = new Parser(s.substring(0, headerEnd));
        headParser.skipWs();
        while (headParser.i < headParser.n) {
            var value = headParser.parseValue();
            if (value && value.type) {
                headers.push(value);
            }
            headParser.skipWs();
            if (headParser.s.charAt(headParser.i) === ";") {
                headParser.i++;
            } else if (value === null && headParser.i >= headParser.n) {
                break;
            }
            headParser.skipWs();
        }

        if (dataStart < 0) {
            throw new Error("no DATA section found - this does not look like a STEP file");
        }
        parser.i = dataStart + 5;
        while (parser.i < parser.n) {
            parser.skipWs();
            if (parser.s.charAt(parser.i) !== "#") {
                if (parser.s.substr(parser.i, 7).toUpperCase() === "ENDSEC;") {
                    break;
                }
                // resynchronise on the next statement
                var next = parser.s.indexOf("#", parser.i);
                if (next < 0) {
                    break;
                }
                parser.i = next;
            }
            parser.i++;
            var idStart = parser.i;
            while (parser.i < parser.n && parser.s.charCodeAt(parser.i) >= 48
                    && parser.s.charCodeAt(parser.i) <= 57) {
                parser.i++;
            }
            var id = parseInt(parser.s.substring(idStart, parser.i), 10);
            parser.skipWs();
            if (parser.s.charAt(parser.i) !== "=") {
                continue;
            }
            parser.i++;
            var record = parser.parseValue();
            parser.skipWs();
            if (parser.s.charAt(parser.i) === ";") {
                parser.i++;
            } else {
                var semi = parser.s.indexOf(";", parser.i);
                parser.i = semi < 0 ? parser.n : semi + 1;
            }
            if (!isNaN(id) && record) {
                if (Array.isArray(record)) {
                    entities.set(id, {type: "_COMPLEX", parts: record, args: []});
                } else {
                    entities.set(id, record);
                }
            }
        }
        return {entities: entities, headers: headers};
    }

    /* --- model access ------------------------------------------------------ */

    function Model(entities) {
        this.entities = entities;
        this.byType = new Map();
        var self = this;
        entities.forEach(function (ent, id) {
            if (ent.type === "_COMPLEX") {
                ent.parts.forEach(function (part) {
                    if (part && part.type) {
                        self.index(part.type, id);
                    }
                });
            } else if (ent.type) {
                self.index(ent.type, id);
            }
        });
    }

    Model.prototype.index = function (type, id) {
        var list = this.byType.get(type);
        if (!list) {
            list = [];
            this.byType.set(type, list);
        }
        list.push(id);
    };

    Model.prototype.ids = function (type) {
        return this.byType.get(type) || [];
    };

    Model.prototype.get = function (value) {
        if (value && value.ref !== undefined) {
            return this.entities.get(value.ref) || null;
        }
        return value || null;
    };

    /* Return the record of the requested type, looking inside complex instances. */
    Model.prototype.as = function (value, type) {
        var ent = this.get(value);
        if (!ent) {
            return null;
        }
        if (ent.type === type) {
            return ent;
        }
        if (ent.type === "_COMPLEX") {
            for (var i = 0; i < ent.parts.length; i++) {
                if (ent.parts[i] && ent.parts[i].type === type) {
                    return ent.parts[i];
                }
            }
        }
        return null;
    };

    Model.prototype.typeOf = function (value) {
        var ent = this.get(value);
        if (!ent) {
            return null;
        }
        if (ent.type === "_COMPLEX") {
            var fallback = null;
            for (var i = 0; i < ent.parts.length; i++) {
                var t = ent.parts[i] && ent.parts[i].type;
                if (!t) {
                    continue;
                }
                if (SURFACE_TYPES[t] || CURVE_TYPES[t]) {
                    return t;
                }
                if (!fallback) {
                    fallback = t;
                }
            }
            return fallback;
        }
        return ent.type;
    };

    Model.prototype.point = function (value) {
        var ent = this.as(value, "CARTESIAN_POINT");
        if (!ent) {
            return null;
        }
        var coords = ent.args[1] || [];
        return [coords[0] || 0, coords[1] || 0, coords[2] || 0];
    };

    Model.prototype.direction = function (value, fallback) {
        var ent = this.as(value, "DIRECTION");
        if (!ent) {
            return fallback ? fallback.slice() : null;
        }
        var coords = ent.args[1] || [];
        return normalize([coords[0] || 0, coords[1] || 0, coords[2] || 0]);
    };

    /* AXIS2_PLACEMENT_3D -> orthonormal frame */
    Model.prototype.placement = function (value) {
        var ent = this.as(value, "AXIS2_PLACEMENT_3D");
        if (!ent) {
            return identityXf();
        }
        var origin = this.point(ent.args[1]) || [0, 0, 0];
        var z = this.direction(ent.args[2], [0, 0, 1]) || [0, 0, 1];
        var refx = this.direction(ent.args[3], null);
        if (!refx || length(refx) < 1e-12) {
            refx = Math.abs(z[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
        }
        var x = normalize(sub(refx, scale(z, dot(refx, z))));
        if (length(x) < 1e-12) {
            x = normalize(cross(Math.abs(z[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0], z));
        }
        var y = cross(z, x);
        return {m: [x[0], y[0], z[0], x[1], y[1], z[1], x[2], y[2], z[2]], t: origin,
                x: x, y: y, z: z, o: origin};
    };

    /* Geometry types we know how to evaluate; used to pick the interesting part
     * out of a complex (multi-type) entity instance. */
    var CURVE_TYPES = {
        LINE: 1, CIRCLE: 1, ELLIPSE: 1, POLYLINE: 1, TRIMMED_CURVE: 1, COMPOSITE_CURVE: 1,
        B_SPLINE_CURVE: 1, B_SPLINE_CURVE_WITH_KNOTS: 1, RATIONAL_B_SPLINE_CURVE: 1,
        SURFACE_CURVE: 1, SEAM_CURVE: 1, INTERSECTION_CURVE: 1
    };

    /* --- curve discretisation --------------------------------------------- */

    function Tessellator(model) {
        this.model = model;
        this.positions = [];
        this.normals = [];
        this.edgeLines = [];
        this.bbox = P.emptyBBox();
        this.faceCount = 0;
        this.meshedFaces = 0;
        this.failedFaces = 0;
        this.unsupportedSurfaces = {};
        this.curveCache = new Map();
    }

    Tessellator.prototype.curvePoints = function (curveRef, p1, p2, sameSense) {
        var model = this.model;
        var type = model.typeOf(curveRef);
        var ent = model.get(curveRef);
        if (!type || !ent) {
            return [p1, p2];
        }
        switch (type) {
        case "LINE":
            return [p1, p2];
        case "CIRCLE":
            return this.conicPoints(model.as(curveRef, "CIRCLE"), p1, p2, sameSense, false);
        case "ELLIPSE":
            return this.conicPoints(model.as(curveRef, "ELLIPSE"), p1, p2, sameSense, true);
        case "B_SPLINE_CURVE_WITH_KNOTS":
        case "RATIONAL_B_SPLINE_CURVE":
        case "B_SPLINE_CURVE":
            return this.splinePoints(curveRef, p1, p2);
        case "POLYLINE":
            var pts = (ent.args[1] || []).map(function (ref) {
                return model.point(ref);
            }).filter(Boolean);
            return pts.length >= 2 ? pts : [p1, p2];
        case "TRIMMED_CURVE":
            return this.curvePoints(ent.args[1], p1, p2, sameSense);
        case "SURFACE_CURVE":
        case "SEAM_CURVE":
        case "INTERSECTION_CURVE":
            return this.curvePoints(ent.args[1], p1, p2, sameSense);
        case "COMPOSITE_CURVE":
            return this.compositePoints(ent, p1, p2);
        default:
            return [p1, p2];
        }
    };

    Tessellator.prototype.compositePoints = function (ent, p1, p2) {
        var model = this.model;
        var segments = ent.args[1] || [];
        var out = [];
        for (var i = 0; i < segments.length; i++) {
            var seg = model.as(segments[i], "COMPOSITE_CURVE_SEGMENT");
            if (!seg) {
                continue;
            }
            var pts = this.curvePoints(seg.args[2], p1, p2, true);
            for (var k = 0; k < pts.length; k++) {
                if (!out.length || length(sub(out[out.length - 1], pts[k])) > 1e-9) {
                    out.push(pts[k]);
                }
            }
        }
        return out.length >= 2 ? out : [p1, p2];
    };

    Tessellator.prototype.conicPoints = function (ent, p1, p2, sameSense, isEllipse) {
        var model = this.model;
        var frame = model.placement(ent.args[1]);
        var r1 = ent.args[2] || 0;
        var r2 = isEllipse ? (ent.args[3] || r1) : r1;
        var inv = xfInvert(frame);
        var l1 = xfPoint(inv, p1);
        var l2 = xfPoint(inv, p2);
        var a1 = Math.atan2(l1[1] / (r2 || 1), l1[0] / (r1 || 1));
        var a2 = Math.atan2(l2[1] / (r2 || 1), l2[0] / (r1 || 1));
        var sweep;
        if (sameSense) {
            sweep = a2 - a1;
            while (sweep <= 1e-9) {
                sweep += Math.PI * 2;
            }
        } else {
            sweep = a2 - a1;
            while (sweep >= -1e-9) {
                sweep -= Math.PI * 2;
            }
        }
        if (length(sub(p1, p2)) < 1e-9) {
            sweep = sameSense ? Math.PI * 2 : -Math.PI * 2;
        }
        var n = P.arcSegments(Math.max(r1, r2), Math.abs(sweep));
        var pts = [];
        for (var i = 0; i <= n; i++) {
            var a = a1 + sweep * (i / n);
            pts.push(xfPoint(frame, [r1 * Math.cos(a), r2 * Math.sin(a), 0]));
        }
        pts[0] = p1;
        pts[pts.length - 1] = p2;
        return pts;
    };

    /* B-spline curves come in two shapes: a simple B_SPLINE_CURVE_WITH_KNOTS entity
     * (which carries the inherited attributes, starting with the name) and a complex
     * instance where every part only lists its own attributes. */
    Tessellator.prototype.splineData = function (curveRef) {
        var model = this.model;
        var entity = model.get(curveRef);
        var complex = entity && entity.type === "_COMPLEX";
        var basic = model.as(curveRef, "B_SPLINE_CURVE_WITH_KNOTS");
        var generic = model.as(curveRef, "B_SPLINE_CURVE") || basic;
        var rational = model.as(curveRef, "RATIONAL_B_SPLINE_CURVE");
        if (!generic) {
            return null;
        }
        var offset = complex ? 0 : 1;   // simple entities start with the name
        var data = {
            degree: generic.args[offset],
            control: generic.args[offset + 1] || [],
            multiplicities: [],
            knotValues: [],
            weights: null
        };
        if (basic) {
            var knotOffset = complex ? 0 : 6;
            data.multiplicities = basic.args[knotOffset] || [];
            data.knotValues = basic.args[knotOffset + 1] || [];
        }
        if (rational) {
            var w = rational.args[complex ? 0 : rational.args.length - 1];
            if (Array.isArray(w)) {
                data.weights = w;
            }
        }
        return data;
    };

    Tessellator.prototype.splinePoints = function (curveRef, p1, p2) {
        var model = this.model;
        var data = this.splineData(curveRef);
        if (!data) {
            return [p1, p2];
        }
        var degree = data.degree;
        var ctrl = data.control.map(function (ref) {
            return model.point(ref);
        }).filter(Boolean);
        if (ctrl.length < 2 || !(degree >= 1)) {
            return [p1, p2];
        }
        var knots = [];
        for (var i = 0; i < data.knotValues.length; i++) {
            var count = data.multiplicities[i] || 1;
            for (var k = 0; k < count; k++) {
                knots.push(data.knotValues[i]);
            }
        }
        if (knots.length !== ctrl.length + degree + 1) {
            knots = uniformKnots(ctrl.length, degree);
        }
        var weights = (data.weights && data.weights.length === ctrl.length)
            ? data.weights : null;
        var samples = Math.min(400, Math.max(16, ctrl.length * 8));
        var pts = evalBSpline(ctrl, weights, knots, degree, samples);
        if (p1) {
            pts[0] = p1;
        }
        if (p2) {
            pts[pts.length - 1] = p2;
        }
        return pts;
    };

    function uniformKnots(count, degree) {
        var knots = [];
        var inner = count - degree - 1;
        for (var i = 0; i <= degree; i++) {
            knots.push(0);
        }
        for (var j = 1; j <= inner; j++) {
            knots.push(j / (inner + 1));
        }
        for (var k = 0; k <= degree; k++) {
            knots.push(1);
        }
        return knots;
    }

    function evalBSpline(ctrl, weights, knots, degree, samples) {
        var n = ctrl.length - 1;
        var t0 = knots[degree];
        var t1 = knots[n + 1];
        var pts = [];
        if (!(t1 > t0)) {
            return ctrl.slice();
        }
        for (var s = 0; s <= samples; s++) {
            var t = t0 + (t1 - t0) * (s / samples);
            if (s === samples) {
                t = t1 - (t1 - t0) * 1e-9;
            }
            var span = degree;
            for (var i = degree; i <= n; i++) {
                if (t >= knots[i] && t < knots[i + 1]) {
                    span = i;
                    break;
                }
                span = i;
            }
            var d = [];
            for (var j = 0; j <= degree; j++) {
                var idx = span - degree + j;
                var w = weights ? weights[idx] : 1;
                var c = ctrl[idx];
                d.push([c[0] * w, c[1] * w, c[2] * w, w]);
            }
            for (var r = 1; r <= degree; r++) {
                for (var q = degree; q >= r; q--) {
                    var i2 = span - degree + q;
                    var den = knots[i2 + degree - r + 1] - knots[i2];
                    var alpha = den > 1e-12 ? (t - knots[i2]) / den : 0;
                    for (var cc = 0; cc < 4; cc++) {
                        d[q][cc] = (1 - alpha) * d[q - 1][cc] + alpha * d[q][cc];
                    }
                }
            }
            var res = d[degree];
            var wf = Math.abs(res[3]) > 1e-12 ? res[3] : 1;
            pts.push([res[0] / wf, res[1] / wf, res[2] / wf]);
        }
        return pts;
    }

    /* --- surfaces ---------------------------------------------------------- */

    var SURFACE_TYPES = {
        PLANE: 1, CYLINDRICAL_SURFACE: 1, CONICAL_SURFACE: 1, SPHERICAL_SURFACE: 1,
        TOROIDAL_SURFACE: 1, DEGENERATE_TOROIDAL_SURFACE: 1, B_SPLINE_SURFACE_WITH_KNOTS: 1,
        SURFACE_OF_LINEAR_EXTRUSION: 1, SURFACE_OF_REVOLUTION: 1, RATIONAL_B_SPLINE_SURFACE: 1
    };

    /* A surface object exposes:
     *   toUV(point)   -> [u, v]
     *   normalAt(u,v) -> unit normal (surface orientation)
     *   pointAt(u,v)  -> 3d point (used for the periodic stitching path)
     *   periodU       -> period of u (0 = not periodic)
     */
    Tessellator.prototype.surfaceFor = function (surfaceRef) {
        var model = this.model;
        var type = model.typeOf(surfaceRef);
        var ent;
        switch (type) {
        case "PLANE":
            ent = model.as(surfaceRef, "PLANE");
            return planeSurface(model.placement(ent.args[1]));
        case "CYLINDRICAL_SURFACE":
            ent = model.as(surfaceRef, "CYLINDRICAL_SURFACE");
            return cylinderSurface(model.placement(ent.args[1]), ent.args[2]);
        case "CONICAL_SURFACE":
            ent = model.as(surfaceRef, "CONICAL_SURFACE");
            return coneSurface(model.placement(ent.args[1]), ent.args[2], ent.args[3]);
        case "SPHERICAL_SURFACE":
            ent = model.as(surfaceRef, "SPHERICAL_SURFACE");
            return sphereSurface(model.placement(ent.args[1]), ent.args[2]);
        case "TOROIDAL_SURFACE":
            ent = model.as(surfaceRef, "TOROIDAL_SURFACE");
            return torusSurface(model.placement(ent.args[1]), ent.args[2], ent.args[3]);
        default:
            if (type) {
                this.unsupportedSurfaces[type] = (this.unsupportedSurfaces[type] || 0) + 1;
            }
            return null;
        }
    };

    function planeSurface(frame) {
        return {
            kind: "plane",
            periodU: 0,
            toUV: function (p) {
                var d = sub(p, frame.o);
                return [dot(d, frame.x), dot(d, frame.y)];
            },
            pointAt: function (u, v) {
                return add(frame.o, add(scale(frame.x, u), scale(frame.y, v)));
            },
            normalAt: function () {
                return frame.z;
            }
        };
    }

    function cylinderSurface(frame, radius) {
        return {
            kind: "cylinder",
            periodU: Math.PI * 2,
            uScale: Math.abs(radius) || 1,
            toUV: function (p) {
                var d = sub(p, frame.o);
                return [Math.atan2(dot(d, frame.y), dot(d, frame.x)), dot(d, frame.z)];
            },
            pointAt: function (u, v) {
                return add(frame.o, add(add(scale(frame.x, radius * Math.cos(u)),
                                            scale(frame.y, radius * Math.sin(u))),
                                        scale(frame.z, v)));
            },
            normalAt: function (u) {
                return normalize(add(scale(frame.x, Math.cos(u)), scale(frame.y, Math.sin(u))));
            }
        };
    }

    function coneSurface(frame, radius, halfAngle) {
        var tan = Math.tan(halfAngle || 0);
        return {
            kind: "cone",
            periodU: Math.PI * 2,
            uScale: Math.abs(radius) || 1,
            toUV: function (p) {
                var d = sub(p, frame.o);
                return [Math.atan2(dot(d, frame.y), dot(d, frame.x)), dot(d, frame.z)];
            },
            pointAt: function (u, v) {
                var r = radius + v * tan;
                return add(frame.o, add(add(scale(frame.x, r * Math.cos(u)),
                                            scale(frame.y, r * Math.sin(u))),
                                        scale(frame.z, v)));
            },
            normalAt: function (u) {
                var radial = add(scale(frame.x, Math.cos(u)), scale(frame.y, Math.sin(u)));
                return normalize(sub(radial, scale(frame.z, tan)));
            }
        };
    }

    function sphereSurface(frame, radius) {
        return {
            kind: "sphere",
            periodU: Math.PI * 2,
            uScale: Math.abs(radius) || 1,
            toUV: function (p) {
                var d = sub(p, frame.o);
                var x = dot(d, frame.x), y = dot(d, frame.y), z = dot(d, frame.z);
                var r = Math.sqrt(x * x + y * y);
                return [Math.atan2(y, x), Math.atan2(z, r)];
            },
            pointAt: function (u, v) {
                var cv = Math.cos(v);
                return add(frame.o, add(add(scale(frame.x, radius * cv * Math.cos(u)),
                                            scale(frame.y, radius * cv * Math.sin(u))),
                                        scale(frame.z, radius * Math.sin(v))));
            },
            normalAt: function (u, v) {
                var cv = Math.cos(v);
                return normalize(add(add(scale(frame.x, cv * Math.cos(u)),
                                         scale(frame.y, cv * Math.sin(u))),
                                     scale(frame.z, Math.sin(v))));
            }
        };
    }

    function torusSurface(frame, major, minor) {
        return {
            kind: "torus",
            periodU: Math.PI * 2,
            uScale: Math.abs(major) || 1,
            toUV: function (p) {
                var d = sub(p, frame.o);
                var x = dot(d, frame.x), y = dot(d, frame.y), z = dot(d, frame.z);
                var u = Math.atan2(y, x);
                var r = Math.sqrt(x * x + y * y) - major;
                return [u, Math.atan2(z, r)];
            },
            pointAt: function (u, v) {
                var r = major + minor * Math.cos(v);
                return add(frame.o, add(add(scale(frame.x, r * Math.cos(u)),
                                            scale(frame.y, r * Math.sin(u))),
                                        scale(frame.z, minor * Math.sin(v))));
            },
            normalAt: function (u, v) {
                var cv = Math.cos(v);
                return normalize(add(add(scale(frame.x, cv * Math.cos(u)),
                                         scale(frame.y, cv * Math.sin(u))),
                                     scale(frame.z, Math.sin(v))));
            }
        };
    }

    /* Least-squares plane through a set of points - fallback for surfaces we
     * cannot evaluate analytically (B-splines, extrusions, revolutions). */
    function fittedPlane(points) {
        var n = points.length;
        if (n < 3) {
            return null;
        }
        var centroid = [0, 0, 0];
        var i;
        for (i = 0; i < n; i++) {
            centroid = add(centroid, points[i]);
        }
        centroid = scale(centroid, 1 / n);
        // Newell's method gives a robust normal for near-planar loops.
        var normal = [0, 0, 0];
        for (i = 0; i < n; i++) {
            var a = points[i];
            var b = points[(i + 1) % n];
            normal[0] += (a[1] - b[1]) * (a[2] + b[2]);
            normal[1] += (a[2] - b[2]) * (a[0] + b[0]);
            normal[2] += (a[0] - b[0]) * (a[1] + b[1]);
        }
        normal = normalize(normal);
        if (length(normal) < 0.5) {
            return null;
        }
        var maxDev = 0;
        var extent = 0;
        for (i = 0; i < n; i++) {
            var d = sub(points[i], centroid);
            maxDev = Math.max(maxDev, Math.abs(dot(d, normal)));
            extent = Math.max(extent, length(d));
        }
        if (extent > 0 && maxDev > extent * 0.05) {
            return null;   // clearly not planar
        }
        var ref = Math.abs(normal[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
        var x = normalize(cross(ref, normal));
        var y = cross(normal, x);
        return planeSurface({o: centroid, x: x, y: y, z: normal});
    }

    /* --- topology walk ----------------------------------------------------- */

    Tessellator.prototype.loopPoints = function (loopRef) {
        var model = this.model;
        var loop = model.get(loopRef);
        var type = model.typeOf(loopRef);
        var pts = [];
        var self = this;
        if (type === "POLY_LOOP") {
            (loop.args[1] || []).forEach(function (ref) {
                var p = model.point(ref);
                if (p) {
                    pts.push(p);
                }
            });
            return pts;
        }
        if (type === "VERTEX_LOOP") {
            return [];
        }
        if (type !== "EDGE_LOOP") {
            return [];
        }
        var orientedEdges = loop.args[1] || [];
        orientedEdges.forEach(function (oeRef) {
            var oe = model.as(oeRef, "ORIENTED_EDGE");
            if (!oe) {
                return;
            }
            // ORIENTED_EDGE(name, edge_start*, edge_end*, edge_element, orientation)
            var forward = !(oe.args[4] && oe.args[4].enum === "F");
            var edge = model.as(oe.args[3], "EDGE_CURVE");
            if (!edge) {
                return;
            }
            var v1 = model.point(vertexPoint(model, edge.args[1]));
            var v2 = model.point(vertexPoint(model, edge.args[2]));
            if (!v1 || !v2) {
                return;
            }
            var sameSense = !(edge.args[4] && edge.args[4].enum === "F");
            var edgePts = self.curvePoints(edge.args[3], v1, v2, sameSense);
            self.recordEdge(edgePts, oe.args[3] && oe.args[3].ref);
            if (!forward) {
                edgePts = edgePts.slice().reverse();
            }
            for (var i = 0; i < edgePts.length; i++) {
                var p = edgePts[i];
                if (!pts.length || length(sub(pts[pts.length - 1], p)) > 1e-9) {
                    pts.push(p);
                }
            }
        });
        // drop a duplicated closing point
        while (pts.length > 1 && length(sub(pts[0], pts[pts.length - 1])) < 1e-9) {
            pts.pop();
        }
        return pts;
    };

    function vertexPoint(model, ref) {
        var vertex = model.as(ref, "VERTEX_POINT");
        return vertex ? vertex.args[1] : ref;
    }

    /* Each edge is visited once per adjacent face - keep only the first copy of
     * every edge within one placement of the shape. */
    Tessellator.prototype.setPlacement = function (xf) {
        this.currentXf = xf;
        this.placement = (this.placement || 0) + 1;
        this.seenEdges = new Set();
    };

    Tessellator.prototype.recordEdge = function (pts, edgeRef) {
        if (edgeRef !== undefined && this.seenEdges) {
            if (this.seenEdges.has(edgeRef)) {
                return;
            }
            this.seenEdges.add(edgeRef);
        }
        var xf = this.currentXf;
        for (var i = 0; i + 1 < pts.length; i++) {
            var a = xf ? xfPoint(xf, pts[i]) : pts[i];
            var b = xf ? xfPoint(xf, pts[i + 1]) : pts[i + 1];
            this.edgeLines.push(a[0], a[1], a[2], b[0], b[1], b[2]);
            P.growBBox(this.bbox, a[0], a[1], a[2]);
            P.growBBox(this.bbox, b[0], b[1], b[2]);
        }
    };

    Tessellator.prototype.emitTriangle = function (a, b, c, na, nb, nc) {
        var xf = this.currentXf;
        if (xf) {
            a = xfPoint(xf, a);
            b = xfPoint(xf, b);
            c = xfPoint(xf, c);
            na = xfDir(xf, na);
            nb = xfDir(xf, nb);
            nc = xfDir(xf, nc);
        }
        this.positions.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
        this.normals.push(na[0], na[1], na[2], nb[0], nb[1], nb[2], nc[0], nc[1], nc[2]);
    };

    Tessellator.prototype.addFace = function (faceRef) {
        var model = this.model;
        var face = model.as(faceRef, "ADVANCED_FACE") || model.as(faceRef, "FACE_SURFACE");
        if (!face) {
            return;
        }
        this.faceCount++;
        var boundRefs = face.args[1] || [];
        var surfaceRef = face.args[2];
        var sameSense = !(face.args[3] && face.args[3].enum === "F");

        var loops = [];
        var outerIndex = 0;
        for (var i = 0; i < boundRefs.length; i++) {
            var bound = model.as(boundRefs[i], "FACE_OUTER_BOUND")
                || model.as(boundRefs[i], "FACE_BOUND");
            if (!bound) {
                continue;
            }
            var orientation = !(bound.args[2] && bound.args[2].enum === "F");
            var pts = this.loopPoints(bound.args[1]);
            if (pts.length < 3) {
                continue;
            }
            if (!orientation) {
                pts.reverse();
            }
            var isOuter = model.as(boundRefs[i], "FACE_OUTER_BOUND") !== null;
            if (isOuter) {
                outerIndex = loops.length;
            }
            loops.push(pts);
        }
        if (!loops.length) {
            return;
        }
        if (this.positions.length / 9 > MAX_TRIANGLES) {
            return;
        }

        var surface = this.surfaceFor(surfaceRef);
        if (!surface) {
            surface = fittedPlane(loops[outerIndex]);
        }
        if (!surface) {
            this.failedFaces++;
            return;
        }
        try {
            if (this.meshFace(surface, loops, outerIndex, sameSense)) {
                this.meshedFaces++;
            } else {
                this.failedFaces++;
            }
        } catch (err) {
            this.failedFaces++;
        }
    };

    /* Map a loop into surface parameter space, keeping u continuous across the
     * period boundary of closed surfaces. */
    function loopToUV(surface, pts) {
        var uv = [];
        var period = surface.periodU;
        var prevU = null;
        for (var i = 0; i < pts.length; i++) {
            var c = surface.toUV(pts[i]);
            var u = c[0];
            if (period && prevU !== null) {
                while (u - prevU > period / 2) {
                    u -= period;
                }
                while (prevU - u > period / 2) {
                    u += period;
                }
            }
            prevU = u;
            uv.push([u, c[1]]);
        }
        return uv;
    }

    function polygonArea(uv) {
        var sum = 0;
        for (var i = 0, j = uv.length - 1; i < uv.length; j = i++) {
            sum += (uv[j][0] - uv[i][0]) * (uv[j][1] + uv[i][1]);
        }
        return sum / 2;
    }

    Tessellator.prototype.meshFace = function (surface, loops, outerIndex, sameSense) {
        var i, k;
        var uvLoops = loops.map(function (pts) {
            return loopToUV(surface, pts);
        });

        // A closed face (e.g. a full cylinder) whose bounds each wrap the whole
        // period cannot be triangulated as a flat polygon - build a strip instead.
        if (surface.periodU && uvLoops.length === 2
                && isFullPeriod(uvLoops[0], surface.periodU)
                && isFullPeriod(uvLoops[1], surface.periodU)) {
            return this.meshPeriodicStrip(surface, uvLoops, sameSense);
        }

        // Anisotropic surfaces: scale u so that ear clipping sees sane proportions.
        var uScale = surface.uScale || 1;
        var outer = uvLoops[outerIndex];
        var meanU = 0;
        for (i = 0; i < outer.length; i++) {
            meanU += outer[i][0];
        }
        meanU /= outer.length;

        var data = [];
        var points3d = [];
        var holeIndices = [];
        var order = [outerIndex];
        for (i = 0; i < uvLoops.length; i++) {
            if (i !== outerIndex) {
                order.push(i);
            }
        }
        for (var oi = 0; oi < order.length; oi++) {
            var li = order[oi];
            var uv = uvLoops[li];
            var pts = loops[li];
            if (oi > 0) {
                holeIndices.push(data.length / 2);
                // shift the hole into the same period window as the outer loop
                if (surface.periodU) {
                    var holeMean = 0;
                    for (k = 0; k < uv.length; k++) {
                        holeMean += uv[k][0];
                    }
                    holeMean /= uv.length;
                    var shift = Math.round((meanU - holeMean) / surface.periodU) * surface.periodU;
                    if (shift) {
                        uv = uv.map(function (c) {
                            return [c[0] + shift, c[1]];
                        });
                    }
                }
            }
            for (k = 0; k < uv.length; k++) {
                data.push(uv[k][0] * uScale, uv[k][1]);
                points3d.push({p: pts[k], uv: uv[k]});
            }
        }

        var indices = P.triangulate(data, holeIndices);
        if (!indices.length) {
            return false;
        }
        if (surface.kind !== "plane") {
            P.improveTriangulation(data, indices);
        }
        var flip = sameSense ? 1 : -1;
        // Ear clipping happily draws long diagonals across a face; on curved
        // surfaces those chords would cut through the solid, so the result is
        // refined until every triangle stays close to the real surface.
        var tolerance = surface.kind === "plane"
            ? Infinity : Math.max((surface.uScale || 1) * 0.004, 1e-9);
        for (i = 0; i + 2 < indices.length; i += 3) {
            var a = points3d[indices[i]];
            var b = points3d[indices[i + 1]];
            var c = points3d[indices[i + 2]];
            if (!a || !b || !c) {
                continue;
            }
            this.emitRefined(surface, a, b, c, flip, tolerance, 0);
        }
        return true;
    };

    var MAX_REFINE_DEPTH = 5;

    function surfaceMidpoint(surface, v1, v2) {
        var uv = [(v1.uv[0] + v2.uv[0]) / 2, (v1.uv[1] + v2.uv[1]) / 2];
        var onSurface = surface.pointAt(uv[0], uv[1]);
        var chord = scale(add(v1.p, v2.p), 0.5);
        return {uv: uv, p: onSurface, deviation: length(sub(onSurface, chord))};
    }

    Tessellator.prototype.emitRefined = function (surface, a, b, c, flip, tolerance, depth) {
        if (depth < MAX_REFINE_DEPTH && tolerance !== Infinity
                && this.positions.length / 9 < MAX_TRIANGLES) {
            // The split decision only looks at an edge's own end points, so
            // neighbouring triangles always agree and no cracks appear.
            var ab = surfaceMidpoint(surface, a, b);
            var bc = surfaceMidpoint(surface, b, c);
            var ca = surfaceMidpoint(surface, c, a);
            var splitAB = ab.deviation > tolerance;
            var splitBC = bc.deviation > tolerance;
            var splitCA = ca.deviation > tolerance;
            var count = (splitAB ? 1 : 0) + (splitBC ? 1 : 0) + (splitCA ? 1 : 0);
            var next = depth + 1;
            if (count === 3) {
                this.emitRefined(surface, a, ab, ca, flip, tolerance, next);
                this.emitRefined(surface, ab, b, bc, flip, tolerance, next);
                this.emitRefined(surface, ca, bc, c, flip, tolerance, next);
                this.emitRefined(surface, ab, bc, ca, flip, tolerance, next);
                return;
            }
            if (count === 2) {
                if (!splitCA) {
                    this.emitRefined(surface, a, ab, bc, flip, tolerance, next);
                    this.emitRefined(surface, ab, b, bc, flip, tolerance, next);
                    this.emitRefined(surface, a, bc, c, flip, tolerance, next);
                } else if (!splitAB) {
                    this.emitRefined(surface, a, b, bc, flip, tolerance, next);
                    this.emitRefined(surface, a, bc, ca, flip, tolerance, next);
                    this.emitRefined(surface, ca, bc, c, flip, tolerance, next);
                } else {
                    this.emitRefined(surface, a, ab, ca, flip, tolerance, next);
                    this.emitRefined(surface, ab, b, ca, flip, tolerance, next);
                    this.emitRefined(surface, b, c, ca, flip, tolerance, next);
                }
                return;
            }
            if (count === 1) {
                if (splitAB) {
                    this.emitRefined(surface, a, ab, c, flip, tolerance, next);
                    this.emitRefined(surface, ab, b, c, flip, tolerance, next);
                } else if (splitBC) {
                    this.emitRefined(surface, a, b, bc, flip, tolerance, next);
                    this.emitRefined(surface, a, bc, c, flip, tolerance, next);
                } else {
                    this.emitRefined(surface, a, b, ca, flip, tolerance, next);
                    this.emitRefined(surface, ca, b, c, flip, tolerance, next);
                }
                return;
            }
        }
        var na = scale(surface.normalAt(a.uv[0], a.uv[1]), flip);
        var nb = scale(surface.normalAt(b.uv[0], b.uv[1]), flip);
        var nc = scale(surface.normalAt(c.uv[0], c.uv[1]), flip);
        var geo = cross(sub(b.p, a.p), sub(c.p, a.p));
        if (length(geo) < 1e-18) {
            return;
        }
        if (dot(geo, na) < 0) {
            this.emitTriangle(a.p, c.p, b.p, na, nc, nb);
        } else {
            this.emitTriangle(a.p, b.p, c.p, na, nb, nc);
        }
    };

    function isFullPeriod(uv, period) {
        var min = Infinity, max = -Infinity;
        for (var i = 0; i < uv.length; i++) {
            min = Math.min(min, uv[i][0]);
            max = Math.max(max, uv[i][0]);
        }
        return (max - min) > period * 0.95;
    }

    Tessellator.prototype.meshPeriodicStrip = function (surface, uvLoops, sameSense) {
        var period = surface.periodU;
        var samples = 0;
        uvLoops.forEach(function (uv) {
            samples = Math.max(samples, uv.length);
        });
        samples = Math.max(samples, P.arcSegments(surface.uScale || 1, period));
        samples = Math.max(16, Math.min(samples, 512));
        var rings = uvLoops.map(function (uv) {
            return resamplePeriodic(uv, period, samples);
        });
        var flip = sameSense ? 1 : -1;
        for (var i = 0; i < samples; i++) {
            var j = (i + 1) % samples;
            var a = rings[0][i], b = rings[0][j];
            var c = rings[1][i], d = rings[1][j];
            var pa = surface.pointAt(a[0], a[1]);
            var pb = surface.pointAt(b[0], b[1]);
            var pc = surface.pointAt(c[0], c[1]);
            var pd = surface.pointAt(d[0], d[1]);
            var na = scale(surface.normalAt(a[0], a[1]), flip);
            var nb = scale(surface.normalAt(b[0], b[1]), flip);
            var nc = scale(surface.normalAt(c[0], c[1]), flip);
            var nd = scale(surface.normalAt(d[0], d[1]), flip);
            this.emitOriented(pa, pb, pc, na, nb, nc);
            this.emitOriented(pb, pd, pc, nb, nd, nc);
        }
        return true;
    };

    Tessellator.prototype.emitOriented = function (a, b, c, na, nb, nc) {
        var geo = cross(sub(b, a), sub(c, a));
        if (length(geo) < 1e-18) {
            return;
        }
        if (dot(geo, na) < 0) {
            this.emitTriangle(a, c, b, na, nc, nb);
        } else {
            this.emitTriangle(a, b, c, na, nb, nc);
        }
    };

    /* Resample a closed parameter ring at evenly spaced u values. */
    function resamplePeriodic(uv, period, samples) {
        var sorted = uv.slice().sort(function (a, b) {
            return a[0] - b[0];
        });
        var u0 = sorted[0][0];
        var out = [];
        for (var i = 0; i < samples; i++) {
            var u = u0 + period * (i / samples);
            out.push([u, interpolateV(sorted, u, period)]);
        }
        return out;
    }

    function interpolateV(sorted, u, period) {
        var n = sorted.length;
        var uu = sorted[0][0] + ((u - sorted[0][0]) % period + period) % period;
        for (var i = 0; i + 1 < n; i++) {
            if (uu >= sorted[i][0] && uu <= sorted[i + 1][0]) {
                var span = sorted[i + 1][0] - sorted[i][0];
                var t = span > 1e-12 ? (uu - sorted[i][0]) / span : 0;
                return sorted[i][1] + (sorted[i + 1][1] - sorted[i][1]) * t;
            }
        }
        return sorted[n - 1][1];
    }

    /* --- shape representation traversal ------------------------------------ */

    function collectFaces(model, itemRef, faces, seen) {
        var type = model.typeOf(itemRef);
        var ent = model.get(itemRef);
        if (!ent || !type) {
            return;
        }
        var ref = itemRef && itemRef.ref;
        if (ref !== undefined) {
            if (seen.has(ref)) {
                return;
            }
            seen.add(ref);
        }
        switch (type) {
        case "MANIFOLD_SOLID_BREP":
        case "BREP_WITH_VOIDS":
            collectFaces(model, ent.args[1], faces, seen);
            if (Array.isArray(ent.args[2])) {
                ent.args[2].forEach(function (voidRef) {
                    collectFaces(model, voidRef, faces, seen);
                });
            }
            break;
        case "SHELL_BASED_SURFACE_MODEL":
        case "FACE_BASED_SURFACE_MODEL":
            (ent.args[1] || []).forEach(function (shell) {
                collectFaces(model, shell, faces, seen);
            });
            break;
        case "CLOSED_SHELL":
        case "OPEN_SHELL":
        case "CONNECTED_FACE_SET":
            (ent.args[1] || []).forEach(function (face) {
                faces.push(face);
            });
            break;
        case "ORIENTED_CLOSED_SHELL":
            collectFaces(model, ent.args[2], faces, seen);
            break;
        case "ADVANCED_FACE":
        case "FACE_SURFACE":
            faces.push(itemRef);
            break;
        case "GEOMETRIC_CURVE_SET":
        case "GEOMETRIC_SET":
            break;
        default:
            break;
        }
    }

    function isShapeRep(type) {
        return type === "SHAPE_REPRESENTATION"
            || type === "ADVANCED_BREP_SHAPE_REPRESENTATION"
            || type === "MANIFOLD_SURFACE_SHAPE_REPRESENTATION"
            || type === "GEOMETRICALLY_BOUNDED_SURFACE_SHAPE_REPRESENTATION"
            || type === "FACETED_BREP_SHAPE_REPRESENTATION";
    }

    /* Build the placement of every shape representation by following
     * REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION links. */
    function buildRepTransforms(model) {
        var parents = new Map();       // child rep id -> [{parent, xf}]
        model.ids("REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION").forEach(function (id) {
            var ent = model.entities.get(id);
            var rel = model.as({ref: id}, "REPRESENTATION_RELATIONSHIP");
            var withXf = model.as({ref: id}, "REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION");
            if (!rel || !withXf || !ent) {
                return;
            }
            var rep1 = rel.args[2];
            var rep2 = rel.args[3];
            var op = model.as(withXf.args[0], "ITEM_DEFINED_TRANSFORMATION");
            if (!rep1 || !rep2 || !op) {
                return;
            }
            var a = model.placement(op.args[2]);
            var b = model.placement(op.args[3]);
            var child = rep1.ref;
            var parent = rep2.ref;
            var childRep = model.entities.get(child);
            var parentRep = model.entities.get(parent);
            // The relating representation is normally the child; swap when only the
            // other one actually carries geometry.
            if (childRep && parentRep && itemCount(childRep) === 0 && itemCount(parentRep) > 0) {
                var swap = child;
                child = parent;
                parent = swap;
                var swapXf = a;
                a = b;
                b = swapXf;
            }
            var list = parents.get(child) || [];
            list.push({parent: parent, xf: xfCompose(b, xfInvert(a))});
            parents.set(child, list);
        });

        // MAPPED_ITEM placements are unambiguous.
        var mapped = new Map();
        model.ids("MAPPED_ITEM").forEach(function (id) {
            var ent = model.entities.get(id);
            var source = model.as(ent.args[1], "REPRESENTATION_MAP");
            if (!source) {
                return;
            }
            var origin = model.placement(source.args[0]);
            var target = model.placement(ent.args[2]);
            mapped.set(id, {rep: source.args[1] && source.args[1].ref,
                            xf: xfCompose(target, xfInvert(origin))});
        });
        return {parents: parents, mapped: mapped};
    }

    function itemCount(rep) {
        return (rep && Array.isArray(rep.args[1])) ? rep.args[1].length : 0;
    }

    function worldTransform(repId, links, depth) {
        var list = links.parents.get(repId);
        if (!list || !list.length || depth > 12) {
            return identityXf();
        }
        var first = list[0];
        return xfCompose(worldTransform(first.parent, links, depth + 1), first.xf);
    }

    /* --- units -------------------------------------------------------------- */

    function findUnits(model) {
        var names = [];
        model.ids("SI_UNIT").forEach(function (id) {
            var ent = model.entities.get(id);
            var record = model.as({ref: id}, "SI_UNIT");
            var isLength = false;
            var complex = model.entities.get(id);
            if (complex && complex.type === "_COMPLEX") {
                complex.parts.forEach(function (part) {
                    if (part.type === "LENGTH_UNIT") {
                        isLength = true;
                    }
                });
            }
            if (!isLength || !record) {
                return;
            }
            var prefix = record.args[0] && record.args[0].enum;
            var unit = record.args[1] && record.args[1].enum;
            var prefixes = {MILLI: "mm", CENTI: "cm", DECI: "dm", KILO: "km", MICRO: "um"};
            if (unit === "METRE") {
                names.push(prefix ? (prefixes[prefix] || (prefix.toLowerCase() + "m")) : "m");
            }
        });
        model.ids("CONVERSION_BASED_UNIT").forEach(function (id) {
            var ent = model.entities.get(id);
            var record = model.as({ref: id}, "CONVERSION_BASED_UNIT");
            if (record && typeof record.args[0] === "string") {
                names.push(record.args[0].toLowerCase());
            }
        });
        return names.length ? names[0] : null;
    }

    /* --- entry point --------------------------------------------------------- */

    P.parseSTEP = function (buffer, progress) {
        var text = P.decodeText(buffer);
        if (!/ISO-10303-21/i.test(text.substring(0, 4096))) {
            throw new Error("missing ISO-10303-21 header - this does not look like a STEP file");
        }
        if (progress) {
            progress(0.1, "reading entities");
        }
        var parsed = parseFile(text);
        var model = new Model(parsed.entities);
        if (progress) {
            progress(0.35, "building geometry");
        }

        var tess = new Tessellator(model);
        var links = buildRepTransforms(model);
        var warnings = [];
        var seenFaces = new Set();
        var placedFaces = 0;

        var repIds = [];
        model.entities.forEach(function (ent, id) {
            if (isShapeRep(model.typeOf({ref: id}))) {
                repIds.push(id);
            }
        });

        repIds.forEach(function (repId) {
            var rep = model.entities.get(repId);
            var items = rep.args[1] || [];
            var xf = worldTransform(repId, links, 0);
            items.forEach(function (item) {
                var faces = [];
                var itemType = model.typeOf(item);
                if (itemType === "MAPPED_ITEM") {
                    var info = links.mapped.get(item.ref);
                    if (info && info.rep) {
                        var mappedRep = model.entities.get(info.rep);
                        if (mappedRep) {
                            var mappedItems = mappedRep.args[1] || [];
                            var childXf = xfCompose(xf, info.xf);
                            mappedItems.forEach(function (mi) {
                                var subFaces = [];
                                collectFaces(model, mi, subFaces, new Set());
                                tess.setPlacement(childXf);
                                subFaces.forEach(function (face) {
                                    seenFaces.add(face.ref);
                                    placedFaces++;
                                    tess.addFace(face);
                                });
                            });
                        }
                    }
                    return;
                }
                collectFaces(model, item, faces, new Set());
                tess.setPlacement(xf);
                faces.forEach(function (face) {
                    seenFaces.add(face.ref);
                    placedFaces++;
                    tess.addFace(face);
                });
            });
        });

        // Fallback: files without a usable representation graph still get drawn.
        if (!placedFaces) {
            tess.setPlacement(null);
            var loose = model.ids("ADVANCED_FACE").concat(model.ids("FACE_SURFACE"));
            loose.forEach(function (id) {
                if (!seenFaces.has(id)) {
                    tess.addFace({ref: id});
                }
            });
            if (loose.length) {
                warnings.push("no shape representation found - all faces were drawn untransformed");
            }
        }

        if (progress) {
            progress(0.85, "packing buffers");
        }

        if (!tess.positions.length && !tess.edgeLines.length) {
            throw new Error("no B-rep geometry found in this STEP file");
        }

        var unsupported = Object.keys(tess.unsupportedSurfaces);
        if (unsupported.length) {
            warnings.push("approximated as flat: " + unsupported.map(function (k) {
                return k.toLowerCase().replace(/_/g, " ") + " x" + tess.unsupportedSurfaces[k];
            }).join(", "));
        }
        if (tess.failedFaces) {
            warnings.push(tess.failedFaces + " face(s) could not be tessellated "
                + "(shown as wireframe only)");
        }
        if (tess.positions.length / 9 > MAX_TRIANGLES) {
            warnings.push("triangle limit reached - the model was truncated");
        }

        var schema = null;
        var name = null;
        parsed.headers.forEach(function (h) {
            if (h.type === "FILE_SCHEMA" && h.args[0] && h.args[0][0]) {
                schema = String(h.args[0][0]).split(" ")[0];
            }
            if (h.type === "FILE_NAME" && typeof h.args[0] === "string") {
                name = h.args[0];
            }
        });

        var unit = findUnits(model);
        var stats = [
            ["Faces", tess.faceCount],
            ["Triangles", Math.floor(tess.positions.length / 9)],
            ["Entities", parsed.entities.size]
        ];
        if (unit) {
            stats.push(["Units", unit]);
        }
        if (schema) {
            stats.push(["Schema", schema]);
        }
        if (name) {
            stats.push(["Internal name", name]);
        }

        var positions = new Float32Array(tess.positions);
        var normals = new Float32Array(tess.normals);
        P.bboxOf(positions, tess.bbox);

        return {
            format: "STEP",
            flavour: schema || "ISO-10303-21",
            kind: "3d",
            mesh: positions.length ? {positions: positions, normals: normals} : null,
            edges: tess.edgeLines.length ? [{
                name: "Edges",
                color: [0.09, 0.11, 0.16],
                visible: true,
                positions: new Float32Array(tess.edgeLines),
                segments: tess.edgeLines.length / 6
            }] : [],
            bbox: tess.bbox,
            stats: stats,
            warnings: warnings
        };
    };
})(typeof self !== "undefined" ? self : this);
