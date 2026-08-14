/* PyCAM Viewer - service worker: offline app shell + Web Share Target handling.
 *
 * Copyright 2026 The PyCAM contributors
 * Licensed under the GNU General Public License v3 or later (see COPYING.TXT).
 */
var CACHE = "pycam-viewer-v1";
var SHARE_CACHE = "pycam-share";

var SHELL = [
    "./",
    "index.html",
    "css/app.css",
    "js/app.js",
    "js/i18n.js",
    "js/viewer.js",
    "js/worker.js",
    "js/parsers/common.js",
    "js/parsers/triangulate.js",
    "js/parsers/stl.js",
    "js/parsers/dxf.js",
    "js/parsers/step.js",
    "js/parsers/index.js",
    "manifest.webmanifest",
    "icons/icon.svg",
    "icons/icon-192.png",
    "icons/icon-512.png"
];

self.addEventListener("install", function (event) {
    event.waitUntil(caches.open(CACHE).then(function (cache) {
        return cache.addAll(SHELL);
    }).then(function () {
        return self.skipWaiting();
    }));
});

self.addEventListener("activate", function (event) {
    event.waitUntil(caches.keys().then(function (keys) {
        return Promise.all(keys.map(function (key) {
            if (key !== CACHE && key !== SHARE_CACHE) {
                return caches.delete(key);
            }
            return null;
        }));
    }).then(function () {
        return self.clients.claim();
    }));
});

self.addEventListener("fetch", function (event) {
    var url = new URL(event.request.url);

    // A file shared from another app arrives as a POST; stash it and redirect.
    if (event.request.method === "POST" && url.pathname.endsWith("/share-target")) {
        event.respondWith((async function () {
            try {
                var data = await event.request.formData();
                var file = data.get("file");
                if (file) {
                    var cache = await caches.open(SHARE_CACHE);
                    await cache.put("shared-file", new Response(file, {
                        headers: {"x-file-name": file.name || "shared"}
                    }));
                }
            } catch (err) {
                // fall through to the app, which will simply show the welcome screen
            }
            return Response.redirect("./?share=1", 303);
        })());
        return;
    }

    if (event.request.method !== "GET" || url.origin !== self.location.origin) {
        return;
    }

    event.respondWith(caches.match(event.request).then(function (cached) {
        if (cached) {
            // Refresh in the background so updates land on the next start.
            event.waitUntil(fetch(event.request).then(function (response) {
                if (response && response.ok) {
                    return caches.open(CACHE).then(function (cache) {
                        return cache.put(event.request, response.clone());
                    });
                }
                return null;
            }).catch(function () {}));
            return cached;
        }
        return fetch(event.request).then(function (response) {
            if (response && response.ok && response.type === "basic") {
                var copy = response.clone();
                caches.open(CACHE).then(function (cache) {
                    cache.put(event.request, copy);
                });
            }
            return response;
        }).catch(function () {
            return caches.match("index.html");
        });
    }));
});
