/* PyCAM Viewer - parsing worker.
 *
 * Keeps the UI responsive while large files are being read.
 *
 * Copyright 2026 The PyCAM contributors
 * Licensed under the GNU General Public License v3 or later (see COPYING.TXT).
 */
/* global importScripts, PVX */
importScripts("parsers/common.js", "parsers/triangulate.js", "parsers/stl.js",
              "parsers/dxf.js", "parsers/step.js", "parsers/index.js");

self.onmessage = function (event) {
    var msg = event.data || {};
    var id = msg.id;
    var started = Date.now();
    function report(fraction, label) {
        self.postMessage({id: id, type: "progress", fraction: fraction, label: label});
    }
    try {
        report(0.05, "reading");
        var result = PVX.parseFile(msg.buffer, msg.name, report);
        result.parseMs = Date.now() - started;
        var transfer = [];
        if (result.mesh) {
            transfer.push(result.mesh.positions.buffer, result.mesh.normals.buffer);
            if (result.mesh.colors) {
                transfer.push(result.mesh.colors.buffer);
            }
        }
        (result.edges || []).forEach(function (layer) {
            transfer.push(layer.positions.buffer);
        });
        self.postMessage({id: id, type: "done", result: result}, transfer);
    } catch (err) {
        self.postMessage({id: id, type: "error", message: err && err.message
            ? err.message : String(err)});
    }
};
