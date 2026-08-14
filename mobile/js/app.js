/* PyCAM Viewer - application shell: file intake, worker orchestration, UI state.
 *
 * Copyright 2026 The PyCAM contributors
 * Licensed under the GNU General Public License v3 or later (see COPYING.TXT).
 */
(function (root) {
    "use strict";

    var P = root.PVX;
    var doc = root.document;
    var t = P.t;

    var el = {};
    ["canvas", "file-name", "file-meta", "btn-open", "btn-panel", "btn-open-main", "btn-fit",
     "btn-view", "btn-shading", "btn-grid", "btn-share", "view-menu", "side-tools", "welcome",
     "panel", "panel-handle", "stats", "warnings", "layer-list", "sel-shading", "sel-projection",
     "chk-grid", "chk-axes", "chk-bbox", "chk-lock", "progress", "progress-bar", "progress-label",
     "toast", "file-input", "recent", "recent-list", "tab-info", "tab-layers", "tab-display"
    ].forEach(function (id) {
        el[id] = doc.getElementById(id);
    });

    P.applyTranslations();

    var viewer = null;
    try {
        viewer = new P.Viewer(el.canvas);
    } catch (err) {
        showToast(t("unsupported"));
    }

    if (viewer) {
        viewer.insetBottom = 96;   // height of the collapsed info panel
    }

    var worker = null;
    var requestId = 0;
    var pending = new Map();
    var currentModel = null;

    function startWorker() {
        if (worker || !root.Worker) {
            return;
        }
        try {
            worker = new root.Worker("js/worker.js");
            worker.onmessage = function (event) {
                var msg = event.data;
                var handlers = pending.get(msg.id);
                if (!handlers) {
                    return;
                }
                if (msg.type === "progress") {
                    handlers.progress(msg.fraction, msg.label);
                } else if (msg.type === "done") {
                    pending.delete(msg.id);
                    handlers.resolve(msg.result);
                } else if (msg.type === "error") {
                    pending.delete(msg.id);
                    handlers.reject(new Error(msg.message));
                }
            };
            worker.onerror = function () {
                worker = null;   // fall back to main-thread parsing
            };
        } catch (err) {
            worker = null;
        }
    }
    startWorker();

    function parseBuffer(buffer, name, onProgress) {
        startWorker();
        if (worker) {
            return new Promise(function (resolve, reject) {
                var id = ++requestId;
                pending.set(id, {resolve: resolve, reject: reject, progress: onProgress});
                worker.postMessage({id: id, buffer: buffer, name: name}, [buffer]);
            });
        }
        return new Promise(function (resolve, reject) {
            // Give the browser a chance to paint the progress dialog first.
            root.setTimeout(function () {
                try {
                    resolve(P.parseFile(buffer, name, onProgress));
                } catch (err) {
                    reject(err);
                }
            }, 30);
        });
    }

    /* --- UI helpers --------------------------------------------------------- */

    function showToast(message, timeout) {
        el.toast.textContent = message;
        el.toast.hidden = false;
        root.clearTimeout(showToast.timer);
        showToast.timer = root.setTimeout(function () {
            el.toast.hidden = true;
        }, timeout || 4200);
    }

    function setProgress(fraction, label) {
        el.progress.hidden = false;
        el["progress-bar"].style.width = Math.round(Math.max(0.03, fraction) * 100) + "%";
        el["progress-label"].textContent = label;
    }

    function hideProgress() {
        el.progress.hidden = true;
    }

    function formatNumber(value) {
        if (typeof value !== "number") {
            return String(value);
        }
        if (Math.abs(value) >= 1000) {
            return value.toLocaleString();
        }
        return String(Math.round(value * 1000) / 1000);
    }

    function formatSize(bytes) {
        if (bytes < 1024) {
            return bytes + " B";
        }
        if (bytes < 1024 * 1024) {
            return (bytes / 1024).toFixed(1) + " kB";
        }
        return (bytes / (1024 * 1024)).toFixed(1) + " MB";
    }

    var PROGRESS_LABELS = {
        reading: "reading", "building geometry": "geometry", "packing buffers": "packing",
        "reading entities": "entities"
    };

    function translateProgress(label) {
        var key = PROGRESS_LABELS[label];
        return key ? t(key) : (label || t("loading"));
    }

    /* --- model presentation ------------------------------------------------- */

    function showModel(result, file) {
        currentModel = result;
        viewer.setModel(result);
        el["file-name"].textContent = file.name;
        el["file-meta"].textContent = result.format + " · " + formatSize(file.size);
        el.welcome.hidden = true;
        el.panel.hidden = false;
        el["side-tools"].hidden = false;
        el.panel.classList.add("collapsed");

        var stats = [];
        stats.push([t("statFormat"), result.format + (result.flavour ? " (" + result.flavour + ")" : "")]);
        stats.push([t("statSize"), formatSize(file.size)]);
        if (P.isFiniteBBox(result.bbox)) {
            var b = result.bbox;
            stats.push([t("statSizeXYZ"),
                        formatNumber(b.max[0] - b.min[0]) + " × "
                        + formatNumber(b.max[1] - b.min[1]) + " × "
                        + formatNumber(b.max[2] - b.min[2])]);
        }
        (result.stats || []).forEach(function (entry) {
            stats.push([entry[0], formatNumber(entry[1])]);
        });
        if (result.parseMs !== undefined) {
            stats.push([t("statTime"), (result.parseMs / 1000).toFixed(2) + " s"]);
        }
        el.stats.innerHTML = "";
        stats.forEach(function (entry) {
            var dt = doc.createElement("dt");
            dt.textContent = entry[0];
            var dd = doc.createElement("dd");
            dd.textContent = entry[1];
            el.stats.appendChild(dt);
            el.stats.appendChild(dd);
        });

        if (result.warnings && result.warnings.length) {
            el.warnings.hidden = false;
            el.warnings.innerHTML = "";
            result.warnings.forEach(function (text) {
                var p = doc.createElement("p");
                p.textContent = text;
                el.warnings.appendChild(p);
            });
        } else {
            el.warnings.hidden = true;
        }

        buildLayerList(result);
        el["sel-shading"].value = viewer.options.shading;
        el["btn-shading"].classList.toggle("on", viewer.options.shading !== "shaded");
        el["sel-projection"].value = viewer.options.projection;
        el["chk-lock"].checked = viewer.options.lockRotation;
        el["btn-grid"].classList.toggle("on", viewer.options.showGrid);
    }

    function buildLayerList(result) {
        el["layer-list"].innerHTML = "";
        // A layer can span several draw groups (entities may override the layer
        // colour), so the panel groups them back together by name.
        var groups = new Map();
        (result.edges || []).forEach(function (layer, index) {
            if (layer.name === "Edges") {
                return;
            }
            var entry = groups.get(layer.name);
            if (!entry) {
                entry = {name: layer.name, color: layer.color, segments: 0, indices: [],
                         visible: layer.visible !== false};
                groups.set(layer.name, entry);
            }
            entry.segments += layer.segments;
            entry.indices.push(index);
        });

        if (!groups.size) {
            var empty = doc.createElement("li");
            empty.textContent = t("noLayers");
            empty.style.color = "var(--muted)";
            el["layer-list"].appendChild(empty);
            return;
        }

        groups.forEach(function (entry) {
            var li = doc.createElement("li");
            var swatch = doc.createElement("span");
            swatch.className = "swatch";
            swatch.style.background = "rgb(" + entry.color.map(function (c) {
                return Math.round(c * 255);
            }).join(",") + ")";
            var name = doc.createElement("span");
            name.className = "name";
            name.textContent = entry.name;
            var count = doc.createElement("small");
            count.textContent = entry.segments.toLocaleString();
            var toggle = doc.createElement("input");
            toggle.type = "checkbox";
            toggle.checked = entry.visible;
            toggle.addEventListener("change", function () {
                entry.indices.forEach(function (index) {
                    viewer.setLayerVisible(index, toggle.checked);
                });
            });
            li.appendChild(swatch);
            li.appendChild(name);
            li.appendChild(count);
            li.appendChild(toggle);
            el["layer-list"].appendChild(li);
        });
    }

    /* --- file intake --------------------------------------------------------- */

    function readAsArrayBuffer(file) {
        if (file.arrayBuffer) {
            return file.arrayBuffer();
        }
        return new Promise(function (resolve, reject) {
            var reader = new FileReader();
            reader.onload = function () {
                resolve(reader.result);
            };
            reader.onerror = function () {
                reject(new Error("could not read the file"));
            };
            reader.readAsArrayBuffer(file);
        });
    }

    function openFile(file) {
        if (!file || !viewer) {
            return;
        }
        setProgress(0.05, t("loading"));
        var meta = {name: file.name || "model", size: file.size || 0};
        readAsArrayBuffer(file).then(function (buffer) {
            meta.size = buffer.byteLength;
            var keep = buffer.slice(0);   // the worker takes ownership of `buffer`
            return parseBuffer(buffer, meta.name, function (fraction, label) {
                setProgress(fraction, translateProgress(label));
            }).then(function (result) {
                hideProgress();
                showModel(result, meta);
                rememberFile(meta.name, keep);
            });
        }).catch(function (err) {
            hideProgress();
            showToast(t("errorPrefix") + (err && err.message ? err.message : err), 6000);
        });
    }

    el["file-input"].addEventListener("change", function () {
        if (el["file-input"].files && el["file-input"].files[0]) {
            openFile(el["file-input"].files[0]);
        }
        el["file-input"].value = "";
    });

    function pickFile() {
        el["file-input"].click();
    }

    el["btn-open"].addEventListener("click", pickFile);
    el["btn-open-main"].addEventListener("click", pickFile);

    ["dragenter", "dragover"].forEach(function (type) {
        doc.addEventListener(type, function (event) {
            event.preventDefault();
            el.welcome.classList.add("drag-over");
        });
    });
    ["dragleave", "drop"].forEach(function (type) {
        doc.addEventListener(type, function (event) {
            event.preventDefault();
            el.welcome.classList.remove("drag-over");
            if (type === "drop" && event.dataTransfer && event.dataTransfer.files[0]) {
                openFile(event.dataTransfer.files[0]);
            }
        });
    });

    /* --- controls -------------------------------------------------------------- */

    el["btn-fit"].addEventListener("click", function () {
        viewer.fit();
    });

    el["btn-view"].addEventListener("click", function () {
        el["view-menu"].hidden = !el["view-menu"].hidden;
    });

    el["view-menu"].addEventListener("click", function (event) {
        var button = event.target.closest("button[data-view]");
        if (!button) {
            return;
        }
        viewer.fit(button.getAttribute("data-view"));
        el["view-menu"].hidden = true;
    });

    var SHADING_ORDER = ["shaded", "shaded-edges", "wireframe"];

    el["btn-shading"].addEventListener("click", function () {
        var next = SHADING_ORDER[(SHADING_ORDER.indexOf(viewer.options.shading) + 1)
            % SHADING_ORDER.length];
        viewer.setOption("shading", next);
        el["sel-shading"].value = next;
        el["btn-shading"].classList.toggle("on", next !== "shaded");
    });

    el["btn-grid"].addEventListener("click", function () {
        var next = !viewer.options.showGrid;
        viewer.setOption("showGrid", next);
        el["chk-grid"].checked = next;
        el["btn-grid"].classList.toggle("on", next);
    });

    el["btn-share"].addEventListener("click", function () {
        if (!currentModel) {
            return;
        }
        el.canvas.toBlob(function (blob) {
            if (!blob) {
                return;
            }
            var name = (el["file-name"].textContent || "model").replace(/\.[^.]+$/, "") + ".png";
            var file = new File([blob], name, {type: "image/png"});
            if (root.navigator.canShare && root.navigator.canShare({files: [file]})) {
                root.navigator.share({files: [file], title: name}).catch(function () {});
                return;
            }
            var url = URL.createObjectURL(blob);
            var link = doc.createElement("a");
            link.href = url;
            link.download = name;
            link.click();
            root.setTimeout(function () {
                URL.revokeObjectURL(url);
            }, 4000);
            showToast(t("savedImage"), 2500);
        }, "image/png");
    });

    el["btn-panel"].addEventListener("click", function () {
        if (el.panel.hidden) {
            return;
        }
        el.panel.classList.toggle("collapsed");
    });

    el["panel-handle"].addEventListener("click", function () {
        el.panel.classList.toggle("collapsed");
    });

    doc.querySelectorAll(".tab").forEach(function (tab) {
        tab.addEventListener("click", function () {
            doc.querySelectorAll(".tab").forEach(function (other) {
                other.classList.toggle("active", other === tab);
            });
            var name = tab.getAttribute("data-tab");
            el["tab-info"].hidden = name !== "info";
            el["tab-layers"].hidden = name !== "layers";
            el["tab-display"].hidden = name !== "display";
            el.panel.classList.remove("collapsed");
        });
    });

    el["sel-shading"].addEventListener("change", function () {
        viewer.setOption("shading", el["sel-shading"].value);
        el["btn-shading"].classList.toggle("on", el["sel-shading"].value !== "shaded");
    });
    el["sel-projection"].addEventListener("change", function () {
        viewer.setOption("projection", el["sel-projection"].value);
    });
    el["chk-grid"].addEventListener("change", function () {
        viewer.setOption("showGrid", el["chk-grid"].checked);
        el["btn-grid"].classList.toggle("on", el["chk-grid"].checked);
    });
    el["chk-axes"].addEventListener("change", function () {
        viewer.setOption("showAxes", el["chk-axes"].checked);
    });
    el["chk-bbox"].addEventListener("change", function () {
        viewer.setOption("showBBox", el["chk-bbox"].checked);
    });
    el["chk-lock"].addEventListener("change", function () {
        viewer.setOption("lockRotation", el["chk-lock"].checked);
    });

    doc.addEventListener("keydown", function (event) {
        if (!viewer || event.metaKey || event.ctrlKey) {
            return;
        }
        var keys = {f: "fit", "1": "front", "2": "right", "3": "top", "0": "iso"};
        var action = keys[event.key.toLowerCase()];
        if (action === "fit") {
            viewer.fit();
        } else if (action) {
            viewer.fit(action);
        } else if (event.key === "o") {
            pickFile();
        }
    });

    /* --- recent files (IndexedDB) ---------------------------------------------- */

    var DB_NAME = "pycam-viewer";
    var STORE = "recent";
    var MAX_RECENT = 5;
    var MAX_RECENT_BYTES = 32 * 1024 * 1024;

    function withStore(mode) {
        return new Promise(function (resolve, reject) {
            if (!root.indexedDB) {
                reject(new Error("no indexeddb"));
                return;
            }
            var request = root.indexedDB.open(DB_NAME, 1);
            request.onupgradeneeded = function () {
                if (!request.result.objectStoreNames.contains(STORE)) {
                    request.result.createObjectStore(STORE, {keyPath: "id", autoIncrement: true});
                }
            };
            request.onsuccess = function () {
                var db = request.result;
                resolve(db.transaction(STORE, mode).objectStore(STORE));
            };
            request.onerror = function () {
                reject(request.error);
            };
        });
    }

    function rememberFile(name, buffer) {
        if (buffer.byteLength > MAX_RECENT_BYTES) {
            refreshRecent();
            return;
        }
        withStore("readwrite").then(function (store) {
            store.add({name: name, data: buffer, time: Date.now()});
            store.getAll().onsuccess = function (event) {
                var all = event.target.result || [];
                all.sort(function (a, b) {
                    return b.time - a.time;
                });
                all.slice(MAX_RECENT).forEach(function (entry) {
                    store.delete(entry.id);
                });
                refreshRecent();
            };
        }).catch(function () {});
    }

    function refreshRecent() {
        withStore("readonly").then(function (store) {
            store.getAll().onsuccess = function (event) {
                var all = (event.target.result || []).sort(function (a, b) {
                    return b.time - a.time;
                }).slice(0, MAX_RECENT);
                el["recent-list"].innerHTML = "";
                el.recent.hidden = !all.length;
                all.forEach(function (entry) {
                    var li = doc.createElement("li");
                    var button = doc.createElement("button");
                    var label = doc.createElement("span");
                    label.textContent = entry.name;
                    var size = doc.createElement("small");
                    size.textContent = formatSize(entry.data.byteLength);
                    button.appendChild(label);
                    button.appendChild(size);
                    button.addEventListener("click", function () {
                        openFile(new File([entry.data], entry.name));
                    });
                    li.appendChild(button);
                    el["recent-list"].appendChild(li);
                });
            };
        }).catch(function () {});
    }
    refreshRecent();

    /* --- integrations: share target, file handler, ?url= ------------------------ */

    function loadFromCacheShare() {
        if (!root.caches) {
            return;
        }
        root.caches.open("pycam-share").then(function (cache) {
            return cache.match("shared-file").then(function (response) {
                if (!response) {
                    return null;
                }
                var name = response.headers.get("x-file-name") || "shared";
                return response.blob().then(function (blob) {
                    cache.delete("shared-file");
                    openFile(new File([blob], name));
                });
            });
        }).catch(function () {});
    }

    var params = new URLSearchParams(root.location.search);
    if (params.get("share")) {
        loadFromCacheShare();
        history.replaceState(null, "", root.location.pathname);
    } else if (params.get("url")) {
        var url = params.get("url");
        setProgress(0.05, t("loading"));
        fetch(url).then(function (response) {
            if (!response.ok) {
                throw new Error("HTTP " + response.status);
            }
            return response.blob();
        }).then(function (blob) {
            openFile(new File([blob], url.split("/").pop() || "model"));
        }).catch(function (err) {
            hideProgress();
            showToast(t("errorPrefix") + err.message, 6000);
        });
    }

    if (root.launchQueue && root.LaunchParams) {
        root.launchQueue.setConsumer(function (params2) {
            if (params2.files && params2.files.length) {
                params2.files[0].getFile().then(openFile);
            }
        });
    }

    if ("serviceWorker" in root.navigator) {
        root.addEventListener("load", function () {
            root.navigator.serviceWorker.register("sw.js").catch(function () {});
        });
    }
})(typeof self !== "undefined" ? self : this);
