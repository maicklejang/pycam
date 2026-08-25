/* PyCAM Viewer - WebGL renderer, camera and touch controls.
 *
 * Deliberately dependency free: a small matrix helper, two shader programs
 * (shaded triangles, coloured lines) and a pointer-event based orbit camera.
 *
 * Copyright 2026 The PyCAM contributors
 * Licensed under the GNU General Public License v3 or later (see COPYING.TXT).
 */
(function (root) {
    "use strict";

    var P = root.PVX = root.PVX || {};

    /* --- 4x4 matrices (column major, like WebGL wants them) ---------------- */

    var M4 = {
        identity: function () {
            return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
        },
        multiply: function (out, a, b) {
            for (var c = 0; c < 4; c++) {
                for (var r = 0; r < 4; r++) {
                    out[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1]
                        + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
                }
            }
            return out;
        },
        perspective: function (out, fovy, aspect, near, far) {
            var f = 1 / Math.tan(fovy / 2);
            out.fill(0);
            out[0] = f / aspect;
            out[5] = f;
            out[10] = (far + near) / (near - far);
            out[11] = -1;
            out[14] = 2 * far * near / (near - far);
            return out;
        },
        ortho: function (out, left, right, bottom, top, near, far) {
            out.fill(0);
            out[0] = 2 / (right - left);
            out[5] = 2 / (top - bottom);
            out[10] = -2 / (far - near);
            out[12] = -(right + left) / (right - left);
            out[13] = -(top + bottom) / (top - bottom);
            out[14] = -(far + near) / (far - near);
            out[15] = 1;
            return out;
        },
        lookAt: function (out, eye, center, up) {
            var zx = eye[0] - center[0], zy = eye[1] - center[1], zz = eye[2] - center[2];
            var zl = Math.hypot(zx, zy, zz) || 1;
            zx /= zl; zy /= zl; zz /= zl;
            var xx = up[1] * zz - up[2] * zy;
            var xy = up[2] * zx - up[0] * zz;
            var xz = up[0] * zy - up[1] * zx;
            var xl = Math.hypot(xx, xy, xz) || 1;
            xx /= xl; xy /= xl; xz /= xl;
            var yx = zy * xz - zz * xy;
            var yy = zz * xx - zx * xz;
            var yz = zx * xy - zy * xx;
            out[0] = xx; out[1] = yx; out[2] = zx; out[3] = 0;
            out[4] = xy; out[5] = yy; out[6] = zy; out[7] = 0;
            out[8] = xz; out[9] = yz; out[10] = zz; out[11] = 0;
            out[12] = -(xx * eye[0] + xy * eye[1] + xz * eye[2]);
            out[13] = -(yx * eye[0] + yy * eye[1] + yz * eye[2]);
            out[14] = -(zx * eye[0] + zy * eye[1] + zz * eye[2]);
            out[15] = 1;
            return out;
        },
        normalMatrix: function (out, mv) {
            // The model-view matrix is a rigid transform here, so the upper 3x3 works as is.
            out[0] = mv[0]; out[1] = mv[1]; out[2] = mv[2];
            out[3] = mv[4]; out[4] = mv[5]; out[5] = mv[6];
            out[6] = mv[8]; out[7] = mv[9]; out[8] = mv[10];
            return out;
        },
        /* General inverse, needed to turn a tap back into a world space ray. */
        invert: function (out, m) {
            var a00 = m[0], a01 = m[1], a02 = m[2], a03 = m[3];
            var a10 = m[4], a11 = m[5], a12 = m[6], a13 = m[7];
            var a20 = m[8], a21 = m[9], a22 = m[10], a23 = m[11];
            var a30 = m[12], a31 = m[13], a32 = m[14], a33 = m[15];
            var b00 = a00 * a11 - a01 * a10;
            var b01 = a00 * a12 - a02 * a10;
            var b02 = a00 * a13 - a03 * a10;
            var b03 = a01 * a12 - a02 * a11;
            var b04 = a01 * a13 - a03 * a11;
            var b05 = a02 * a13 - a03 * a12;
            var b06 = a20 * a31 - a21 * a30;
            var b07 = a20 * a32 - a22 * a30;
            var b08 = a20 * a33 - a23 * a30;
            var b09 = a21 * a32 - a22 * a31;
            var b10 = a21 * a33 - a23 * a31;
            var b11 = a22 * a33 - a23 * a32;
            var det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
            if (!det) {
                return null;
            }
            det = 1 / det;
            out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det;
            out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
            out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det;
            out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
            out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det;
            out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
            out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det;
            out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
            out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det;
            out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
            out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det;
            out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
            out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det;
            out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
            out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det;
            out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
            return out;
        }
    };

    /* --- picking maths (kept free of WebGL so the tests can reach it) ------- */

    /* Moeller-Trumbore. Returns the ray parameter of the hit, or -1. */
    function rayTriangle(origin, direction, ax, ay, az, bx, by, bz, cx, cy, cz) {
        var e1x = bx - ax, e1y = by - ay, e1z = bz - az;
        var e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
        var px = direction[1] * e2z - direction[2] * e2y;
        var py = direction[2] * e2x - direction[0] * e2z;
        var pz = direction[0] * e2y - direction[1] * e2x;
        var det = e1x * px + e1y * py + e1z * pz;
        if (det > -1e-12 && det < 1e-12) {
            return -1;                     // ray is parallel to the triangle
        }
        var inv = 1 / det;
        var tx = origin[0] - ax, ty = origin[1] - ay, tz = origin[2] - az;
        var u = (tx * px + ty * py + tz * pz) * inv;
        if (u < -1e-6 || u > 1 + 1e-6) {
            return -1;
        }
        var qx = ty * e1z - tz * e1y;
        var qy = tz * e1x - tx * e1z;
        var qz = tx * e1y - ty * e1x;
        var v = (direction[0] * qx + direction[1] * qy + direction[2] * qz) * inv;
        if (v < -1e-6 || u + v > 1 + 1e-6) {
            return -1;
        }
        var t = (e2x * qx + e2y * qy + e2z * qz) * inv;
        return t > 1e-6 ? t : -1;
    }

    /* Distance from a point to a segment in 2D, plus the segment parameter. */
    function closestOnSegment2D(px, py, ax, ay, bx, by) {
        var dx = bx - ax, dy = by - ay;
        var lengthSq = dx * dx + dy * dy;
        var u = lengthSq > 1e-12 ? ((px - ax) * dx + (py - ay) * dy) / lengthSq : 0;
        u = Math.max(0, Math.min(1, u));
        var qx = ax + dx * u, qy = ay + dy * u;
        return {u: u, distance: Math.hypot(px - qx, py - qy)};
    }

    /* A point that divides a segment at `u` on screen sits at a different
     * fraction in space; undo the projective distortion. */
    function perspectiveParameter(u, wa, wb) {
        var denominator = (1 - u) / wa + u / wb;
        if (!isFinite(denominator) || Math.abs(denominator) < 1e-12) {
            return u;
        }
        return (u / wb) / denominator;
    }

    P.pickMath = {
        rayTriangle: rayTriangle,
        closestOnSegment2D: closestOnSegment2D,
        perspectiveParameter: perspectiveParameter,
        invertMatrix: M4.invert
    };

    /* --- shaders ----------------------------------------------------------- */

    var MESH_VS = [
        "attribute vec3 aPosition;",
        "attribute vec3 aNormal;",
        "uniform mat4 uMVP;",
        "uniform mat4 uModelView;",
        "uniform mat3 uNormalMatrix;",
        "varying vec3 vNormal;",
        "varying vec3 vWorldNormal;",
        "varying vec3 vViewPos;",
        "varying vec3 vWorldPos;",
        "void main() {",
        "  vNormal = uNormalMatrix * aNormal;",
        "  vWorldNormal = aNormal;",
        "  vWorldPos = aPosition;",
        "  vViewPos = (uModelView * vec4(aPosition, 1.0)).xyz;",
        "  gl_Position = uMVP * vec4(aPosition, 1.0);",
        "}"
    ].join("\n");

    var MESH_FS = [
        "precision mediump float;",
        "varying vec3 vNormal;",
        "varying vec3 vWorldNormal;",
        "varying vec3 vViewPos;",
        "uniform vec3 uColor;",
        "uniform vec3 uBackColor;",
        "uniform vec4 uClipPlane;",
        "uniform float uClipEnabled;",
        "varying vec3 vWorldPos;",
        "void main() {",
        "  if (uClipEnabled > 0.5 && dot(vWorldPos, uClipPlane.xyz) > uClipPlane.w) {",
        "    discard;",
        "  }",
        "  vec3 n = normalize(vNormal);",
        "  vec3 wn = normalize(vWorldNormal);",
        "  if (!gl_FrontFacing) { n = -n; wn = -wn; }",
        "  vec3 base = gl_FrontFacing ? uColor : uBackColor;",
        "  vec3 view = normalize(-vViewPos);",
        "  vec3 key = normalize(vec3(0.4, 0.35, 0.85));",
        "  float diffuse = max(dot(n, key), 0.0);",
        "  float fill = max(dot(n, normalize(vec3(-0.6, -0.3, 0.2))), 0.0) * 0.35;",
        "  float sky = 0.5 + 0.5 * wn.z;",           // Z-up hemisphere light
        "  float rim = pow(1.0 - max(dot(n, view), 0.0), 3.0) * 0.18;",
        "  vec3 color = base * (0.22 + 0.30 * sky + 0.55 * diffuse + fill);",
        "  vec3 halfway = normalize(key + view);",
        "  color += vec3(1.0) * pow(max(dot(n, halfway), 0.0), 42.0) * 0.22;",
        "  color += vec3(0.45, 0.62, 0.95) * rim;",
        "  gl_FragColor = vec4(color, 1.0);",
        "}"
    ].join("\n");

    var LINE_VS = [
        "attribute vec3 aPosition;",
        "uniform mat4 uMVP;",
        "uniform vec2 uOffset;",
        "uniform float uDepthNudge;",
        "varying vec3 vWorldPos;",
        "void main() {",
        "  vWorldPos = aPosition;",
        "  vec4 pos = uMVP * vec4(aPosition, 1.0);",
        "  pos.xy += uOffset * pos.w;",
        "  pos.z -= uDepthNudge * pos.w;",
        "  gl_Position = pos;",
        "}"
    ].join("\n");

    var LINE_FS = [
        "precision mediump float;",
        "uniform vec3 uColor;",
        "uniform float uAlpha;",
        "uniform vec4 uClipPlane;",
        "uniform float uClipEnabled;",
        "varying vec3 vWorldPos;",
        "void main() {",
        "  if (uClipEnabled > 0.5 && dot(vWorldPos, uClipPlane.xyz) > uClipPlane.w) {",
        "    discard;",
        "  }",
        "  gl_FragColor = vec4(uColor, uAlpha);",
        "}"
    ].join("\n");

    /* Full screen gradient, the way a CAD viewport usually looks. */
    var BACKGROUND_VS = [
        "attribute vec2 aPosition;",
        "varying float vHeight;",
        "void main() {",
        "  vHeight = aPosition.y * 0.5 + 0.5;",
        "  gl_Position = vec4(aPosition, 0.0, 1.0);",
        "}"
    ].join("\n");

    var BACKGROUND_FS = [
        "precision mediump float;",
        "varying float vHeight;",
        "uniform vec3 uTop;",
        "uniform vec3 uBottom;",
        "void main() { gl_FragColor = vec4(mix(uBottom, uTop, vHeight), 1.0); }"
    ].join("\n");

    /* Palettes.  The light one is the default: a dark viewport hides the very
     * shading it is supposed to show, especially on a phone in daylight.
     *
     * `backface` is only slightly darker than `material` on purpose.  Real STEP
     * assemblies routinely contain parts whose faces are wound the other way; a
     * contrasting back face colour turned those parts into a different-coloured
     * blob rather than telling anyone anything useful. */
    var THEMES = {
        light: {
            backgroundTop: [0.95, 0.96, 0.97],
            backgroundBottom: [0.72, 0.75, 0.79],
            material: [0.60, 0.65, 0.72],
            backface: [0.50, 0.54, 0.60],
            cut: [0.44, 0.49, 0.57],
            grid: [0.58, 0.61, 0.66],
            outline: [0.10, 0.12, 0.16],
            wireframe: [0.15, 0.35, 0.60],
            bbox: [0.85, 0.45, 0.10],
            measure: [0.85, 0.42, 0.05],
            axes: [[0.80, 0.20, 0.20], [0.20, 0.55, 0.20], [0.20, 0.35, 0.75]]
        },
        dark: {
            backgroundTop: [0.086, 0.098, 0.13],
            backgroundBottom: [0.043, 0.051, 0.07],
            material: [0.62, 0.68, 0.78],
            backface: [0.50, 0.55, 0.64],
            cut: [0.50, 0.56, 0.66],
            grid: [0.16, 0.19, 0.25],
            outline: [0.05, 0.07, 0.11],
            wireframe: [0.45, 0.72, 0.95],
            bbox: [0.95, 0.62, 0.25],
            measure: [1.0, 0.78, 0.25],
            axes: [[0.90, 0.35, 0.35], [0.42, 0.82, 0.45], [0.40, 0.60, 0.95]]
        }
    };

    function compile(gl, type, source) {
        var shader = gl.createShader(type);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
            throw new Error("shader error: " + gl.getShaderInfoLog(shader));
        }
        return shader;
    }

    function program(gl, vs, fs, attributes) {
        var prog = gl.createProgram();
        gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, vs));
        gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, fs));
        attributes.forEach(function (name, index) {
            gl.bindAttribLocation(prog, index, name);
        });
        gl.linkProgram(prog);
        if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
            throw new Error("link error: " + gl.getProgramInfoLog(prog));
        }
        var uniforms = {};
        var count = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
        for (var i = 0; i < count; i++) {
            var info = gl.getActiveUniform(prog, i);
            uniforms[info.name] = gl.getUniformLocation(prog, info.name);
        }
        return {handle: prog, uniforms: uniforms};
    }

    /* --- viewer ------------------------------------------------------------ */

    function Viewer(canvas) {
        this.canvas = canvas;
        var options = {alpha: false, antialias: true, depth: true, stencil: true,
                       preserveDrawingBuffer: true, powerPreference: "high-performance"};
        var gl = canvas.getContext("webgl", options) || canvas.getContext("experimental-webgl", options);
        if (!gl) {
            throw new Error("WebGL is not available in this browser");
        }
        this.gl = gl;
        this.meshProgram = program(gl, MESH_VS, MESH_FS, ["aPosition", "aNormal"]);
        this.lineProgram = program(gl, LINE_VS, LINE_FS, ["aPosition"]);
        this.backgroundProgram = program(gl, BACKGROUND_VS, BACKGROUND_FS, ["aPosition"]);
        this.backgroundQuad = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, this.backgroundQuad);
        gl.bufferData(gl.ARRAY_BUFFER,
                      new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);

        this.model = null;
        this.buffers = {mesh: null, edges: [], grid: null, axes: null, bbox: null,
                        wireframe: null};
        this.theme = THEMES.light;

        this.options = {
            projection: "perspective",
            shading: "shaded",       // shaded | shaded-edges | wireframe
            showGrid: true,
            showAxes: true,
            showBBox: false,
            lockRotation: false,
            theme: "light"
        };

        /* Section plane: `position` is 0..1 across the model's extent on `axis`. */
        this.section = {active: false, axis: 2, position: 0.5, flip: false};

        this.camera = {target: [0, 0, 0], distance: 10, yaw: -Math.PI / 4,
                       pitch: 0.55, fov: Math.PI / 4};
        this.modelRadius = 1;
        this.insetBottom = 0;   // screen pixels hidden by UI at the bottom
        this.dirty = true;
        this.pointers = new Map();
        this.pinch = null;
        this.lastTap = 0;
        this.mvp = M4.identity();
        this.view = M4.identity();
        this.proj = M4.identity();
        this.normalMatrix = new Float32Array(9);
        this.inverseMVP = M4.identity();
        this.measure = {active: false, points: [], onChange: null};

        this.setupInput();
        this.resize();
        var self = this;
        this.frame = function () {
            self.renderIfNeeded();
            root.requestAnimationFrame(self.frame);
        };
        root.requestAnimationFrame(this.frame);
        root.addEventListener("resize", function () {
            self.resize();
        });
    }

    Viewer.prototype.invalidate = function () {
        this.dirty = true;
    };

    Viewer.prototype.resize = function () {
        var ratio = Math.min(root.devicePixelRatio || 1, 2.5);
        var width = Math.max(1, Math.round(this.canvas.clientWidth * ratio));
        var height = Math.max(1, Math.round(this.canvas.clientHeight * ratio));
        if (this.canvas.width !== width || this.canvas.height !== height) {
            this.canvas.width = width;
            this.canvas.height = height;
            this.invalidate();
        }
    };

    Viewer.prototype.setTheme = function (name) {
        this.theme = THEMES[name] || THEMES.light;
        this.options.theme = THEMES[name] ? name : "light";
        this.invalidate();
    };

    /* A line colour meant for the opposite background would vanish; pull it back. */
    Viewer.prototype.themedLineColor = function (color) {
        var luminance = color[0] * 0.299 + color[1] * 0.587 + color[2] * 0.114;
        if (this.options.theme === "light" && luminance > 0.72) {
            return [color[0] * 0.22, color[1] * 0.22, color[2] * 0.26];
        }
        if (this.options.theme === "dark" && luminance < 0.18) {
            return [0.35 + color[0] * 0.4, 0.38 + color[1] * 0.4, 0.45 + color[2] * 0.4];
        }
        return color;
    };

    Viewer.prototype.setSection = function (changes) {
        var section = this.section;
        if (changes.active !== undefined) {
            section.active = !!changes.active;
        }
        if (changes.axis !== undefined) {
            section.axis = changes.axis;
        }
        if (changes.position !== undefined) {
            section.position = Math.max(0, Math.min(1, changes.position));
        }
        if (changes.flip !== undefined) {
            section.flip = !!changes.flip;
        }
        this.buildSectionCap();
        this.invalidate();
        return this.sectionState();
    };

    Viewer.prototype.sectionState = function () {
        var bbox = this.model && this.model.bbox;
        var state = {active: this.section.active, axis: this.section.axis,
                     position: this.section.position, flip: this.section.flip,
                     value: null};
        if (P.isFiniteBBox(bbox)) {
            var axis = this.section.axis;
            state.value = bbox.min[axis]
                + (bbox.max[axis] - bbox.min[axis]) * this.section.position;
        }
        return state;
    };

    /* Plane as {normal, offset}: everything with dot(p, normal) > offset is cut. */
    Viewer.prototype.sectionPlane = function () {
        var state = this.sectionState();
        if (state.value === null) {
            return null;
        }
        var normal = [0, 0, 0];
        normal[this.section.axis] = this.section.flip ? -1 : 1;
        return {normal: normal, offset: this.section.flip ? -state.value : state.value};
    };

    /* The cut surface: a quad on the plane, big enough to cover the model, drawn
     * only where the stencil pass says we are inside the solid. */
    Viewer.prototype.buildSectionCap = function () {
        if (this.buffers.cap) {
            this.gl.deleteBuffer(this.buffers.cap.position);
            this.gl.deleteBuffer(this.buffers.cap.normal);
            this.buffers.cap = null;
        }
        var plane = this.sectionPlane();
        if (!plane || !this.section.active || !this.buffers.mesh) {
            return;
        }
        var bbox = this.model.bbox;
        var axis = this.section.axis;
        var u = (axis + 1) % 3;
        var v = (axis + 2) % 3;
        var pad = this.modelRadius * 0.05;
        var value = this.sectionState().value;
        var corners = [[bbox.min[u] - pad, bbox.min[v] - pad],
                       [bbox.max[u] + pad, bbox.min[v] - pad],
                       [bbox.max[u] + pad, bbox.max[v] + pad],
                       [bbox.min[u] - pad, bbox.max[v] + pad]];
        var order = [0, 1, 2, 0, 2, 3];
        var positions = [];
        var normals = [];
        for (var i = 0; i < order.length; i++) {
            var point = [0, 0, 0];
            point[axis] = value;
            point[u] = corners[order[i]][0];
            point[v] = corners[order[i]][1];
            positions.push(point[0], point[1], point[2]);
            normals.push(plane.normal[0], plane.normal[1], plane.normal[2]);
        }
        this.buffers.cap = {position: this.makeBuffer(new Float32Array(positions)),
                            normal: this.makeBuffer(new Float32Array(normals)),
                            count: positions.length / 3};
    };

    Viewer.prototype.setOption = function (key, value) {
        this.options[key] = value;
        if (key === "theme") {
            this.setTheme(value);
        }
        if (key === "showBBox" && value && this.model) {
            this.buildBBox();
        }
        if (key === "shading" && value === "wireframe" && !this.buffers.wireframe) {
            this.buildWireframe();
        }
        this.invalidate();
    };

    /* --- buffer management ------------------------------------------------- */

    Viewer.prototype.makeBuffer = function (data) {
        var gl = this.gl;
        var buffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
        return buffer;
    };

    Viewer.prototype.dispose = function () {
        var gl = this.gl;
        var self = this;
        function drop(entry) {
            if (entry && entry.position) {
                gl.deleteBuffer(entry.position);
            }
            if (entry && entry.normal) {
                gl.deleteBuffer(entry.normal);
            }
        }
        drop(this.buffers.mesh);
        drop(this.buffers.grid);
        drop(this.buffers.axes);
        drop(this.buffers.bbox);
        drop(this.buffers.wireframe);
        drop(this.buffers.measure);
        drop(this.buffers.cap);
        this.buffers.edges.forEach(drop);
        this.buffers = {mesh: null, edges: [], grid: null, axes: null, bbox: null,
                        wireframe: null, measure: null, cap: null};
        this.rawMesh = null;
        this.measure.points = [];
    };

    Viewer.prototype.setModel = function (result) {
        this.dispose();
        this.model = result;
        this.rawMesh = result.mesh || null;
        if (result.mesh && result.mesh.positions.length) {
            this.buffers.mesh = {
                position: this.makeBuffer(result.mesh.positions),
                normal: this.makeBuffer(result.mesh.normals),
                count: result.mesh.positions.length / 3
            };
        }
        var self = this;
        (result.edges || []).forEach(function (layer, index) {
            self.buffers.edges.push({
                position: self.makeBuffer(layer.positions),
                count: layer.positions.length / 3,
                color: layer.color || [0.9, 0.9, 0.9],
                visible: layer.visible !== false,
                index: index
            });
        });
        this.options.shading = (this.buffers.mesh && this.buffers.edges.length)
            ? "shaded-edges" : "shaded";
        this.options.lockRotation = result.kind === "2d";
        this.options.projection = result.kind === "2d" ? "orthographic" : "perspective";
        this.section.active = false;
        this.section.position = 0.5;
        this.buildGrid();
        if (this.options.showBBox) {
            this.buildBBox();
        }
        this.fit(result.kind === "2d" ? "top" : "iso");
    };

    Viewer.prototype.setLayerVisible = function (index, visible) {
        if (this.buffers.edges[index]) {
            this.buffers.edges[index].visible = visible;
            this.invalidate();
        }
    };

    /* Triangle edges for the wireframe mode - built on demand, capped so that
     * huge meshes cannot exhaust memory on a phone. */
    Viewer.prototype.buildWireframe = function () {
        if (!this.rawMesh) {
            return;
        }
        var positions = this.rawMesh.positions;
        var triangles = positions.length / 9;
        if (triangles > 400000) {
            return;
        }
        var out = new Float32Array(triangles * 18);
        var w = 0;
        for (var t = 0; t < triangles; t++) {
            var o = t * 9;
            for (var e = 0; e < 3; e++) {
                var a = o + e * 3;
                var b = o + ((e + 1) % 3) * 3;
                out[w++] = positions[a]; out[w++] = positions[a + 1]; out[w++] = positions[a + 2];
                out[w++] = positions[b]; out[w++] = positions[b + 1]; out[w++] = positions[b + 2];
            }
        }
        this.buffers.wireframe = {position: this.makeBuffer(out), count: out.length / 3};
    };

    function niceStep(value) {
        var exponent = Math.floor(Math.log(value) / Math.LN10);
        var base = Math.pow(10, exponent);
        var fraction = value / base;
        var step = fraction < 2 ? 1 : (fraction < 5 ? 2 : 5);
        return step * base;
    }

    Viewer.prototype.buildGrid = function () {
        if (!this.model || !P.isFiniteBBox(this.model.bbox)) {
            return;
        }
        var bbox = this.model.bbox;
        var size = Math.max(bbox.max[0] - bbox.min[0], bbox.max[1] - bbox.min[1],
                            bbox.max[2] - bbox.min[2], 1e-6);
        var step = niceStep(size / 8);
        var half = Math.ceil(size * 1.2 / step) * step;
        var z = bbox.min[2];
        var data = [];
        for (var i = -half; i <= half + step * 0.5; i += step) {
            data.push(-half, i, z, half, i, z);
            data.push(i, -half, z, i, half, z);
        }
        this.gridStep = step;
        this.buffers.grid = {position: this.makeBuffer(new Float32Array(data)),
                             count: data.length / 3};

        var axisLength = half * 0.4;
        var axes = [
            0, 0, z, axisLength, 0, z,
            0, 0, z, 0, axisLength, z,
            0, 0, z, 0, 0, axisLength * 0.7
        ];
        this.buffers.axes = {position: this.makeBuffer(new Float32Array(axes)), count: 6};
    };

    Viewer.prototype.buildBBox = function () {
        if (!this.model || !P.isFiniteBBox(this.model.bbox)) {
            return;
        }
        var b = this.model.bbox;
        var corners = [
            [b.min[0], b.min[1], b.min[2]], [b.max[0], b.min[1], b.min[2]],
            [b.max[0], b.max[1], b.min[2]], [b.min[0], b.max[1], b.min[2]],
            [b.min[0], b.min[1], b.max[2]], [b.max[0], b.min[1], b.max[2]],
            [b.max[0], b.max[1], b.max[2]], [b.min[0], b.max[1], b.max[2]]
        ];
        var pairs = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4],
                     [0, 4], [1, 5], [2, 6], [3, 7]];
        var data = [];
        pairs.forEach(function (pair) {
            data.push.apply(data, corners[pair[0]]);
            data.push.apply(data, corners[pair[1]]);
        });
        if (this.buffers.bbox) {
            this.gl.deleteBuffer(this.buffers.bbox.position);
        }
        this.buffers.bbox = {position: this.makeBuffer(new Float32Array(data)),
                             count: data.length / 3};
    };

    /* --- camera ------------------------------------------------------------ */

    var VIEWS = {
        iso: [-Math.PI / 4, 0.6],
        top: [-Math.PI / 2, Math.PI / 2 - 0.0001],
        bottom: [-Math.PI / 2, -Math.PI / 2 + 0.0001],
        front: [-Math.PI / 2, 0],
        back: [Math.PI / 2, 0],
        left: [Math.PI, 0],
        right: [0, 0]
    };

    Viewer.prototype.setView = function (name) {
        var view = VIEWS[name] || VIEWS.iso;
        this.camera.yaw = view[0];
        this.camera.pitch = view[1];
        this.invalidate();
    };

    Viewer.prototype.fit = function (viewName) {
        if (viewName) {
            this.setView(viewName);
        }
        var bbox = this.model && this.model.bbox;
        if (!P.isFiniteBBox(bbox)) {
            return;
        }
        var size = [bbox.max[0] - bbox.min[0], bbox.max[1] - bbox.min[1],
                    bbox.max[2] - bbox.min[2]];
        this.camera.target = [(bbox.min[0] + bbox.max[0]) / 2,
                              (bbox.min[1] + bbox.max[1]) / 2,
                              (bbox.min[2] + bbox.max[2]) / 2];
        var radius = Math.max(Math.hypot(size[0], size[1], size[2]) / 2, 1e-6);
        this.modelRadius = radius;
        var aspect = this.canvas.width / Math.max(this.canvas.height, 1);
        var fit = radius / Math.sin(Math.min(this.camera.fov * Math.min(aspect, 1), Math.PI / 2) / 2);
        this.camera.distance = fit * 1.12;
        if (this.insetBottom) {
            this.pan(0, -this.insetBottom / 2);
        }
        this.invalidate();
    };

    Viewer.prototype.eye = function () {
        var c = this.camera;
        var cp = Math.cos(c.pitch);
        return [
            c.target[0] + c.distance * cp * Math.cos(c.yaw),
            c.target[1] + c.distance * cp * Math.sin(c.yaw),
            c.target[2] + c.distance * Math.sin(c.pitch)
        ];
    };

    Viewer.prototype.basis = function () {
        var c = this.camera;
        var forward = [Math.cos(c.pitch) * Math.cos(c.yaw),
                       Math.cos(c.pitch) * Math.sin(c.yaw),
                       Math.sin(c.pitch)];
        var right = [-Math.sin(c.yaw), Math.cos(c.yaw), 0];
        var up = [-Math.sin(c.pitch) * Math.cos(c.yaw),
                  -Math.sin(c.pitch) * Math.sin(c.yaw),
                  Math.cos(c.pitch)];
        return {forward: forward, right: right, up: up};
    };

    /* --- input -------------------------------------------------------------- */

    Viewer.prototype.setupInput = function () {
        var canvas = this.canvas;
        var self = this;

        canvas.style.touchAction = "none";

        canvas.addEventListener("pointerdown", function (event) {
            canvas.setPointerCapture(event.pointerId);
            self.pointers.set(event.pointerId, {x: event.clientX, y: event.clientY,
                                                button: event.button});
            if (self.pointers.size === 2) {
                self.pinch = self.pinchState();
            }
            self.tapCandidate = self.pointers.size === 1
                ? {x: event.clientX, y: event.clientY, time: Date.now(),
                   id: event.pointerId}
                : null;
            var now = Date.now();
            if (event.pointerType !== "mouse" && now - self.lastTap < 300
                    && self.pointers.size === 1 && !self.measure.active) {
                self.fit();
            }
            self.lastTap = now;
        });

        canvas.addEventListener("pointermove", function (event) {
            var pointer = self.pointers.get(event.pointerId);
            if (!pointer) {
                return;
            }
            var dx = event.clientX - pointer.x;
            var dy = event.clientY - pointer.y;
            pointer.x = event.clientX;
            pointer.y = event.clientY;
            if (self.tapCandidate && (Math.abs(event.clientX - self.tapCandidate.x) > 8
                    || Math.abs(event.clientY - self.tapCandidate.y) > 8)) {
                self.tapCandidate = null;      // turned into a drag
            }
            if (self.pointers.size === 1) {
                var panning = pointer.button === 1 || pointer.button === 2
                    || event.shiftKey || self.options.lockRotation;
                if (panning) {
                    self.pan(dx, dy);
                } else {
                    self.orbit(dx, dy);
                }
            } else if (self.pointers.size === 2 && self.pinch) {
                var next = self.pinchState();
                var scale = self.pinch.distance > 1 ? next.distance / self.pinch.distance : 1;
                self.zoom(1 / Math.max(scale, 1e-3));
                self.pan(next.cx - self.pinch.cx, next.cy - self.pinch.cy);
                self.pinch = next;
            }
            event.preventDefault();
        });

        function release(event) {
            var tap = self.tapCandidate;
            self.pointers.delete(event.pointerId);
            if (self.pointers.size < 2) {
                self.pinch = null;
            }
            self.tapCandidate = null;
            if (tap && tap.id === event.pointerId && self.measure.active
                    && event.type === "pointerup" && Date.now() - tap.time < 700) {
                self.addMeasurePoint(event.clientX, event.clientY);
            }
        }
        canvas.addEventListener("pointerup", release);
        canvas.addEventListener("pointercancel", release);
        canvas.addEventListener("pointerleave", release);
        canvas.addEventListener("contextmenu", function (event) {
            event.preventDefault();
        });
        canvas.addEventListener("wheel", function (event) {
            self.zoom(Math.exp(event.deltaY * 0.0015));
            event.preventDefault();
        }, {passive: false});
        canvas.addEventListener("dblclick", function () {
            if (!self.measure.active) {
                self.fit();
            }
        });
    };

    Viewer.prototype.pinchState = function () {
        var list = Array.from(this.pointers.values());
        var a = list[0], b = list[1];
        return {
            distance: Math.hypot(a.x - b.x, a.y - b.y),
            cx: (a.x + b.x) / 2,
            cy: (a.y + b.y) / 2
        };
    };

    Viewer.prototype.orbit = function (dx, dy) {
        if (this.options.lockRotation) {
            return this.pan(dx, dy);
        }
        var speed = 0.0075;
        this.camera.yaw -= dx * speed;
        this.camera.pitch += dy * speed;
        var limit = Math.PI / 2 - 0.001;
        this.camera.pitch = Math.max(-limit, Math.min(limit, this.camera.pitch));
        this.invalidate();
    };

    Viewer.prototype.pan = function (dx, dy) {
        var basis = this.basis();
        var height = this.canvas.clientHeight || 1;
        var worldPerPixel = 2 * this.camera.distance
            * Math.tan(this.camera.fov / 2) / height;
        var sx = -dx * worldPerPixel;
        var sy = dy * worldPerPixel;
        for (var i = 0; i < 3; i++) {
            this.camera.target[i] += basis.right[i] * sx + basis.up[i] * sy;
        }
        this.invalidate();
    };

    Viewer.prototype.zoom = function (factor) {
        this.camera.distance = Math.max(this.modelRadius * 1e-3,
            Math.min(this.camera.distance * factor, this.modelRadius * 400));
        this.invalidate();
    };


    /* --- picking and measuring ---------------------------------------------- */

    /* World point -> CSS pixels (plus clip w, so callers can undo perspective). */
    Viewer.prototype.project = function (point) {
        var m = this.mvp;
        var w = m[3] * point[0] + m[7] * point[1] + m[11] * point[2] + m[15];
        if (!(w > 1e-9)) {
            return null;                    // behind the camera
        }
        var x = (m[0] * point[0] + m[4] * point[1] + m[8] * point[2] + m[12]) / w;
        var y = (m[1] * point[0] + m[5] * point[1] + m[9] * point[2] + m[13]) / w;
        var width = this.canvas.clientWidth || this.canvas.width;
        var height = this.canvas.clientHeight || this.canvas.height;
        return {x: (x * 0.5 + 0.5) * width, y: (0.5 - y * 0.5) * height, w: w};
    };

    Viewer.prototype.screenRay = function (clientX, clientY) {
        var rect = this.canvas.getBoundingClientRect();
        var ndcX = ((clientX - rect.left) / rect.width) * 2 - 1;
        var ndcY = 1 - ((clientY - rect.top) / rect.height) * 2;
        if (!M4.invert(this.inverseMVP, this.mvp)) {
            return null;
        }
        var near = unproject(this.inverseMVP, ndcX, ndcY, -1);
        var far = unproject(this.inverseMVP, ndcX, ndcY, 1);
        if (!near || !far) {
            return null;
        }
        var dx = far[0] - near[0], dy = far[1] - near[1], dz = far[2] - near[2];
        var length = Math.hypot(dx, dy, dz);
        if (!(length > 1e-12)) {
            return null;
        }
        return {origin: near, direction: [dx / length, dy / length, dz / length]};
    };

    function unproject(inverse, x, y, z) {
        var w = inverse[3] * x + inverse[7] * y + inverse[11] * z + inverse[15];
        if (Math.abs(w) < 1e-12) {
            return null;
        }
        return [
            (inverse[0] * x + inverse[4] * y + inverse[8] * z + inverse[12]) / w,
            (inverse[1] * x + inverse[5] * y + inverse[9] * z + inverse[13]) / w,
            (inverse[2] * x + inverse[6] * y + inverse[10] * z + inverse[14]) / w
        ];
    }

    function rayParameter(ray, point) {
        return (point[0] - ray.origin[0]) * ray.direction[0]
            + (point[1] - ray.origin[1]) * ray.direction[1]
            + (point[2] - ray.origin[2]) * ray.direction[2];
    }

    var SNAP_RADIUS = 26;      // CSS pixels

    /* Returns {point, kind} for a tap, preferring model edges and their end
     * points over the plain surface so that measurements land where a person
     * aims: corners first, edges next, faces last. */
    Viewer.prototype.pickPoint = function (clientX, clientY) {
        if (!this.model) {
            return null;
        }
        var ray = this.screenRay(clientX, clientY);
        if (!ray) {
            return null;
        }
        var rect = this.canvas.getBoundingClientRect();
        var tapX = clientX - rect.left;
        var tapY = clientY - rect.top;

        var edgeHit = this.pickEdges(tapX, tapY, ray);
        var surfaceHit = this.pickSurface(ray, tapX, tapY);

        if (edgeHit && surfaceHit) {
            // Keep the snap unless it sits clearly behind the visible surface.
            var slack = Math.max(this.modelRadius * 0.02, 1e-9);
            if (edgeHit.depth <= surfaceHit.depth + slack) {
                return edgeHit;
            }
            return surfaceHit;
        }
        return edgeHit || surfaceHit || null;
    };

    Viewer.prototype.pickEdges = function (tapX, tapY, ray) {
        var layers = this.buffers.edges;
        if (!layers.length || !this.model.edges) {
            return null;
        }
        var best = null;
        for (var l = 0; l < layers.length; l++) {
            if (!layers[l].visible) {
                continue;
            }
            var positions = this.model.edges[layers[l].index].positions;
            for (var i = 0; i + 5 < positions.length; i += 6) {
                var a = [positions[i], positions[i + 1], positions[i + 2]];
                var b = [positions[i + 3], positions[i + 4], positions[i + 5]];
                var pa = this.project(a);
                var pb = this.project(b);
                if (!pa || !pb) {
                    continue;
                }
                // end points win over the segment body: a corner is what people aim at
                var da = Math.hypot(tapX - pa.x, tapY - pa.y);
                var db = Math.hypot(tapX - pb.x, tapY - pb.y);
                var vertex = da <= db ? {point: a, distance: da} : {point: b, distance: db};
                if (vertex.distance <= SNAP_RADIUS
                        && (!best || best.kind !== "vertex" || vertex.distance < best.distance)) {
                    best = {point: vertex.point, kind: "vertex", distance: vertex.distance,
                            depth: rayParameter(ray, vertex.point)};
                    continue;
                }
                if (best && best.kind === "vertex") {
                    continue;
                }
                var onSegment = closestOnSegment2D(tapX, tapY, pa.x, pa.y, pb.x, pb.y);
                if (onSegment.distance <= SNAP_RADIUS
                        && (!best || onSegment.distance < best.distance)) {
                    var t = perspectiveParameter(onSegment.u, pa.w, pb.w);
                    var point = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t,
                                 a[2] + (b[2] - a[2]) * t];
                    best = {point: point, kind: "edge", distance: onSegment.distance,
                            depth: rayParameter(ray, point)};
                }
            }
        }
        return best;
    };

    Viewer.prototype.pickSurface = function (ray, tapX, tapY) {
        if (!this.rawMesh) {
            return null;
        }
        var positions = this.rawMesh.positions;
        var nearest = Infinity;
        var index = -1;
        for (var i = 0; i + 8 < positions.length; i += 9) {
            var t = rayTriangle(ray.origin, ray.direction,
                                positions[i], positions[i + 1], positions[i + 2],
                                positions[i + 3], positions[i + 4], positions[i + 5],
                                positions[i + 6], positions[i + 7], positions[i + 8]);
            if (t > 0 && t < nearest) {
                nearest = t;
                index = i;
            }
        }
        if (index < 0) {
            return null;
        }
        var point = [
            ray.origin[0] + ray.direction[0] * nearest,
            ray.origin[1] + ray.direction[1] * nearest,
            ray.origin[2] + ray.direction[2] * nearest
        ];
        // snap to a corner of the triangle that was hit, when the tap is close
        var best = null;
        for (var c = 0; c < 3; c++) {
            var corner = [positions[index + c * 3], positions[index + c * 3 + 1],
                          positions[index + c * 3 + 2]];
            var projected = this.project(corner);
            if (!projected) {
                continue;
            }
            var distance = Math.hypot(tapX - projected.x, tapY - projected.y);
            if (distance <= SNAP_RADIUS && (!best || distance < best.distance)) {
                best = {point: corner, distance: distance};
            }
        }
        if (best) {
            return {point: best.point, kind: "vertex", distance: best.distance,
                    depth: rayParameter(ray, best.point)};
        }
        return {point: point, kind: "surface", distance: 0, depth: nearest};
    };

    Viewer.prototype.setMeasureActive = function (active) {
        this.measure.active = !!active;
        if (!active) {
            this.clearMeasure();
        } else {
            this.notifyMeasure();
        }
        this.invalidate();
    };

    Viewer.prototype.clearMeasure = function () {
        this.measure.points = [];
        this.buildMeasureBuffer();
        this.notifyMeasure();
        this.invalidate();
    };

    Viewer.prototype.addMeasurePoint = function (clientX, clientY) {
        var hit = this.pickPoint(clientX, clientY);
        if (!hit) {
            this.notifyMeasure("miss");
            return null;
        }
        if (this.measure.points.length >= 2) {
            this.measure.points = [];
        }
        this.measure.points.push(hit);
        this.buildMeasureBuffer();
        this.notifyMeasure();
        this.invalidate();
        return hit;
    };

    Viewer.prototype.notifyMeasure = function (note) {
        if (this.measure.onChange) {
            this.measure.onChange(this.measureState(note));
        }
    };

    Viewer.prototype.measureState = function (note) {
        var points = this.measure.points;
        var state = {count: points.length, note: note || null,
                     points: points.map(function (hit) {
                         return {point: hit.point.slice(), kind: hit.kind};
                     })};
        if (points.length === 2) {
            var a = points[0].point, b = points[1].point;
            state.delta = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
            state.distance = Math.hypot(state.delta[0], state.delta[1], state.delta[2]);
        }
        return state;
    };

    Viewer.prototype.buildMeasureBuffer = function () {
        if (this.buffers.measure) {
            this.gl.deleteBuffer(this.buffers.measure.position);
            this.buffers.measure = null;
        }
        var points = this.measure.points;
        if (!points.length) {
            return;
        }
        var size = Math.max(this.modelRadius * 0.03, 1e-9);
        var data = [];
        points.forEach(function (hit) {
            var p = hit.point;
            for (var axis = 0; axis < 3; axis++) {
                var from = p.slice();
                var to = p.slice();
                from[axis] -= size;
                to[axis] += size;
                data.push(from[0], from[1], from[2], to[0], to[1], to[2]);
            }
        });
        if (points.length === 2) {
            data.push(points[0].point[0], points[0].point[1], points[0].point[2],
                      points[1].point[0], points[1].point[1], points[1].point[2]);
        }
        this.buffers.measure = {position: this.makeBuffer(new Float32Array(data)),
                                count: data.length / 3};
    };

    /* --- drawing ------------------------------------------------------------ */

    Viewer.prototype.renderIfNeeded = function () {
        this.resize();
        if (!this.dirty) {
            return;
        }
        this.dirty = false;
        this.render();
    };

    Viewer.prototype.render = function () {
        var gl = this.gl;
        var width = this.canvas.width;
        var height = this.canvas.height;
        gl.viewport(0, 0, width, height);
        gl.clearColor(this.theme.backgroundBottom[0], this.theme.backgroundBottom[1],
                      this.theme.backgroundBottom[2], 1);
        gl.clearStencil(0);
        gl.enable(gl.DEPTH_TEST);
        gl.depthFunc(gl.LEQUAL);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
        this.drawBackground();
        if (!this.model) {
            return;
        }

        var aspect = width / Math.max(height, 1);
        var near = Math.max(this.camera.distance - this.modelRadius * 6, this.modelRadius * 1e-3);
        var far = this.camera.distance + this.modelRadius * 20;
        if (this.options.projection === "orthographic") {
            var halfHeight = this.camera.distance * Math.tan(this.camera.fov / 2);
            M4.ortho(this.proj, -halfHeight * aspect, halfHeight * aspect,
                     -halfHeight, halfHeight,
                     -this.modelRadius * 40, this.modelRadius * 40 + this.camera.distance);
        } else {
            M4.perspective(this.proj, this.camera.fov, aspect, near, far);
        }
        M4.lookAt(this.view, this.eye(), this.camera.target, [0, 0, 1]);
        M4.multiply(this.mvp, this.proj, this.view);
        M4.normalMatrix(this.normalMatrix, this.view);

        this.clip = this.section.active ? this.sectionPlane() : null;

        if (this.options.showGrid && this.buffers.grid) {
            this.drawLines(this.buffers.grid, this.theme.grid, 1, 1, 0, false);
        }
        if (this.options.showAxes && this.buffers.axes) {
            this.drawAxes();
        }

        var showMesh = this.buffers.mesh && this.options.shading !== "wireframe";
        if (showMesh) {
            this.drawMesh();
            if (this.clip && this.buffers.cap) {
                this.drawSectionCap();
            }
        }
        if (this.options.shading === "wireframe" && this.buffers.wireframe) {
            this.drawLines(this.buffers.wireframe, this.theme.wireframe, 0.55, 2, 0.0);
        }
        var drawEdges = this.buffers.edges.length
            && (this.options.shading !== "shaded" || !this.buffers.mesh);
        if (drawEdges) {
            for (var i = 0; i < this.buffers.edges.length; i++) {
                var layer = this.buffers.edges[i];
                if (!layer.visible) {
                    continue;
                }
                var color = this.buffers.mesh
                    ? this.theme.outline        // plain outlines on top of a shaded solid
                    : this.themedLineColor(layer.color);
                this.drawLines(layer, color, 1, layer.count > 400000 ? 1 : 2, 0.0008);
            }
        }
        if (this.options.showBBox && this.buffers.bbox) {
            this.drawLines(this.buffers.bbox, this.theme.bbox, 0.75, 1, 0, false);
        }
        if (this.buffers.measure) {
            // always on top, so a marker never disappears inside the model
            gl.disable(gl.DEPTH_TEST);
            this.drawLines(this.buffers.measure, this.theme.measure, 1, 2, 0, false);
            gl.enable(gl.DEPTH_TEST);
        }
    };

    Viewer.prototype.drawBackground = function () {
        var gl = this.gl;
        var prog = this.backgroundProgram;
        gl.useProgram(prog.handle);
        gl.uniform3fv(prog.uniforms.uTop, this.theme.backgroundTop);
        gl.uniform3fv(prog.uniforms.uBottom, this.theme.backgroundBottom);
        gl.disable(gl.DEPTH_TEST);
        gl.depthMask(false);
        gl.enableVertexAttribArray(0);
        gl.disableVertexAttribArray(1);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.backgroundQuad);
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        gl.depthMask(true);
        gl.enable(gl.DEPTH_TEST);
    };

    /* Counts how many faces lie between the eye and the plane: an odd count means
     * the plane cuts through solid material, and that is where the cap is drawn. */
    Viewer.prototype.drawSectionCap = function () {
        var gl = this.gl;
        gl.enable(gl.STENCIL_TEST);
        gl.clear(gl.STENCIL_BUFFER_BIT);
        gl.colorMask(false, false, false, false);
        gl.depthMask(false);
        gl.disable(gl.DEPTH_TEST);
        gl.stencilFunc(gl.ALWAYS, 0, 0xff);
        gl.stencilOpSeparate(gl.FRONT, gl.KEEP, gl.KEEP, gl.DECR_WRAP);
        gl.stencilOpSeparate(gl.BACK, gl.KEEP, gl.KEEP, gl.INCR_WRAP);
        this.drawMesh();

        gl.colorMask(true, true, true, true);
        gl.depthMask(true);
        gl.enable(gl.DEPTH_TEST);
        gl.stencilFunc(gl.NOTEQUAL, 0, 0xff);
        gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);
        this.drawMesh(this.buffers.cap, this.theme.cut, true);
        gl.disable(gl.STENCIL_TEST);
    };

    Viewer.prototype.drawMesh = function (buffer, color, ignoreClip) {
        var gl = this.gl;
        var prog = this.meshProgram;
        buffer = buffer || this.buffers.mesh;
        gl.useProgram(prog.handle);
        gl.uniformMatrix4fv(prog.uniforms.uMVP, false, this.mvp);
        gl.uniformMatrix4fv(prog.uniforms.uModelView, false, this.view);
        gl.uniformMatrix3fv(prog.uniforms.uNormalMatrix, false, this.normalMatrix);
        gl.uniform3fv(prog.uniforms.uColor, color || this.theme.material);
        gl.uniform3fv(prog.uniforms.uBackColor, color || this.theme.backface);
        this.applyClip(prog, !ignoreClip);
        gl.enableVertexAttribArray(0);
        gl.enableVertexAttribArray(1);
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer.position);
        gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer.normal);
        gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);
        gl.drawArrays(gl.TRIANGLES, 0, buffer.count);
        gl.disableVertexAttribArray(1);
    };

    Viewer.prototype.applyClip = function (prog, enabled) {
        var gl = this.gl;
        var plane = enabled ? this.clip : null;
        if (!prog.uniforms.uClipPlane) {
            return;
        }
        if (plane) {
            gl.uniform4f(prog.uniforms.uClipPlane, plane.normal[0], plane.normal[1],
                         plane.normal[2], plane.offset);
            gl.uniform1f(prog.uniforms.uClipEnabled, 1);
        } else {
            gl.uniform1f(prog.uniforms.uClipEnabled, 0);
        }
    };

    /* Line width is capped at 1px on most GPUs, so thicker strokes are faked by
     * redrawing the geometry with sub-pixel offsets. */
    Viewer.prototype.drawLines = function (buffer, color, alpha, passes, depthNudge, clip) {
        var gl = this.gl;
        var prog = this.lineProgram;
        gl.useProgram(prog.handle);
        this.applyClip(prog, clip !== false);
        gl.uniformMatrix4fv(prog.uniforms.uMVP, false, this.mvp);
        gl.uniform3fv(prog.uniforms.uColor, color);
        gl.uniform1f(prog.uniforms.uAlpha, alpha);
        gl.uniform1f(prog.uniforms.uDepthNudge, depthNudge || 0);
        gl.enableVertexAttribArray(0);
        gl.disableVertexAttribArray(1);
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer.position);
        gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
        var px = 2 / this.canvas.width;
        var py = 2 / this.canvas.height;
        var offsets = passes > 1
            ? [[0, 0], [px, 0], [0, py], [px, py]]
            : [[0, 0]];
        for (var i = 0; i < offsets.length; i++) {
            gl.uniform2f(prog.uniforms.uOffset, offsets[i][0], offsets[i][1]);
            gl.drawArrays(gl.LINES, 0, buffer.count);
        }
        gl.uniform2f(prog.uniforms.uOffset, 0, 0);
    };

    Viewer.prototype.drawAxes = function () {
        var gl = this.gl;
        var prog = this.lineProgram;
        var colors = this.theme.axes;
        gl.useProgram(prog.handle);
        this.applyClip(prog, false);
        gl.uniformMatrix4fv(prog.uniforms.uMVP, false, this.mvp);
        gl.uniform1f(prog.uniforms.uAlpha, 0.55);
        gl.uniform1f(prog.uniforms.uDepthNudge, 0);
        gl.enableVertexAttribArray(0);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.axes.position);
        gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
        var px = 2 / this.canvas.width;
        var py = 2 / this.canvas.height;
        for (var axis = 0; axis < 3; axis++) {
            gl.uniform3fv(prog.uniforms.uColor, colors[axis]);
            var offsets = [[0, 0], [px, 0], [0, py]];
            for (var i = 0; i < offsets.length; i++) {
                gl.uniform2f(prog.uniforms.uOffset, offsets[i][0], offsets[i][1]);
                gl.drawArrays(gl.LINES, axis * 2, 2);
            }
        }
        gl.uniform2f(prog.uniforms.uOffset, 0, 0);
    };

    Viewer.prototype.snapshot = function () {
        this.render();
        return this.canvas.toDataURL("image/png");
    };

    P.Viewer = Viewer;
})(typeof self !== "undefined" ? self : this);
