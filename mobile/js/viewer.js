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
        }
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
        "void main() {",
        "  vNormal = uNormalMatrix * aNormal;",
        "  vWorldNormal = aNormal;",
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
        "void main() {",
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
        "void main() {",
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
        "void main() { gl_FragColor = vec4(uColor, uAlpha); }"
    ].join("\n");

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
        var options = {alpha: false, antialias: true, depth: true,
                       preserveDrawingBuffer: true, powerPreference: "high-performance"};
        var gl = canvas.getContext("webgl", options) || canvas.getContext("experimental-webgl", options);
        if (!gl) {
            throw new Error("WebGL is not available in this browser");
        }
        this.gl = gl;
        this.meshProgram = program(gl, MESH_VS, MESH_FS, ["aPosition", "aNormal"]);
        this.lineProgram = program(gl, LINE_VS, LINE_FS, ["aPosition"]);

        this.model = null;
        this.buffers = {mesh: null, edges: [], grid: null, axes: null, bbox: null,
                        wireframe: null};
        this.background = [0.055, 0.066, 0.094];
        this.materialColor = [0.62, 0.68, 0.78];
        this.backfaceColor = [0.42, 0.30, 0.34];

        this.options = {
            projection: "perspective",
            shading: "shaded",       // shaded | shaded-edges | wireframe
            showGrid: true,
            showAxes: true,
            showBBox: false,
            lockRotation: false
        };

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

    Viewer.prototype.setOption = function (key, value) {
        this.options[key] = value;
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
        this.buffers.edges.forEach(drop);
        this.buffers = {mesh: null, edges: [], grid: null, axes: null, bbox: null,
                        wireframe: null};
        this.rawMesh = null;
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
            var now = Date.now();
            if (event.pointerType !== "mouse" && now - self.lastTap < 300
                    && self.pointers.size === 1) {
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
            self.pointers.delete(event.pointerId);
            if (self.pointers.size < 2) {
                self.pinch = null;
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
            self.fit();
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
        gl.clearColor(this.background[0], this.background[1], this.background[2], 1);
        gl.enable(gl.DEPTH_TEST);
        gl.depthFunc(gl.LEQUAL);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
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

        if (this.options.showGrid && this.buffers.grid) {
            this.drawLines(this.buffers.grid, [0.16, 0.19, 0.25], 1, 1, 0);
        }
        if (this.options.showAxes && this.buffers.axes) {
            this.drawAxes();
        }

        var showMesh = this.buffers.mesh && this.options.shading !== "wireframe";
        if (showMesh) {
            this.drawMesh();
        }
        if (this.options.shading === "wireframe" && this.buffers.wireframe) {
            this.drawLines(this.buffers.wireframe, [0.45, 0.72, 0.95], 0.55, 2, 0.0);
        }
        var drawEdges = this.buffers.edges.length
            && (this.options.shading !== "shaded" || !this.buffers.mesh);
        if (drawEdges) {
            for (var i = 0; i < this.buffers.edges.length; i++) {
                var layer = this.buffers.edges[i];
                if (!layer.visible) {
                    continue;
                }
                var color = layer.color;
                if (this.buffers.mesh) {
                    color = [0.05, 0.07, 0.11];   // dark outlines on top of a shaded solid
                }
                this.drawLines(layer, color, 1, layer.count > 400000 ? 1 : 2, 0.0008);
            }
        }
        if (this.options.showBBox && this.buffers.bbox) {
            this.drawLines(this.buffers.bbox, [0.95, 0.62, 0.25], 0.75, 1, 0);
        }
    };

    Viewer.prototype.drawMesh = function () {
        var gl = this.gl;
        var prog = this.meshProgram;
        gl.useProgram(prog.handle);
        gl.uniformMatrix4fv(prog.uniforms.uMVP, false, this.mvp);
        gl.uniformMatrix4fv(prog.uniforms.uModelView, false, this.view);
        gl.uniformMatrix3fv(prog.uniforms.uNormalMatrix, false, this.normalMatrix);
        gl.uniform3fv(prog.uniforms.uColor, this.materialColor);
        gl.uniform3fv(prog.uniforms.uBackColor, this.backfaceColor);
        gl.enableVertexAttribArray(0);
        gl.enableVertexAttribArray(1);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.mesh.position);
        gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.mesh.normal);
        gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);
        gl.drawArrays(gl.TRIANGLES, 0, this.buffers.mesh.count);
        gl.disableVertexAttribArray(1);
    };

    /* Line width is capped at 1px on most GPUs, so thicker strokes are faked by
     * redrawing the geometry with sub-pixel offsets. */
    Viewer.prototype.drawLines = function (buffer, color, alpha, passes, depthNudge) {
        var gl = this.gl;
        var prog = this.lineProgram;
        gl.useProgram(prog.handle);
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
        var colors = [[0.90, 0.35, 0.35], [0.42, 0.82, 0.45], [0.40, 0.60, 0.95]];
        gl.useProgram(prog.handle);
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
