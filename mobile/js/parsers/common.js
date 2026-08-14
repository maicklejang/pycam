/* PyCAM Viewer - helpers shared by all parsers.
 *
 * Copyright 2026 The PyCAM contributors
 * Licensed under the GNU General Public License v3 or later (see COPYING.TXT).
 */
(function (root) {
    "use strict";

    var P = root.PVX = root.PVX || {};

    /* Decode a file that is "probably UTF-8, maybe latin-1, maybe UTF-16". */
    P.decodeText = function (buffer) {
        var bytes = new Uint8Array(buffer);
        if (bytes.length >= 2) {
            if (bytes[0] === 0xff && bytes[1] === 0xfe) {
                return new TextDecoder("utf-16le").decode(buffer);
            }
            if (bytes[0] === 0xfe && bytes[1] === 0xff) {
                return new TextDecoder("utf-16be").decode(buffer);
            }
        }
        try {
            return new TextDecoder("utf-8", {fatal: true}).decode(buffer);
        } catch (err) {
            // DXF files written by older CAD packages are usually cp1252/latin-1.
            return new TextDecoder("windows-1252").decode(buffer);
        }
    };

    P.emptyBBox = function () {
        return {min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity]};
    };

    P.growBBox = function (bbox, x, y, z) {
        if (x < bbox.min[0]) { bbox.min[0] = x; }
        if (y < bbox.min[1]) { bbox.min[1] = y; }
        if (z < bbox.min[2]) { bbox.min[2] = z; }
        if (x > bbox.max[0]) { bbox.max[0] = x; }
        if (y > bbox.max[1]) { bbox.max[1] = y; }
        if (z > bbox.max[2]) { bbox.max[2] = z; }
        return bbox;
    };

    P.bboxOf = function (positions, bbox) {
        bbox = bbox || P.emptyBBox();
        for (var i = 0; i + 2 < positions.length; i += 3) {
            P.growBBox(bbox, positions[i], positions[i + 1], positions[i + 2]);
        }
        return bbox;
    };

    P.isFiniteBBox = function (bbox) {
        return !!bbox && isFinite(bbox.min[0]) && isFinite(bbox.max[0])
            && isFinite(bbox.min[1]) && isFinite(bbox.max[1])
            && isFinite(bbox.min[2]) && isFinite(bbox.max[2]);
    };

    /* Number of straight segments to approximate an arc of `sweep` radians with
     * `radius`, keeping the chord error below `tolerance` (but staying sane). */
    P.arcSegments = function (radius, sweep, tolerance) {
        sweep = Math.abs(sweep);
        if (!(radius > 0) || !(sweep > 0)) {
            return 1;
        }
        tolerance = tolerance || Math.max(radius * 0.002, 1e-9);
        var ratio = 1 - tolerance / radius;
        var step = (ratio <= -1 || ratio >= 1) ? sweep : 2 * Math.acos(ratio);
        var n = Math.ceil(sweep / Math.max(step, 1e-6));
        return Math.max(2, Math.min(n, 512));
    };

    /* AutoCAD Color Index -> [r, g, b] in 0..1.
     * Indices 1-9 and 250-255 are the exact standard values, the 10-249 block is
     * reconstructed from its hue/shade layout (close enough for viewing). */
    var aciCache = null;

    function buildAci() {
        var table = new Array(256);
        var fixed = {
            0: [0, 0, 0], 1: [255, 0, 0], 2: [255, 255, 0], 3: [0, 255, 0],
            4: [0, 255, 255], 5: [0, 0, 255], 6: [255, 0, 255], 7: [255, 255, 255],
            8: [128, 128, 128], 9: [192, 192, 192],
            250: [51, 51, 51], 251: [80, 80, 80], 252: [105, 105, 105],
            253: [130, 130, 130], 254: [190, 190, 190], 255: [255, 255, 255]
        };
        var sat = [1, 0.5, 1, 0.5, 1, 0.5, 1, 0.5, 1, 0.5];
        var val = [1, 1, 0.8, 0.8, 0.6, 0.6, 0.45, 0.45, 0.3, 0.3];
        for (var i = 0; i < 256; i++) {
            if (fixed[i]) {
                table[i] = [fixed[i][0] / 255, fixed[i][1] / 255, fixed[i][2] / 255];
            } else if (i >= 10 && i <= 249) {
                var hue = Math.floor((i - 10) / 10) * 15;
                var shade = (i - 10) % 10;
                table[i] = hsvToRgb(hue / 360, sat[shade], val[shade]);
            } else {
                table[i] = [1, 1, 1];
            }
        }
        return table;
    }

    function hsvToRgb(h, s, v) {
        var i = Math.floor(h * 6);
        var f = h * 6 - i;
        var p = v * (1 - s);
        var q = v * (1 - f * s);
        var t = v * (1 - (1 - f) * s);
        switch (i % 6) {
        case 0: return [v, t, p];
        case 1: return [q, v, p];
        case 2: return [p, v, t];
        case 3: return [p, q, v];
        case 4: return [t, p, v];
        default: return [v, p, q];
        }
    }

    P.aciColor = function (index) {
        if (!aciCache) {
            aciCache = buildAci();
        }
        index = Math.round(index);
        if (!(index >= 0 && index <= 255)) {
            index = 7;
        }
        var rgb = aciCache[index];
        // Colour 7 is "black on white paper" - show it as white on our dark canvas.
        if (index === 7 || index === 0) {
            return [0.92, 0.94, 0.98];
        }
        return rgb;
    };
})(typeof self !== "undefined" ? self : this);
