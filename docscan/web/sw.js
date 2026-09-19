/* Service worker: makes docscan start offline once it has been opened.
 *
 * The app shell is small, but the OpenCV WebAssembly build is not, so it is
 * cached as well - after the first visit the app starts without any network.
 */

const CACHE = "docscan-v1";

const SHELL = [
  "./",
  "./index.html",
  "./app.css",
  "./manifest.webmanifest",
  "./js/app.js",
  "./js/cv.js",
  "./js/detect.js",
  "./js/enhance.js",
  "./js/mat.js",
  "./js/pdf.js",
  "./js/store.js",
  "./js/transform.js",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  // the big one: precaching it here is what makes the app start offline.  It
  // is missing when the app runs against the CDN copy, and then the fetch
  // handler below caches that one on first use instead.
  "./vendor/opencv.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // a single missing file must not break the whole installation
    await Promise.all(SHELL.map((url) => cache.add(url).catch(() => {})));
    self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((name) => name !== CACHE).map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  const isOpenCv = url.pathname.endsWith("opencv.js");
  if (url.origin !== self.location.origin && !isOpenCv) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(request, { ignoreSearch: true });
    if (cached) {
      if (!isOpenCv) {
        // refresh in the background so the next start is up to date
        fetch(request).then((response) => {
          if (response && response.ok) cache.put(request, response.clone());
        }).catch(() => {});
      }
      return cached;
    }
    try {
      const response = await fetch(request);
      if (response && (response.ok || response.type === "opaque")) {
        cache.put(request, response.clone()).catch(() => {});
      }
      return response;
    } catch (error) {
      const fallback = await cache.match("./index.html");
      if (request.mode === "navigate" && fallback) return fallback;
      throw error;
    }
  })());
});
