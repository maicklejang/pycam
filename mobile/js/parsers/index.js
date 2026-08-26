/* PyCAM Viewer - format detection and dispatch.
 *
 * Copyright 2026 The PyCAM contributors
 * Licensed under the GNU General Public License v3 or later (see COPYING.TXT).
 */
(function (root) {
    "use strict";

    var P = root.PVX = root.PVX || {};

    P.EXTENSIONS = [".stl", ".step", ".stp", ".p21", ".dxf"];

    function extensionOf(name) {
        var match = /\.([a-z0-9]+)$/i.exec(name || "");
        return match ? match[1].toLowerCase() : "";
    }

    function sniff(buffer) {
        var head = new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 2048));
        var text = "";
        for (var i = 0; i < head.length; i++) {
            text += String.fromCharCode(head[i]);
        }
        if (/ISO-10303-21/i.test(text)) {
            return "step";
        }
        if (/^\s*(999|0)\r?\n/.test(text) && /SECTION/i.test(text)) {
            return "dxf";
        }
        if (/AutoCAD Binary DXF/.test(text)) {
            return "dxf";
        }
        if (/^\s*solid\s/i.test(text)) {
            return "stl";
        }
        // A valid binary STL announces a triangle count matching the file size.
        if (buffer.byteLength >= 84) {
            var count = new DataView(buffer).getUint32(80, true);
            if (84 + count * 50 === buffer.byteLength) {
                return "stl";
            }
        }
        return null;
    }

    /* buffer: ArrayBuffer, name: original file name (used for the format hint). */
    P.parseFile = function (buffer, name, progress) {
        if (!buffer || !buffer.byteLength) {
            throw new Error("the file is empty");
        }
        var ext = extensionOf(name);
        var kind = sniff(buffer);
        if (!kind) {
            if (ext === "stl") {
                kind = "stl";
            } else if (ext === "dxf") {
                kind = "dxf";
            } else if (ext === "step" || ext === "stp" || ext === "p21") {
                kind = "step";
            }
        }
        switch (kind) {
        case "stl":
            return P.parseSTL(buffer, progress);
        case "dxf":
            return P.parseDXF(buffer, progress);
        case "step":
            return P.parseSTEP(buffer, progress);
        default:
            throw new Error("unknown file format - supported are STL, STEP/STP and DXF");
        }
    };
})(typeof self !== "undefined" ? self : this);
