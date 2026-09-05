/* 오프라인 캐시 — 파일을 수정하면 CACHE 버전을 올리세요. */
const CACHE = "laser-guide-v1.0.0";
const ASSETS = [
  "./",
  "./index.html",
  "./css/app.css",
  "./js/config.js",
  "./js/materials.js",
  "./js/shop.js",
  "./js/engine.js",
  "./js/store.js",
  "./js/testgrid.js",
  "./js/app.js",
  "./manifest.webmanifest",
  "./icons/favicon-64.png",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/* 캐시 우선 + 백그라운드 갱신 (오프라인에서도 항상 열림) */
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET" || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    caches.match(req).then((hit) => {
      const net = fetch(req).then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      }).catch(() => hit || caches.match("./index.html"));
      return hit || net;
    })
  );
});
