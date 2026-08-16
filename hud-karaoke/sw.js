/*
 * Offline shell.
 *
 * A car loses the network in tunnels, underground car parks and half the
 * countryside, so the whole app is precached and served cache first.  Songs
 * are not touched here: they live in IndexedDB, which is offline anyway.
 */

const CACHE = "hud-karaoke-v1";

const SHELL = [
    "./",
    "./index.html",
    "./manifest.webmanifest",
    "./css/hud.css",
    "./js/main.js",
    "./js/lrc.js",
    "./js/clock.js",
    "./js/hudview.js",
    "./js/library.js",
    "./js/settings.js",
    "./js/safety.js",
    "./songs/demo.lrc",
    "./assets/icon.svg",
    "./assets/icon-192.png",
    "./assets/icon-512.png",
    "./assets/icon-maskable-512.png",
];

self.addEventListener("install", (event) => {
    event.waitUntil(
        caches
            .open(CACHE)
            .then((cache) => cache.addAll(SHELL))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener("activate", (event) => {
    event.waitUntil(
        caches
            .keys()
            .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
            .then(() => self.clients.claim())
    );
});

self.addEventListener("fetch", (event) => {
    const request = event.request;
    if (request.method !== "GET" || new URL(request.url).origin !== self.location.origin) {
        return;
    }

    event.respondWith(
        caches.match(request, { ignoreSearch: true }).then((hit) => {
            if (hit) {
                /* Refresh in the background so an update lands on the next start. */
                event.waitUntil(refresh(request));
                return hit;
            }
            return fetch(request)
                .then((response) => store(request, response))
                .catch(() => caches.match("./index.html"));
        })
    );
});

async function refresh(request) {
    try {
        const response = await fetch(request);
        await store(request, response);
    } catch (error) {
        /* Offline: the cached copy already went out. */
    }
}

async function store(request, response) {
    if (response && response.ok && response.type === "basic") {
        const cache = await caches.open(CACHE);
        await cache.put(request, response.clone());
    }
    return response;
}
